import { and, isNull, eq } from 'drizzle-orm';

import { getDb, users } from '@/db';
import { describeErrorForLog } from '@/lib/auth/log';

/**
 * Persist the verification a provider already asserted.
 *
 * Auth.js throws Google's answer away. When it creates a user from an OAuth
 * profile it hardcodes `emailVerified: null`
 * (`node_modules/@auth/core/lib/actions/callback/handle-login.js:260`) even
 * though the same profile carried `email_verified: true`, and the Google
 * provider only documents that field for use inside a `signIn` callback
 * (`node_modules/@auth/core/providers/google.js:64-77`). The result is that
 * every Google account in `users` reads as permanently unverified, which is
 * not a display problem but a wrong fact in a security-relevant column — one
 * nothing reads today, and therefore one that will surprise whoever writes the
 * first gate on it.
 *
 * Deliberately narrow:
 * - Writes only on a positive assertion. `false`, `undefined` and a missing
 *   email are all no-ops, so a provider that does not report verification
 *   cannot accidentally mark anything.
 * - Never overwrites. `WHERE email_verified IS NULL` keeps the first verified
 *   instant as the record, and makes a later unverified assertion harmless.
 * - Matches on email alone, which is the only identity an OAuth profile
 *   asserts about an existing row.
 * - Fails soft. A stamp is a data-quality nicety; it must never turn a
 *   working sign-in into a failed one, so a database error is logged through
 *   `describeErrorForLog` (never the raw error, whose query/params can carry
 *   an email) and swallowed.
 *
 * There is no backfill for rows already in the database. We did not observe
 * verification for those sign-ins, so `NOW()` would be an invented timestamp
 * standing in for an unobserved fact; those rows correct themselves the next
 * time their owner signs in.
 */
export async function stampEmailVerifiedFromProfile(profile: {
  provider: string;
  email: string | undefined;
  emailVerified: boolean | undefined;
}): Promise<void> {
  if (profile.emailVerified !== true || !profile.email) return;

  try {
    const db = await getDb();
    await db
      .update(users)
      .set({ emailVerified: new Date() })
      .where(and(eq(users.email, profile.email), isNull(users.emailVerified)));
  } catch (error: unknown) {
    console.error(
      JSON.stringify({
        event: 'auth.email_verified.stamp.failed',
        provider: profile.provider,
        ...describeErrorForLog(error),
      }),
    );
  }
}
