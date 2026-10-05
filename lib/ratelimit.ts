// Process-local fixed-window rate limiter; runtime-agnostic (no node: APIs).
// Enforced in the /api/* route handlers, not proxy.ts — see apiRateLimit for
// why the proxy cannot host it.

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
 * The whole per-IP rate-limit decision for one API request, pure.
 *
 * Lives here rather than in proxy.ts because the proxy cannot host it: the
 * only way to run custom logic there is `export const proxy = auth(async …)`,
 * and that wrapper form was measured to bypass authConfig.callbacks.authorized
 * — `/app` answered 200 and `/account` 500 to anonymous visitors instead of
 * the 307 the callback mandates. `export { auth as proxy }` is the form that
 * enforces authorization, so it stays, and the limiter moves to the route
 * handlers, which is the other place that sees every `/api/*` request.
 *
 * Split decision/Response so the anonymous-vs-authed branching is testable
 * without a Next runtime: rateLimitDecision is arithmetic, apiRateLimit only
 * renders it.
 */
export function rateLimitDecision(headers: Headers): {
  allowed: boolean;
  retryAfterSec: number;
  limit: number;
} {
  const anonymous = !hasSessionCookie({ headers });
  const limit = anonymous ? ANON_LIMIT_60S : AUTHED_LIMIT_60S;
  const rate = checkRate(
    `${anonymous ? 'anon' : 'auth'}:${clientIp({ headers })}`,
    limit,
    RATE_WINDOW_MS,
  );
  return { ...rate, limit };
}

/**
 * The `/api/*` guard from the spec's global constraints: 10 req/min
 * anonymous, 30 req/min authenticated. Returns the 429 to hand back, or null
 * to let the request through.
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
 */
export function apiRateLimit(request: { headers: Headers }): Response | null {
  const decision = rateLimitDecision(request.headers);
  if (decision.allowed) return null;
  return new Response(
    JSON.stringify({ error: RATE_LIMIT_MESSAGE, retryAfterSec: decision.retryAfterSec }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(decision.retryAfterSec),
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
