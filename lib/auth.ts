import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import NextAuth, { CredentialsSignin } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { z } from 'zod';

import { accounts, getDb, users } from '@/db';
import { authConfig } from '@/lib/auth.config';
import { verifyPassword } from '@/lib/auth/passwords';

// Shown on /signin when a password-less (Google-only) account submits the
// password form — Review focus #3.
export const GOOGLE_ONLY_SIGN_IN_CODE = 'google_only';
export const GOOGLE_ONLY_SIGN_IN_MESSAGE = 'This account uses Google sign-in';

export class GoogleOnlyAccountSignInError extends CredentialsSignin {
  code = GOOGLE_ONLY_SIGN_IN_CODE;

  constructor() {
    super(GOOGLE_ONLY_SIGN_IN_MESSAGE);
  }
}

const credentialsSchema = z.object({
  email: z.email().trim().toLowerCase(),
  password: z.string().min(1),
});

// Kept as a named export so integration tests can pin the sign-in rules
// (including the Google-only account guard) without spinning up the full
// Auth.js request pipeline.
export async function authorize(credentials: Record<string, unknown> | undefined) {
  const parsed = credentialsSchema.safeParse(credentials);
  if (!parsed.success) return null;

  const user = await (
    await getDb()
  ).query.users.findFirst({ where: eq(users.email, parsed.data.email) });
  if (!user) return null;

  // NULL password_hash = Google-only account: clean error, never a crash.
  if (user.passwordHash === null) throw new GoogleOnlyAccountSignInError();

  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) return null;

  // DTO: never return the row — passwordHash must not leave this function.
  return { id: user.id, email: user.email, name: user.name, image: user.image };
}

// Lazy config: our getDb() singleton resolves asynchronously (migrations),
// while DrizzleAdapter needs a live drizzle instance — so build the adapter
// per first auth call, not at module scope.
export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const db = await getDb();
  return {
    ...authConfig,
    // Adapter defaults to singular table names ("user", "account", …); bind
    // it to our plural schema tables or auth fails at runtime, not compile.
    // Only users+accounts are bound: with strategy "jwt" the adapter never
    // reads or writes sessions/verification_tokens (its defaults for those
    // are inert table definitions — and our sessions table uses a unique
    // column rather than the PK the adapter's type demands).
    adapter: DrizzleAdapter(db, {
      usersTable: users,
      accountsTable: accounts,
    }),
    providers: [
      // clientId/clientSecret inferred from AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET.
      Google,
      Credentials({
        name: 'Email and password',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
        },
        authorize,
      }),
    ],
  };
});
