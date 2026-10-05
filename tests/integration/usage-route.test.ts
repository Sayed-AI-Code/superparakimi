import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb, resetTestDb, users } from '@/db';
import { ANON_LIMIT_60S, RATE_LIMIT_MESSAGE } from '@/lib/ratelimit';
import { FREE_DAILY_LIMIT } from '@/lib/quota/quotaService';

// auth() is a module export, so mocking it is the sanctioned session seam —
// same pattern as tests/integration/paraphrase-route.test.ts. The quota
// service and database are deliberately NOT mocked: the point of this file is
// that the endpoint reports real quota state.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { GET } from '@/app/api/usage/route';

const mockedAuth = vi.mocked(auth);

/**
 * Every call here presents a different client IP, on purpose. This suite tests
 * quota reporting, not the per-IP brake; a dozen calls from one simulated
 * visitor would exhaust that visitor's anonymous budget and answer 429 before
 * the assertion actually under test could run. The brake is pinned in
 * tests/unit/ratelimit.test.ts and by the anonymous-429 test at the bottom of
 * this file, which reuses one IP deliberately.
 */
function apiReq(): Request {
  return new Request('http://localhost/api/usage', {
    headers: { 'x-forwarded-for': `203.0.113.${crypto.randomUUID().slice(0, 7)}` },
  });
}

let userId: string;

async function mkUser(): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@t.dev` })
    .returning({ id: users.id });
  return row.id;
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTestDb();
  userId = await mkUser();
  mockedAuth.mockResolvedValue({ user: { id: userId, email: 'a@t.dev' } } as never);
});

describe('GET /api/usage', () => {
  it('401 with a JSON body when anonymous — never a redirect', async () => {
    mockedAuth.mockResolvedValue(null as never);
    const res = await GET(apiReq());

    expect(res.status).toBe(401);
    // A redirect here would turn an API call into an HTML sign-in page.
    expect([301, 302, 303, 307, 308]).not.toContain(res.status);
    expect(res.redirected ?? false).toBe(false);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });

  it('401 when a session exists but carries no user id', async () => {
    mockedAuth.mockResolvedValue({ user: {} } as never);
    const res = await GET(apiReq());
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('reports the fresh-user shape {used:0, limit:10, remaining:10}', async () => {
    const res = await GET(apiReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      used: 0,
      limit: FREE_DAILY_LIMIT,
      remaining: FREE_DAILY_LIMIT,
      resetsAt: expect.any(String),
    });
    expect(FREE_DAILY_LIMIT).toBe(10);
  });

  it('resetsAt is a UTC instant on the wire (Z suffix), not a local string', async () => {
    const body = (await GET(apiReq()).then((r) => r.json())) as { resetsAt: string };
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(body.resetsAt))).toBe(false);
  });

  it('counts a consumed-but-still-streaming request against the limit', async () => {
    const { beginUsage } = await import('@/lib/quota/quotaService');
    await beginUsage(userId, 12, 'openai/gpt-4o-mini', 'standard', 'light');

    const body = (await GET(apiReq()).then((r) => r.json())) as Record<string, unknown>;
    expect(body).toMatchObject({ used: 1, remaining: FREE_DAILY_LIMIT - 1 });
  });

  it('reaches remaining:0 after the limit is consumed, and allowed flips off', async () => {
    const { beginUsage, check } = await import('@/lib/quota/quotaService');
    for (let i = 0; i < FREE_DAILY_LIMIT; i++) {
      await beginUsage(userId, 5, 'openai/gpt-4o-mini', 'formal', 'strong');
    }

    const body = (await GET(apiReq()).then((r) => r.json())) as Record<string, number>;
    expect(body.used).toBe(FREE_DAILY_LIMIT);
    expect(body.remaining).toBe(0);
    // The endpoint never claims more headroom than the quota service has.
    const quota = await check(userId);
    expect(quota.allowed).toBe(false);
    expect(quota.limit - quota.used).toBe(body.remaining);
  });

  // The brake is wired into THIS route, not just into lib/ratelimit: an
  // anonymous caller is refused before the 401 gate can be farmed for free.
  it('answers 429 with retry-after once an anonymous IP spends its minute here', async () => {
    mockedAuth.mockResolvedValue(null as never);
    const ip = '198.51.100.77';
    const req = () =>
      new Request('http://localhost/api/usage', { headers: { 'x-forwarded-for': ip } });

    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      // Anonymous, so the route's own answer is 401 — the point is that the
      // limiter let it through to get that answer.
      expect((await GET(req())).status).toBe(401);
    }

    const blocked = await GET(req());
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('content-type')).toBe('application/json');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(blocked.json()).resolves.toMatchObject({ error: RATE_LIMIT_MESSAGE });
  });
});
