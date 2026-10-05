import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DrizzleQueryError } from 'drizzle-orm';

// `@/db` is mocked here on purpose: this file is not about Postgres, it is
// about which shape signUpWithEmail reads the SQLSTATE from. The real-Postgres
// reproduction of the same race lives in
// tests/integration/signup.test.ts — this pins the shapes deterministically,
// including the legacy top-level `code` form.
vi.mock('@/db', () => ({
  getDb: vi.fn(),
  users: { email: 'email' },
}));

import { getDb } from '@/db';
import { signUpWithEmail } from '@/lib/auth/signup';

const EMAIL = 'race@example.com';
const PASSWORD = 'hunter2-horse';
const HASH = '$2b$12$abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmn';

// A driver error is what actually carries the SQLSTATE; drizzle re-wraps it.
function driverError(code: string): Error {
  return Object.assign(new Error('duplicate key value violates unique constraint'), { code });
}

// Verbatim drizzle-orm 0.45 wrapper: message/query/params carry credentials,
// SQLSTATE on `cause.code`, top-level `code` undefined.
function wrapped(code: string): Error {
  return new DrizzleQueryError(
    `insert into "users" ("email", "password_hash") values ($1, $2)`,
    [EMAIL, HASH],
    driverError(code),
  );
}

const mockedGetDb = vi.mocked(getDb);

function dbRejecting(error: unknown) {
  const values = vi.fn().mockRejectedValue(error);
  const onConflict = vi.fn();
  mockedGetDb.mockResolvedValue({
    query: { users: { findFirst: vi.fn().mockResolvedValue(undefined) } },
    insert: () => ({ values: () => values().then(() => onConflict()) }),
  } as never);
  return values;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('signUpWithEmail duplicate-key handling (SQLSTATE location)', () => {
  it('reads the SQLSTATE from cause.code — the shape drizzle actually throws', async () => {
    dbRejecting(wrapped('23505'));

    expect(await signUpWithEmail({ email: EMAIL, password: PASSWORD })).toEqual({
      error: 'Email already registered',
    });
  });

  it('still reads a top-level code (raw driver error, unwrapped)', async () => {
    dbRejecting(driverError('23505'));

    expect(await signUpWithEmail({ email: EMAIL, password: PASSWORD })).toEqual({
      error: 'Email already registered',
    });
  });

  it('rethrows a different SQLSTATE rather than calling it a duplicate', async () => {
    dbRejecting(wrapped('23503'));

    await expect(signUpWithEmail({ email: EMAIL, password: PASSWORD })).rejects.toThrow();
  });

  it('rethrows an error with no SQLSTATE at all', async () => {
    dbRejecting(new Error('connection reset'));

    await expect(signUpWithEmail({ email: EMAIL, password: PASSWORD })).rejects.toThrow(
      'connection reset',
    );
  });

  it('never puts the email or the hash in the error it surfaces', async () => {
    dbRejecting(wrapped('23505'));

    const result = await signUpWithEmail({ email: EMAIL, password: PASSWORD });
    expect(JSON.stringify(result)).not.toContain(EMAIL);
    expect(JSON.stringify(result)).not.toMatch(/\$2[aby]\$/);
  });
});
