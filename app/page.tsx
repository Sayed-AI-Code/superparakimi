import Link from 'next/link';
import type { Metadata } from 'next';

import { MODES, STRENGTHS } from '@/lib/mode/prompts';
import { FREE_DAILY_LIMIT } from '@/lib/quota/limit';

export const metadata: Metadata = {
  title: 'superparakimi — paraphrase with control over mode and strength',
  description:
    'Rewrite text in six modes and three intensities, streamed back live. Free plan: 10 paraphrases a day.',
};

// One line per mode, from the same MODES array that drives the workspace
// selector and the system prompts in lib/mode/prompts.ts. Not a hand-copied
// list: adding a mode there puts it here, so the landing page cannot advertise
// a mode the engine does not implement (or omit one it does).
const MODE_COPY: Record<string, string> = {
  standard: 'Faithful everyday English — the safe default.',
  fluent: 'Idiomatic and smooth, like a strong native writer.',
  simple: 'Plain words, short sentences, easy on first read.',
  formal: 'Polished and professional, no contractions.',
  creative: 'Bolder wording and varied rhythm, same meaning.',
  academic: 'Precise, cautious, scholarly register.',
};

/**
 * Landing page (spec §5). Server component only — no `'use client'`, no state,
 * no handlers: the interactive surface is /app, and the only thing on this
 * page that does anything is a link. The free-tier number is
 * `FREE_DAILY_LIMIT` from lib/quota/limit.ts rather than a literal 10, so the
 * copy cannot drift from what the quota service actually enforces, and no usage
 * figures or testimonials are invented.
 */
export default function LandingPage() {
  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16 sm:py-24">
      <div className="w-full max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-widest text-zinc-500">
          {MODES.length} modes · {STRENGTHS.length} intensities
        </p>
        <h1 className="mt-3 text-4xl font-semibold leading-tight tracking-tight text-black sm:text-5xl dark:text-zinc-50">
          Paraphrase with control, not a coin flip.
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-zinc-600 dark:text-zinc-400">
          Paste your text, pick a mode and how hard you want it rewritten, and read
          the result as it streams in. Grammar cleanup or a full rebuild of every
          sentence — you decide, and the meaning stays yours.
        </p>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/signup"
            className="flex h-12 items-center justify-center rounded-full bg-black px-6 font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Get started free
          </Link>
          <Link
            href="/signin"
            className="flex h-12 items-center justify-center rounded-full border border-black/10 px-6 font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
          >
            Sign in
          </Link>
        </div>

        <p className="mt-4 font-mono text-sm text-zinc-600 dark:text-zinc-400">
          {FREE_DAILY_LIMIT} free paraphrases/day
        </p>

        <section className="mt-16" aria-labelledby="modes-heading">
          <h2
            id="modes-heading"
            className="text-xs font-medium uppercase tracking-wide text-zinc-500"
          >
            Modes
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {MODES.map((mode) => (
              <li
                key={mode.id}
                className="rounded-lg border border-black/10 p-4 dark:border-white/10"
              >
                <span className="font-mono text-sm font-semibold text-black dark:text-zinc-50">
                  {mode.label}
                </span>
                <p className="mt-1 text-sm leading-6 text-zinc-600 dark:text-zinc-400">
                  {MODE_COPY[mode.id] ?? 'Rewritten to a distinct register.'}
                </p>
              </li>
            ))}
          </ul>
        </section>

        <section className="mt-12" aria-labelledby="strength-heading">
          <h2
            id="strength-heading"
            className="text-xs font-medium uppercase tracking-wide text-zinc-500"
          >
            Strength
          </h2>
          <p className="mt-4 text-sm leading-7 text-zinc-600 dark:text-zinc-400">
            Every mode runs at{' '}
            {STRENGTHS.map((strength, index) => (
              <span key={strength.id}>
                {index > 0 && ', '}
                <span className="font-mono text-black dark:text-zinc-50">
                  {strength.label}
                </span>
              </span>
            ))}
            {', '}
            from a light touch on wording to a paragraph rebuilt from its ideas.
          </p>
        </section>
      </div>
    </main>
  );
}
