import { auth } from '@/lib/auth';
import { describeErrorForLog } from '@/lib/auth/log';
import { createOpenRouterProvider } from '@/lib/paraphrase/openrouter';
import type { ParaphraseProvider } from '@/lib/paraphrase/types';
import { DEFAULT_MODEL, UpstreamUnavailableError } from '@/lib/paraphrase/types';
import {
  abortUsage,
  beginUsage,
  check,
  completeUsage,
} from '@/lib/quota/quotaService';
import { apiRateLimit, rateLimitDb } from '@/lib/ratelimit';
import { paraphraseRequestSchema } from '@/lib/validation';

// zod caps the TRIMMED text, so leading/trailing whitespace stays unbounded
// until schema.parse sees it. This raw-byte ceiling bounds the body on the
// wire before any parsing. Sized for spec-legal input, not for ASCII: 5,000
// chars is 20,000 bytes at 4 bytes/char (emoji) plus the JSON envelope, so
// an 8 KB guard would reject legitimate non-Latin text.
const MAX_BODY_BYTES = 32_768;

// PRE-STREAM only (no usage_events row exists, quota untouched). Spec §7
// quotes this copy verbatim; do not reuse it anywhere a row was created.
const UPSTREAM_ERROR_MESSAGE = "Service hiccup — didn't count against your limit";
const CANCELLED_MESSAGE = 'Request cancelled.';
const GENERIC_STREAM_MESSAGE = 'Generation stopped unexpectedly.';
const QUOTA_MESSAGE = "You've used all your free paraphrases for today.";

// DURING-STREAMING only (beginUsage already created the row, so the slot is
// spent — see the first-delta rule in lib/quota/quotaService.ts). Spec §7:
// "UI notes the request counts because generation started." These must never
// borrow the pre-stream "didn't count" wording, which is true only before the
// first delta.
const BILLED_UPSTREAM_MESSAGE =
  'Service hiccup — this request counted, because generation started.';
const BILLED_CANCELLED_MESSAGE =
  'Stopped — this request counted, because generation started.';
const BILLED_GENERIC_MESSAGE =
  'Generation stopped unexpectedly — this request counted, because generation started.';

type Frame =
  | { type: 'delta'; text: string }
  | { type: 'done'; remaining: number }
  | { type: 'error'; message: string };

const encoder = new TextEncoder();

function sse(payload: Frame): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function jsonError(
  status: number,
  body: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && /abort/i.test(error.name);
}

function resolveModel(): string {
  // DEFAULT_MODEL is shared with the provider, so the model recorded on the
  // usage row is the model actually called.
  return process.env.PARAPHRASE_MODEL ?? DEFAULT_MODEL;
}

async function remainingFor(userId: string): Promise<number> {
  const status = await check(userId);
  // Clamped here exactly as in GET /api/usage — this feeds the terminal `done`
  // frame, so an unclamped value would reach the meter after every generation
  // that trips quotaService's documented accepted race (used=11) and render
  // "-1 of 10 left today" while the endpoint says 0. Both derivation sites
  // must agree or the two endpoints disagree about the same user's day.
  return Math.max(0, status.limit - status.used);
}

function sseResponse(
  chunks: AsyncGenerator<Uint8Array>,
  onCancel?: () => Promise<void>,
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await chunks.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      async cancel() {
        // Release THIS generator first; its `finally` terminalizes the row and
        // releases the provider iterator. Then run onCancel, because if the
        // consumer abandons BEFORE the first read the generator never began —
        // .return() on an unstarted generator runs no body and no finally, so
        // teardown has to happen out here too.
        await chunks.return(undefined);
        await onCancel?.();
      },
    }),
    {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      },
    },
  );
}

