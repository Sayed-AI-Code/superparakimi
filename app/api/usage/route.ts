import { auth } from '@/lib/auth';
import { check } from '@/lib/quota/quotaService';

/**
 * GET /api/usage — the client's read-only view of today's quota.
 *
 * Anonymous callers get 401 with a JSON body, never a redirect: this endpoint
 * is consumed by fetch(), which would follow a 302 to /signin and hand back
 * HTML where the client expects `{used, limit, remaining}`.
 *
 * `remaining` is derived, not stored — QuotaStatus carries only `used` and
 * `limit`, so the subtraction lives here (and in the `done` SSE frame of
 * POST /api/paraphrase) rather than in a second source of truth.
 *
 * `resetsAt` leaves as the UTC instant the quota service computed (next UTC
 * midnight, ISO with Z). Converting it to the visitor's zone is a display
 * concern owned by the client — see formatResetLocal.
 *
 * Read-only: this handler never writes a usage_events row. Quota is consumed
 * solely by POST /api/paraphrase at its first non-empty delta, so polling
 * this endpoint cannot spend a user's day.
 */
export async function GET(): Promise<Response> {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Sign in to see your usage' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  const { used, limit, resetsAt } = await check(userId);
  return new Response(JSON.stringify({ used, limit, remaining: limit - used, resetsAt }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
