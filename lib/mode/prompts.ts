export type Mode =
  | 'standard'
  | 'fluent'
  | 'simple'
  | 'formal'
  | 'creative'
  | 'academic';

export type Strength = 'light' | 'medium' | 'strong';

export const MODES: readonly { id: Mode; label: string }[] = [
  { id: 'standard', label: 'Standard' },
  { id: 'fluent', label: 'Fluent' },
  { id: 'simple', label: 'Simple' },
  { id: 'formal', label: 'Formal' },
  { id: 'creative', label: 'Creative' },
  { id: 'academic', label: 'Academic' },
];

export const STRENGTHS: readonly { id: Strength; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'medium', label: 'Medium' },
  { id: 'strong', label: 'Strong' },
];

const BASE =
  "You are a paraphrasing engine. Rewrite the user's text, preserving meaning. Output only the rewritten text.";

const TONE: Record<Mode, string> = {
  standard:
    'Keep a neutral, faithful register: natural everyday English that mirrors the original voice without adding flourish.',
  fluent:
    "Make the text read as if written by an articulate native speaker: idiomatic phrasing, smooth rhythm, and no stiff or translated-sounding constructions.",
  simple:
    'Use plain, common words and short declarative sentences; break dense ideas into smaller ones so a general audience understands on first read.',
  formal:
    'Adopt a polished, professional register: prefer full forms over contractions, and use courteous, objective phrasing suitable for business or official correspondence.',
  creative:
    'Take real liberties with expression: vivid verbs, varied sentence lengths, and unexpected word choices, while the underlying meaning stays exactly intact.',
  academic:
    'Write in a scholarly register: precise discipline-neutral vocabulary, careful hedging where claims are uncertain, and impersonal prose suitable for a research context.',
};

const DEPTH: Record<Strength, string> = {
  light:
    'Edit lightly: fix grammar, tighten awkward phrases, and refresh repeated words while keeping the original sentence order and structure intact.',
  medium:
    'Rewrite at sentence level: merge or split sentences, substitute strong synonyms, and reorder clauses where it improves flow, without dropping or adding ideas.',
  strong:
    'Rebuild each paragraph from its core ideas: restructure the argument, vary how each sentence opens, and choose genuinely new wording throughout, staying faithful to the original meaning.',
};

function buildPrompts(): Record<`${Mode}:${Strength}`, string> {
  const prompts = {} as Record<`${Mode}:${Strength}`, string>;
  for (const mode of MODES) {
    for (const strength of STRENGTHS) {
      prompts[`${mode.id}:${strength.id}`] =
        `${BASE} ${TONE[mode.id]} ${DEPTH[strength.id]}`;
    }
  }
  return prompts;
}

const PROMPTS = buildPrompts();

export function getSystemPrompt(mode: Mode, strength: Strength): string {
  const prompt = PROMPTS[`${mode}:${strength}`];
  if (!prompt) {
    throw new RangeError(
      `Unknown prompt key "${mode}:${strength}" — mode and strength must be valid ids.`,
    );
  }
  return prompt;
}
