import type { DefaultSession, NextAuthConfig } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: { id: string } & DefaultSession['user'];
  }
}

// Minimal, dependency-free config shared by the full instance (lib/auth.ts)
// and the lean instance in proxy.ts, so the proxy never pulls in the
// Drizzle adapter, the database, or provider implementations.
export const authConfig = {
  // Review focus / plan constraint: JWT strategy, 30-day sessions.
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  pages: { signIn: '/signin' },
  // Not behind Vercel's proxy in every environment; derive the URL from
  // forwarded headers instead of requiring AUTH_URL.
  trustHost: true,
  providers: [],
  callbacks: {
    // Proxy redirect rule: unauthenticated /app/** and /account/** get sent
    // to /signin?callbackUrl=… (Auth.js appends callbackUrl itself).
    authorized({ auth, request: { nextUrl } }) {
      const isProtected = /^\/(app|account)(?:\/|$)/.test(nextUrl.pathname);
      return !isProtected || Boolean(auth?.user);
    },
    session({ session, token }) {
      if (token.sub) session.user.id = token.sub;
      return session;
    },
  },
} satisfies NextAuthConfig;
