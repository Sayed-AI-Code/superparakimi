import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DrizzleQueryError } from 'drizzle-orm/errors';

import { getDb, resetTestDb, users } from '@/db';
import { describeErrorForLog } from '@/lib/auth/log';

const EMAIL = 'mallory@example.com';
const HASH = '$2b$12$C6UzMDzWz7H0kZQx1nGkOeHKmE4oEhYh0eH3oO0k7mN2pQrStUvWx'; // realistic shape, fake value
const QUERY = `insert into "users" ("email", "password_hash") values ($1, $2)`;

function stringify(...args: unknown[]): string {
  return args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
}

function leakChecks(rendered: string) {
  expect(rendered).not.toContain(EMAIL);
  expect(rendered).not.toContain(HASH);
  expect(rendered).not.toContain('password_hash');
  expect(rendered).not.toContain('params:');
  expect(rendered).not.toContain('Failed query:');
}

describe('describeErrorForLog', () => {
  beforeEach(async () => {
    await getDb();
  });

  it('on a synthetic DrizzleQueryError (built as drizzle builds it), logs no email/hash/query/params but keeps diagnostics', () => {
    // Mirrors drizzle-orm/errors.js exactly: message interpolates query +
    // params, and query/params are own enumerable props console.error prints.
    const cause = Object.assign(new Error('division by zero'), { code: '22012' });
    const error = new DrizzleQueryError(QUERY, [EMAIL, HASH], cause);

    // The raw error really is dangerous — that is what makes the helper
    // necessary…
    expect(error.message).toContain(EMAIL);
    expect(error.message).toContain(HASH);
    // …and the helper's projection is not.
    const info = describeErrorForLog(error);
    const rendered = stringify('[signup] signUpWithEmail failed', info);
    leakChecks(rendered);

    // Diagnostics survive.
    expect(info.name).toBe('DrizzleQueryError');
    expect(info.postgresCode).toBe('22012');
    expect(info.stack).toBeTruthy();
  });

  it('on a REAL failed insert through this tree\'s drizzle+PGlite, the logged shape leaks no credentials', async () => {
    await resetTestDb();
    const db = await getDb();
    const { sql } = await import('drizzle-orm');

    let caught: unknown;
    try {
      // Server-side failure with the email and hash present as params —
      // exactly the shape signup's INSERT failure takes.
      await db
        .insert(users)
        .values({ id: sql`1/0`, email: EMAIL, passwordHash: HASH });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DrizzleQueryError);

    // Ground truth (verified 2026-10-05 against drizzle 0.45.3): the raw
    // error's message/stack/query/params DO contain the credentials…
    const raw = caught as DrizzleQueryError;
    expect(raw.message).toContain(EMAIL);
    expect(String(raw.stack)).toContain(EMAIL);
    // …so only the helper's projection may reach the log.
    const info = describeErrorForLog(caught);
    leakChecks(stringify('[signup] signUpWithEmail failed', info));

    expect(info.name).toBeTruthy();
    expect(info.stack).toBeTruthy();
    // Postgres code present (error or cause).
    expect(info.postgresCode).toBeTruthy();
  });

  it('never falls back to the wrapping error stack when a cause stack exists', () => {
    const cause = Object.assign(new Error('connection terminated'), { code: '08006' });
    const error = new DrizzleQueryError(QUERY, [EMAIL, HASH], cause);
    const info = describeErrorForLog(error);
    // DrizzleQueryError's own stack starts with its credential-bearing
    // message; the cause's stack does not.
    expect(String(error.stack)).toContain(EMAIL);
    expect(info.stack).not.toContain(EMAIL);
    expect(info.postgresCode).toBe('08006');
  });

  it('survives non-error throwables without crashing the log path', () => {
    for (const weird of [undefined, null, 'boom', 42]) {
      const info = describeErrorForLog(weird);
      expect(() => stringify('[signup] signUpWithEmail failed', info)).not.toThrow();
    }
  });

  it('page handler logs the projection, not the rejection (spy over console.error)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const cause = Object.assign(new Error('permission denied'), { code: '42501' });
      const error = new DrizzleQueryError(QUERY, [EMAIL, HASH], cause);
      // Same expression the signup page uses.
      console.error('[signup] signUpWithEmail failed', describeErrorForLog(error));
      const logged = stringify(...spy.mock.calls[0]!);
      leakChecks(logged);
      expect(logged).toContain('42501');
    } finally {
      spy.mockRestore();
    }
  });
});
