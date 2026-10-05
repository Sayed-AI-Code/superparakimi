import { asc, eq } from 'drizzle-orm';
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { accounts, getDb, users } from '@/db';
import { auth, GOOGLE_ONLY_SIGN_IN_MESSAGE } from '@/lib/auth';
import { describeErrorForLog } from '@/lib/auth/log';
import { safeRedirectTarget } from '@/lib/auth/redirect';
import { setPassword } from '@/lib/account/actions';

export const metadata: Metadata = {
  title: 'Account · superparakimi',
  description: 'Your sign-in methods and password.',
};

// How a provider id is named to the user. Unknown providers render their raw
// id — an invented label would be a lie about a connection we cannot name.
const PROVIDER_LABELS: Record<string, string> = {
  google: 'Google',
  credentials: 'Email and password',
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * /account — email, connected sign-in methods, and add/change password
 * (spec §5). Server component: the password form is a plain progressive
 * <form> with an inline Server Action, so it submits with no client JS.
 *
 * Defense in depth: proxy.ts matches '/account/:path*' and sends anonymous
 * visitors to /signin, but this page does not depend on that. The proxy is
 * routing, not a security boundary — the matcher list lives in a different
 * file from this one, and a page that trusts it renders account data the
 * moment the matcher is edited or a rendered RSC payload reaches the route
 * some other way. So the session and the row are re-read here, and the
 * mutation re-checks again inside setPassword.
 */
export default async function AccountPage(props: PageProps<'/account'>) {
  const params = await props.searchParams;

  const session = await auth();
  const userId = session?.user?.id;
  // No signed-in user means there is no account to show and no id to query
  // by. /signin is ours, not user-supplied; it still goes through the
  // sanitizer because the rule is that no redirect ever skips it.
  if (!userId) redirect(safeRedirectTarget('/signin'));

  const db = await getDb();

  // Authoritative row, not the JWT: the token can outlive an email change.
  const user = await db.query.users
    .findFirst({
      where: eq(users.id, userId),
      columns: { email: true, passwordHash: true },
    })
    .catch((error: unknown) => {
      // Never a raw error: DrizzleQueryError embeds SQL and params.
      console.error('account.read.failed', describeErrorForLog(error));
      return null;
    });

  if (!user) redirect(safeRedirectTarget('/signin'));

  const rows = await db.query.accounts
    .findMany({
      where: eq(accounts.userId, userId),
      columns: { provider: true },
      // Stable order; `accounts` has no created_at column, so provider id is
      // the only sortable thing we select.
      orderBy: asc(accounts.provider),
    })
    .catch((error: unknown) => {
      // A failed provider read must not blank the page or leak the query:
      // the accounts table holds access and ID tokens, so the SQL itself is
      // sensitive. The password section renders independently of this.
      console.error('account.providers.read.failed', describeErrorForLog(error));
      return null;
    });

  const providers = [...new Set((rows ?? []).map((row) => row.provider))];
  const hasPassword = user.passwordHash !== null;
  const googleOnly = !hasPassword && providers.includes('google');

  const err = typeof params.err === 'string' ? params.err : null;
  const saved = params.saved === '1';

  return (
    <main className="flex flex-1 flex-col items-center px-6 py-16">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Account
        </h1>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          Signed in as{' '}
          <span className="font-mono text-black dark:text-zinc-50">{user.email}</span>
        </p>

        {err && (
          <p
            role="alert"
            className="mt-6 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {err}
          </p>
        )}
        {saved && (
          <p className="mt-6 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
            {hasPassword ? 'Password changed.' : 'Password added.'}
          </p>
        )}

        <section className="mt-8" aria-labelledby="methods-heading">
          <h2
            id="methods-heading"
            className="text-xs font-medium uppercase tracking-wide text-zinc-500"
          >
            Sign-in methods
          </h2>
          {providers.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              {rows === null
                ? 'Sign-in methods unavailable right now.'
                : 'No connected sign-in methods on record.'}
            </p>
          ) : (
            <ul className="mt-2 flex flex-wrap gap-2">
              {providers.map((provider) => (
                <li
                  key={provider}
                  className="rounded-full border border-black/10 px-3 py-1 font-mono text-xs text-black dark:border-white/15 dark:text-zinc-50"
                >
                  {providerLabel(provider)}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* The password section only ever renders for a reason: a form to add
            a password when there is none, or to change one when there is. */}
        <section className="mt-8" aria-labelledby="password-heading">
          <h2
            id="password-heading"
            className="text-xs font-medium uppercase tracking-wide text-zinc-500"
          >
            {hasPassword ? 'Change password' : 'Add password'}
          </h2>

          {googleOnly && (
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              {GOOGLE_ONLY_SIGN_IN_MESSAGE}. Adding a password lets you sign in with this
              email as well — it does not remove Google.
            </p>
          )}

          <form
            className="mt-3 flex flex-col gap-3"
            action={async (formData: FormData) => {
              'use server';
              const result = await setPassword(userId, {
                current: String(formData.get('current') ?? ''),
                next: String(formData.get('next') ?? ''),
              });
              if ('error' in result) {
                redirect(
                  safeRedirectTarget(`/account?err=${encodeURIComponent(result.error)}`),
                );
              }
              redirect(safeRedirectTarget('/account?saved=1'));
            }}
          >
            {hasPassword && (
              <label className="flex flex-col gap-1 text-sm">
                Current password
                <input
                  type="password"
                  name="current"
                  required
                  autoComplete="current-password"
                  className="rounded-md border border-black/10 bg-white px-3 py-2 text-black dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50"
                />
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              {hasPassword ? 'New password' : 'Password'}
              <input
                type="password"
                name="next"
                required
                minLength={8}
                autoComplete={hasPassword ? 'new-password' : 'new-password'}
                className="rounded-md border border-black/10 bg-white px-3 py-2 text-black dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50"
              />
            </label>
            <button
              type="submit"
              className="mt-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
            >
              {hasPassword ? 'Change password' : 'Add password'}
            </button>
          </form>
        </section>

        <p className="mt-10 text-sm text-zinc-600 dark:text-zinc-400">
          <Link
            href="/app"
            className="font-medium text-black underline dark:text-zinc-50"
          >
            Back to the workspace
          </Link>
        </p>
      </div>
    </main>
  );
}
