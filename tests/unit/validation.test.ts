import { describe, it, expect } from 'vitest';
import {
  MAX_INPUT_CHARS,
  paraphraseRequestSchema,
} from '@/lib/validation';
import type { ParaphraseRequest } from '@/lib/validation';
import type { Mode, Strength } from '@/lib/mode/prompts';
import { MODES, STRENGTHS } from '@/lib/mode/prompts';

describe('paraphraseRequestSchema', () => {
  it('accepts a valid payload', () => {
    const result = paraphraseRequestSchema.safeParse({
      text: 'Hello world',
      mode: 'standard',
      strength: 'light',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const parsed: ParaphraseRequest = result.data;
      expect(parsed.text).toBe('Hello world');
      expect(parsed.mode).toBe('standard');
      expect(parsed.strength).toBe('light');
    }
  });

  it('rejects empty and whitespace-only text', () => {
    expect(
      paraphraseRequestSchema.safeParse({
        text: '',
        mode: 'standard',
        strength: 'light',
      }).success,
    ).toBe(false);
    expect(
      paraphraseRequestSchema.safeParse({
        text: '   \n\t  ',
        mode: 'standard',
        strength: 'light',
      }).success,
    ).toBe(false);
  });

  it('rejects 5001 chars, accepts 5000', () => {
    const ok = { text: 'a'.repeat(5000), mode: 'standard', strength: 'light' } as const;
    expect(paraphraseRequestSchema.safeParse(ok).success).toBe(true);
    expect(paraphraseRequestSchema.safeParse({ ...ok, text: 'a'.repeat(5001) }).success).toBe(false);
  });

  it('MAX_INPUT_CHARS is exactly 5000', () => {
    expect(MAX_INPUT_CHARS).toBe(5000);
  });

  it('rejects unknown mode and empty strength', () => {
    expect(
      paraphraseRequestSchema.safeParse({
        text: 'hello',
        mode: 'pirate',
        strength: 'light',
      }).success,
    ).toBe(false);
    expect(
      paraphraseRequestSchema.safeParse({
        text: 'hello',
        mode: 'standard',
        strength: '',
      }).success,
    ).toBe(false);
  });

  it('accepts every mode/strength id exported by prompts.ts', () => {
    for (const m of MODES) {
      for (const s of STRENGTHS) {
        const mode: Mode = m.id;
        const strength: Strength = s.id;
        expect(
          paraphraseRequestSchema.safeParse({
            text: 'hello',
            mode,
            strength,
          }).success,
          `mode ${mode} / strength ${strength} should parse`,
        ).toBe(true);
      }
    }
  });

  it('parses hostile payload as inert data without transformation', () => {
    const hostile = {
      text: '<script>x</script>',
      mode: 'standard',
      strength: 'light',
    };
    const result = paraphraseRequestSchema.safeParse(hostile);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe('<script>x</script>');
    }
  });

  it('trims surrounding whitespace before enforcing length', () => {
    // Trim runs before the cap: padding beyond 5000 chars is fine once trimmed.
    const padded = 'a'.repeat(MAX_INPUT_CHARS);
    const paddedResult = paraphraseRequestSchema.safeParse({
      text: `  ${padded}  `,
      mode: 'standard',
      strength: 'light',
    });
    expect(paddedResult.success).toBe(true);
    if (paddedResult.success) {
      expect(paddedResult.data.text).toBe(padded);
    }
    // Whitespace is stripped from the parsed value.
    const result = paraphraseRequestSchema.safeParse({
      text: '  hello  ',
      mode: 'standard',
      strength: 'light',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe('hello');
    }
  });
});
