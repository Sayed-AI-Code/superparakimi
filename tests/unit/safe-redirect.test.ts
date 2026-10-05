import { describe, expect, it } from 'vitest';

import { safeRedirectTarget } from '@/lib/auth/redirect';

// Review finding (Critical): the signin callbackUrl sanitizer must reject
// every authority-form open redirect — including /\host, which passes a
// startsWith('//') check but resolves to another origin (WHATWG URL parses
// '\' as '/' for special schemes).
describe('safeRedirectTarget', () => {
  it('keeps plain same-origin paths, with or without query', () => {
    expect(safeRedirectTarget('/app/editor')).toBe('/app/editor');
    expect(safeRedirectTarget('/account?tab=usage')).toBe('/account?tab=usage');
    expect(safeRedirectTarget('/')).toBe('/');
  });

  it('flattens absolute same-origin URLs (as the proxy sends them) to paths', () => {
    expect(safeRedirectTarget('https://app.example.com/app/editor')).toBe('/app/editor');
    // Any origin is discarded on absolute URLs, so an evil host also lands
    // on a same-origin path.
    expect(safeRedirectTarget('https://evil.com/stolen')).toBe('/stolen');
  });

  it('rejects authority-form open redirects', () => {
    expect(safeRedirectTarget('//evil.com')).toBe('/app');
    // The reviewer's vector: '/' + backslash.
    expect(safeRedirectTarget('/\\evil.com')).toBe('/app');
    expect(safeRedirectTarget('\\/evil.com')).toBe('/app');
    expect(safeRedirectTarget('\\\\evil.com')).toBe('/app');
    expect(safeRedirectTarget('/\\/evil.com')).toBe('/app');
  });

  it('never returns a value a browser can resolve off-origin', () => {
    const origin = 'https://app.example.com';
    const vectors = [
      '/app',
      '/\\evil.com',
      '/\\\\evil.com',
      '//evil.com',
      '\\evil.com',
      'https://evil.com/x',
      'javascript:alert(1)',
      '/%5Cevil.com',
      '',
      '   ',
      undefined,
    ];
    for (const v of vectors) {
      const out = safeRedirectTarget(v);
      expect(out, `vector ${JSON.stringify(v)} → ${out}`).not.toBe('');
      const resolved = new URL(out, origin);
      expect(resolved.origin, `vector ${JSON.stringify(v)} escapes origin`).toBe(origin);
      expect(out.startsWith('/'), `vector ${JSON.stringify(v)} is not a path`).toBe(true);
    }
  });

  it('falls back to /app for empty or missing input', () => {
    expect(safeRedirectTarget(undefined)).toBe('/app');
    expect(safeRedirectTarget('')).toBe('/app');
  });
});
