import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { MAX_INPUT_CHARS } from '@/lib/validation';
import { capChars, countChars, wellFormedText } from '@/lib/workspace/helpers';

/**
 * The cap must be counted the way zod counts it. zod v4 `.max(n)` compares
 * against CODE POINTS, while `String.prototype.length` is UTF-16 UNITS — so an
 * implementation using `.length`/`.slice` disagrees with the server for every
 * astral-plane character (emoji, most CJK-ext, musical symbols).
 *
 * Verified consequences of the old `.slice(0, 5000)` implementation:
 *   - 4,000 emoji = 4,000 code points (server-legal) = 8,000 UTF-16 units
 *     -> trimmed to 2,500 emoji, destroying 1,500 legitimate characters while
 *        the UI claimed it had trimmed to the limit.
 *   - 'a'.repeat(4999) + one emoji -> slice strands a LONE HIGH SURROGATE,
 *     which zod accepts and an upstream tokenizer can reject.
 */
const zodSchema = z.string().trim().min(1).max(MAX_INPUT_CHARS);

describe('countChars agrees with zod', () => {
  it('counts code points, not UTF-16 units', () => {
    const emoji = '😀'.repeat(4000);
    expect(emoji.length).toBe(8000);
    expect(countChars(emoji)).toBe(4000);
    // The whole point: zod accepts this, so the UI must not touch it.
    expect(zodSchema.safeParse(emoji).success).toBe(true);
    expect(capChars(emoji, MAX_INPUT_CHARS)).toEqual({
      text: emoji,
      truncated: false,
    });
  });

  it('accepts exactly 5,000 emoji untouched', () => {
    const emoji = '😀'.repeat(MAX_INPUT_CHARS);
    expect(countChars(emoji)).toBe(5000);
    const capped = capChars(emoji, MAX_INPUT_CHARS);
    expect(capped.truncated).toBe(false);
    expect(capped.text).toBe(emoji);
    expect(zodSchema.safeParse(capped.text).success).toBe(true);
  });

  it('rejects 5,001 emoji down to 5,000 code points and stays zod-legal', () => {
    const emoji = '😀'.repeat(MAX_INPUT_CHARS + 1);
    expect(zodSchema.safeParse(emoji).success).toBe(false);
    const capped = capChars(emoji, MAX_INPUT_CHARS);
    expect(capped.truncated).toBe(true);
    expect(countChars(capped.text)).toBe(5000);
    expect(capped.text).toBe(emoji.slice(0, 10_000));
    expect(zodSchema.safeParse(capped.text).success).toBe(true);
  });

  it('counts mixed BMP + astral text the way zod does', () => {
    const mixed = `${'a'.repeat(4999)}😀`;
    expect(mixed.length).toBe(5001); // UTF-16 lies
    expect(countChars(mixed)).toBe(5000);
    expect(zodSchema.safeParse(mixed).success).toBe(true);
    expect(capChars(mixed, MAX_INPUT_CHARS).truncated).toBe(false);
  });
});

describe('capChars never strands a surrogate pair', () => {
  it('does not cut a pair in half at the boundary', () => {
    const input = `${'a'.repeat(MAX_INPUT_CHARS - 1)}😀`; // 5,000 cp / 5,001 units
    const capped = capChars(input, MAX_INPUT_CHARS);
    expect(countChars(capped.text)).toBe(MAX_INPUT_CHARS);
    expect(capped.text.isWellFormed()).toBe(true);
    expect(capped.text.endsWith('😀')).toBe(true);

    // The naive implementation this replaces — kept as the counter-example, so
    // a regression to .slice() fails here with a readable diff.
    const naive = input.slice(0, MAX_INPUT_CHARS);
    expect(naive.isWellFormed()).toBe(false);
  });

  it('truncation boundary always lands between complete code points', () => {
    const input = '😀'.repeat(3000);
    for (const max of [1, 3, 999, 2999, 3000]) {
      const capped = capChars(input, max);
      expect(capped.text.isWellFormed()).toBe(true);
      expect(countChars(capped.text)).toBeLessThanOrEqual(max);
    }
  });
});

describe('wellFormedText keeps the outbound payload sendable', () => {
  it('replaces a lone surrogate with U+FFFD rather than shipping it', () => {
    const lone = `${'hello'}${String.fromCharCode(0xd800)}world`;
    expect(lone.isWellFormed()).toBe(false);
    const safe = wellFormedText(lone);
    expect(safe.isWellFormed()).toBe(true);
    expect(safe).not.toContain(String.fromCharCode(0xd800));
    expect(safe).toContain('hello');
    expect(safe).toContain('world');
  });

  it('is a no-op on well-formed text, including emoji and combining marks', () => {
    const fine = 'naïve 🦊 🧮 combine';
    expect(wellFormedText(fine)).toBe(fine);
  });

  it('survives a lone low surrogate and a lone surrogate at the very end', () => {
    for (const input of [
      `${String.fromCharCode(0xdc00)}tail`,
      `head${String.fromCharCode(0xd800)}`,
      String.fromCharCode(0xd800),
    ]) {
      const safe = wellFormedText(input);
      expect(safe.isWellFormed()).toBe(true);
    }
  });
});
