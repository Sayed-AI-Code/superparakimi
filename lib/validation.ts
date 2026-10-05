import { z } from 'zod';
import type { Mode, Strength } from '@/lib/mode/prompts';

export const MAX_INPUT_CHARS = 5000;

const MODE_IDS = [
  'standard',
  'fluent',
  'simple',
  'formal',
  'creative',
  'academic',
] as const satisfies readonly Mode[];

const STRENGTH_IDS = [
  'light',
  'medium',
  'strong',
] as const satisfies readonly Strength[];

export const paraphraseRequestSchema = z.object({
  text: z.string().trim().min(1).max(MAX_INPUT_CHARS),
  mode: z.enum(MODE_IDS),
  strength: z.enum(STRENGTH_IDS),
});

export type ParaphraseRequest = z.infer<typeof paraphraseRequestSchema>;