/**
 * Quota is consumed exactly once, at `beginUsage`, on the FIRST text delta.
 * `check()` gates once before streaming starts and is never re-evaluated
 * mid-stream — text the user has already been billed for must not be cut off
 * because the count crossed a line halfway through.
 *
 * Because an HTTP status has to be chosen before any byte is written, the
 * first delta is pulled BEFORE a Response exists. That is what lets a
 * pre-delta upstream failure answer 502 with no row instead of a 200 SSE
 * that already claimed success. Never retries upstream — a single pass.
 */
export function makeRouteHandler({ provider }: { provider: ParaphraseProvider }) {
  return {
    async POST(request: Request): Promise<Response> {
      // ONE id per request, minted before anything that can fail. Spec §7 makes
      // correlation ids the seam between what the client saw and what the server
      // logged; an id minted inline at each call site cannot join to anything,
      // and one minted only inside a console.error call is pure decoration.
      // Attached to 5xx/502 bodies and to every log line for this request;
      // deliberately NOT added to the 401/422/429 bodies, whose shapes are
      // pinned by the spec and by existing tests.
      const correlationId = crypto.randomUUID();

      // Per-IP brake, ahead of the auth gate: a limiter that runs after the
      // 401 has nothing to limit, since anonymous callers would collect
      // unlimited 401s for free. 10/min anonymous, 30/min authenticated.
      // Abuse control, NOT quota — a denial here consumes no quota and writes
      // no usage_events row.
      const limited = await apiRateLimit(request, await rateLimitDb());
      if (limited) return limited;

      const session = await auth();
      const userId = session?.user?.id;
      if (!userId) {
        return jsonError(401, { error: 'Sign in to paraphrase' });
      }

      const raw = await request.text();
      if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
        return jsonError(422, { error: 'Message too large' });
      }

      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonError(422, { error: 'Invalid JSON body' });
      }

      const parsed = paraphraseRequestSchema.safeParse(body);
      if (!parsed.success) {
        return jsonError(422, { error: 'Invalid paraphrase request' });
      }
      const { text, mode, strength } = parsed.data;

      const quota = await check(userId);
      if (!quota.allowed) {
        return jsonError(429, {
          error: QUOTA_MESSAGE,
          limit: quota.limit,
          used: quota.used,
          resetsAt: quota.resetsAt,
        });
      }

      const iterator = provider
        .stream(text, mode, strength, request.signal)[Symbol.asyncIterator]();
      const charsIn = text.length;

      let eventId: string | null = null;
      let totalChars = 0;

      // Prime on the first non-empty delta. Quota is consumed here — and
      // nowhere else.
      let first: IteratorResult<string> | null = null;
      try {
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (next.value.length === 0) continue;
          if (eventId === null) {
            eventId = await beginUsage(userId, charsIn, resolveModel(), mode, strength);
          }
          totalChars += next.value.length;
          first = next;
          break;
        }
      } catch (error) {
        // Caller cancellation first: an abort that is not shaped like an
        // AbortError must not be misreported as an upstream fault.
        if (request.signal.aborted || isAbortLike(error)) {
          // A row can already exist here: the priming loop bills before it
          // breaks, so an abort on a later iteration has spent the slot. The
          // copy must follow the row, not the abort.
          if (eventId !== null) {
            await abortUsage(eventId);
            return jsonError(499, { error: BILLED_CANCELLED_MESSAGE, correlationId });
          }
          return jsonError(499, { error: CANCELLED_MESSAGE, correlationId });
        }
        if (eventId === null) {
          // Log the fault the user was just given an ID for — a correlation ID
          // that resolves to nothing server-side is decoration, not diagnosis.
          // The projection keeps credentials and query text out of the log.
          console.error('[paraphrase] pre-delta failure', {
            correlationId,
            ...describeErrorForLog(error),
          });
          if (error instanceof UpstreamUnavailableError) {
            return jsonError(502, {
              error: UPSTREAM_ERROR_MESSAGE,
              correlationId,
            });
          }
          return jsonError(500, {
            error: GENERIC_STREAM_MESSAGE,
            correlationId,
          });
        }
        // Delta already delivered and billed: end the stream honestly, with
        // copy that admits the slot was spent.
        await abortUsage(eventId);
        return sseResponse(
          (async function* () {
            yield sse({
              type: 'error',
              message: error instanceof UpstreamUnavailableError
                ? BILLED_UPSTREAM_MESSAGE
                : BILLED_GENERIC_MESSAGE,
            });
          })(),
        );
      }

      // Upstream closed without a single delta: nothing generated, nothing
      // billed, no row. Still logged — this id goes to the client, and an id
      // with no matching log line cannot be used to diagnose anything.
      if (first === null) {
        if (eventId !== null) await abortUsage(eventId);
        console.error('[paraphrase] upstream returned zero deltas', {
          correlationId,
          mode,
          strength,
          charsIn,
        });
        return jsonError(502, {
          error: UPSTREAM_ERROR_MESSAGE,
          correlationId,
        });
      }

      const firstDelta = first.value;
      // A delivered delta is always billed before it is recorded — the
      // priming loop above bills on the first non-empty delta and only then
      // sets `first`. TypeScript cannot see that coupling across the loop, so
      // the invariant is stated explicitly instead of cast away; reaching this
      // branch would mean text was delivered unbilled, which is a 500 and
      // still writes no row.
      if (eventId === null) {
        // Unreachable by construction, but it answers with an id, so it must
        // log that same id — otherwise the client holds a handle to nothing.
        console.error('[paraphrase] delivered delta without a billed row', {
          correlationId,
          charsIn,
        });
        return jsonError(500, {
          error: GENERIC_STREAM_MESSAGE,
          correlationId,
        });
      }
      const billedId = eventId;

      // Settlement is hoisted OUT of the generator on purpose. The row is
      // already billed at this point, and a consumer that cancels before the
      // first read closes a generator that never began — no body, no finally.
      // Teardown therefore cannot depend on the generator ever starting.
      // Idempotent, so every exit path can call it without double-writing.
      let settled = false;
      async function settle(): Promise<void> {
        if (settled) return;
        settled = true;
        try {
          await abortUsage(billedId);
        } finally {
          // Release upstream even if the row update threw.
          await iterator.return?.();
        }
      }

      return sseResponse(
        (async function* () {
          try {
            // The first delta yield must be INSIDE the try, so a consumer that
            // cancels after reading delta one still lands in the finally.
            yield sse({ type: 'delta', text: firstDelta });
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              if (next.value.length === 0) continue;
              totalChars += next.value.length;
              yield sse({ type: 'delta', text: next.value });
            }
            if (request.signal.aborted) {
              await settle();
              yield sse({ type: 'error', message: BILLED_CANCELLED_MESSAGE });
              return;
            }
            await completeUsage(billedId, totalChars);
            // Billed as completed: the settle in `finally` must not overwrite
            // the terminal status, so mark it settled before releasing upstream.
            settled = true;
            await iterator.return?.();
            yield sse({ type: 'done', remaining: await remainingFor(userId) });
          } catch (error) {
            await settle();
            console.error('[paraphrase] stream failed', {
              correlationId,
              billedId,
              ...describeErrorForLog(error),
            });
            // Every exit from here is POST-billing: `billedId` is non-null by
            // construction, so the row exists and the slot is spent regardless of
            // whether this was a cancellation, an upstream fault, or a programmer
            // fault. The unbilled copies must never appear in this generator.
            const message =
              request.signal.aborted || isAbortLike(error)
                ? BILLED_CANCELLED_MESSAGE
                : error instanceof UpstreamUnavailableError
                  ? BILLED_UPSTREAM_MESSAGE
                  : BILLED_GENERIC_MESSAGE;
            yield sse({ type: 'error', message });
          } finally {
            // Any remaining exit — abandonment, throw inside catch, early
            // return — terminalizes the row and releases upstream exactly once.
            await settle();
          }
        })(),
        settle,
      );
    },
  };
}

export const { POST } = makeRouteHandler({ provider: createOpenRouterProvider() });
