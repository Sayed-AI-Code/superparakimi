import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createSseLineBuffer,
  formatResetLocal,
  parseSseLine,
} from '@/lib/workspace/helpers';

const PROBE = path.join(__dirname, '..', 'probes', 'format-reset-probe.ts');

/**
 * Pinned instant, and the arithmetic behind every assertion below.
 *
 *   UTC           2026-03-14T05:30:31.000Z
 *   Karachi       UTC+05:00 (no DST since 2008)  05:30 + 5:00 = 10:30:31  → hour 10
 *   New York      EDT, UTC-04:00 (DST began 2026-03-08, so the 14th is EDT)
 *                 05:30 - 4:00 = 01:30:31        → hour 1
 *   UTC (wrong)   05:30:31                        → hour 5
 *
 * Hour tokens 10 / 1 / 5 are mutually exclusive strings, so a formatResetLocal
 * that leaked the UTC hour fails BOTH zone assertions (Review focus #4).
 */
const PINNED_UTC = '2026-03-14T05:30:31.000Z';

function probeIn(zone: string): string {
  // stderr is silenced: running a bare .ts file makes Node print a
  // MODULE_TYPELESS_PACKAGE_JSON notice, which is expected noise here.
  return execFileSync(process.execPath, [PROBE], {
    env: { ...process.env, TZ: zone },
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .toString()
    .trim();
}

describe('parseSseLine', () => {
  it('parses all three Task 9 frame types', () => {
    expect(parseSseLine('data: {"type":"delta","text":"Hello"}')).toEqual({
      type: 'delta',
      text: 'Hello',
    });
    expect(parseSseLine('data: {"type":"done","remaining":9}')).toEqual({
      type: 'done',
      remaining: 9,
    });
    expect(parseSseLine('data: {"type":"error","message":"Nope"}')).toEqual({
      type: 'error',
      message: 'Nope',
    });
  });

  it('accepts both "data: " and "data:" (the space after the colon is optional)', () => {
    expect(parseSseLine('data:{"type":"delta","text":"x"}')).not.toBeNull();
    expect(parseSseLine('data:  {"type":"delta","text":"x"}')).not.toBeNull();
  });

  it('ignores event:/id:/retry: fields, comments, and blank lines', () => {
    expect(parseSseLine('event: delta')).toBeNull();
    expect(parseSseLine('id: 42')).toBeNull();
    expect(parseSseLine('retry: 3000')).toBeNull();
    expect(parseSseLine(': keep-alive')).toBeNull();
    expect(parseSseLine(':')).toBeNull();
    expect(parseSseLine('')).toBeNull();
    expect(parseSseLine('   ')).toBeNull();
    expect(parseSseLine('gradienting')).toBeNull();
  });

  it('returns null for malformed JSON and for well-formed JSON that is not a frame', () => {
    expect(parseSseLine('data: {')).toBeNull();
    expect(parseSseLine('data:')).toBeNull();
    expect(parseSseLine('data:   ')).toBeNull();
    expect(parseSseLine('data: null')).toBeNull();
    expect(parseSseLine('data: [1,2]')).toBeNull();
    expect(parseSseLine("data: {'single': 'quotes'}")).toBeNull();
    expect(parseSseLine('data: {"type":"delta"}')).toBeNull(); // no text
    expect(parseSseLine('data: {"type":"delta","text":42}')).toBeNull(); // wrong text type
    expect(parseSseLine('data: {"type":"delta","text":"x","trailing":}')).toBeNull();
  });

  it('never throws on hostile input', () => {
    const hostile = [
      '',
      ' ',
      '\n',
      '\r\n',
      'data:',
      'data: ',
      'data: {',
      'data: {}',
      'data: {',
      'data: null',
      'data: undefined',
      'data: NaN',
      'data: "just a string"',
      'data: 42',
      'event: delta',
      ': comment',
      'data: {"type":"delta","text":"\\ud800"}', // lone surrogate escape
      `data: {"type":"delta","text":"${String.fromCharCode(0xd800)}"}`, // raw lone surrogate
      `data: {"type":"delta","text":"${String.fromCharCode(0x00)}${String.fromCharCode(0x1f)}"}`, // NUL + control
      'data: {"type":"delta","text":"Ā"}',
      'data: {"type":"delta","text":"' + 'x'.repeat(100_000) + '"}',
      'data: {"type":"done","remaining":"nine"}',
      'data: {"type":"done","remaining":1e999}',
      'data: {"type":"error"}',
      'DATA: {"type":"delta","text":"case"}',
      'data:[',
      'data: ,',
      '﻿data: {"type":"delta","text":"bom"}',
      'data: {"type":"delta","text":"a"}{"type":"done","remaining":1}',
    ];

    for (const line of hostile) {
      let frame: ReturnType<typeof parseSseLine> | undefined;
      // The assertion is "does not throw" — any of these throwing is a bug.
      expect(() => {
        frame = parseSseLine(line);
      }).not.toThrow();
      expect(frame === null || typeof frame === 'object').toBe(true);
    }
  });

  it('carries text through unchanged, including emoji and newlines-in-JSON', () => {
    const frame = parseSseLine('data: {"type":"delta","text":"naïve 🦊\\n"}');
    expect(frame).toEqual({ type: 'delta', text: 'naïve 🦊\n' });
  });
});

describe('createSseLineBuffer — split frames across reads', () => {
  it('reassembles one frame delivered as "data: {" then the rest', () => {
    const buffer = createSseLineBuffer();
    expect(buffer.push('data: {')).toEqual([]);
    expect(buffer.push('"type":"delta","text":"Hi"}')).toEqual([]);
    expect(buffer.push('\n')).toEqual([{ type: 'delta', text: 'Hi' }]);
  });

  it('reassembles a frame split byte-by-byte', () => {
    const buffer = createSseLineBuffer();
    const line = 'data: {"type":"done","remaining":3}\n\n';
    const frames: unknown[] = [];
    for (const ch of line) frames.push(...buffer.push(ch));
    expect(frames).toEqual([{ type: 'done', remaining: 3 }]);
  });

  it('drains several frames from one chunk and keeps the partial tail', () => {
    const buffer = createSseLineBuffer();
    const chunk =
      'data: {"type":"delta","text":"One"}\n\n' +
      'data: {"type":"delta","text":"Two"}\n\n' +
      'data: {"type":"del';
    expect(buffer.push(chunk)).toEqual([
      { type: 'delta', text: 'One' },
      { type: 'delta', text: 'Two' },
    ]);
    expect(buffer.push('ta","text":"Three"}\n\n')).toEqual([
      { type: 'delta', text: 'Three' },
    ]);
  });

  it('tolerates CRLF framing and flushes an unterminated final line', () => {
    const buffer = createSseLineBuffer();
    expect(buffer.push('data: {"type":"delta","text":"crlf"}\r\n\r\n')).toEqual([
      { type: 'delta', text: 'crlf' },
    ]);
    expect(buffer.push('data: {"type":"delta","text":"tail"}')).toEqual([]);
    expect(buffer.flush()).toEqual([{ type: 'delta', text: 'tail' }]);
    expect(buffer.flush()).toEqual([]);
  });

  it('never carries a junk line into a frame and never throws', () => {
    const buffer = createSseLineBuffer();
    // ': ping' is a complete comment line (dropped); 'data: {' is an
    // *unterminated* fragment, so it must survive in the buffer until the rest
    // of the frame arrives on the next chunk.
    expect(() => buffer.push(': ping\n\ndata: {')).not.toThrow();
    expect(buffer.push('"type":"error","message":"boom"}\n\n')).toEqual([
      { type: 'error', message: 'boom' },
    ]);
  });

  it('drops a complete-but-malformed data line instead of buffering it forever', () => {
    const buffer = createSseLineBuffer();
    expect(buffer.push('data: {\n')).toEqual([]);
    // The bad line was terminated, so it is gone — the next frame parses clean.
    expect(buffer.push('data: {"type":"delta","text":"ok"}\n\n')).toEqual([
      { type: 'delta', text: 'ok' },
    ]);
  });
});

describe('formatResetLocal — UTC on the wire, local on the screen (Review focus #4)', () => {
  it('renders the correct local hour in Asia/Karachi (+05:00)', () => {
    const out = probeIn('Asia/Karachi');
    // 05:30:31Z + 05:00 = 10:30:31 local, so the hour token is 10 (or 010-free "10").
    expect(out).toMatch(/(?:^|\D)10:30/);
    // If the helper leaked the UTC hour the string would read 5:30 instead.
    expect(out).not.toMatch(/(?:^|\D)0?5:30/);
  });

  it('renders the correct local hour in America/New_York (EDT, -04:00)', () => {
    const out = probeIn('America/New_York');
    // 05:30:31Z - 04:00 = 01:30:31 local, rendered 1:30 (en-US) or 01:30 (24h).
    expect(out).toMatch(/(?:^|\D)0?1:30/);
    expect(out).not.toMatch(/(?:^|\D)0?5:30/);
  });

  it('produces different output for the two zones', () => {
    expect(probeIn('Asia/Karachi')).not.toEqual(probeIn('America/New_York'));
  });

  it('is stable and non-empty in-process, and never throws on odd input', () => {
    expect(formatResetLocal(PINNED_UTC)).toBeTruthy();
    expect(typeof formatResetLocal(PINNED_UTC)).toBe('string');
    // Garbage in is a display problem, not a crash: the route always feeds a
    // valid ISO instant, so the helper passes it straight to toLocaleString.
    expect(() => formatResetLocal('not-a-date')).not.toThrow();
    expect(typeof formatResetLocal('')).toBe('string');
  });
});
