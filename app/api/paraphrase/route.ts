import { auth } from '@/lib/auth';
import { createOpenRouterProvider } from '@/lib/paraphrase/openrouter';
import type { ParaphraseProvider } from '@/lib/paraphrase/types';
import { UpstreamUnavailableError } from '@/lib/paraphrase/types';
import {
  abortUsage,
  beginUsage,
  check,
  completeUsage,
} from '@/lib/quota/quotaService';
import { ANON_LIMIT_60S, AUTHED_LIMIT_60S, checkRate } from '@/lib/ratelimit';
import { paraphraseRequestSchema } from '@/lib/validation';

const RATE_WINDOW_MS = 60_000;

// zod caps the TRIMMED text, so leading/trailing whitespace stays unbounded
// until schema.parse sees it. This raw-byte ceiling bounds the body on the
// wire before any parsing. Sized for spec-legal input, not for ASCII: 5,000
// chars is 20,000 bytes at 4 bytes/char (emoji) plus the JSON envelope, so
// an 8 KB guard would reject legitimate non-Latin text.
const MAX_BODY_BYTES = 32_768;

const UPSTREAM_ERROR_MESSAGE = "Service hiccup — didn't count against your limit";
const CANCELLED_MESSAGE = 'Request cancelled.';
const GENERIC_STREAM_MESSAGE = 'Generation stopped unexpectedly.';
const RATE_LIMIT_MESSAGE = 'Too many requests. Please slow down.';
const QUOTA_MESSAGE = "You've used all your free paraphrases for today.";

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

function clientIp(request: Request): string {
  // First hop of x-forwarded-for: the client address behind the trusted proxy.
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && /abort/i.test(error.name);
}

function resolveModel(): string {
  return process.env.PARAPHRASE_MODEL ?? 'openai/gpt-4o-mini';
}

async function remainingFor(userId: string): Promise<number> {
  const status = await check(userId);
  return status.limit - status.used;
}

function sseResponse(chunks: AsyncGenerator<Uint8Array>): Response {
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
      async cancel(reason) {
        // Consumer went away: release the provider iterator so its upstream
        // request is torn down instead of streaming into a discarded stream.
        await chunks.return(undefined);
        void reason;
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

      // Abuse control, NOT quota: a rate-limit denial consumes no quota and
      // writes no usageEvents row.
      const limit = session ? AUTHED_LIMIT_60S : ANON_LIMIT_60S;
      const rate = checkRate(clientIp(request), limit, RATE_WINDOW_MS);
      if (!rate.allowed) {
        return jsonError(
          429,
          { error: RATE_LIMIT_MESSAGE, retryAfterSec: rate.retryAfterSec },
          { 'retry-after': String(rate.retryAfterSec) },
        );
      }

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
          if (eventId !== null) await abortUsage(eventId);
          return jsonError(499, { error: CANCELLED_MESSAGE });
        }
        if (eventId === null) {
          if (error instanceof UpstreamUnavailableError) {
            return jsonError(502, {
              error: UPSTREAM_ERROR_MESSAGE,
              correlationId: crypto.randomUUID(),
            });
          }
          return jsonError(500, {
            error: GENERIC_STREAM_MESSAGE,
            correlationId: crypto.randomUUID(),
          });
        }
        // Delta already delivered and billed: end the stream honestly.
        if (eventId !== null) await abortUsage(eventId);
        return sseResponse(
          (async function* () {
            yield sse({
              type: 'error',
              message: error instanceof UpstreamUnavailableError
                ? UPSTREAM_ERROR_MESSAGE
                : GENERIC_STREAM_MESSAGE,
            });
          })(),
        );
      }

      // Upstream closed without a single delta: nothing generated, nothing
      // billed, no row.
      if (first === null) {
        if (eventId !== null) await abortUsage(eventId);
        return jsonError(502, {
          error: UPSTREAM_ERROR_MESSAGE,
          correlationId: crypto.randomUUID(),
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
        return jsonError(500, {
          error: GENERIC_STREAM_MESSAGE,
          correlationId: crypto.randomUUID(),
        });
      }
      const billedId = eventId;

      return sseResponse(
        (async function* () {
          yield sse({ type: 'delta', text: firstDelta });
          let settled = false;
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done) break;
              if (next.value.length === 0) continue;
              totalChars += next.value.length;
              yield sse({ type: 'delta', text: next.value });
            }
            if (request.signal.aborted) {
              await abortUsage(billedId);
              settled = true;
              yield sse({ type: 'error', message: CANCELLED_MESSAGE });
              return;
            }
            await completeUsage(billedId, totalChars);
            settled = true;
            yield sse({ type: 'done', remaining: await remainingFor(userId) });
          } catch (error) {
            if (!settled) {
              await abortUsage(billedId);
              settled = true;
            }
            // Check the signal before naming a fault: a cancellation is not
            // the provider's failure.
            const message =
              request.signal.aborted || isAbortLike(error)
                ? CANCELLED_MESSAGE
                : error instanceof UpstreamUnavailableError
                  ? UPSTREAM_ERROR_MESSAGE
                  : GENERIC_STREAM_MESSAGE;
            yield sse({ type: 'error', message });
          }
        })(),
      );
    },
  };
}

export const { POST } = makeRouteHandler({ provider: createOpenRouterProvider() });
