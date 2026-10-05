import bcrypt from 'bcryptjs';

// Plan constraint: bcrypt cost 12. bcryptjs is pure JS — no native builds
// on Vercel.
export const BCRYPT_COST = 12;

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, BCRYPT_COST);
}

// A NULL hash means the account has no password (Google-only signup).
// Fail closed with `false` instead of throwing so the sign-in path can
// render a clean error.
export async function verifyPassword(pw: string, hash: string | null): Promise<boolean> {
  if (hash === null) return false;
  return bcrypt.compare(pw, hash);
}
