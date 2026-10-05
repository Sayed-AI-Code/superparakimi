import http from 'node:http';

/**
 * Mock OpenRouter-compatible upstream for the Playwright smoke (spec §10:
 * "paraphrase canned text against mocked upstream").
 *
 * Speaks just enough of the OpenAI chat-completions SSE contract for the
 * openai SDK v7 client in lib/paraphrase/openrouter.ts to parse it:
 * `data: {"choices":[{"delta":{"content":"…"}}]}` frames, then
 * `data: [DONE]`. Deliberately NOT a generic mock — it emits a fixed canned
 * paraphrase so the spec can assert the exact text lands in the output pane,
 * and it rejects any request that does not carry an API key, so a regression
 * that stopped sending the key fails loudly instead of silently returning
 * empty content (which the provider would then report as a zero-delta fault).
 */
const CANONICAL_TEXT = 'The quick brown fox jumps over the lazy dog.';
const CHUNKS = ['The quick ', 'brown fox ', 'jumps over ', 'the lazy dog.'];

export type MockUpstream = {
  url: string;
  requests: number;
  lastBody: string;
  close: () => Promise<void>;
};

export function startMockUpstream(port: number): Promise<MockUpstream> {
  let requests = 0;
  let lastBody = '';

  const server = http.createServer((req, res) => {
    const body: Buffer[] = [];
    req.on('data', (chunk: Buffer) => body.push(chunk));
    req.on('end', () => {
      lastBody = Buffer.concat(body).toString('utf8');

      if (!req.headers.authorization) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'missing api key' } }));
        return;
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }

      requests += 1;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // No compression: the client decodes bytes straight from the socket
        // in the test's chunked reads, and gzip would make the framing test
        // depend on Node's auto-decompression instead of our own parsing.
      });

      let index = 0;
      const sendNext = () => {
        if (index < CHUNKS.length) {
          const chunk = CHUNKS[index++];
          res.write(
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
            })}\n\n`,
          );
          // Small delay so the spec can observe progressive rendering rather
          // than a single flush that would pass even if streaming were broken.
          setTimeout(sendNext, 40);
          return;
        }
        res.write('data: [DONE]\n\n');
        res.end();
      };
      sendNext();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}/v1`,
        get requests() {
          return requests;
        },
        get lastBody() {
          return lastBody;
        },
        close: () =>
          new Promise<void>((done, fail) => server.close((e) => (e ? fail(e) : done()))),
      });
    });
  });
}

export const MOCK_PARAPHRASE = CANONICAL_TEXT;
