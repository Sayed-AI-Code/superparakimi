import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';

import { getDb, rateLimitBuckets, resetTestDb } from '@/db';
import { RATE_LIMIT_MESSAGE, apiRateLimit, sharedCheckRate } from '@/lib/ratelimit';

/**
 * The shared-store rate limiter.
 *
 * The process-local Map in lib/ratelimit.ts counts correctly but only for
 * itself: on Vercel these handlers run as default Node serverless functions,
 * so every warm Lambda holds its own counter and a caller who lands on a
 * different instance restarts at zero. These tests put the counter in
 * Postgres, where it is one number that every instance reads and writes, and
 * assert the properties that only a shared store can have:
 *
 * 1. the count survives a fresh caller in the same process, because it lives
 *    in a row and not in a variable;
 * 2. 20 concurrent hits against a limit of 10 let exactly 10 through, because
 *    the increment is a single atomic UPSERT rather than read-then-write.
 *
 * Local runs use the in-process PGlite that `getDb()` boots under
 * NODE_ENV=test; CI runs the same file against a real postgres:16 through
 * DATABASE_URL_TEST. The production Neon HTTP driver — the one actually
 * serving superparakimi.vercel.app — cannot be exercised from CI without
 * credentials, so `scripts/check-ratelimit-neon.ts` runs the identical
 * assertions against a real Neon endpoint by hand, and its output is what the
 * "verified against Neon" claim rests on.
 */

const WINDOW_60S = 60_000;

/** Reads the row straight out of the table. The point of doing this with raw
 * SQL rather than through the store is that it proves the counter is a fact
 * about the database: a store that kept its number in a Map would satisfy
 * every allow/deny assertion above and still fail this one. */
async function rowCount(bucketKey: string, windowStart: number): Promise<number | null> {
  const db = await getDb();
  const res = await db
    .select({ count: rateLimitBuckets.count })
    .from(rateLimitBuckets)
    .where(
      and(eq(rateLimitBuckets.bucketKey, bucketKey), eq(rateLimitBuckets.windowStart, windowStart)),
    );
  return res[0]?.count ?? null;
}

/** The epoch-aligned window `now` falls in, computed the same way the store
 * computes it. Exported maths is asserted rather than trusted. */
function windowStartFor(now: number): number {
  return Math.floor(now / WINDOW_60S) * WINDOW_60S;
}

beforeEach(async () => {
  await resetTestDb();
});

describe('rate_limit_buckets schema', () => {
  it('keys a bucket by (bucket_key, window_start) with a plain integer count', async () => {
    const db = await getDb();
    const key = `anon:192.0.2.${crypto.randomUUID().slice(0, 6)}`;
    const start = windowStartFor(Date.now());

    await sharedCheckRate(db, key, 10, WINDOW_60S);

    // db.execute is typed `unknown` on the pglite driver (and its runtime
    // shape differs per driver), so the raw read is asserted once, through an
    // explicit shape, rather than trusted to a generic that does not apply.
    const raw = (await db.execute(
      sql`SELECT count, window_start FROM rate_limit_buckets WHERE bucket_key = ${key}`,
    )) as unknown as { rows: { count: number | string; window_start: number | string }[] };
    expect(raw.rows).toHaveLength(1);
    expect(Number(raw.rows[0].window_start)).toBe(start);
    expect(Number(raw.rows[0].count)).toBe(1);
  });
});

