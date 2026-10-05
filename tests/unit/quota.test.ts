import { beforeEach, describe, expect, it } from 'vitest';
import { count, eq } from 'drizzle-orm';
import { getDb, resetTestDb, usageEvents, users } from '@/db';
import {
  FREE_DAILY_LIMIT,
  abortUsage,
  beginUsage,
  check,
  completeUsage,
} from '@/lib/quota/quotaService';

async function mkUser(): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@t.dev` })
    .returning({ id: users.id });
  return row.id;
}

beforeEach(async () => {
  await resetTestDb();
});

describe('quota: first-delta rule (spec §6)', () => {
  it('allows the 10th request, blocks the 11th', async () => {
    const u = await mkUser();
    for (let i = 0; i < 9; i++) {
      const id = await beginUsage(u, 10, 'm', 'standard', 'light');
      await completeUsage(id, 9);
    }
    const st9 = await check(u);
    expect(st9.allowed).toBe(true);
    expect(st9.used).toBe(9);

    const tenth = await beginUsage(u, 10, 'm', 'standard', 'light');
    await completeUsage(tenth, 9);
    const st = await check(u);
    expect(st.used).toBe(10);
    expect(st.allowed).toBe(false);
    expect(st.limit).toBe(10);
  });

  it('a streaming (in-flight) row already consumes its slot', async () => {
    const u = await mkUser();
    await beginUsage(u, 42, 'm', 'fluent', 'medium');
    const st = await check(u);
    expect(st.used).toBe(1);
  });

  it('aborted rows still count', async () => {
    const u = await mkUser();
    const id = await beginUsage(u, 10, 'm', 'standard', 'light');
    await abortUsage(id);
    const st = await check(u);
    expect(st.used).toBe(1);
  });

  it('pre-delta failure consumes nothing (no beginUsage, no row)', async () => {
    const u = await mkUser();
    const st = await check(u);
    expect(st.used).toBe(0);
    expect(st.allowed).toBe(true);
    const db = await getDb();
    const [rows] = await db
      .select({ c: count() })
      .from(usageEvents)
      .where(eq(usageEvents.userId, u));
    expect(rows.c).toBe(0);
  });
});

describe('quota: UTC-day window', () => {
  it('counts only rows created in the current UTC day', async () => {
    const u = await mkUser();
    const db = await getDb();
    // 25 hours ago is always strictly before the current UTC midnight.
    await db.insert(usageEvents).values({
      userId: u,
      charsIn: 100,
      model: 'm',
      mode: 'standard',
      strength: 'light',
      status: 'completed',
      correlationId: crypto.randomUUID(),
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });
    // A row with no explicit createdAt lands in today's UTC window.
    await beginUsage(u, 10, 'm', 'standard', 'light');

    const st = await check(u);
    expect(st.used).toBe(1);
    expect(st.allowed).toBe(true);
  });

  it('resetsAt is exactly the next UTC midnight (independently derived)', async () => {
    const u = await mkUser();
    const st = await check(u);
    const now = new Date();
    const expected = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000,
    ).toISOString();
    expect(st.resetsAt).toBe(expected);
    // Sanity: strictly after now, at most 24h out, zeroed time-of-day in UTC.
    const resets = Date.parse(st.resetsAt);
    expect(resets).toBeGreaterThan(now.getTime());
    expect(resets - now.getTime()).toBeLessThanOrEqual(86_400_000);
    expect(st.resetsAt).toMatch(/T00:00:00\.000Z$/);
  });
});

describe('quota: status transitions', () => {
  it('beginUsage creates a streaming row and returns its id', async () => {
    const u = await mkUser();
    const id = await beginUsage(u, 77, 'gpt-test', 'formal', 'strong');
    const db = await getDb();
    const [row] = await db.select().from(usageEvents).where(eq(usageEvents.id, id));
    expect(row.status).toBe('streaming');
    expect(row.userId).toBe(u);
    expect(row.charsIn).toBe(77);
    expect(row.model).toBe('gpt-test');
    expect(row.mode).toBe('formal');
    expect(row.strength).toBe('strong');
    expect(row.charsOut).toBeNull();
    expect(row.correlationId).toBeTruthy();
  });

  it('completeUsage sets completed + chars_out; abortUsage sets aborted; quota unchanged', async () => {
    const u = await mkUser();
    const done = await beginUsage(u, 10, 'm', 'standard', 'light');
    await completeUsage(done, 88);
    const gone = await beginUsage(u, 20, 'm', 'standard', 'light');
    await abortUsage(gone);

    const db = await getDb();
    const [completed] = await db.select().from(usageEvents).where(eq(usageEvents.id, done));
    expect(completed.status).toBe('completed');
    expect(completed.charsOut).toBe(88);
    const [aborted] = await db.select().from(usageEvents).where(eq(usageEvents.id, gone));
    expect(aborted.status).toBe('aborted');
    expect(aborted.charsOut).toBeNull();

    // Transitions never change `used` — rows keep the slot they consumed at birth.
    const st = await check(u);
    expect(st.used).toBe(2);
    expect(st.allowed).toBe(true);
  });

  it('counts are scoped per user', async () => {
    const a = await mkUser();
    const b = await mkUser();
    await beginUsage(a, 10, 'm', 'standard', 'light');
    expect((await check(a)).used).toBe(1);
    expect((await check(b)).used).toBe(0);
  });
});

describe('quota: limit value', () => {
  it('FREE_DAILY_LIMIT is 10 and check() reports it', async () => {
    const u = await mkUser();
    expect(FREE_DAILY_LIMIT).toBe(10);
    const st = await check(u);
    expect(st.limit).toBe(10);
  });

  it('exactly at the boundary: used=9 allowed, used=10 gated (>= limit)', async () => {
    const u = await mkUser();
    for (let i = 0; i < 9; i++) {
      const id = await beginUsage(u, 1, 'm', 'standard', 'light');
      if (i % 3 === 0) await completeUsage(id, 1);
      else if (i % 3 === 1) await abortUsage(id);
      // i % 3 === 2 stays 'streaming'
    }
    expect((await check(u)).allowed).toBe(true); // 9 < 10 → 10th may start
    await beginUsage(u, 1, 'm', 'standard', 'light'); // 10th consumes its slot
    expect((await check(u)).allowed).toBe(false); // 11th is gated off
    // Mixed statuses (completed/aborted/streaming) within the day all count.
    const db = await getDb();
    const [statusRows] = await db
      .select({ c: count() })
      .from(usageEvents)
      .where(eq(usageEvents.userId, u));
    expect(statusRows.c).toBe(10);
  });
});
