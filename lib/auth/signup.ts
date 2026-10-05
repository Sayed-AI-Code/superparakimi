import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, users } from '@/db';
import {
  MAX_PASSWORD_BYTES,
  PASSWORD_TOO_LONG,
  hashPassword,
  passwordByteLength,
} from '@/lib/auth/passwords';

// Pure server module (no 'use server' directive) so it stays unit-testable;
// pages wrap it in inline server actions. PASSWORD_TOO_LONG comes from
// lib/auth/passwords.ts so both creation boundaries emit identical copy.
const signUpInputSchema = z.object({
  email: z.email({ error: 'Enter a valid email address.' }).trim().toLowerCase(),
  password: z
    .string()
    .min(8, { error: 'Password must be at least 8 characters' })
    // Rejected rather than silently truncated: past this point bcrypt ignores
    // the remainder, so a longer passphrase would be weaker than the user
    // chose and could collide with a different long passphrase sharing the
    // same 72-byte prefix.
    .refine((pw) => passwordByteLength(pw) <= MAX_PASSWORD_BYTES, {
      error: PASSWORD_TOO_LONG,
    }),
});

export type SignUpResult = { ok: true } | { error: string };

export const EMAIL_TAKEN = 'Email already registered';
const INVALID_INPUT = 'Invalid input';

// Rendered by the signup page's own catch, so it belongs to this allowlist too.
export const GENERIC_SIGNUP_ERROR = 'Something went wrong. Please try again.';

/**
 * EVERY string signUpWithEmail can hand back, in one exported allowlist.
 *
 * The page puts these in `?error=` and reads them back off the URL. Rendering
 * whatever arrives would let `/signup?error=<anything>` print attacker-chosen
 * copy inside an official-looking red alert on a public, unauthenticated page —
 * content spoofing, which React's escaping does not address because the text is
 * legitimate-looking, not executable. Every message in the schema above is set
 * explicitly rather than left to zod's defaults, so this list is closed and an
 * unrecognised value means someone put it there, not that a message was added
 * and forgotten.
 *
 * Cost of the allowlist: a NEW error string added to the schema must be added
 * here too, or it degrades to the generic refusal while the action still
 * reports it. That failure is visible and safe, which is the right trade.
 */
export const SIGN_UP_ERRORS: readonly string[] = [
  'Enter a valid email address.',
  'Password must be at least 8 characters',
  PASSWORD_TOO_LONG,
  INVALID_INPUT,
  EMAIL_TAKEN,
  GENERIC_SIGNUP_ERROR,
];

// PostgreSQL SQLSTATE for unique_violation — the index, not the pre-check, is
// the authority on uniqueness.
const UNIQUE_VIOLATION = '23505';

export async function signUpWithEmail(input: {
  email: string;
  password: string;
}): Promise<SignUpResult> {
  const parsed = signUpInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? INVALID_INPUT };
  }
  const { email, password } = parsed.data;

  const db = await getDb();
  if (await db.query.users.findFirst({ where: eq(users.email, email) })) {
    return { error: EMAIL_TAKEN };
  }

  const passwordHash = await hashPassword(password);
  try {
    await db.insert(users).values({ email, passwordHash });
  } catch (error) {
    // Concurrent signups race past the pre-check; the unique index is the
    // source of truth (23505 = unique_violation).
    if (sqlState(error) === UNIQUE_VIOLATION) {
      return { error: EMAIL_TAKEN };
    }
    throw error;
  }
  return { ok: true };
}

// Where the SQLSTATE actually lives. A raw driver error carries it on
// `code`, but drizzle-orm 0.45 wraps every query failure in
// DrizzleQueryError, which keeps `code` on the wrapped cause and puts the
// SQL + params (email + bcrypt hash) in its own message. Reading only the
// top level — as this did — means the unique-violation branch never fires
// and a genuine race surfaces a generic 500 instead of EMAIL_TAKEN. Both
// shapes are read here so the branch works with and without the wrapper.
export function sqlState(error: unknown): string | undefined {
  const err = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined;
  if (typeof err?.code === 'string') return err.code;
  if (typeof err?.cause?.code === 'string') return err.cause.code;
  return undefined;
}
