import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, resetTestDb, usageEvents, users } from '@/db';
import { UpstreamUnavailableError } from '@/lib/paraphrase/types';
import type { ParaphraseProvider } from '@/lib/paraphrase/types';
import { check } from '@/lib/quota/quotaService';

vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

import { auth } from '@/lib/auth';
import { makeRouteHandler } from '@/app/api/paraphrase/route';

const mockedAuth = vi.mocked(auth);

/** Spec §7, quoted verbatim — the PRE-STREAM (unbilled) 502 copy. */
const SPEC_UNBILLED_COPY = "Service hiccup — didn't count against your limit";

let userId: string;
let ipSeq = 0;
let errorLog: Array<Record<string, unknown>>;

async function mkUser(): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@t.dev` })
    .returning({ id: users.id });
  return row.id;
}

function fakeReq(
  body: unknown,
  opts: { ip?: string; signal?: AbortSignal } = {},
): Request {
  const ip = opts.ip ?? `10.99.${(ipSeq >> 8) & 255}.${++ipSeq & 255}`;
  return new Request('http://localhost/api/paraphrase', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
}

function parseFrames(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>);
}

async function rowsFor(uid: string) {
  const db = await getDb();
  return db.select().from(usageEvents).where(eq(usageEvents.userId, uid));
}

const PAYLOAD = { text: 'hello', mode: 'standard', strength: 'light' };

beforeEach(async () => {
  vi.restoreAllMocks();
  errorLog = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    const meta = args[1];
    if (meta && typeof meta === 'object') errorLog.push(meta as Record<string, unknown>);
  });
  await resetTestDb();
  userId = await mkUser();
  mockedAuth.mockResolvedValue({ user: { id: userId, email: 'a@t.dev' } } as never);
});

describe('billing copy matches the billing state (spec §7)', () => {
  it('pre-stream 502 keeps the spec-quoted "didn\'t count" copy verbatim', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          throw new UpstreamUnavailableError('connection refused');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe(SPEC_UNBILLED_COPY);
    // And the copy is true: nothing was billed on this path.
    expect(await rowsFor(userId)).toHaveLength(0);
    expect((await check(userId)).used).toBe(0);
  });

  it('mid-stream upstream death: the frame says it COUNTED and never says "didn\'t count"', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          yield 'partial ';
          throw new UpstreamUnavailableError('mid-stream death');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    const frames = await res.text().then(parseFrames);
    const last = frames.at(-1) as { type: string; message: string };

    expect(last.type).toBe('error');
    // The load-bearing assertion: the old copy promised "didn't count" on a
    // request whose row was already created by beginUsage. Flip the constant
    // back and this fails.
    expect(last.message).not.toMatch(/didn'?t count/i);
    expect(last.message).toMatch(/count(ed)?\b/i);
    expect(last.message).toMatch(/generation started/i);

    // Truth check: this request DID consume the slot.
    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('aborted');
    expect((await check(userId)).used).toBe(1);
  });

  it('Stop mid-stream: the frame says it COUNTED and never says "didn\'t count"', async () => {
    const ac = new AbortController();
    let release: (err: unknown) => void = () => {};
    const gate = new Promise<never>((_resolve, reject) => {
      release = reject;
    });

    const route = makeRouteHandler({
      provider: {
        stream: (_t, _m, _s, signal) => {
          signal.addEventListener('abort', () => release(new DOMException('Aborted', 'AbortError')));
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
    // Consume the first delta so the row is billed before the abort lands.
    await reader.read();
    ac.abort();
    const tail = decoder.decode((await reader.read()).value);
    await reader.cancel().catch(() => {});

    const last = parseFrames(tail).at(-1) as { type: string; message: string };
    expect(last.type).toBe('error');
    expect(last.message).not.toMatch(/didn'?t count/i);
    expect(last.message).toMatch(/count(ed)?\b/i);

    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('aborted');
    expect((await check(userId)).used).toBe(1);
  });

  it('mid-stream unexpected (non-upstream, non-abort) throw also says it counted', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          yield 'partial';
          throw new Error('programmer fault');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    const frames = await res.text().then(parseFrames);
    const last = frames.at(-1) as { type: string; message: string };

    expect(last.type).toBe('error');
    expect(last.message).not.toMatch(/didn'?t count/i);
    expect(last.message).toMatch(/count(ed)?\b/i);
    expect((await check(userId)).used).toBe(1);
  });
});

describe('correlation id is a joinable seam, not decoration (spec §7)', () => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  it('the zero-delta 502 correlationId is actually logged', async () => {
    // This path previously minted a correlationId for the client with no
    // matching log line anywhere, so the id resolved to nothing.
    const route = makeRouteHandler({
      provider: { stream: async function* () {} } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { correlationId: string };
    expect(body.correlationId).toMatch(UUID);

    const logged = errorLog.filter((e) => typeof e.correlationId === 'string');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.map((e) => e.correlationId)).toContain(body.correlationId);
  });

  it('one request logs exactly one correlationId, shared with the response body', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          throw new UpstreamUnavailableError('socket hang up');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    const body = (await res.json()) as { correlationId: string };

    const logged = errorLog.filter((e) => typeof e.correlationId === 'string');
    expect(logged).toHaveLength(1);
    expect(logged[0].correlationId).toBe(body.correlationId);
  });

  it('a mid-stream fault logs the request id and leaks no message/query/params', async () => {
    const route = makeRouteHandler({
      provider: {
        stream: async function* () {
          yield 'partial';
          throw new UpstreamUnavailableError('mid-stream death');
        },
      } as ParaphraseProvider,
    });

    await route.POST(fakeReq(PAYLOAD)).then((r) => r.text());

    const logged = errorLog.filter((e) => typeof e.correlationId === 'string');
    expect(logged).toHaveLength(1);
    expect(logged[0].correlationId).toMatch(UUID);
    expect(logged[0]).not.toHaveProperty('message');
    expect(logged[0]).not.toHaveProperty('query');
    expect(logged[0]).not.toHaveProperty('params');
  });

  it('a pre-stream 429 still answers instantly with no usage row', async () => {
    // Guard on scope: the per-request id must not delay or alter the
    // quota-exhausted path, which carries its own shape.
    const { beginUsage } = await import('@/lib/quota/quotaService');
    const { FREE_DAILY_LIMIT } = await import('@/lib/quota/quotaService');
    for (let i = 0; i < FREE_DAILY_LIMIT; i++) {
      await beginUsage(userId, 5, 'openai/gpt-4o-mini', 'standard', 'light');
    }

    const route = makeRouteHandler({
      provider: {
        stream: () => {
          throw new Error('must not be reached');
        },
      } as ParaphraseProvider,
    });

    const res = await route.POST(fakeReq(PAYLOAD));
    expect(res.status).toBe(429);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ limit: FREE_DAILY_LIMIT, used: FREE_DAILY_LIMIT });
    expect(await rowsFor(userId)).toHaveLength(FREE_DAILY_LIMIT);
  });
});
