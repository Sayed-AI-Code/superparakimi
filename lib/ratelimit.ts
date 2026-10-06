// Rate limiting for /api/*, backed by Postgres so the count is true across
// serverless instances. Falls back to a process-local window when no database
// is reachable — see apiRateLimit. Runtime-agnostic (no node: APIs).

import { sql } from 'drizzle-orm';

import { getDb, rateLimitBuckets } from '@/db';
import type { DB } from '@/db';
import { describeErrorForLog } from '@/lib/auth/log';

export const ANON_LIMIT_60S = 10;
export const AUTHED_LIMIT_60S = 30;
export const RATE_WINDOW_MS = 60_000;

// Single source for the denial copy, so every rate-limited route says exactly
// the same sentence and a copy change is one edit.
export const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down.';

/**
 * First hop of `x-forwarded-for`.
 *
 * ACCEPTED WEAKNESS, stated plainly: this is trustworthy only on Vercel
 * (spec §11), whose edge overwrites the inbound value. On any other host a
 * client can forge the header and turn every limiter here into a no-op. The
 * Web Request API exposes no peer address, so there is no fallback to a
 * socket address; the structural fix is to trust only the last hop, or to put
 * the limit at the CDN (Vercel WAF). This is an abuse brake, not a wall.
 */
export function clientIp(request: { headers: Headers }): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Cheap auth-class probe for the edge limiter, before any JWT verification.
 * Matches the Auth.js session cookie by substring rather than an exact name,
 * because the name varies with deployment (`__Host-authjs.session-token`
 * behind a secure proxy, `authjs.session-token` on localhost, and a
 * `__Secure-` prefix in between) and hardcoding one variant would silently
 * classify every signed-in visitor as anonymous. A forged cookie cannot buy
 * anything: it only selects a roomier bucket, and the routes still 401
 * without a valid session.
 */
export function hasSessionCookie(request: { headers: Headers }): boolean {
  const cookie = request.headers.get('cookie');
  return cookie !== null && cookie.includes('session-token');
}

/**
 * Which bucket a request belongs to, and how large that bucket is. One source
 * of truth for the bucket name so the in-memory and Postgres paths cannot
 * disagree about who a caller is — if they did, a caller would get a fresh
 * budget simply by the store being chosen differently.
 *
 * Anonymous-vs-authenticated is decided on the cookie alone, never by waiting
 * for a JWT check: this brake has to run ahead of the 401 gate or anonymous
 * callers collect unlimited 401s for free.
 */
export function rateLimitBucket(headers: Headers): { key: string; limit: number } {
  const anonymous = !hasSessionCookie({ headers });
  return {
    key: `${anonymous ? 'anon' : 'auth'}:${clientIp({ headers })}`,
    limit: anonymous ? ANON_LIMIT_60S : AUTHED_LIMIT_60S,
  };
}

/**
 * The shared-window check: atomically take one slot in `key`'s current fixed
 * window, and answer from the number the database actually stored.
 *
 * This is the fix for the limiter that was not. A process-local Map counts
 * requests per instance, so on Vercel — where these handlers are default Node
 * serverless functions, unpinned — the enforced limit is however many instances
 * happen to be warm, times the documented number, and it resets on every cold
 * start. Here the counter is one row, and every instance increments the same
 * row, so "10 per minute" means ten.
 *
 * ONE round trip, and it has to be that way: the increment and the read cannot
 * be separate statements. Two callers that both read 9 and both write 10 would
 * each believe they were the tenth; the `ON CONFLICT ... DO UPDATE ...
 * RETURNING count` form makes Postgres serialize the write on the row and hand
 * each caller its own distinct position in the queue. Transactions are not an
 * option — the Neon HTTP driver throws `No transactions support in neon-http
 * driver` (node_modules/drizzle-orm/neon-http/session.cjs) — so the atomicity
 * has to live inside the single statement.
 *
 * The `WHERE count < limit` guard means a denial writes nothing: the row
 * holds "requests taken", never "requests attempted", and stops at the limit
 * instead of running away past it. No row returned therefore means denied,
 * which is also why the denied branch does not need to read the count back —
 * the window is epoch-aligned, so the time until it refills is arithmetic
 * against `now` alone.
 */
