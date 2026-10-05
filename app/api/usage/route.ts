import { auth } from '@/lib/auth';
import { describeErrorForLog } from '@/lib/auth/log';
import { apiRateLimit } from '@/lib/ratelimit';
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
 * POST /api/paraphrase) rather than in a second source of truth. It is clamped
 * at zero because `used` may exceed `limit` under a race the quota service
 * explicitly accepts; the display never shows a negative.
 *
 * `resetsAt` leaves as the UTC instant the quota service computed (next UTC
 * midnight, ISO with Z). Converting it to the visitor's zone is a display
 * concern owned by the client — see formatResetLocal.
 *
 * Read-only: this handler never writes a usage_events row. Quota is consumed
 * solely by POST /api/paraphrase at its first non-empty delta, so polling
 * this endpoint cannot spend a user's day.
 */
export async function GET(request: Request): Promise<Response> {
  // Ahead of the 401 gate on purpose: anonymous callers are exactly who this
  // brake exists for, and a limiter behind the auth check would only ever see
  // signed-in traffic.
  const limited = apiRateLimit(request);
  if (limited) return limited;

  // One id per request, generated before anything that can throw, so the
  // `console.error` below and the body handed to the client carry the same
  // value. Without it a visitor reporting "it broke at 14:02" cannot be joined
  // to a log line (spec §7: correlation_id is returned in the error body).
  const correlationId = crypto.randomUUID();

  try {
    const session = await auth();
    const userId = session?.user?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: 'Sign in to see your usage' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    const { used, limit, resetsAt } = await check(userId);
    return new Response(
      JSON.stringify({
        used,
        limit,
        // Clamped, not raw: quotaService documents an accepted race where two
        // concurrent first-deltas both insert, so `used` can legitimately reach
        // 11 against a limit of 10. The overcount is tolerated; the "-1 left
        // today" it would render is a UI lie about a count nobody can have.
        remaining: Math.max(0, limit - used),
        resetsAt,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  } catch (error) {
    // Route-level catch (spec §7). `describeErrorForLog` is the only thing
    // that reaches the log — never the raw error, whose message or `.cause`
    // can carry the connection string. Scope this honestly: check()'s query
    // params are the userId alone, so there is no credential to leak here; the
    // rule being honoured is the spec's catch clause, not a redaction fix.
    console.error(
      JSON.stringify({
        event: 'usage.read.failed',
        correlationId,
        ...describeErrorForLog(error),
      }),
    );
    return new Response(
      JSON.stringify({ error: 'Could not read your usage — try again.', correlationId }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    );
  }
}
