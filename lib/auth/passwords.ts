import bcrypt from 'bcryptjs';

// Plan constraint: bcrypt cost 12. bcryptjs is pure JS — no native builds
// on Vercel.
export const BCRYPT_COST = 12;

/**
 * bcrypt consumes at most the first 72 BYTES of a password and silently
 * discards the rest. The consequence is not merely a weakened secret — it is
 * a collision: two different long passwords that share a 72-byte prefix
 * produce a verifiable match against the SAME hash. Verified against the
 * bcryptjs in this project: `compare('w'.repeat(72)+'BOB',
 * hash('w'.repeat(72)+'ALICE'))` returns `true`.
 *
 * So the cap is enforced at every password-CREATION boundary, in bytes (not
 * UTF-16 units — bcrypt hashes bytes, and a multi-byte passphrsase hits the
 * wall sooner than its character count suggests). Deliberately NOT enforced on
 * the `current`/sign-in verification path: a user who registered a longer
 * password before this guard existed must still be able to sign in and change
 * it, so a max there would lock them out of their own account.
 *
 * The proper long-term fix is a SHA-256 pre-hash before bcrypt, which removes
 * the ceiling entirely — but that invalidates every stored hash and is a
 * migration, not a guard. Tracked for slice 2.
 */
export const MAX_PASSWORD_BYTES = 72;

/**
 * One copy for both creation boundaries (`signUpWithEmail` and
 * `setPassword.next`). Duplicated, the two would drift and the same mistake
 * would read differently depending on which form caught it.
 */
export const PASSWORD_TOO_LONG = `Password must be ${MAX_PASSWORD_BYTES} bytes or shorter.`;

/** Byte length as bcrypt sees it — NOT `String.prototype.length`. */
export function passwordByteLength(password: string): number {
  return new TextEncoder().encode(password).length;
}

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
