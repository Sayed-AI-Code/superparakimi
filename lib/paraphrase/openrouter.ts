import OpenAI, { APIUserAbortError } from 'openai';
import { getSystemPrompt } from '@/lib/mode/prompts';
import type { Mode, Strength } from '@/lib/mode/prompts';
import { UpstreamUnavailableError, UPSTREAM_TIMEOUT_MS } from './types';
import type { ParaphraseProvider } from './types';

const DEFAULT_MODEL = 'openai/gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function isAbortLike(error: unknown): boolean {
  return (
    error instanceof APIUserAbortError ||
    (error instanceof Error && /abort/i.test(error.name))
  );
}

/**
 * Env (key/model/baseURL) is read at CALL time (inside stream()), so
 * tests and runtime config changes take effect without re-creating the
 * provider. No secret ever appears in a thrown message; raw errors ride
 * on `cause` for server-side logs only.
 */
export function createOpenRouterProvider(opts?: { timeoutMs?: number }): ParaphraseProvider {
  const timeoutMs = opts?.timeoutMs ?? UPSTREAM_TIMEOUT_MS;

  return {
    async *stream(
      text: string,
      mode: Mode,
      strength: Strength,
      callerSignal: AbortSignal,
    ): AsyncGenerator<string> {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        throw new UpstreamUnavailableError('OpenRouter is not configured');
      }
      const model = process.env.PARAPHRASE_MODEL ?? DEFAULT_MODEL;
      const baseURL = process.env.OPENROUTER_BASE_URL ?? DEFAULT_BASE_URL;
      // maxRetries: 0 — spec forbids silent upstream retry; a lost
      // response after upstream already generated must not double-bill.
      // Exactly one upstream request per stream() call (SDK default is 2).
      const client = new OpenAI({ apiKey, baseURL, maxRetries: 0 });
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = AbortSignal.any([callerSignal, timeoutSignal]);

      let deltaCount = 0;
      try {
        const stream = await client.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: getSystemPrompt(mode, strength) },
              { role: 'user', content: text },
            ],
            stream: true,
          },
          { signal },
        );
        for await (const chunk of stream) {
          for (const choice of chunk.choices) {
            const content = choice.delta.content;
            if (content) {
              deltaCount += 1;
              yield content;
            }
          }
        }
      } catch (error) {
        // Caller-initiated abort surfaces as AbortError, as-is.
        if (isAbortLike(error) && callerSignal.aborted) {
          throw error;
        }
        // Timeout fired (abort on the composed signal, caller is clean) or
        // any other upstream fault: HTTP reject, mid-stream socket death.
        throw new UpstreamUnavailableError(
          timeoutSignal.aborted ? 'OpenRouter request timed out' : 'OpenRouter request failed',
          { cause: error },
        );
      }
      // openai SDK v7.28 swallows transport aborts as NORMAL stream end
      // (see openai/core/streaming.js isTransportAbortError branch), so an
      // abort can surface here instead of the catch above. Caller abort
      // wins over timeout; restore the AbortError contract for Task 9.
      if (callerSignal.aborted) {
        throw callerSignal.reason instanceof Error
          ? callerSignal.reason
          : new DOMException('Aborted', 'AbortError');
      }
      if (timeoutSignal.aborted) {
        throw new UpstreamUnavailableError('OpenRouter request timed out');
      }
      // The SDK cannot distinguish `data: [DONE]` from a clean truncated
      // EOF — a stream that ends without a single delta consumed nothing
      // and is an upstream fault, never a success.
      if (deltaCount === 0) {
        throw new UpstreamUnavailableError('OpenRouter stream ended without any content');
      }
    },
  };
}
