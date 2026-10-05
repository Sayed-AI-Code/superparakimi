import { CredentialsSignin } from 'next-auth';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  signIn,
  GOOGLE_ONLY_SIGN_IN_CODE,
  GOOGLE_ONLY_SIGN_IN_MESSAGE,
} from '@/lib/auth';

// callbackUrl arrives from the proxy (absolute, same-origin) or a crafted
// link: keep only same-origin paths, never protocol-relative ones.
function safeRedirectTarget(raw: string | undefined): string {
  if (!raw) return '/app';
  let path = raw;
  try {
    const url = new URL(raw);
    path = `${url.pathname}${url.search}`;
  } catch {
    // Not absolute — treat as a path below.
  }
  if (!path.startsWith('/') || path.startsWith('//')) return '/app';
  return path;
}

function notice(
  err: string | undefined,
  code: string | undefined,
  error: string | undefined,
  registered: string | undefined,
): { text: string; tone: 'error' | 'ok' } | null {
  if (err === GOOGLE_ONLY_SIGN_IN_CODE || code === GOOGLE_ONLY_SIGN_IN_CODE) {
    return { text: GOOGLE_ONLY_SIGN_IN_MESSAGE, tone: 'error' };
  }
  if (err) return { text: 'Invalid email or password.', tone: 'error' };
  if (error) return { text: 'Sign-in failed. Please try again.', tone: 'error' };
  if (registered) return { text: 'Account created. Sign in to continue.', tone: 'ok' };
  return null;
}

export default async function SignInPage(props: PageProps<'/signin'>) {
  const params = await props.searchParams;
  const text = (key: string): string | undefined => {
    const value = params[key];
    return typeof value === 'string' ? value : undefined;
  };
  const callbackUrl = safeRedirectTarget(text('callbackUrl'));
  const note = notice(text('err'), text('code'), text('error'), text('registered'));

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Sign in
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Continue paraphrasing where you left off.
        </p>

        {note && (
          <p
            role={note.tone === 'error' ? 'alert' : undefined}
            className={`mb-4 rounded-md px-3 py-2 text-sm ${
              note.tone === 'error'
                ? 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300'
                : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300'
            }`}
          >
            {note.text}
          </p>
        )}

        <form
          className="flex flex-col gap-3"
          action={async (formData: FormData) => {
            'use server';
            const target = safeRedirectTarget(String(formData.get('callbackUrl') ?? ''));
            try {
              await signIn('credentials', {
                email: formData.get('email') ?? '',
                password: formData.get('password') ?? '',
                redirectTo: target,
              });
            } catch (error) {
              // signIn exits via redirect() on success; only sign-in
              // rejections are re-routed to the form here.
              if (error instanceof CredentialsSignin) {
                const code = String((error as { code?: string }).code ?? 'credentials');
                redirect(`/signin?err=${encodeURIComponent(code)}&callbackUrl=${encodeURIComponent(target)}`);
              }
              throw error;
            }
          }}
        >
          <input type="hidden" name="callbackUrl" value={callbackUrl} />
          <label className="flex flex-col gap-1 text-sm">
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              className="rounded-md border border-black/10 bg-white px-3 py-2 text-black dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            Password
            <input
              type="password"
              name="password"
              required
              autoComplete="current-password"
              className="rounded-md border border-black/10 bg-white px-3 py-2 text-black dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          <button
            type="submit"
            className="mt-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Sign in
          </button>
        </form>

        <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wide text-zinc-400">
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
          or
          <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        </div>

        <form
          action={async () => {
            'use server';
            await signIn('google', { redirectTo: callbackUrl });
          }}
        >
          <button
            type="submit"
            className="w-full rounded-full border border-black/10 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
          >
            Continue with Google
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          No account?{' '}
          <Link href="/signup" className="font-medium text-black underline dark:text-zinc-50">
            Sign up
          </Link>
        </p>
      </div>
    </main>
  );
}
