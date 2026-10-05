// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Workspace from '@/components/Workspace';
import UsageMeter from '@/components/UsageMeter';
import {
  publishUsage,
  requestUsageRefresh,
  USAGE_EVENT,
  USAGE_REFRESH_EVENT,
} from '@/lib/workspace/helpers';
import { MAX_INPUT_CHARS } from '@/lib/validation';

const ENCODER = new TextEncoder();

function frame(f: unknown): Uint8Array {
  return ENCODER.encode(`data: ${JSON.stringify(f)}\n\n`);
}

function sse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8' },
  });
}

/**
 * A body that emits `frames` ONCE and then stays open.
 *
 * `pull` is called again after every read, so a pull that enqueues
 * unconditionally is an infinite delta generator — that is how the first
 * draft of this file OOM-killed its Vitest worker. The stream holds until the
 * caller's AbortController fires, which is the shape of a live SSE connection.
 */
function openStream(frames: Uint8Array[], signalOf: () => AbortSignal | null) {
  let emitted = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!emitted) {
        emitted = true;
        for (const f of frames) controller.enqueue(f);
        return;
      }
      return new Promise<void>((resolve) => {
        const signal = signalOf();
        if (!signal) return;
        if (signal.aborted) {
          controller.close();
          resolve();
          return;
        }
        signal.addEventListener(
          'abort',
          () => {
            controller.close();
            resolve();
          },
          { once: true },
        );
      });
    },
  });
}

/** A body that writes every frame immediately, then closes. */
function closedStream(frames: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < frames.length) controller.enqueue(frames[index++]);
      else controller.close();
    },
  });
}

function usage(over: Partial<{ used: number; limit: number; remaining: number }> = {}) {
  return {
    used: over.used ?? 0,
    limit: over.limit ?? 10,
    remaining: over.remaining ?? 10,
    resetsAt: '2026-03-14T05:30:31.000Z',
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const sendButton = () =>
  screen.getByRole('button', { name: /^paraphras/i }) as HTMLButtonElement;

const box = () => screen.getByLabelText('Text to paraphrase') as HTMLTextAreaElement;

/** The meter and the page heading show the same sentence — scope the query. */
function meterText(): string {
  return document.querySelector('#usage-meter')?.textContent ?? '';
}

function type(text: string) {
  fireEvent.change(box(), { target: { value: text } });
}

let fetchMock: ReturnType<typeof vi.fn>;
let navigations: string[];
let liveSignal: AbortSignal | null;

/** Routes /api/paraphrase through `answer`, everything else (i.e. /api/usage). */
function routeParaphrase(answer: (signal: () => AbortSignal | null) => Promise<Response>) {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).includes('/api/paraphrase')) {
      liveSignal = (init?.signal as AbortSignal) ?? null;
      return answer(() => liveSignal);
    }
    return Promise.resolve(jsonResponse(usage()));
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  liveSignal = null;
  navigations = [];
  vi.stubGlobal('fetch', fetchMock);
  // jsdom refuses real navigation; capture the assignment so the redirect can
  // be asserted instead of swallowed by a "Not implemented: navigation".
  Object.defineProperty(window, 'location', {
    configurable: true,
    writable: true,
    value: {
      pathname: '/app',
      href: '/app',
      assign: (target: string) => navigations.push(target),
      replace: (target: string) => navigations.push(target),
    },
  });
  fetchMock.mockResolvedValue(jsonResponse(usage()));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('quota gate — each term is individually load-bearing', () => {
  it('is disabled with empty input and ENABLED once there is text', () => {
    render(<Workspace />);
    // Dropping `countChars(text.trim()) > 0` fails the first assertion.
    expect(sendButton().disabled).toBe(true);
    type('hello');
    // Positive control: without it, an always-disabled button would make every
    // other gate assertion in this file vacuous.
    expect(sendButton().disabled).toBe(false);
  });

  it('is disabled while streaming', async () => {
    routeParaphrase((sig) => Promise.resolve(sse(openStream([frame({ type: 'delta', text: 'One ' })], sig))));

    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/One/)).toBeTruthy());

    // Dropping `!streaming` fails here: double-submit becomes possible.
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy();
  });

  it('is disabled at remaining === 0 even with valid text', async () => {
    render(<Workspace />);
    type('hello');
    expect(sendButton().disabled).toBe(false);

    publishUsage(usage({ used: 10, limit: 10, remaining: 0 }));
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    // Dropping the exhausted term fails the assertion above.
    expect(document.body.textContent).toContain('Daily limit reached');
  });

  it('is live again when the bus reports headroom restored', async () => {
    render(<Workspace />);
    type('hello');
    publishUsage(usage({ used: 10, limit: 10, remaining: 0 }));
    await waitFor(() => expect(sendButton().disabled).toBe(true));
    publishUsage(usage({ used: 9, limit: 10, remaining: 1 }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
  });
});

