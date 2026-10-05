import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, users } from '@/db';
import { auth } from '@/lib/auth';
import { describeErrorForLog } from '@/lib/auth/log';
import {
  MAX_PASSWORD_BYTES,
  hashPassword,
  passwordByteLength,
  verifyPassword,
} from '@/lib/auth/passwords';

// Pure server module, no 'use server' directive — the same shape as
// lib/auth/signup.ts: keeping it directive-free means Vitest imports it
// directly, and pages wrap it in an inline `'use server'` action.
//
// TRUST BOUNDARY: this function takes a `userId` argument that arrives from a
// form, i.e. from the client. It is NOT trusted. Every call re-reads the
// session here via auth() (which derives from the __Host- session cookie, not
// from request body) and refuses unless the session's own user id equals the
// id being acted on. The page also checks its session before rendering, but
// render-time gating is not a security boundary — Server Actions are
// reachable by direct POST without ever loading the page — so the check lives
// here, at the only place that can enforce it on every invocation.

export type SetPasswordResult = { ok: true } | { error: string };

export const PASSWORD_TOO_WEAK = 'Password must be at least 8 characters';
export const PASSWORD_TOO_LONG = `Password must be ${MAX_PASSWORD_BYTES} bytes or shorter.`;

// Copy is spec'd for the weak-password case; the rest are ours and stay
// deliberately vague off-origin. None of these ever carry a hash, a password,
// or an error message from the driver.
const NOT_SIGNED_IN = 'Not signed in.';
const ENTER_CURRENT = 'Enter your current password.';
const WRONG_CURRENT = 'Current password is incorrect.';
const UNSPECIFIED = 'Something went wrong. Please try again.';

const inputSchema = z.object({
  userId: z.uuid(),
  next: z
    .string()
    .min(8, { error: PASSWORD_TOO_WEAK })
    // Same byte ceiling as signUpWithEmail, and for the same reason: bcrypt
    // silently drops everything past 72 bytes, so two different long
    // passphrases sharing a prefix verify against the same hash. Enforced on
    // this CREATION path only — `current` below is deliberately uncapped so a
    // member who registered a longer password before this guard existed can
    // still sign in and change it.
    .refine((pw) => passwordByteLength(pw) <= MAX_PASSWORD_BYTES, {
      error: PASSWORD_TOO_LONG,
    }),
  // No floor on purpose: a NULL-hash (Google-only) account has no current
  // password to send, and that first-set is a required path. Accounts that DO
  // have a hash are refused further down, where there is a hash to compare
  // against. No max either: capping the verification input would lock out
  // anyone whose stored hash predates MAX_PASSWORD_BYTES.
  current: z.string(),
});

export async function setPassword(
  userId: string,
  input: { current: string; next: string },
): Promise<SetPasswordResult> {
  // 1. Authorize before anything else, including shape validation of the
  //    passwords: an unauthorized caller gets the same generic refusal
  //    whatever else is wrong, so the endpoint cannot be used to probe
  //    another account. Note `userId` is a client-supplied claim; `session`
  //    comes from the session cookie and is the only trusted id here.
  const session = await auth().catch((error: unknown) => {
    console.error('account.setPassword.session.failed', describeErrorForLog(error));
    return null;
  });

  if (!session?.user?.id) return { error: NOT_SIGNED_IN };
  // The session's id is the truth; the argument is only ever a claim.
  if (session.user.id !== userId) {
    console.error('account.authorization.mismatch', {
      sessionId: session.user.id,
      claimedId: userId,
    });
    return { error: NOT_SIGNED_IN };
  }

  const parsed = inputSchema.safeParse({
    userId: session.user.id,
    next: input?.next,
    current: input?.current,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
  }
  const { next, current } = parsed.data;

  const db = await getDb();

  let storedHash: string | null | undefined;
  try {
    const row = await db.query.users.findFirst({
      where: eq(users.id, session.user.id),
      columns: { passwordHash: true },
    });
    if (!row) return { error: NOT_SIGNED_IN };
    storedHash = row.passwordHash;
  } catch (error) {
    console.error('account.setPassword.read.failed', describeErrorForLog(error));
    return { error: UNSPECIFIED };
  }

  // An account with a hash must prove it: a missing or wrong `current` is a
  // refusal, never a silent overwrite. A NULL hash means there is nothing to
  // prove against — first-set, so `current` is ignored entirely.
  if (storedHash !== null) {
    if (current.trim().length === 0) return { error: ENTER_CURRENT };
    if (!(await verifyPassword(current, storedHash))) {
      return { error: WRONG_CURRENT };
    }
  }

  try {
    // bcryptjs cost 12 via hashPassword; the hash never leaves this scope.
    const passwordHash = await hashPassword(next);
    await db
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, session.user.id));
  } catch (error) {
    console.error('account.setPassword.write.failed', describeErrorForLog(error));
    return { error: UNSPECIFIED };
  }

  return { ok: true };
}
