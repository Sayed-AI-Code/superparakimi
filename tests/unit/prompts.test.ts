import { describe, it, expect } from 'vitest';
import { MODES, STRENGTHS, getSystemPrompt } from '@/lib/mode/prompts';
import type { Mode, Strength } from '@/lib/mode/prompts';

describe('prompt table', () => {
  it('all 18 combinations return non-empty prompts', () => {
    for (const m of MODES) for (const s of STRENGTHS)
      expect(getSystemPrompt(m.id, s.id).length).toBeGreaterThan(40);
  });
  it('unknown mode throws', () => {
    expect(() => getSystemPrompt('pirate' as Mode, 'light')).toThrow(RangeError);
    expect(() => getSystemPrompt('standard', 'turbo' as Strength)).toThrow(RangeError);
  });
  it('all 18 prompts are pairwise distinct', () => {
    const seen = new Map<string, string>();
    for (const m of MODES)
      for (const s of STRENGTHS) {
        const key = `${m.id}:${s.id}`;
        const prompt = getSystemPrompt(m.id, s.id);
        const previous = seen.get(prompt);
        expect(
          previous,
          `prompt for ${key} duplicates prompt for ${previous}`,
        ).toBeUndefined();
        seen.set(prompt, key);
      }
    expect(seen.size).toBe(18);
  });
});