describe('usage bus wiring — swapping the two event names breaks these', () => {
  // Both components import the same constants, so renaming or swapping the two
  // literals in helpers.ts stays internally consistent and every other test in
  // this file still passes. These pins are the only thing standing between a
  // typo there and a silently dead bus: they name the wire format itself, so
  // the constant must equal the literal AND a hand-written literal must reach
  // both subscribers.
  it('the event names are the pinned wire format, and a literal event reaches both subscribers', async () => {
    expect(USAGE_EVENT).toBe('parakimi:usage');
    expect(USAGE_REFRESH_EVENT).toBe('parakimi:usage:refresh');

    render(
      <>
        <UsageMeter />
        <Workspace />
      </>,
    );
    await waitFor(() => expect(meterText()).toBe('10 of 10 left today'));

    window.dispatchEvent(
      new CustomEvent('parakimi:usage', {
        detail: usage({ used: 4, limit: 10, remaining: 6 }),
      }),
    );
    await waitFor(() => expect(meterText()).toBe('6 of 10 left today'));

    // The literal refresh channel is what asks for a re-read; if the two
    // literals were swapped this dispatch would land on nothing.
    const before = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event('parakimi:usage:refresh'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(before + 1));
  });

  it('USAGE_EVENT carries new numbers into the meter and the gate', async () => {
    render(
      <>
        <UsageMeter />
        <Workspace />
      </>,
    );
    await waitFor(() => expect(meterText()).toBe('10 of 10 left today'));

    publishUsage(usage({ used: 7, limit: 10, remaining: 3 }));
    await waitFor(() => expect(meterText()).toBe('3 of 10 left today'));
    expect(screen.queryByText(/Daily limit reached/)).toBeNull();

    publishUsage(usage({ used: 10, limit: 10, remaining: 0 }));
    // At exhaustion the meter appends the local reset time (spec §7), so match
    // the count rather than the whole sentence.
    await waitFor(() => expect(meterText()).toContain('0 of 10 left today'));
    expect(meterText()).toMatch(/resets \d/);
    await waitFor(() => expect(sendButton().disabled).toBe(true));
  });

  it('USAGE_REFRESH_EVENT makes the meter re-read; the wrong channel must not', async () => {
    render(<UsageMeter />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(USAGE_EVENT).not.toEqual(USAGE_REFRESH_EVENT);

    requestUsageRefresh();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // Publishing on the wrong channel must NOT trigger a re-read. If the two
    // constants in helpers.ts were swapped, this is the assertion that fails.
    const before = fetchMock.mock.calls.length;
    window.dispatchEvent(new Event(USAGE_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(before);
  });

  it('the meter renders nothing on a 401 and does not navigate', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Sign in to see your usage' }, 401));
    const { container } = render(<UsageMeter />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
    expect(navigations).toEqual([]);
    expect(window.location.href).toBe('/app');
  });

  it('a terminal done frame decrements the meter through the bus', async () => {
    render(
      <>
        <UsageMeter />
        <Workspace />
      </>,
    );
    await waitFor(() => expect(meterText()).toBe('10 of 10 left today'));

    routeParaphrase(() =>
      Promise.resolve(
        sse(
          closedStream([
            frame({ type: 'delta', text: 'text' }),
            frame({ type: 'done', remaining: 9 }),
          ]),
        ),
      ),
    );
    type('hello');
    fireEvent.click(sendButton());

    await waitFor(() => expect(meterText()).toBe('9 of 10 left today'));
  });
});

describe('input cap in code points, with its inline error', () => {
  it('trims an over-long paste to the cap and says so', () => {
    render(<Workspace />);
    type('x'.repeat(MAX_INPUT_CHARS + 250));
    expect(box().value.length).toBe(MAX_INPUT_CHARS);
    expect(screen.getByText(/Trimmed to 5,000 characters — that is the limit\./)).toBeTruthy();
  });

  it('shows no trim error at exactly the cap', () => {
    render(<Workspace />);
    type('x'.repeat(MAX_INPUT_CHARS));
    expect(screen.queryByText(/Trimmed to/)).toBeNull();
    expect(sendButton().disabled).toBe(false);
  });

  it('counts 4,000 emoji as 4,000 characters and trims nothing', () => {
    render(<Workspace />);
    const emoji = '😀'.repeat(4000);
    type(emoji);
    // UTF-16 would read 8,000 here and wrongly trim half the text away.
    expect(Array.from(box().value).length).toBe(4000);
    expect(box().value).toBe(emoji);
    expect(screen.queryByText(/Trimmed to/)).toBeNull();
    expect(screen.getByText('4,000 / 5,000')).toBeTruthy();
  });

  it('trims 5,001 emoji to 5,000 code points, well-formed', () => {
    render(<Workspace />);
    type('😀'.repeat(MAX_INPUT_CHARS + 1));
    expect(Array.from(box().value).length).toBe(MAX_INPUT_CHARS);
    expect(box().value.isWellFormed()).toBe(true);
    expect(screen.getByText(/Trimmed to/)).toBeTruthy();
  });

  it('never strands a lone surrogate when the cut lands inside a pair', () => {
    render(<Workspace />);
    // 4,999 BMP chars + one emoji = 5,000 code points, 5,001 UTF-16 units.
    // A .slice(0, 5000) would cut the pair in half.
    type(`${'a'.repeat(MAX_INPUT_CHARS - 1)}😀`);
    expect(box().value.isWellFormed()).toBe(true);
    expect(box().value.endsWith('😀')).toBe(true);
    expect(screen.queryByText(/Trimmed to/)).toBeNull();
  });

  it('sends a well-formed body when the input ends in a lone surrogate', async () => {
    let sent = '';
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/paraphrase')) {
        sent = String(init?.body ?? '');
        liveSignal = (init?.signal as AbortSignal) ?? null;
        return Promise.resolve(
          sse(
            closedStream([
              frame({ type: 'delta', text: 'ok' }),
              frame({ type: 'done', remaining: 9 }),
            ]),
          ),
        );
      }
      return Promise.resolve(jsonResponse(usage()));
    });

    render(<Workspace />);
    type(`hello${String.fromCharCode(0xd800)}`);
    fireEvent.click(sendButton());

    await waitFor(() => expect(sent).not.toBe(''));
    const payload = JSON.parse(sent) as { text: string };
    expect(payload.text.isWellFormed()).toBe(true);
    expect(payload.text).toContain('hello');
  });
});