describe('sharedCheckRate: fixed window, one number for every caller', () => {
  it('allows exactly the limit then denies, from a store that keeps nothing in memory', async () => {
    const db = await getDb();
    const key = `anon:198.51.100.${crypto.randomUUID().slice(0, 6)}`;

    for (let i = 0; i < 10; i++) {
      const res = await sharedCheckRate(db, key, 10, WINDOW_60S);
      expect(res.allowed).toBe(true);
      expect(res.retryAfterSec).toBe(0);
    }

    const denied = await sharedCheckRate(db, key, 10, WINDOW_60S);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('reads its state from the row, not from the process — a second call sees the first', async () => {
    const db = await getDb();
    const key = `auth:203.0.113.${crypto.randomUUID().slice(0, 6)}`;
    const now = Date.now();

    await sharedCheckRate(db, key, 5, WINDOW_60S, now);
    expect(await rowCount(key, windowStartFor(now))).toBe(1);

    await sharedCheckRate(db, key, 5, WINDOW_60S, now + 1_000);
    expect(await rowCount(key, windowStartFor(now))).toBe(2);

    await sharedCheckRate(db, key, 5, WINDOW_60S, now + 2_000);
    await sharedCheckRate(db, key, 5, WINDOW_60S, now + 3_000);
    await sharedCheckRate(db, key, 5, WINDOW_60S, now + 4_000);
    expect(await rowCount(key, windowStartFor(now))).toBe(5);

    const denied = await sharedCheckRate(db, key, 5, WINDOW_60S, now + 5_000);
    expect(denied.allowed).toBe(false);
    // The row never grows past the ceiling: a denial must not keep counting,
    // or the stored number stops meaning "requests taken".
    expect(await rowCount(key, windowStartFor(now))).toBe(5);
  });

  it('rolls into a new window once the old one expires, leaving the old row alone', async () => {
    const db = await getDb();
    const key = `anon:192.0.2.${crypto.randomUUID().slice(0, 6)}`;
    const now = Math.floor(Date.now() / WINDOW_60S) * WINDOW_60S;

    for (let i = 0; i < 3; i++) {
      expect((await sharedCheckRate(db, key, 3, WINDOW_60S, now + i * 1_000)).allowed).toBe(true);
    }
    expect((await sharedCheckRate(db, key, 3, WINDOW_60S, now + 30_000)).allowed).toBe(false);

    const nextWindow = now + WINDOW_60S;
    const fresh = await sharedCheckRate(db, key, 3, WINDOW_60S, nextWindow);
    expect(fresh.allowed).toBe(true);
    expect(fresh.retryAfterSec).toBe(0);

    expect(await rowCount(key, windowStartFor(now))).toBe(3);
    expect(await rowCount(key, nextWindow)).toBe(1);
  });

  it('isolates buckets from each other', async () => {
    const db = await getDb();
    const now = Date.now();
    const exhausted = `anon:198.51.100.${crypto.randomUUID().slice(0, 6)}`;
    const untouched = `auth:198.51.100.${crypto.randomUUID().slice(0, 6)}`;

    for (let i = 0; i < 4; i++) {
      await sharedCheckRate(db, exhausted, 4, WINDOW_60S, now);
    }
    expect((await sharedCheckRate(db, exhausted, 4, WINDOW_60S, now)).allowed).toBe(false);
    expect((await sharedCheckRate(db, untouched, 30, WINDOW_60S, now)).allowed).toBe(true);
  });

  it('lets exactly the limit through when 20 callers race on one bucket', async () => {
    const db = await getDb();
    const key = `anon:203.0.113.${crypto.randomUUID().slice(0, 6)}`;

    const results = await Promise.all(
      Array.from({ length: 20 }, () => sharedCheckRate(db, key, 10, WINDOW_60S)),
    );

    // Read-then-write would let several of these see count=1 and all say
    // yes. The single UPSERT ... DO UPDATE is what makes 10 the hard number.
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(10);
    expect(await rowCount(key, windowStartFor(Date.now()))).toBe(10);
  });

  it('reports the seconds until the window resets, counting down', async () => {
    const db = await getDb();
    const key = `anon:192.0.2.${crypto.randomUUID().slice(0, 6)}`;
    const now = Math.floor(Date.now() / WINDOW_60S) * WINDOW_60S;

    for (let i = 0; i < 2; i++) await sharedCheckRate(db, key, 2, WINDOW_60S, now);

    const justAfter = await sharedCheckRate(db, key, 2, WINDOW_60S, now + 1_000);
    expect(justAfter.allowed).toBe(false);
    expect(justAfter.retryAfterSec).toBe(59);

    const nearlyDone = await sharedCheckRate(db, key, 2, WINDOW_60S, now + 59_500);
    expect(nearlyDone.allowed).toBe(false);
    expect(nearlyDone.retryAfterSec).toBe(1);
  });
});

describe('apiRateLimit against a shared store', () => {
  function anonReq(ip: string) {
    return { headers: new Headers({ 'x-forwarded-for': ip }) };
  }

  it('returns null while the shared bucket has room and 429 once it does not', async () => {
    const db = await getDb();
    const ip = `198.51.100.${crypto.randomUUID().slice(0, 6)}`;

    for (let i = 0; i < 10; i++) {
      expect(await apiRateLimit(anonReq(ip), db)).toBeNull();
    }

    const blocked = await apiRateLimit(anonReq(ip), db);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get('content-type')).toBe('application/json');
    expect(Number(blocked!.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(blocked!.json()).resolves.toEqual({
      error: RATE_LIMIT_MESSAGE,
      retryAfterSec: expect.any(Number),
    });
  });
});
