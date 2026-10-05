import Link from 'next/link';
import { redirect } from 'next/navigation';

import { signUpWithEmail } from '@/lib/auth/signup';

export default async function SignUpPage(props: PageProps<'/signup'>) {
  const params = await props.searchParams;
  const error =
    typeof params.error === 'string' && params.error.length > 0 ? params.error : null;

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
          Create an account
        </h1>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          Free plan. No card required.
        </p>

        {error && (
          <p
            role="alert"
            className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {error}
          </p>
        )}

        <form
          className="flex flex-col gap-3"
          action={async (formData: FormData) => {
            'use server';
            const result = await signUpWithEmail({
              email: String(formData.get('email') ?? ''),
              password: String(formData.get('password') ?? ''),
            }).catch((error: unknown) => {
              // signUpWithEmail rethrows unexpected failures (everything but
              // duplicate-email) so they are never anonymous: log the
              // error's message + stack server-side, render a generic
              // string to the user. Credentials never reach the log.
              console.error('[signup] signUpWithEmail failed', error);
              return { error: 'Something went wrong. Please try again.' };
            });
            if ('error' in result) {
              redirect(`/signup?error=${encodeURIComponent(result.error)}`);
            }
            redirect('/signin?registered=1');
          }}
        >
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
              minLength={8}
              autoComplete="new-password"
              className="rounded-md border border-black/10 bg-white px-3 py-2 text-black dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50"
            />
          </label>
          <button
            type="submit"
            className="mt-2 rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
          >
            Sign up
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-zinc-600 dark:text-zinc-400">
          Already registered?{' '}
          <Link href="/signin" className="font-medium text-black underline dark:text-zinc-50">
            Sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
