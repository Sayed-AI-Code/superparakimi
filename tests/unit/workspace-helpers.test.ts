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
 * Pinned instants, and the arithmetic behind every assertion below.
 *
 *   UTC           2026-03-14T05:30:31.000Z
 *   Karachi       UTC+05:00 (no DST since 2008)  05:30 + 5:00 = 10:30:31  → 14 Mar, 10
 *   New York      EDT, UTC-04:00 (DST began 2026-03-08, so the 14th is EDT)
 *                 05:30 - 4:00 = 01:30:31        → 14 Mar, 1
 *   UTC (wrong)   05:30:31                        → hour 5
 *
 *   UTC           2026-03-14T20:15:00.000Z  (the DATE-ROLLING instant)
 *   Karachi       +05:00 → 2026-03-15T01:15   → 15 Mar, 1   ← different DAY
 *   New York      -04:00 → 2026-03-14T16:15   → 14 Mar, 4 PM ← still the 14th
 *
 * The second instant is the one that matters most: `resetsAt` is always the
 * next UTC midnight, so a helper that got the ZONE wrong most plausibly gets
 * the DAY wrong too — and an hour-only assertion cannot see that, because
 * "1:15" and "16:15" both pass a /1/ test while disagreeing about the date.
 * These assertions therefore pin the WHOLE rendered string, date included.
 *
 * The exact strings are Node's default en-US `toLocaleString()` output on
 * this platform (verified by running the probe). If a future CI image ships a
 * non-en-US default locale these fail loudly, showing both strings — that is
 * the intended signal, not flake.
 */
const PINNED_UTC = '2026-03-14T05:30:31.000Z';
const DATE_ROLLING_UTC = '2026-03-14T20:15:00.000Z';

function probeIn(zone: string, instant: string = PINNED_UTC): string {
  // stderr is captured, not discarded, and rides along in the failure message:
  // a silenced pipe turns a RangeError or ERR_MODULE_NOT_FOUND into a bare
  // execFileSync failure with no diagnosis at all. The MODULE_TYPELESS_
  // PACKAGE_JSON notice Node prints for a bare .ts file is expected noise and
  // is no excuse for losing the real errors with it.
  let stderr = '';
  try {
    const out = execFileSync(process.execPath, [PROBE, instant], {
      env: { ...process.env, TZ: zone },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    return out.trim();
  } catch (error) {
    stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
    throw new Error(
      `TZ probe failed for zone=${zone} instant=${instant}\n${stderr}`,
      { cause: error },
    );
  }
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
  // Every assertion below pins the FULL string — date included. An hour token
  // alone survives a whole-day slip, and a whole-day slip is the realistic
  // failure for a value that is always "next UTC midnight".
  it('renders the full local date and time in Asia/Karachi (+05:00)', () => {
    expect(probeIn('Asia/Karachi')).toBe('3/14/2026, 10:30:31 AM');
    // If the helper leaked the UTC hour the string would read 5:30 instead.
    expect(probeIn('Asia/Karachi')).not.toMatch(/(?:^|\D)0?5:30/);
  });

  it('renders the full local date and time in America/New_York (EDT, -04:00)', () => {
    expect(probeIn('America/New_York')).toBe('3/14/2026, 1:30:31 AM');
    expect(probeIn('America/New_York')).not.toMatch(/(?:^|\D)0?5:30/);
  });

  it('rolls the calendar day the zone rolls it — the highest-value bug here', () => {
    // 2026-03-14T20:15Z is already the 15th in Karachi (+05:00) and still the
    // 14th in New York (-04:00). A helper that formats in a fixed zone — UTC,
    // or the server's — gets one of these two dates wrong.
    expect(probeIn('Asia/Karachi', DATE_ROLLING_UTC)).toBe('3/15/2026, 1:15:00 AM');
    expect(probeIn('America/New_York', DATE_ROLLING_UTC)).toBe('3/14/2026, 4:15:00 PM');
    // Same instant, different day: the day token must differ between zones.
    expect(probeIn('Asia/Karachi', DATE_ROLLING_UTC)).not.toEqual(
      probeIn('America/New_York', DATE_ROLLING_UTC),
    );
  });

  it('pins UTC itself to the naive reading, proving the two above are not vacuous', () => {
    // Under TZ=UTC the same instants render their UTC face. If these matched
    // the Karachi/New York strings above, those assertions would be proving
    // nothing because TZ were being ignored entirely.
    expect(probeIn('UTC')).toBe('3/14/2026, 5:30:31 AM');
    expect(probeIn('UTC', DATE_ROLLING_UTC)).toBe('3/14/2026, 8:15:00 PM');
  });

  it('produces different output for the two zones', () => {
    expect(probeIn('Asia/Karachi')).not.toEqual(probeIn('America/New_York'));
  });

  it('renders the production shape — resetsAt is always next UTC midnight', () => {
    // Every real resetsAt is the next UTC 00:00:00Z, so this is the case the
    // endpoint actually serves. Note the trap: it is 8 PM on the PREVIOUS
    // calendar day in New York. A helper that formatted the UTC date portion
    // would print 3/15 to a New York visitor whose reset is tonight, 3/14 —
    // wrong by a full day, invisible to any hour-only assertion.
    expect(probeIn('UTC', '2026-03-15T00:00:00.000Z')).toBe('3/15/2026, 12:00:00 AM');
    expect(probeIn('Asia/Karachi', '2026-03-15T00:00:00.000Z')).toBe('3/15/2026, 5:00:00 AM');
    expect(probeIn('America/New_York', '2026-03-15T00:00:00.000Z')).toBe(
      '3/14/2026, 8:00:00 PM',
    );
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
