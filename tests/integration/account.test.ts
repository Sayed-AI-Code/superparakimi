import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, resetTestDb, users } from '@/db';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';

// auth() is a module export, so mocking it is the sanctioned session seam —
// same pattern as tests/integration/usage-route.test.ts. The database and the
// password module stay REAL: the point of this file is that the persisted
// bcrypt hash is what actually changes.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { setPassword } from '@/lib/account/actions';

const mockedAuth = vi.mocked(auth);

const OWNER_EMAIL = 'owner@example.com';
const OTHER_EMAIL = 'intruder@example.com';
const PASSWORD = 'hunter2-horse';
const NEW_PASSWORD = 'correct-horse-battery';

async function makeUser(
  email: string,
  password: string | null,
): Promise<{ id: string; email: string }> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash: password })
    .returning({ id: users.id, email: users.email });
  return row;
}

async function hashOf(id: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.query.users.findFirst({
    where: eq(users.id, id),
    columns: { passwordHash: true },
  });
  return row?.passwordHash ?? null;
}

function signInAs(user: { id: string; email: string }) {
  mockedAuth.mockResolvedValue({ user } as never);
}

let owner: { id: string; email: string };
let ownerHash: string;

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTestDb();
  ownerHash = await hashPassword(PASSWORD);
  owner = await makeUser(OWNER_EMAIL, ownerHash);
  signInAs(owner);
});

describe('setPassword — change password on an account that has a hash', () => {
  it('rejects a wrong current password and leaves the stored hash untouched', async () => {
    const result = await setPassword(owner.id, {
      current: 'totally-wrong-password',
      next: NEW_PASSWORD,
    });

    expect(result).toEqual({ error: expect.any(String) });
    expect(await hashOf(owner.id)).toBe(ownerHash);
    expect(await verifyPassword(NEW_PASSWORD, await hashOf(owner.id))).toBe(false);
  });

  it('rejects a missing current password and leaves the stored hash untouched', async () => {
    const result = await setPassword(owner.id, { current: '', next: NEW_PASSWORD });

    expect(result).toEqual({ error: expect.any(String) });
    expect(await hashOf(owner.id)).toBe(ownerHash);
  });

  it('rejects a new password shorter than 8 characters, with the spec wording', async () => {
    const result = await setPassword(owner.id, {
      current: PASSWORD,
      next: 'short',
    });

    // Asserted against the spec'd literal, not a constant in the module that
    // produced it, so renaming the message cannot silently regress the copy.
    expect(result).toEqual({ error: 'Password must be at least 8 characters' });
    expect(await hashOf(owner.id)).toBe(ownerHash);
  });

  it('accepts exactly 8 characters and persists a new bcrypt cost-12 hash', async () => {
    const eight = 'abcdefgh';
    expect(await setPassword(owner.id, { current: PASSWORD, next: eight })).toEqual({
      ok: true,
    });

    const stored = await hashOf(owner.id);
    expect(stored).not.toBe(ownerHash);
    expect(stored?.split('$')[2]).toBe('12');
    expect(await verifyPassword(eight, stored)).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
  });

  it('updates the persisted hash on success (verified through verifyPassword, not the return value)', async () => {
    expect(await setPassword(owner.id, { current: PASSWORD, next: NEW_PASSWORD })).toEqual({
      ok: true,
    });

    const stored = await hashOf(owner.id);
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(NEW_PASSWORD);
    expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true);
    expect(await verifyPassword(PASSWORD, stored)).toBe(false);
  });

  it('never returns the hash or either password in the result', async () => {
    const result = await setPassword(owner.id, { current: PASSWORD, next: NEW_PASSWORD });
    const text = JSON.stringify(result);

    expect(text).not.toContain(NEW_PASSWORD);
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toMatch(/\$2[aby]\$/);
  });

  it('persists a well-formed bcrypt digest that is not derived from the plaintext visibly', async () => {
    // Pins the shape of what actually lands in password_hash: a cost-12
    // bcrypt digest, 60 chars, with no visible copy of the password inside
    // it. ASCII so the expected length is exact — bcryptjs counts cost and
    // salt in the prefix and the digest is fixed-size.
    const ascii = 'PlainAscii99';
    expect(await setPassword(owner.id, { current: PASSWORD, next: ascii })).toEqual({ ok: true });

    const stored = await hashOf(owner.id);
    expect(stored).toMatch(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/);
    expect(stored).not.toContain(ascii);
    expect(await verifyPassword(ascii, stored)).toBe(true);
  });
});

