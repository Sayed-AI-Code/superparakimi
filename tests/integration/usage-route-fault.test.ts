import { beforeEach, describe, expect, it, vi } from 'vitest';

// This file exists because tests/integration/usage-route.test.ts promises the
// quota service is NOT mocked — that file proves the endpoint reports real
// quota state. Proving the route-level catch needs the opposite: a genuinely
// rejected `check()`. Splitting the two keeps both premises honest.
//
// `importOriginal` keeps FREE_DAILY_LIMIT, beginUsage, completeUsage and
// abortUsage real. Only `check` is forced to fail, and only in this file.
vi.mock('@/lib/quota/quotaService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/quota/quotaService')>();
  return { ...actual, check: vi.fn() };
});

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { check } from '@/lib/quota/quotaService';
import { GET } from '@/app/api/usage/route';

const mockedAuth = vi.mocked(auth);
const mockedCheck = vi.mocked(check);

// Shaped like the leak this route must never emit: a drizzle query wrapper
// whose message, query and params all carry the email and the bcrypt hash.
const LEAKY_EMAIL = 'victim@example.com';
const LEAKY_HASH = '$2b$10$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRST0123456789abcdef';

function leakyDrizzleError(): Error {
  const cause = Object.assign(new Error('error: duplicate key value'), {
    code: '23505',
    stack: 'Error: error: duplicate key value\n    at PostgresClient.query',
  });
  const error = new Error(
    `Failed query: insert into "users" ("email") values ('${LEAKY_EMAIL}') returning "password_hash"\nparams: ${LEAKY_HASH}`,
  );
  (error as Error & { query: string }).query =
    `insert into "users" ("email", "password_hash") values ('${LEAKY_EMAIL}', '${LEAKY_HASH}')`;
  (error as Error & { params: unknown[] }).params = [LEAKY_EMAIL, LEAKY_HASH];
  error.cause = cause;
  return error;
}

/** Everything the route handed to console.error, as one string to assert on. */
let logged: () => string;

beforeEach(() => {
  vi.restoreAllMocks();
  mockedAuth.mockResolvedValue({ user: { id: 'u-1', email: LEAKY_EMAIL } } as never);
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  logged = () => spy.mock.calls.map((call) => String(call[0])).join('\n');
});

describe('GET /api/usage — route-level catch (spec §7)', () => {
  it('turns a rejected check() into 500 + correlationId, never a raw throw', async () => {
    mockedCheck.mockRejectedValue(leakyDrizzleError());

    const res = await GET();

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
  });

  it('leaks no email, hash, query or params in the 500 body', async () => {
    mockedCheck.mockRejectedValue(leakyDrizzleError());

    const text = await (await GET()).text();

    expect(text).not.toContain(LEAKY_EMAIL);
    expect(text).not.toContain(LEAKY_HASH);
    expect(text).not.toMatch(/\$2[aby]\$/);
    expect(text).not.toMatch(/insert into|params:/i);
  });

  it('logs the same correlationId the client received — the seam must join', async () => {
    mockedCheck.mockRejectedValue(leakyDrizzleError());

    const body = await (await GET()).json();

    expect(logged()).toContain(body.correlationId as string);
  });

  it('logs no credential even when the error is full of them, keeps diagnostics', async () => {
    mockedCheck.mockRejectedValue(leakyDrizzleError());

    await GET();

    const text = logged();
    expect(text).not.toContain(LEAKY_EMAIL);
    expect(text).not.toContain(LEAKY_HASH);
    expect(text).not.toMatch(/insert into|params:/i);
    // Redaction that discards everything is not debuggable either.
    expect(text).toContain('23505');
    expect(text).toContain('usage.read.failed');
  });

  it('catches an unexpected throw from auth() too, not just from check()', async () => {
    mockedCheck.mockResolvedValue({ allowed: true, used: 0, limit: 10, resetsAt: 'x' });
    mockedAuth.mockRejectedValue(new Error('adapter exploded'));

    const res = await GET();

    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty('correlationId');
  });

  it('renders remaining 0 for the documented used=11 blow-by, never -1', async () => {
    // quotaService accepts a race where two concurrent first deltas both
    // insert, so used can pass limit. The count overcounts; the display lies.
    mockedCheck.mockResolvedValue({
      allowed: false,
      used: 11,
      limit: 10,
      resetsAt: '2026-03-15T05:30:31.000Z',
    });

    const body = await (await GET()).json();

    expect(body.used).toBe(11);
    expect(body.limit).toBe(10);
    expect(body.remaining).toBe(0);
  });
});
