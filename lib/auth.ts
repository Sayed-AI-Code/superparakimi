import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import NextAuth, { CredentialsSignin, type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import Google from 'next-auth/providers/google';
import { z } from 'zod';

import { accounts, getDb, users } from '@/db';
import { authConfig } from '@/lib/auth.config';
import { stampEmailVerifiedFromProfile } from '@/lib/auth/email-verified';
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
export async function buildAuthConfig(): Promise<NextAuthConfig> {
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
    callbacks: {
      // Spread first: authConfig carries `authorized` and `session`, and a
      // callbacks object here that omitted them would silently displace both
      // — losing the proxy's redirect rule is the exact class of bug that
      // took the `export const proxy = auth(async …)` form down.
      ...authConfig.callbacks,
      // Persist the verification a provider asserted but Auth.js discards for
      // new OAuth users. Must live here and not in authConfig: authConfig is
      // dependency-free so proxy.ts never pulls in the Drizzle adapter or the
      // database, and this writes to the database.
      //
      // Always returns true — a bookkeeping write, not a gate. The credentials
      // provider has no profile, so `email_verified` is undefined there and
      // the stamp is a no-op for password sign-ins.
      //
      // AWAITED. Fire-and-forget here would be the same mistake as an
      // un-awaited cleanup in the rate limiter: a serverless function may
      // freeze the instant it returns its response, and the row would stay
      // false as often as not. Awaiting is safe rather than risky precisely
      // because stampEmailVerifiedFromProfile catches and logs its own
      // database errors — it cannot reject, so it cannot fail a sign-in.
      async signIn({ account, profile }) {
        await stampEmailVerifiedFromProfile({
          provider: account?.provider ?? 'unknown',
          email: typeof profile?.email === 'string' ? profile.email : undefined,
          emailVerified:
            (profile as { email_verified?: unknown } | undefined)?.email_verified === true,
        });
        return true;
      },
    },
  };
}

export const { handlers, auth, signIn, signOut } = NextAuth(buildAuthConfig);
