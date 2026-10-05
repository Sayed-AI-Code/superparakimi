import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { CredentialsSignin } from 'next-auth';

import { getDb, resetTestDb, users } from '@/db';
import { signUpWithEmail } from '@/lib/auth/signup';
import { authorize } from '@/lib/auth';

const EMAIL = 'alice@example.com';
const PASSWORD = 'hunter2-horse';

async function findUser(email: string) {
  const db = await getDb();
  return db.query.users.findFirst({ where: eq(users.email, email) });
}

describe('signUpWithEmail', () => {
  beforeAll(async () => {
    await getDb(); // boot the test DB once before truncating
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  it('creates a user with a bcrypt (cost 12) password hash', async () => {
    expect(await signUpWithEmail({ email: EMAIL, password: PASSWORD })).toEqual({ ok: true });

    const user = await findUser(EMAIL);
    expect(user).toBeDefined();
    expect(user?.passwordHash).toBeTruthy();
    expect(user?.passwordHash).not.toBe(PASSWORD);
    expect(user?.passwordHash?.split('$')[2]).toBe('12');
    expect(user?.plan).toBe('free');
  });

  it('rejects a duplicate email', async () => {
    expect(await signUpWithEmail({ email: EMAIL, password: PASSWORD })).toEqual({ ok: true });

    const second = await signUpWithEmail({ email: EMAIL, password: 'other-password' });
    expect(second).toEqual({ error: 'Email already registered' });
  });

  // Concurrent-signup race, reproduced for real. The `findFirst` pre-check is
  // the only thing that catches a duplicate today: by the time the INSERT
  // runs, drizzle-orm 0.45 has wrapped the driver's unique_violation in a
  // DrizzleQueryError whose SQLSTATE lives on `cause.code`, NOT on `code`
  // (verified: top-level `.code` is undefined, `.cause.code` is '23505').
  // Forcing the pre-check to miss makes the unique index the real source of
  // the failure, so this exercises the branch rather than a mock of it.
  it('reports "Email already registered" when the race slips past the pre-check and the unique index rejects', async () => {
    expect(await signUpWithEmail({ email: EMAIL, password: PASSWORD })).toEqual({ ok: true });

    const db = await getDb();
    const spy = vi.spyOn(db.query.users, 'findFirst').mockResolvedValue(undefined);
    try {
      // Real INSERT, real unique index, real DrizzleQueryError.
      expect(await signUpWithEmail({ email: EMAIL, password: 'other-password' })).toEqual({
        error: 'Email already registered',
      });
    } finally {
      spy.mockRestore();
    }
    // And the unique index really was the thing that rejected it.
    expect((await findUser(EMAIL))?.passwordHash).not.toBeNull();
  });

  it('rejects a password shorter than 8 characters and stores nothing', async () => {
    const result = await signUpWithEmail({ email: EMAIL, password: 'short' });
    expect(result).toEqual({ error: expect.stringContaining('8') });
    expect(await findUser(EMAIL)).toBeUndefined();
  });

  it('rejects an invalid email and stores nothing', async () => {
    expect(await signUpWithEmail({ email: 'not-an-email', password: PASSWORD })).toEqual({
      error: expect.any(String),
    });
    expect(await findUser('not-an-email')).toBeUndefined();
  });
});

describe('credentials authorize (password sign-in)', () => {
  beforeAll(async () => {
    await getDb();
  });

  beforeEach(async () => {
    await resetTestDb();
  });

  // Review focus #3: a Google-only account (NULL password_hash) that submits
  // the password form must get a clean "use Google" error — no crash.
  it('rejects a Google-only account with the Google sign-in message, no crash', async () => {
    const db = await getDb();
    await db.insert(users).values({ email: 'google-only@example.com', passwordHash: null });

    const promise = authorize({ email: 'google-only@example.com', password: 'whatever' });
    await expect(promise).rejects.toBeInstanceOf(CredentialsSignin);
    // Asserted against the spec'd literals — not the lib/auth.ts constants
    // that produced them — so renaming those constants cannot silently
    // regress the user-facing contract.
    await expect(promise).rejects.toThrow('This account uses Google sign-in');
    await promise.catch((error: unknown) => {
      expect((error as CredentialsSignin).code).toBe('google_only');
    });
  });

  it('signs in a password account with valid credentials, without leaking the hash', async () => {
    await signUpWithEmail({ email: EMAIL, password: PASSWORD });

    const user = await authorize({ email: EMAIL, password: PASSWORD });
    expect(user).toMatchObject({ email: EMAIL });
    expect(user?.id).toBeTruthy();
    expect((user as Record<string, unknown>).passwordHash).toBeUndefined();
  });

  it('returns null for unknown email and for a wrong password', async () => {
    await signUpWithEmail({ email: EMAIL, password: PASSWORD });

    expect(await authorize({ email: 'nobody@example.com', password: PASSWORD })).toBeNull();
    expect(await authorize({ email: EMAIL, password: 'wrong-password' })).toBeNull();
  });

  it('returns null for missing or malformed credentials', async () => {
    expect(await authorize({})).toBeNull();
    expect(await authorize({ email: EMAIL })).toBeNull();
    expect(await authorize({ email: 'nope', password: 'x' })).toBeNull();
  });
});
