// Process-local fixed-window rate limiter; runtime-agnostic (no node: APIs)
// so it stays importable from edge middleware.

export const ANON_LIMIT_60S = 10;
export const AUTHED_LIMIT_60S = 30;

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
