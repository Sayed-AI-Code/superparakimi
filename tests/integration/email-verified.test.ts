import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { getDb, resetTestDb, users } from '@/db';
import { stampEmailVerifiedFromProfile } from '@/lib/auth/email-verified';

/**
 * Google tells us `email_verified: true` on every sign-in and we throw that
 * answer away: @auth/core hardcodes `emailVerified: null` when it creates a
 * user from an OAuth profile
 * (`node_modules/@auth/core/lib/actions/callback/handle-login.js:260`), so a
 * Google account sits in `users` looking permanently unverified. Nothing in
 * this app reads the column today, which is exactly why it is worth fixing
 * now: a column that is *known false* and unread is a landmine the day
 * something starts gating on it — a domain allow-list, a password-reset
 * policy, an "is this real?" support lookup.
 *
 * The fix self-heals at sign-in and never fabricates: the timestamp is
 * written only when the provider asserted verification, and only for the
 * account the profile identifies. There is deliberately no backfill of
 * existing rows, because we did not observe verification for those sign-ins
 * and `NOW()` would be a made-up timestamp standing in for an unobserved
 * fact. They correct themselves on the owner's next sign-in.
 */

async function findUser(email: string) {
  const db = await getDb();
  return db.query.users.findFirst({ where: eq(users.email, email) });
}

beforeAll(async () => {
  await getDb();
});

beforeEach(async () => {
  await resetTestDb();
});

describe('stampEmailVerifiedFromProfile', () => {
  it('stamps email_verified when Google says the address is verified', async () => {
    const db = await getDb();
    const email = `verified-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await db.insert(users).values({ email });
    expect((await findUser(email))?.emailVerified).toBeNull();

    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: true });

    const stamped = await findUser(email);
    expect(stamped?.emailVerified).toBeInstanceOf(Date);
  });

  it('does not stamp when the provider did not assert verification', async () => {
    const db = await getDb();
    const email = `unverified-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await db.insert(users).values({ email });

    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: false });
    expect((await findUser(email))?.emailVerified).toBeNull();

    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: undefined });
    expect((await findUser(email))?.emailVerified).toBeNull();
  });

  it('never touches an already-verified row, so the original instant survives', async () => {
    const db = await getDb();
    const email = `original-${crypto.randomUUID().slice(0, 8)}@example.com`;
    const first = new Date(Date.UTC(2020, 0, 2, 3, 4, 5));
    await db.insert(users).values({ email, emailVerified: first });

    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: true });

    expect((await findUser(email))?.emailVerified?.getTime()).toBe(first.getTime());
  });

  it('does not stamp a credentials account from an unrelated verified profile', async () => {
    const db = await getDb();
    const email = `alice-${crypto.randomUUID().slice(0, 8)}@example.com`;
    // A password account with no verified email of its own.
    await db.insert(users).values({ email, passwordHash: 'x'.repeat(60) });

    // Same email presented by a provider that did not verify it: no stamp.
    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: false });
    expect((await findUser(email))?.emailVerified).toBeNull();
  });

  it('is a no-op for an unknown email rather than an error', async () => {
    await expect(
      stampEmailVerifiedFromProfile({
        provider: 'google',
        email: `nobody-${crypto.randomUUID()}@example.com`,
        emailVerified: true,
      }),
    ).resolves.toBeUndefined();
  });

  it('ignores an absent email — nothing to match a row on', async () => {
    await expect(
      stampEmailVerifiedFromProfile({ provider: 'google', email: undefined, emailVerified: true }),
    ).resolves.toBeUndefined();
  });

  it('never lowers a stamped value on a later unverified assertion', async () => {
    const db = await getDb();
    const email = `drift-${crypto.randomUUID().slice(0, 8)}@example.com`;
    await db.insert(users).values({ email });

    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: true });
    const stamped = (await findUser(email))?.emailVerified;
    expect(stamped).toBeInstanceOf(Date);

    // A later profile that claims less must not undo the earlier proof.
    await stampEmailVerifiedFromProfile({ provider: 'google', email, emailVerified: false });
    expect((await findUser(email))?.emailVerified?.getTime()).toBe(stamped?.getTime());
  });
});