export async function sharedCheckRate(
  db: DB,
  key: string,
  limit: number,
  windowMs: number,
  now: number = Date.now(),
): Promise<{ allowed: boolean; retryAfterSec: number }> {
  const windowStart = Math.floor(now / windowMs) * windowMs;

  // The table name has to come from the query builder, not from a template
  // hole: `${rateLimitBuckets.name}` inside sql`` binds "rate_limit_buckets"
  // as a VALUE and generates `SET count = 'rate_limit_buckets'.count + 1`,
  // which is a syntax error at best and a silent no-op at worst.
  const taken = await db
    .insert(rateLimitBuckets)
    .values({ bucketKey: key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.bucketKey, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
      setWhere: sql`${rateLimitBuckets.count} < ${limit}`,
    })
    .returning({ count: rateLimitBuckets.count });

  if (taken.length === 0) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((windowStart + windowMs - now) / 1000),
    };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/**
 * Resolve the shared store once per process.
 *
 * Returns null rather than throwing. A limiter that fails the request when its
 * own store is down has turned a slow database into an outage, which is a worse
 * failure than the abuse it prevents — so a Neon hiccup logs and degrades to
 * the per-instance window, and the site keeps serving. Fail-open is the
 * deliberate trade-off here, stated plainly: while the store is unreachable the
 * limit is only per-instance again, exactly the behaviour before this fix. The
 * quota (10/day) is not relaxed by it — that is enforced separately, by
 * quotaService, against the same database.
 */
let sharedDb: Promise<DB | null> | null = null;

export function rateLimitDb(): Promise<DB | null> {
  sharedDb ??= getDb().catch((error: unknown) => {
    sharedDb = null;
    console.error(
      JSON.stringify({
        event: 'ratelimit.store.unavailable',
        fallback: 'in-memory',
        ...describeErrorForLog(error),
      }),
    );
    return null;
  });
  return sharedDb;
}

/**
 * The `/api/*` guard from the spec's global constraints: 10 req/min
 * anonymous, 30 req/min authenticated. Returns the 429 to hand back, or null
 * to let the request through.
 *
 * Reads the count from the shared Postgres store when one is reachable, and
 * from the process-local window otherwise — including when the caller
 * deliberately passes `null`, which is how a test says "exercise the fallback".
 *
 * Read literally, one bucket per caller rather than one per route: an
 * anonymous visitor who spends their 10 on /api/usage polling is also blocked
 * from /api/paraphrase until the window resets. That is the spec's "on
 * /api/*", and it is the stricter reading, so it is the one implemented.
 *
 * RISK, surfaced rather than hidden: `/api/auth/*` is inside this net. One
 * Auth.js sign-in round trip costs several anonymous requests (csrf, providers,
 * signin, callback, session), so the anonymous budget of 10 is not as roomy as
 * it sounds for a visitor who signs in, fails, and retries. It is deliberate —
 * `/api/auth` is the credential-stuffing surface and the limit would be
 * worthless if it excluded it — but the first person to rate-limit themselves
 * through Google OAuth will report it as a bug in the login, not as the brake
 * working.
 *
 * Cost, named: one extra Postgres round trip on every `/api/*` request. On the
 * Neon free tier and at this traffic that is noise next to a paraphrase stream,
 * and it is the price of a limit that is actually enforced.
 */
export async function apiRateLimit(
  request: { headers: Headers },
  // No default: omitting the store silently reintroduces the per-instance
  // bug this file exists to fix, so every caller has to say which store it
  // means. Pass `await rateLimitDb()` in routes (shared, degrades to
  // in-memory when the database is unreachable); pass `null` in a test that
  // wants the pure arithmetic without a database.
  db: DB | null,
): Promise<Response | null> {
  const { key, limit } = rateLimitBucket(request.headers);
  const rate = db
    ? await sharedCheckRate(db, key, limit, RATE_WINDOW_MS)
    : checkRate(key, limit, RATE_WINDOW_MS);

  if (rate.allowed) return null;
  return new Response(
    JSON.stringify({ error: RATE_LIMIT_MESSAGE, retryAfterSec: rate.retryAfterSec }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(rate.retryAfterSec),
      },
    },
  );
}

const MAX_KEYS = 10_000;

type Window = { count: number; resetAt: number };

const windows = new Map<string, Window>();

function prune(now: number): void {
  for (const [key, window] of windows) {
    if (window.resetAt <= now) windows.delete(key);
  }
  // Map iterates in insertion order, so the first keys are the oldest.
  if (windows.size > MAX_KEYS) {
    let excess = windows.size - MAX_KEYS;
    for (const key of windows.keys()) {
      windows.delete(key);
      if (--excess <= 0) break;
    }
  }
}

export function checkRate(
  key: string,
  limit: number,
  windowMs: number,
): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  prune(now);

  const window = windows.get(key);
  if (!window || window.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  if (window.count >= limit) {
    return {
      allowed: false,
      retryAfterSec: Math.ceil((window.resetAt - now) / 1000),
    };
  }
  window.count += 1;
  return { allowed: true, retryAfterSec: 0 };
}
