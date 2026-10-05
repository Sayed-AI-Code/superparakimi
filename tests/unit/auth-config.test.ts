import { describe, expect, it } from 'vitest';

import { authConfig } from '@/lib/auth.config';

type AuthorizedArg = Parameters<NonNullable<typeof authConfig.callbacks.authorized>>[0];

// authorized() is the only authorization decision proxy.ts makes; the
// framework turns a `false` here into the /signin?callbackUrl=… redirect.
// Exercised directly so the rule is pinned without booting a proxy runtime.
function authorized(pathname: string, hasUser: boolean): boolean {
  const arg = {
    auth: hasUser ? { user: { id: 'u1' }, expires: '' } : null,
    request: { nextUrl: { pathname } },
  } as unknown as AuthorizedArg;
  // Callbacks may return a Response; here it is always a boolean.
  return authConfig.callbacks.authorized?.(arg) as boolean;
}

describe('proxy redirect rule (authorized callback)', () => {
  it('blocks unauthenticated access to /app/** and /account/**', () => {
    expect(authorized('/app', false)).toBe(false);
    expect(authorized('/app/', false)).toBe(false);
    expect(authorized('/app/editor', false)).toBe(false);
    expect(authorized('/account', false)).toBe(false);
    expect(authorized('/account/billing', false)).toBe(false);
  });

  it('allows authenticated access to protected routes', () => {
    expect(authorized('/app/editor', true)).toBe(true);
    expect(authorized('/account/billing', true)).toBe(true);
  });

  it('leaves public routes open to everyone', () => {
    for (const hasUser of [false, true]) {
      expect(authorized('/', hasUser)).toBe(true);
      expect(authorized('/signin', hasUser)).toBe(true);
      expect(authorized('/signup', hasUser)).toBe(true);
      // Prefix look-alikes must NOT be treated as protected.
      expect(authorized('/application', hasUser)).toBe(true);
      expect(authorized('/accounting', hasUser)).toBe(true);
    }
  });
});
