import NextAuth from 'next-auth';

import { authConfig } from '@/lib/auth.config';

// Lean instance: authConfig carries only session strategy + callbacks, so
// the proxy never pulls in the Drizzle adapter or provider implementations
// (the full instance lives in lib/auth.ts). Node.js runtime is the default
// here and runtime is not configurable in proxy (Next 16).
const { auth } = NextAuth(authConfig);

export { auth as proxy };

export const config = {
  matcher: ['/app/:path*', '/account/:path*'],
};