describe('setPassword — first password on a NULL-hash (Google-only) account', () => {
  it('succeeds with an empty current password and stores a verifiable hash', async () => {
    const googleOnly = await makeUser('google-only@example.com', null);
    signInAs(googleOnly);
    expect(await hashOf(googleOnly.id)).toBeNull();

    expect(await setPassword(googleOnly.id, { current: '', next: NEW_PASSWORD })).toEqual({
      ok: true,
    });

    const stored = await hashOf(googleOnly.id);
    expect(stored).toBeTruthy();
    expect(stored?.split('$')[2]).toBe('12');
    expect(await verifyPassword(NEW_PASSWORD, stored)).toBe(true);
  });

  it('ignores a filled-in current password on a NULL-hash account (nothing to check)', async () => {
    const googleOnly = await makeUser('autofill@example.com', null);
    signInAs(googleOnly);

    // No stored secret exists to compare against, so demanding a match here
    // would make the required first-set path impossible for any browser that
    // autofills the field.
    expect(await setPassword(googleOnly.id, { current: 'junk', next: NEW_PASSWORD })).toEqual({
      ok: true,
    });
    expect(await verifyPassword(NEW_PASSWORD, await hashOf(googleOnly.id))).toBe(true);
  });

  it('still enforces the 8-character floor on the first-set path', async () => {
    const googleOnly = await makeUser('weak-first-set@example.com', null);
    signInAs(googleOnly);

    expect(await setPassword(googleOnly.id, { current: '', next: 'short' })).toEqual({
      error: 'Password must be at least 8 characters',
    });
    expect(await hashOf(googleOnly.id)).toBeNull();
  });
});

describe('setPassword — the action, not the page, is the authorization boundary', () => {
  it('refuses to change another user password when the session belongs to someone else', async () => {
    const victim = await makeUser(OTHER_EMAIL, await hashPassword(PASSWORD));
    const victimHash = await hashOf(victim.id);
    signInAs(owner);

    const result = await setPassword(victim.id, {
      current: PASSWORD,
      next: NEW_PASSWORD,
    });

    expect(result).toEqual({ error: expect.any(String) });
    expect(await hashOf(victim.id)).toBe(victimHash);
    expect(await verifyPassword(NEW_PASSWORD, await hashOf(victim.id))).toBe(false);
  });

  it('refuses to set a first password for another NULL-hash user', async () => {
    const victim = await makeUser('victim-google@example.com', null);
    signInAs(owner);

    expect(await setPassword(victim.id, { current: '', next: NEW_PASSWORD })).toEqual({
      error: expect.any(String),
    });
    expect(await hashOf(victim.id)).toBeNull();
  });

  it('refuses an anonymous caller and stores nothing', async () => {
    mockedAuth.mockResolvedValue(null as never);

    const result = await setPassword(owner.id, { current: PASSWORD, next: NEW_PASSWORD });

    expect(result).toEqual({ error: expect.any(String) });
    expect(await hashOf(owner.id)).toBe(ownerHash);
  });

  it('refuses a session with no user id', async () => {
    mockedAuth.mockResolvedValue({ user: {} } as never);

    expect(await setPassword(owner.id, { current: PASSWORD, next: NEW_PASSWORD })).toEqual({
      error: expect.any(String),
    });
    expect(await hashOf(owner.id)).toBe(ownerHash);
  });

  it('rejects a malformed userId before touching the database, and does not 500', async () => {
    // A malformed uuid makes Postgres throw 22P02; the action must translate
    // that into a {error} result rather than an unhandled rejection.
    const result = await setPassword('not-a-uuid', {
      current: PASSWORD,
      next: NEW_PASSWORD,
    });

    expect(result).toEqual({ error: expect.any(String) });
  });
});