describe('abort on unmount (spec §7: navigating away halts token spend)', () => {
  it('aborts the live request when unmounted mid-stream', async () => {
    routeParaphrase((sig) =>
      Promise.resolve(sse(openStream([frame({ type: 'delta', text: 'token ' })], sig))),
    );

    const { unmount } = render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/token/)).toBeTruthy());

    expect(liveSignal).not.toBeNull();
    expect(liveSignal!.aborted).toBe(false);

    // Dropped the unmount cleanup → stays false and this test fails.
    unmount();
    await waitFor(() => expect(liveSignal!.aborted).toBe(true));
  });

  it('does not abort a request that already completed cleanly', async () => {
    routeParaphrase(() =>
      Promise.resolve(
        sse(
          closedStream([
            frame({ type: 'delta', text: 'all of it' }),
            frame({ type: 'done', remaining: 9 }),
          ]),
        ),
      ),
    );

    const { unmount } = render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/all of it/)).toBeTruthy());
    await waitFor(() =>
      expect(document.querySelector('pre[data-status]')?.getAttribute('data-status')).toBe(
        'idle',
      ),
    );

    // The stream finished cleanly, so the controller ref is cleared: unmounting
    // must not abort a completed request (that would be a spurious cancel).
    unmount();
    expect(liveSignal!.aborted).toBe(false);
  });

  it('Stop still aborts, and unmounting afterwards does not throw or double-fire', async () => {
    routeParaphrase((sig) =>
      Promise.resolve(sse(openStream([frame({ type: 'delta', text: 'more ' })], sig))),
    );

    const { unmount } = render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByRole('button', { name: /stop/i })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: /stop/i }));
    expect(liveSignal!.aborted).toBe(true);

    // abort() is idempotent; the cleanup must not conjure a second controller.
    expect(() => unmount()).not.toThrow();
    expect(liveSignal!.aborted).toBe(true);
  });
});

