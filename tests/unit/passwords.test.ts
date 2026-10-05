import { describe, expect, it } from 'vitest';

import { hashPassword, verifyPassword } from '@/lib/auth/passwords';

const PLAINTEXT = 'correct-horse-battery';

describe('hashPassword', () => {
  it('returns a bcrypt hash that is not the plaintext', async () => {
    const hash = await hashPassword(PLAINTEXT);
    expect(hash).not.toBe(PLAINTEXT);
    expect(hash.startsWith('$2')).toBe(true);
  });

  it('uses cost 12 (plan constraint: bcrypt cost 12)', async () => {
    const hash = await hashPassword(PLAINTEXT);
    // bcrypt encoded form: $2b$<cost>$<salt><digest>
    expect(hash.split('$')[2]).toBe('12');
  });

  it('salts each hash, so the same password hashes differently', async () => {
    const [a, b] = await Promise.all([hashPassword(PLAINTEXT), hashPassword(PLAINTEXT)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(PLAINTEXT, a)).toBe(true);
    expect(await verifyPassword(PLAINTEXT, b)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('verifies the matching password', async () => {
    const hash = await hashPassword(PLAINTEXT);
    expect(await verifyPassword(PLAINTEXT, hash)).toBe(true);
  });

  it('rejects a wrong password', async () => {
    const hash = await hashPassword(PLAINTEXT);
    expect(await verifyPassword('wrong-horse-battery', hash)).toBe(false);
  });

  it('returns false without throwing for a NULL hash (Google-only accounts)', async () => {
    // users.password_hash is nullable; Google-only users never set one.
    // The verify path must fail closed, not crash on null.
    await expect(verifyPassword('anything', null)).resolves.toBe(false);
  });
});
