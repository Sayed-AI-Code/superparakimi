// Pure client-side helpers for the workspace UI.
//
// DELIBERATELY dependency-free: no `@/` imports, no React, no DOM APIs. That
// keeps this module loadable by a bare `node` subprocess (see
// tests/probes/format-reset-probe.ts), which is the only honest way to test
// timezone-dependent formatting — Intl caches the zone per process, so
// flipping process.env.TZ inside Vitest does nothing.
//
// `Frame` is re-declared here rather than imported from the paraphrase route:
// the route runs on the server and cannot be imported into a client bundle
// without dragging in auth/db/quota. The shape is the SSE wire contract
// frozen by Task 9 — if it changes there, change it here.
export type Frame =
  | { type: 'delta'; text: string }
  | { type: 'done'; remaining: number }
  | { type: 'error'; message: string };

/**
 * Parses a single SSE line into a frame, or returns null for anything that is
 * not a frame: `event:`/`id:`/`retry:` fields, `:` comment (keep-alive) lines,
 * blank lines, and malformed or non-frame JSON.
 *
 * NEVER throws — not on any input. It is called once per line for every chunk
 * of a live stream, so a single stray frame must not be able to kill the read
 * loop and blank out text the user is already watching.
 */
export function parseSseLine(line: string): Frame | null {
  if (typeof line !== 'string' || line.length === 0) return null;

  // A BOM is legal at the start of a text/event-stream and browsers strip it
  // from the *stream*, not from a chunk that lands mid-line. Remove it so a
  // leading BOM does not silently cost the user a delta.
  const text = line.charCodeAt(0) === 0xfeff ? line.slice(1) : line;
  if (text.length === 0) return null;

  // Field name is case-sensitive per the SSE spec; only `data:` carries a
  // frame. Strip exactly one optional space after the colon, then trim.
  if (!text.startsWith('data:')) return null;
  const payload = text.slice('data:'.length).trim();
  if (payload.length === 0) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  return isFrame(parsed) ? parsed : null;
}

function isFrame(value: unknown): value is Frame {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { type?: unknown; text?: unknown; remaining?: unknown; message?: unknown };
  switch (candidate.type) {
    case 'delta':
      return typeof candidate.text === 'string';
    case 'done':
      // 1e999 parses to Infinity, which would render as a nonsense count.
      return typeof candidate.remaining === 'number' && Number.isFinite(candidate.remaining);
    case 'error':
      return typeof candidate.message === 'string';
    default:
      return false;
  }
}

/**
 * Buffer for the incremental read loop: `res.body.getReader()` hands back
 * chunks at arbitrary byte boundaries, so an SSE frame routinely arrives as
 * `"data: {"` in one read and the rest in the next. Feed every decoded chunk
 * to `push`; it returns only the frames whose lines are complete, holding any
 * partial trailing line until the next chunk. `flush` handles a stream that
 * ends without a final newline.
 */
export function createSseLineBuffer(): {
  push(chunk: string): Frame[];
  flush(): Frame[];
} {
  let pending = '';

  function drain(line: string): Frame[] {
    // CRLF leaves a trailing CR on each line; parseSseLine would reject it.
    const frame = parseSseLine(line.endsWith('\r') ? line.slice(0, -1) : line);
    return frame === null ? [] : [frame];
  }

  return {
    push(chunk: string): Frame[] {
      if (typeof chunk !== 'string' || chunk.length === 0) return [];
      const text = pending + chunk;
      const lines = text.split('\n');
      // The final element is incomplete (or '' after a terminating newline).
      pending = lines.pop() ?? '';
      const frames: Frame[] = [];
      for (const line of lines) frames.push(...drain(line));
      return frames;
    },
    flush(): Frame[] {
      const rest = pending;
      pending = '';
      return drain(rest);
    },
  };
}

/**
 * Renders the quota reset instant in the *viewer's* locale and zone.
 *
 * The wire carries UTC (`resetsAt` is an ISO instant with a Z suffix,
 * computed as next-UTC-midnight by the quota service). Only here, at the
 * moment of display, does it become local — passing an explicit `timeZone`
 * would freeze the string to someone else's clock.
 */
export function formatResetLocal(resetsAtIso: string): string {
  return new Date(resetsAtIso).toLocaleString();
}

/**
 * Character counting and capping that agree with the server's zod schema.
 *
 * zod v4 `.max(n)` compares against CODE POINTS. `String.prototype.length` is
 * UTF-16 UNITS, and `.slice()` cuts on them — so for any astral-plane
 * character (emoji, CJK extension B+, musical symbols) the naive pair
 * disagrees with the server in both directions: it trims text the server would
 * have accepted, and it can strand a lone high surrogate at the cut, which
 * zod happily accepts but an upstream tokenizer may reject. `Array.from`
 * iterates code points, so these helpers count and cut the same units the
 * schema does.
 *
 * The cap still falls on a code-point boundary, not a grapheme boundary: a
 * combining mark or ZWJ sequence can be separated from its base character.
 * That yields well-formed, sendable text, which is all the cap promises;
 * `Intl.Segmenter` would be the upgrade if grapheme-exact counting matters.
 */
export function countChars(value: string): number {
  if (typeof value !== 'string') return 0;
  return Array.from(value).length;
}

export function capChars(
  value: string,
  max: number,
): { text: string; truncated: boolean } {
  if (typeof value !== 'string') return { text: '', truncated: false };
  const chars = Array.from(value);
  if (chars.length <= max) return { text: value, truncated: false };
  return { text: chars.slice(0, max).join(''), truncated: true };
}

/**
 * Makes a string safe to send: a lone surrogate (possible in a DOM value from
 * a truncated paste or an autofill) becomes U+FFFD rather than travelling to
 * the upstream, which may 400 on it. No-op on well-formed text.
 */
export function wellFormedText(value: string): string {
  if (typeof value !== 'string') return '';
  if (typeof value.isWellFormed !== 'function') return value;
  return value.isWellFormed() ? value : value.toWellFormed();
}

/**
 * Window event names used to keep the two client components in sync.
 *
 * UsageMeter lives in app/layout.tsx and Workspace in app/app/page.tsx —
 * different React trees, so there is no shared state to lift into. UsageMeter
 * is the only component that fetches /api/usage (spec §7: once on load, no
 * polling); Workspace publishes the authoritative `remaining` from the stream's
 * terminal `done` frame, and asks for a refetch when a stream dies without one
 * (abort, mid-stream fault) — quota may already have been spent on the first
 * delta, so the meter must not keep showing the pre-stream count.
 */
export const USAGE_EVENT = 'parakimi:usage';
export const USAGE_REFRESH_EVENT = 'parakimi:usage:refresh';

/** The GET /api/usage response body. */
export type Usage = {
  used: number;
  limit: number;
  remaining: number;
  resetsAt: string;
};

export function publishUsage(usage: Usage): void {
  window.dispatchEvent(new CustomEvent<Usage>(USAGE_EVENT, { detail: usage }));
}

/** Subscribes to usage updates; returns the unsubscribe function. */
export function subscribeUsage(onUsage: (usage: Usage) => void): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<Usage>).detail;
    if (detail && typeof detail.remaining === 'number') onUsage(detail);
  };
  window.addEventListener(USAGE_EVENT, handler);
  return () => window.removeEventListener(USAGE_EVENT, handler);
}

/** Asks whoever owns the /api/usage fetch to run it again. */
export function requestUsageRefresh(): void {
  window.dispatchEvent(new Event(USAGE_REFRESH_EVENT));
}
