/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { MODES } from '@/lib/mode/prompts';
import { FREE_DAILY_LIMIT } from '@/lib/quota/limit';
import LandingPage from '@/app/page';

// vitest.config.ts does not set globals: true, so testing-library's automatic
// cleanup never registers. Without this afterEach, every render in the file
// stays in document.body and each test asserts against the accumulated output
// of all the previous ones — which is exactly how a "6 modes" assertion ends
// up looking at 12.
afterEach(cleanup);

// The landing page is a plain Server Component: awaiting it yields a resolved
// element tree, which jsdom renders. No client component is involved.
const page = () => render(LandingPage());

describe('landing page (spec §5)', () => {
  it('states the free-tier allowance from FREE_DAILY_LIMIT, not a literal 10', () => {
    page();

    expect(screen.getByText(`${FREE_DAILY_LIMIT} free paraphrases/day`)).toBeTruthy();
    // Per-element, not body.textContent: adjacent inline elements concatenate
    // with no separator ("Sign in10 free…"), so a whole-document regex is
    // unreliable here. If a second element ever advertises a different number,
    // that one is a hardcoded lie against the constant the quota enforces.
    const claims = screen
      .getAllByText(/\d+ free paraphrases\/day/)
      .map((el) => el.textContent ?? '');
    expect(claims).toEqual([`${FREE_DAILY_LIMIT} free paraphrases/day`]);
  });

  it('shows every mode from MODES, and exactly that many', () => {
    page();
    const text = document.body.textContent ?? '';

    for (const mode of MODES) {
      expect(text).toContain(mode.label);
    }
    // A count mismatch means the list is being hand-maintained somewhere.
    expect(document.querySelectorAll('[aria-labelledby="modes-heading"] li')).toHaveLength(
      MODES.length,
    );
  });

  it('ships no Next.js or Vercel scaffold links', () => {
    page();

    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs.some((href) => /nextjs\.org|vercel\.com|next\.svg|vercel\.svg/i.test(href))).toBe(
      false,
    );
  });

  it('offers sign-in and sign-up CTAs, linking only same-origin paths', () => {
    page();

    const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
    expect(hrefs).toContain('/signin');
    expect(hrefs).toContain('/signup');
    // Zero client JS beyond links, and nothing off-origin to hand to a browser.
    for (const href of hrefs) expect(href.startsWith('/')).toBe(true);
  });

  it('invents no usage numbers or testimonials', () => {
    page();
    const text = document.body.textContent ?? '';

    expect(text).not.toMatch(/\d+\+?\s*(happy|satisfied|trusted|users|customers|reviews)/i);
    expect(text).not.toMatch(/star rating|5\/5|#1 (paraphraser|tool)/i);
  });
});