describe('error state is live and durable', () => {
  const COUNTED = 'Service hiccup — this request counted, because generation started.';

  it('keeps the note, the status, and the partial output after a mid-stream fault', async () => {
    routeParaphrase(() =>
      Promise.resolve(
        sse(
          closedStream([
            frame({ type: 'delta', text: 'partial ' }),
            frame({ type: 'error', message: COUNTED }),
          ]),
        ),
      ),
    );

    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('counted'));
    const pre = () => document.querySelector('pre[data-status]')?.getAttribute('data-status');
    expect(pre()).toBe('error');
    expect(document.querySelector('pre')?.textContent).toContain('partial');

    // DURABLE: the old finally wrote 'idle' in this same tick and erased it.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pre()).toBe('error');
    expect(screen.getByText(/Partial text above is kept/)).toBeTruthy();
  });

  it('leaves the error state when the user edits the input', async () => {
    routeParaphrase(() =>
      Promise.resolve(sse(closedStream([frame({ type: 'error', message: COUNTED })]))),
    );
    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    type('hello again');
    await waitFor(() =>
      expect(document.querySelector('pre[data-status]')?.getAttribute('data-status')).toBe(
        'idle',
      ),
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('returns to idle after a clean run', async () => {
    routeParaphrase(() =>
      Promise.resolve(
        sse(
          closedStream([
            frame({ type: 'delta', text: 'done text' }),
            frame({ type: 'done', remaining: 9 }),
          ]),
        ),
      ),
    );
    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByText(/done text/)).toBeTruthy());
    expect(document.querySelector('pre[data-status]')?.getAttribute('data-status')).toBe('idle');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports a transport failure as a durable error without touching quota', async () => {
    routeParaphrase(() => Promise.reject(new TypeError('Failed to fetch')));
    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not reach the service.'),
    );
    expect(document.querySelector('pre[data-status]')?.getAttribute('data-status')).toBe('error');
  });
});

describe('401 redirects to sign-in (spec §7)', () => {
  it('navigates to /signin carrying a callback back to /app', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/paraphrase')) {
        liveSignal = (init?.signal as AbortSignal) ?? null;
        return Promise.resolve(jsonResponse({ error: 'Sign in to paraphrase' }, 401));
      }
      return Promise.resolve(jsonResponse(usage()));
    });

    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());

    await waitFor(() =>
      expect(window.location.href).toBe('/signin?callbackUrl=%2Fapp'),
    );
    // Same-origin path only — no authority form slipped past the guard.
    expect(window.location.href).not.toMatch(/^\/\//);
  });

  it('does not navigate on a 429, and shows the reset time', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url).includes('/api/paraphrase')) {
        liveSignal = (init?.signal as AbortSignal) ?? null;
        return Promise.resolve(
          jsonResponse(
            {
              error: "You've used all your free paraphrases for today.",
              limit: 10,
              used: 10,
              resetsAt: '2026-03-14T05:30:31.000Z',
            },
            429,
          ),
        );
      }
      return Promise.resolve(jsonResponse(usage()));
    });

    render(<Workspace />);
    type('hello');
    fireEvent.click(sendButton());

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(window.location.href).toBe('/app');
    expect(navigations).toEqual([]);
    expect(screen.getByRole('alert').textContent).toContain('Resets');
  });
});
