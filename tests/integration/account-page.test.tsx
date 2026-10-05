/** @vitest-environment jsdom */
// Component tests for /account: the conditional password form, the provider
// list, and the anonymous redirect. auth() is the sanctioned session seam;
// the database stays REAL so "add vs change" and the provider chips come from
// users.password_hash and the accounts table rather than a fixture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { accounts, getDb, resetTestDb, users } from '@/db';
import { SET_PASSWORD_ERRORS, UNSPECIFIED } from '@/lib/account/actions';
import { hashPassword } from '@/lib/auth/passwords';

// vitest.config.ts does not set globals: true, so testing-library's automatic
// cleanup never registers. Without this, every render in the file stays in
// document.body and later tests assert against the accumulated output of
// earlier ones — two of the assertions below would then pass for the wrong
// reason (a Google-only notice rendered by a previous test).
afterEach(cleanup);

// The spec'd literals live in lib/auth.ts, which the page imports from — so
// the mock has to carry them too, or the page renders "undefined" as its
// notice and the test passes while the UI is broken.
vi.mock('@/lib/auth', () => ({
  auth: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  GOOGLE_ONLY_SIGN_IN_CODE: 'google_only',
  GOOGLE_ONLY_SIGN_IN_MESSAGE: 'This account uses Google sign-in',
}));

import { auth, GOOGLE_ONLY_SIGN_IN_MESSAGE } from '@/lib/auth';
import AccountPage from '@/app/account/page';

const mockedAuth = vi.mocked(auth);

async function makeUser(email: string, passwordHash: string | null) {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash })
    .returning({ id: users.id, email: users.email });
  return row;
}

async function addAccount(userId: string, provider: string, extra?: Record<string, string>) {
  const db = await getDb();
  await db.insert(accounts).values({
    userId,
    type: 'oauth',
    provider,
    providerAccountId: `${provider}-${crypto.randomUUID()}`,
    ...extra,
  });
}

const anonymousProps = { searchParams: Promise.resolve({}) } as never;

beforeEach(async () => {
  vi.restoreAllMocks();
  await resetTestDb();
});

describe('/account page', () => {
  it('redirects an anonymous visitor rather than rendering account data', async () => {
    mockedAuth.mockResolvedValue(null as never);

    // redirect() throws the framework's control-flow error. That throw IS the
    // guarantee: no session, no rendered account page, at the page level —
    // not only via the proxy matcher.
    await expect(AccountPage(anonymousProps)).rejects.toThrow();
  });

  it('offers "Add password" and no current-password field to a NULL-hash user', async () => {
    const user = await makeUser('g@example.com', null);
    await addAccount(user.id, 'google');
    mockedAuth.mockResolvedValue({ user } as never);

    render(await AccountPage(anonymousProps));

    expect(screen.getByRole('heading', { name: 'Add password' })).toBeTruthy();
    expect(document.querySelector('input[name="current"]')).toBeNull();
    expect(document.querySelector('input[name="next"]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Add password' })).toBeTruthy();
  });

  it('shows the Google-only notice verbatim for a Google-only account', async () => {
    const googleOnly = await makeUser('g2@example.com', null);
    await addAccount(googleOnly.id, 'google');
    mockedAuth.mockResolvedValue({ user: googleOnly } as never);

    render(await AccountPage(anonymousProps));

    // Verbatim spec copy, matched exactly at its start rather than skimmed.
    expect(screen.getByText(new RegExp(`^${GOOGLE_ONLY_SIGN_IN_MESSAGE}`))).toBeTruthy();
  });

  it('does not tell a password account that it is Google-only', async () => {
    const withPassword = await makeUser('p2@example.com', await hashPassword('hunter2-horse'));
    await addAccount(withPassword.id, 'credentials');
    mockedAuth.mockResolvedValue({ user: withPassword } as never);

    render(await AccountPage(anonymousProps));

    expect(screen.queryByText(new RegExp(GOOGLE_ONLY_SIGN_IN_MESSAGE))).toBeNull();
  });

  it('offers "Change password" with a current-password field once a hash exists', async () => {
    const user = await makeUser('p@example.com', await hashPassword('hunter2-horse'));
    mockedAuth.mockResolvedValue({ user } as never);

    render(await AccountPage(anonymousProps));

    expect(screen.getByRole('heading', { name: 'Change password' })).toBeTruthy();
    expect(document.querySelector('input[name="current"]')).not.toBeNull();
    expect(document.querySelector('input[name="next"]')).not.toBeNull();
  });

  it('lists connected providers read from the accounts table', async () => {
    const user = await makeUser('multi@example.com', await hashPassword('hunter2-horse'));
    await addAccount(user.id, 'google');
    await addAccount(user.id, 'credentials');
    mockedAuth.mockResolvedValue({ user } as never);

    render(await AccountPage(anonymousProps));
    const text = document.body.textContent ?? '';

    expect(text).toContain('Google');
    expect(text).toContain('Email and password');
    expect(text).toContain('multi@example.com');
  });

  it('renders no token, hash or SQL, and never raw HTML', async () => {
    const user = await makeUser('leak@example.com', await hashPassword('hunter2-horse'));
    await addAccount(user.id, 'google', {
      access_token: 'ya29.SECRETACCESS',
      id_token: 'eyJ.SECRETID',
      refresh_token: 'SECRETREFRESH',
    });
    mockedAuth.mockResolvedValue({ user } as never);

    render(await AccountPage(anonymousProps));
    const html = document.body.innerHTML;

    expect(html).not.toContain('SECRETACCESS');
    expect(html).not.toContain('SECRETID');
    expect(html).not.toContain('SECRETREFRESH');
    expect(html).not.toMatch(/\$2[aby]\$/);
    expect(html).not.toMatch(/select .+ from /i);
  });

  it('surfaces the ?err= message the action produced, as text', async () => {
    const user = await makeUser('err@example.com', await hashPassword('hunter2-horse'));
    mockedAuth.mockResolvedValue({ user } as never);

    render(
      await AccountPage({
        searchParams: Promise.resolve({ err: 'Current password is incorrect.' }),
      } as never),
    );

    expect(screen.getByRole('alert').textContent).toBe('Current password is incorrect.');
  });

  it('refuses to render attacker-chosen ?err= copy (content spoofing, not XSS)', async () => {
    // React escaping rules out script execution here, but that is not the
    // defect. The defect is that ANY text an attacker puts in the URL would
    // appear inside an official-looking role="alert" bubble directly above a
    // live password field — which reads as an instruction from us.
    const user = await makeUser('spoof@example.com', await hashPassword('hunter2-horse'));
    mockedAuth.mockResolvedValue({ user } as never);

    const payload = 'Your password expires today. Reset it below to keep access.';
    render(
      await AccountPage({
        searchParams: Promise.resolve({ err: payload }),
      } as never),
    );

    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).not.toContain('expires today');
    expect(alert).not.toContain('Reset it below');
    expect(alert).toBe(UNSPECIFIED);
  });

  it('still renders every message the action can actually emit', async () => {
    const user = await makeUser('known@example.com', await hashPassword('hunter2-horse'));
    mockedAuth.mockResolvedValue({ user } as never);

    for (const message of SET_PASSWORD_ERRORS) {
      render(
        await AccountPage({
          searchParams: Promise.resolve({ err: message }),
        } as never),
      );
      expect(screen.getByRole('alert').textContent).toBe(message);
      cleanup();
    }
  });
});
