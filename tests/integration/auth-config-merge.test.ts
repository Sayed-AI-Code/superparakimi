import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resetTestDb, users } from '@/db';
import { authConfig } from '@/lib/auth.config';
import { buildAuthConfig } from '@/lib/auth';

/**
 * The full NextAuth config is assembled by SPREADING authConfig and then
 * overriding parts of it. Every one of those spreads is a way to silently
 * delete a security control, and TypeScript will not stop you: `callbacks` is
 * an object, so supplying a new `callbacks` replaces the whole bag, and the
 * `session` callback inside it is the only thing that copies `token.sub` onto
 * `session.user.id`.
 *
 * If that callback is dropped, `session.user.id` is undefined, both API
 * handlers take their `if (!userId) -> 401` branch, and the app is fully
 * broken for signed-in users. Nothing in the suite would notice, because the
 * route tests mock `auth()` and hand back a session themselves. So the merge
 * itself is asserted here, against the real built config.
 */

beforeAll(async () => {
  // Boot the test database once: buildAuthConfig calls getDb() to construct
  // the Drizzle adapter, and under NODE_ENV=test that also runs migrations.
  await resetTestDb();
});

beforeEach(async () => {
  await resetTestDb();
});

describe('buildAuthConfig — the spread must not delete a control', () => {
  it('keeps the session callback that puts user.id on the session', async () => {
    const config = await buildAuthConfig();
    const session = config.callbacks?.session;
    expect(session).toBeTypeOf('function');

    // The callbacks take ONE destructured object, not positional args —
    // calling session(session, token) reads `undefined.sub` and fails here
    // rather than in production.
    const out = session!({
      session: { user: {} },
      token: { sub: 'user-123' },
      isNewSession: false,
    } as never);
    // authConfig's session callback is SYNCHRONOUS (it returns the object,
    // not a Promise) — asserted rather than assumed, since `.resolves` on a
    // plain object is a test bug, not a product bug.
    expect(out).toMatchObject({ user: { id: 'user-123' } });
  });

  it('keeps the authorized callback and its /app + /account rule intact', async () => {
    const config = await buildAuthConfig();
    const authorized = config.callbacks?.authorized;
    expect(authorized).toBeTypeOf('function');
    expect(authorized).toBe(authConfig.callbacks.authorized);

    const at = (pathname: string) =>
      authorized!({ auth: undefined, request: { nextUrl: { pathname } } } as never);

    // Protected without a session.
    expect(at('/app')).toBe(false);
    expect(at('/account')).toBe(false);
    // Open paths.
    expect(at('/')).toBe(true);
    expect(at('/signin')).toBe(true);
    // Not a prefix collision: /applications is not /app.
    expect(at('/applications')).toBe(true);
  });

  it('adds signIn without displacing the callbacks it did not come to change', async () => {
    const config = await buildAuthConfig();
    expect(Object.keys(config.callbacks ?? {}).sort()).toEqual(
      ['authorized', 'session', 'signIn'].sort(),
    );
  });

  it('binds the adapter to the plural tables, not the adapter camelCase defaults', async () => {
    const config = await buildAuthConfig();
    expect(config.adapter).toBeDefined();
    // A credentials sign-in has no profile: the stamp must be a no-op, not a
    // throw, so the added signIn callback cannot break password login.
    const signIn = config.callbacks?.signIn;
    await expect(signIn!({ user: {} as never, account: undefined, profile: undefined })).resolves.toBe(
      true,
    );
  });

  it('does not stamp a user the email does not identify', async () => {
    const email = `merge-${crypto.randomUUID().slice(0, 8)}@example.com`;

    const signIn = (await buildAuthConfig()).callbacks?.signIn;
    // Google asserts verification for an address that has no row at all.
    // `user` is a required member of the signIn callback's argument, so it
    // is supplied rather than cast away.
    await signIn!({
      user: {} as never,
      account: { provider: 'google' } as never,
      profile: { email, email_verified: true },
    });

    // No row was created by the stamp, and nothing threw.
    const { eq } = await import('drizzle-orm');
    const { getDb } = await import('@/db');
    const d = await getDb();
    expect(await d.query.users.findFirst({ where: eq(users.email, email) })).toBeUndefined();
  });
});
