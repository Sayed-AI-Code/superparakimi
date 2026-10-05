// Sanitizes a user-supplied redirect target to a same-origin path.
// callbackUrl arrives from the proxy (absolute, same-origin href) or a
// crafted link. Absolute URLs are flattened to their path (origin is
// discarded); everything else must be a plain path.
//
// Rejects every authority-form start: `//host`, `/\host`, and their
// variants. The WHATWG URL parser treats `\` as `/` for special schemes,
// so `/\evil.com` resolves to `https://evil.com/` in browsers despite
// passing a plain startsWith('//') check — hence the regex on the first
// two characters.
export function safeRedirectTarget(raw: string | undefined): string {
  if (!raw) return '/app';
  let path = raw;
  try {
    const url = new URL(raw);
    path = `${url.pathname}${url.search}`;
  } catch {
    // Not absolute — validate as a path below.
  }
  if (!path.startsWith('/') || /^\/[\\\/]/.test(path)) return '/app';
  return path;
}
