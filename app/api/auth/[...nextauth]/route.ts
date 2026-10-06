import type { NextRequest } from 'next/server';

import { handlers } from '@/lib/auth';
import { apiRateLimit, rateLimitDb } from '@/lib/ratelimit';

/**
 * The Auth.js catch-all, wrapped in the per-IP brake.
 *
 * This is the route where guessed credentials arrive, so it is the one the
 * spec's anonymous limit most needs to cover — excluding it would leave the
 * limiter pointed away from the only surface that matters for credential
 * stuffing.
 *
 * The wrapper is deliberately thin and does NOT go through proxy.ts: the
 * `export const proxy = auth(async …)` form was measured to bypass
 * authConfig.callbacks.authorized, so `export { auth as proxy }` stays as the
 * authorization gate and limiting happens here, in the handler, where it cannot
 * displace that callback.
 *
 * `??` matters: apiRateLimit returns null when the request is allowed, so the
 * delegate runs only in that case and a 429 short-circuits before Auth.js is
 * touched.
 *
 * Honest trade-off: one Auth.js round trip spends several anonymous requests
 * (csrf, providers, signin, callback, session), so a visitor who signs in,
 * mistypes, and retries twice can spend the budget of 10. That is the spec's
 * number applied literally, and the first such visitor will read it as a broken
 * login. If that happens in production the fix is a wider budget on this
 * prefix, not a weaker limiter elsewhere.
 */
const { GET: authGet, POST: authPost } = handlers;

export async function GET(request: NextRequest): Promise<Response> {
  const limited = await apiRateLimit(request, await rateLimitDb());
  return limited ?? authGet(request);
}

export async function POST(request: NextRequest): Promise<Response> {
  const limited = await apiRateLimit(request, await rateLimitDb());
  return limited ?? authPost(request);
}
