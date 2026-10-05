import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, resetTestDb, usageEvents, users } from '@/db';
import { UpstreamUnavailableError } from '@/lib/paraphrase/types';
import type { ParaphraseProvider } from '@/lib/paraphrase/types';
import { beginUsage, check, completeUsage } from '@/lib/quota/quotaService';

// auth() is a module export, so mocking it is the sanctioned session seam.
// The quota service and the database are deliberately NOT mocked: they are
// what these tests exist to verify.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { makeRouteHandler } from '@/app/api/paraphrase/route';

const mockedAuth = vi.mocked(auth);

let userId: string;
let ipSeq = 0;

async function mkUser(): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@t.dev` })
    .returning({ id: users.id });
  return row.id;
}

type Frame = Record<string, unknown>;

/** Every request gets its own IP so the process-local rate limiter's
 * fixed windows never bleed across tests. */
function fakeReq(
  body: unknown,
  opts: { ip?: string; signal?: AbortSignal } = {},
): Request {
  const ip = opts.ip ?? `10.44.${(ipSeq >> 8) & 255}.${++ipSeq & 255}`;
  return new Request('http://localhost/api/paraphrase', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    signal: opts.signal,
  });
}

async function sseFrames(res: Response): Promise<Frame[]> {
  return parseFrames(await res.text());
}

function parseFrames(text: string): Frame[] {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Frame);
}

async function rowsFor(uid: string) {
  const db = await getDb();
  return db.select().from(usageEvents).where(eq(usageEvents.userId, uid));
}

const PAYLOAD = { text: 'hello', mode: 'standard', strength: 'light' };

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTestDb();
  userId = await mkUser();
  mockedAuth.mockResolvedValue({ user: { id: userId, email: 'a@t.dev' } } as never);
});

describe('POST /api/paraphrase — pre-stream JSON errors', () => {
  it('401 without a session, before anything else runs', async () => {
    mockedAuth.mockResolvedValue(null as never);
    let streamed = false;
    const route = makeRouteHandler({
      provider: {
        stream: () => {
          streamed = true;
          return [];
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(streamed).toBe(false);
    expect(await rowsFor(userId)).toHaveLength(0);
  });

  it('422 on an unknown mode, and no usage row', async () => {
    const route = makeRouteHandler({
      provider: { stream: () => ['never'] } as ParaphraseProvider,
    });
    const res = await route.POST(
      fakeReq({ text: 'hello', mode: 'pirate', strength: 'light' }),
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ error: expect.any(String) });
    expect(await rowsFor(userId)).toHaveLength(0);
  });

  it('422 on malformed JSON, and no usage row', async () => {
    const route = makeRouteHandler({
      provider: { stream: () => ['never'] } as ParaphraseProvider,
    });
    const res = await route.POST(fakeReq('{"text":'));
    expect(res.status).toBe(422);
    expect(await rowsFor(userId)).toHaveLength(0);
  });

  it('rejects a padded over-cap body on the wire (byte guard) — 422, no row', async () => {
    let streamed = false;
    const route = makeRouteHandler({
      provider: {
        stream: () => {
          streamed = true;
          return [];
        },
      } as ParaphraseProvider,
    });
    // 60 KB of whitespace + a legal 5-char text: zod trims this to a VALID
    // payload, so only a raw-byte guard can bound it on the wire.
    const padded = `{"text":"${' '.repeat(60_000)}hello","mode":"standard","strength":"light"}`;
    const res = await route.POST(fakeReq(padded));
    expect(res.status).toBe(422);
    expect(streamed).toBe(false);
    expect(await rowsFor(userId)).toHaveLength(0);
  });

  it('accepts legal max-length multibyte payloads (guard sized for UTF-8, not 8KB)', async () => {
    const route = makeRouteHandler({
      provider: { stream: () => ['ok'] } as ParaphraseProvider,
    });
    // Spec-legal input must never be rejected by the guard. 5,000 chars is
    // 15,000 bytes in Devanagari (3 B/char) and 20,000 bytes in emoji
    // (4 B/char) — so an 8 KB guard would break real users.
    for (const text of ['कि'.repeat(5000), '🜀'.repeat(5000)]) {
      const res = await route.POST(
        fakeReq({ text, mode: 'standard', strength: 'light' }),
      );
      expect(res.status).toBe(200);
      expect((await sseFrames(res))[0]).toEqual({ type: 'delta', text: 'ok' });
    }
  });

  it('rejects text over 5,000 chars with 422', async () => {
    const route = makeRouteHandler({
      provider: { stream: () => ['never'] } as ParaphraseProvider,
    });
    const res = await route.POST(
      fakeReq({ text: 'a'.repeat(5001), mode: 'standard', strength: 'light' }),
    );
    expect(res.status).toBe(422);
    expect(await rowsFor(userId)).toHaveLength(0);
  });

  it('429 with {error,limit,used,resetsAt} once 10 are used, and writes no row', async () => {
    for (let i = 0; i < 10; i++) {
      const id = await beginUsage(userId, 10, 'm', 'standard', 'light');
      await completeUsage(id, 9);
    }
    let streamed = false;
    const route = makeRouteHandler({
      provider: {
        stream: () => {
          streamed = true;
          return [];
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: expect.any(String),
      limit: 10,
      used: 10,
      resetsAt: expect.stringMatching(/T00:00:00\.000Z$/),
    });
    expect(streamed).toBe(false);
    expect(await rowsFor(userId)).toHaveLength(10);
  });
});

describe('POST /api/paraphrase — rate limiting is not quota', () => {
  it('429 from checkRate after 30 authed requests in a minute, quota untouched, zero rows', async () => {
    const ip = '203.0.113.7';
    const route = makeRouteHandler({
      // Pre-delta failure: consumes a rate-limit slot but NO quota,
      // so the limiter (30/min) is reachable without quota (10/day) firing.
      provider: {
        stream: async function* () {
          throw new UpstreamUnavailableError('upstream down');
        },
      } as ParaphraseProvider,
    });

    const statuses: number[] = [];
    for (let i = 0; i < 30; i++) {
      const res = await route.POST(fakeReq(PAYLOAD, { ip }));
      statuses.push(res.status);
    }
    expect(statuses).toEqual(new Array(30).fill(502));

    const limited = await route.POST(fakeReq(PAYLOAD, { ip }));
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: expect.any(String), retryAfterSec: expect.any(Number) });
    expect(await rowsFor(userId)).toHaveLength(0);
    expect((await check(userId)).used).toBe(0);
  });

  it('does not count a denied request against the quota or the DB', async () => {
    const st = await check(userId);
    expect(st.used).toBe(0);
    expect(await rowsFor(userId)).toHaveLength(0);
  });
});

describe('POST /api/paraphrase — happy path SSE + first-delta quota', () => {
  it('streams deltas then terminal done{remaining:9}; exactly one completed row', async () => {
    let seenSignal: AbortSignal | null = null;
    const route = makeRouteHandler({
      provider: {
        stream: (_t, _m, _s, signal) => {
          seenSignal = signal;
          return (async function* () {
            yield 'Hello';
            yield ' there';
          })();
        },
      } as ParaphraseProvider,
    });

    const req = fakeReq({ text: 'hello', mode: 'standard', strength: 'light' });
    const res = await route.POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(seenSignal).toBe(req.signal);

    expect(await sseFrames(res)).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ' there' },
      { type: 'done', remaining: 9 },
    ]);

    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 'completed',
      charsIn: 5,
      charsOut: 12,
      mode: 'standard',
      strength: 'light',
    });
    expect((await check(userId)).used).toBe(1);
  });

  it('consumes quota exactly once even for a single-delta stream', async () => {
    const route = makeRouteHandler({
      provider: { stream: () => ['x'] } as ParaphraseProvider,
    });
    const res = await route.POST(fakeReq(PAYLOAD));
    expect(await sseFrames(res)).toEqual([
      { type: 'delta', text: 'x' },
      { type: 'done', remaining: 9 },
    ]);
    expect(await rowsFor(userId)).toHaveLength(1);
  });
});

describe('POST /api/paraphrase — failure paths', () => {
  it('zero-delta upstream failure: 502 JSON, NO usage row, quota unchanged', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          throw new UpstreamUnavailableError('OpenRouter stream ended without any content');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(502);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ error: expect.any(String), correlationId: expect.any(String) });
    expect(await rowsFor(userId)).toHaveLength(0);
    expect((await check(userId)).used).toBe(0);
  });

  it('mid-stream failure after beginUsage: row aborted, quota consumed, error frame last', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          yield 'partial ';
          throw new UpstreamUnavailableError('mid-stream death');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(200);
    const frames = await sseFrames(res);
    expect(frames[0]).toEqual({ type: 'delta', text: 'partial ' });
    expect(frames.at(-1)).toEqual({ type: 'error', message: expect.any(String) });
    expect(frames.some((f) => f.type === 'done')).toBe(false);

    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('aborted');
    expect((await check(userId)).used).toBe(1);
  });

  it('client abort mid-stream: provider sees the request signal, row aborted, quota consumed', async () => {
    const ac = new AbortController();
    let providerSawAbort = false;
    let release: (err: unknown) => void = () => {};
    const gate = new Promise<never>((_resolve, reject) => {
      release = reject;
      ac.signal.addEventListener('abort', () => {
        providerSawAbort = true;
        release(new DOMException('Aborted', 'AbortError'));
      });
    });

    const route = makeRouteHandler({
      provider: {
        stream: (_t, _m, _s, signal) => {
          expect(signal).toBe(ac.signal);
          return (async function* () {
            yield 'first';
            await gate;
            yield 'never';
          })();
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD, { signal: ac.signal }));
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(parseFrames(first)).toEqual([{ type: 'delta', text: 'first' }]);

    ac.abort();

    const tail = decoder.decode((await reader.read()).value);
    expect(parseFrames(tail).at(-1)).toEqual({ type: 'error', message: expect.any(String) });

    expect(providerSawAbort).toBe(true);
    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('aborted');
    expect((await check(userId)).used).toBe(1);
  });

  it('an unexpected (non-abort) mid-stream throw aborts the row and closes cleanly', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          yield 'partial';
          throw new Error('boom');
        },
      } as ParaphraseProvider,
    });
    const res = await route.POST(fakeReq(PAYLOAD));
    const frames = await sseFrames(res);
    expect(frames.at(-1)).toEqual({ type: 'error', message: expect.any(String) });
    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('aborted');
  });

  it('a pre-delta non-abort-shaped throw is still reported as 502, not a cancellation', async () => {
    const ac = new AbortController();
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          throw new TypeError('socket hang up');
        },
      } as ParaphraseProvider,
    });
    const res = await route.POST(fakeReq(PAYLOAD, { signal: ac.signal }));
    expect(res.status).toBe(502);
    expect(await rowsFor(userId)).toHaveLength(0);
  });
});
