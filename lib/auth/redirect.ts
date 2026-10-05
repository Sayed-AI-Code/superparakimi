// Sanitizes a user-supplied redirect target to a same-origin path.
// callbackUrl arrives from the proxy (absolute, same-origin href) or a
// crafted link.
//
// Defense order matters:
// 1. Scrub C0 control chars + DEL first. WHATWG URL parsers strip
//    TAB/LF/CR from the input *before* parsing, so `/\t//evil.com`
//    reaches the browser as `///evil.com` and resolves off-origin — and
//    the TAB form is a legal Location header value. Only the scrubbed
//    value is ever validated or returned; raw input never escapes.
// 2. Flatten absolute URLs to their path (origin is discarded).
// 3. Reject authority-form path starts: `//host`, `/\host`, and any
//    `/` + backslash/slash pair that survives scrubbing.
// 4. Probe-parse: the final path must not change origin under a URL
//    parse against a fixed fictitious origin.
const PROBE_ORIGIN = 'http://redirect-guard.invalid';

export function safeRedirectTarget(raw: string | undefined): string {
  if (!raw) return '/app';
  const cleaned = raw.replace(/[\x00-\x1f\x7f]/g, '');
  let path = cleaned;
  try {
    const url = new URL(cleaned);
    path = `${url.pathname}${url.search}`;
  } catch {
    // Relative reference — validated as a path below.
  }
  if (!path.startsWith('/') || /^\/[\\\/]/.test(path)) return '/app';
  try {
    if (new URL(path, PROBE_ORIGIN).origin !== PROBE_ORIGIN) return '/app';
  } catch {
    return '/app';
  }
  return path;
}
