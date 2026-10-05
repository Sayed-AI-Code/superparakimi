import type { Mode, Strength } from '@/lib/mode/prompts';

export interface ParaphraseProvider {
  stream(text: string, mode: Mode, strength: Strength, signal: AbortSignal): AsyncIterable<string>;
}

/**
 * Any UPSTREAM fault: HTTP error, connection refused/closed, timeout,
 * or a stream that ends with zero deltas. NOT thrown for caller-initiated
 * aborts — those surface as AbortError so Task 9 can distinguish them.
 */
export class UpstreamUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamUnavailableError';
  }
}

export const UPSTREAM_TIMEOUT_MS = 120_000;

/**
 * Single source of truth for the model id. The provider calls upstream with
 * it AND the route records it on the usage row — two sites, one constant.
 * Duplicated defaults here and in the route would let `usageEvents.model`
 * silently lie once one side drifts.
 */
export const DEFAULT_MODEL = 'openai/gpt-4o-mini';
