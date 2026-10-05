import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { getDb, users } from '@/db';
import { hashPassword } from '@/lib/auth/passwords';

// Pure server module (no 'use server' directive) so it stays unit-testable;
// pages wrap it in inline server actions.
const signUpInputSchema = z.object({
  email: z.email({ error: 'Enter a valid email address.' }).trim().toLowerCase(),
  password: z.string().min(8, { error: 'Password must be at least 8 characters' }),
});

export type SignUpResult = { ok: true } | { error: string };

const EMAIL_TAKEN = 'Email already registered';

export async function signUpWithEmail(input: {
  email: string;
  password: string;
}): Promise<SignUpResult> {
  const parsed = signUpInputSchema.safeParse(input);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
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
    if ((error as { code?: string }).code === '23505') {
      return { error: EMAIL_TAKEN };
    }
    throw error;
  }
  return { ok: true };
}
