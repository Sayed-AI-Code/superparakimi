/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// signUpWithEmail is replaced with a spy so this file never touches the
// database; the allowlist constants come through untouched via importOriginal,
// because pinning the page against the REAL list is the entire point — a mock
// that returned the list would let the page and the list drift apart while
// this suite stayed green.
vi.mock('@/lib/auth/signup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/signup')>();
  return { ...actual, signUpWithEmail: vi.fn() };
});

import SignUpPage from '@/app/signup/page';
import { GENERIC_SIGNUP_ERROR, SIGN_UP_ERRORS } from '@/lib/auth/signup';

// `globals` is off in vitest.config.ts, so cleanup is on us. Without it these
// renders accumulate in document.body and getByRole('alert) can match a
// leftover render from an earlier test and pass for the wrong reason.
afterEach(cleanup);

async function page(searchParams: Record<string, string>) {
  return SignUpPage({ searchParams: Promise.resolve(searchParams) } as never);
}

describe('/signup — ?error= is allowlisted, never raw', () => {
  it('refuses attacker-chosen copy (content spoofing, not XSS)', async () => {
    // React escaping rules out script execution. The defect is different: any
    // sentence a stranger puts in the URL would render inside an official red
    // role="alert" on a PUBLIC, unauthenticated page, above a live password
    // field — which reads to a visitor as an instruction from us.
    const payload = 'Your account will be charged $5 unless you re-enter your password';
    render(await page({ error: payload }));

    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).not.toContain('charged $5');
    expect(alert).not.toContain('re-enter your password');
    expect(alert).toBe(GENERIC_SIGNUP_ERROR);
  });

  it('refuses plausible-forped real messages that are not in the list', async () => {
    for (const payload of [
      'Email already registered!',
      'email already registered',
      'Password must be at least 8 charachters',
      'Sign in to continue',
      'You have 0 paraphrases left',
    ]) {
      render(await page({ error: payload }));
      expect(screen.getByRole('alert').textContent).toBe(GENERIC_SIGNUP_ERROR);
      cleanup();
    }
  });

  it('still renders every message signUpWithEmail can actually emit', async () => {
    // The other half of the contract: the allowlist must not swallow real
    // errors. Iterated over the exported list itself so a message added to the
    // schema and forgotten here fails, rather than silently degrading.
    for (const message of SIGN_UP_ERRORS) {
      render(await page({ error: message }));
      expect(screen.getByRole('alert').textContent).toBe(message);
      cleanup();
    }
  });

  it('renders no alert at all when there is no error', async () => {
    render(await page({}));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
