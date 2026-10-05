import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APIUserAbortError } from 'openai';
import { getSystemPrompt } from '@/lib/mode/prompts';
import { createOpenRouterProvider } from '@/lib/paraphrase/openrouter';
import { UPSTREAM_TIMEOUT_MS, UpstreamUnavailableError } from '@/lib/paraphrase/types';

type RecordedRequest = {
  url: string;
  body: Record<string, unknown>;
};

let server: http.Server;
let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;
let recorded: RecordedRequest | null = null;
let requestCount = 0;
const originalEnv = {
  base: process.env.OPENROUTER_BASE_URL,
  key: process.env.OPENROUTER_API_KEY,
  model: process.env.PARAPHRASE_MODEL,
};

function sseHeaders(res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}

function delta(res: http.ServerResponse, content: string): void {
  res.write(`data: {"choices":[{"delta":{"content":${JSON.stringify(content)}}}]}\n\n`);
}

function done(res: http.ServerResponse): void {
  res.write('data: [DONE]\n\n');
  res.end();
}

async function collect(
  iterable: AsyncIterable<string>,
  onFirst?: () => void,
): Promise<{ deltas: string[]; error: unknown }> {
  const deltasOut: string[] = [];
  try {
    for await (const d of iterable) {
      deltasOut.push(d);
      if (onFirst) onFirst();
    }
    return { deltas: deltasOut, error: null };
  } catch (error) {
    return { deltas: deltasOut, error };
  }
}

beforeEach(async () => {
  recorded = null;
  requestCount = 0;
  server = http.createServer((req, res) => {
    requestCount += 1;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      recorded = {
        url: req.url ?? '',
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
      };
    });
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_API_KEY = 'test-key-never-asserted';
  delete process.env.PARAPHRASE_MODEL;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (originalEnv.base === undefined) delete process.env.OPENROUTER_BASE_URL;
  else process.env.OPENROUTER_BASE_URL = originalEnv.base;
  if (originalEnv.key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalEnv.key;
  if (originalEnv.model === undefined) delete process.env.PARAPHRASE_MODEL;
  else process.env.PARAPHRASE_MODEL = originalEnv.model;
});

describe('OpenRouter provider — happy path', () => {
  it('replays canned SSE chunks in order and sends a valid request body', async () => {
    handler = (_req, res) => {
      sseHeaders(res);
      for (const c of ['The', ' quick', ' fox']) delta(res, c);
      done(res);
    };
    const provider = createOpenRouterProvider();
    const { deltas: out, error } = await collect(
      provider.stream('input text', 'standard', 'light', new AbortController().signal),
    );
    expect(error).toBeNull();
    expect(out.join('')).toBe('The quick fox');

    expect(recorded).not.toBeNull();
    expect(recorded!.url).toMatch(/\/chat\/completions$/);
    const body = recorded!.body as {
      model: string;
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.stream).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[0].content).toBe(getSystemPrompt('standard', 'light'));
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toBe('input text');
  });

  it('uses PARAPHRASE_MODEL from env at call time', async () => {
    process.env.PARAPHRASE_MODEL = 'meta-llama/llama-3.1-8b-instruct';
    handler = (_req, res) => {
      sseHeaders(res);
      delta(res, 'ok');
      done(res);
    };
    const provider = createOpenRouterProvider();
    await collect(provider.stream('t', 'fluent', 'medium', new AbortController().signal));
    expect(recorded!.body.model).toBe('meta-llama/llama-3.1-8b-instruct');
  });
});

describe('OpenRouter provider — failure modes → error types', () => {
  it('401 before any delta → UpstreamUnavailableError, zero deltas, sanitized message', async () => {
    handler = (_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    };
    const provider = createOpenRouterProvider();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', new AbortController().signal),
    );
    expect(deltas).toHaveLength(0);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect((error as Error).cause).toBeDefined();
    const msg = (error as Error).message;
    expect(msg).not.toContain('test-key-never-asserted');
    expect(msg).not.toContain('127.0.0.1');
    expect(msg).not.toContain('openai/gpt-4o-mini');
  });

  it('issues exactly ONE upstream request per stream() call (maxRetries: 0, no silent retry)', async () => {
    handler = (_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'boom' } }));
    };
    const provider = createOpenRouterProvider();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', new AbortController().signal),
    );
    expect(deltas).toHaveLength(0);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    // SDK default maxRetries=2 would hit the server 3 times on a 500.
    expect(requestCount).toBe(1);
  });

  it('mid-stream death: already-yielded deltas stand, then UpstreamUnavailableError', async () => {
    handler = (_req, res) => {
      sseHeaders(res);
      delta(res, 'The');
      delta(res, ' quick');
      res.flushHeaders();
      setTimeout(() => res.destroy(), 20);
    };
    const provider = createOpenRouterProvider();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', new AbortController().signal),
    );
    expect(deltas).toEqual(['The', ' quick']);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect((error as Error).cause).toBeDefined();
  });

  it('[DONE] immediately, zero deltas → UpstreamUnavailableError', async () => {
    handler = (_req, res) => {
      sseHeaders(res);
      done(res);
    };
    const provider = createOpenRouterProvider();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', new AbortController().signal),
    );
    expect(deltas).toHaveLength(0);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it('clean EOF WITHOUT [DONE], zero deltas → UpstreamUnavailableError (SDK cannot see it)', async () => {
    handler = (_req, res) => {
      sseHeaders(res);
      res.end();
    };
    const provider = createOpenRouterProvider();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', new AbortController().signal),
    );
    expect(deltas).toHaveLength(0);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
  });

  it('timeout fires before any delta → UpstreamUnavailableError (not AbortError)', async () => {
    handler = (_req, res) => {
      sseHeaders(res); // hold the connection open, send nothing
    };
    const provider = createOpenRouterProvider({ timeoutMs: 40 });
    const started = Date.now();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', new AbortController().signal),
    );
    expect(deltas).toHaveLength(0);
    expect(error).toBeInstanceOf(UpstreamUnavailableError);
    expect(error).not.toBeInstanceOf(APIUserAbortError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('caller abort mid-stream → AbortError surfaced as-is, NOT UpstreamUnavailableError', async () => {
    let sent = 0;
    handler = (_req, res) => {
      sseHeaders(res);
      const send = () => {
        if (sent === 5) return done(res);
        delta(res, `w${sent}`);
        sent += 1;
        setTimeout(send, 40);
      };
      send();
    };
    const controller = new AbortController();
    const provider = createOpenRouterProvider();
    const { deltas, error } = await collect(
      provider.stream('t', 'standard', 'light', controller.signal),
      () => controller.abort(), // abort right after the first yielded delta
    );
    expect(deltas).toEqual(['w0']);
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(UpstreamUnavailableError);
    const isAbort = error instanceof APIUserAbortError || (error instanceof Error && error.name === 'AbortError');
    expect(isAbort).toBe(true);
  });

  it('UPSTREAM_TIMEOUT_MS default is 120_000', () => {
    expect(UPSTREAM_TIMEOUT_MS).toBe(120_000);
  });
});
