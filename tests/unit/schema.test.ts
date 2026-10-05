import { beforeEach, describe, expect, it } from 'vitest';
import { eq, count } from 'drizzle-orm';
import { getDb, resetTestDb, users, usageEvents } from '@/db';

describe('db schema round-trip (in-process Postgres via PGlite)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  it('round-trips a usage event with terminal status', async () => {
    const db = await getDb();
    const uid = crypto.randomUUID();
    await db.insert(users).values({ id: uid, email: `${uid}@t.dev` });
    const id = crypto.randomUUID();
    await db
      .insert(usageEvents)
      .values({
        id,
        userId: uid,
        charsIn: 100,
        model: 'm',
        mode: 'standard',
        strength: 'light',
        status: 'streaming',
        correlationId: crypto.randomUUID(),
      });
    await db
      .update(usageEvents)
      .set({ status: 'completed', charsOut: 90 })
      .where(eq(usageEvents.id, id));
    const [row] = await db.select().from(usageEvents).where(eq(usageEvents.id, id));
    expect(row.status).toBe('completed');
    expect(row.charsOut).toBe(90);
  });

  it('applies users table defaults (plan=free, id + createdAt generated)', async () => {
    const db = await getDb();
    const uid = crypto.randomUUID();
    const [user] = await db
      .insert(users)
      .values({ id: uid, email: `${uid}@t.dev` })
      .returning();
    expect(user.id).toBe(uid);
    expect(user.plan).toBe('free');
    expect(user.passwordHash).toBeNull();
    expect(user.createdAt).toBeInstanceOf(Date);
  });

  it('resetTestDb empties usageEvents (and users)', async () => {
    const db = await getDb();
    const uid = crypto.randomUUID();
    await db.insert(users).values({ id: uid, email: `${uid}@t.dev` });
    await db.insert(usageEvents).values({
      userId: uid,
      charsIn: 10,
      model: 'm',
      mode: 'standard',
      strength: 'light',
      status: 'aborted',
      correlationId: crypto.randomUUID(),
    });
    const [before] = await db.select({ n: count() }).from(usageEvents);
    expect(before.n).toBe(1);

    await resetTestDb();

    const [after] = await db.select({ n: count() }).from(usageEvents);
    expect(after.n).toBe(0);
    const [usersLeft] = await db.select({ n: count() }).from(users);
    expect(usersLeft.n).toBe(0);
  });

  it('getDb returns the same singleton instance', async () => {
    const first = await getDb();
    const second = await getDb();
    expect(second).toBe(first);
  });
});
