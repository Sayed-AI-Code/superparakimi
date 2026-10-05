import { and, count, eq, gte } from 'drizzle-orm';
import { getDb, usageEvents } from '@/db';
import type { Mode, Strength } from '@/lib/mode/prompts';

export const FREE_DAILY_LIMIT = 10;

export type QuotaStatus = {
  allowed: boolean;
  used: number;
  limit: number;
  resetsAt: string;
};

// Start of the current UTC day (never local-time arithmetic).
function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * First-delta rule (spec §6): any usage_events row that EXISTS for the
 * current UTC day has consumed its slot, regardless of status
 * (streaming/completed/aborted all count). The route gates by calling
 * check() BEFORE beginUsage(); beginUsage never re-checks.
 * Intentional MVP trade-off: two concurrent check() calls can both see
 * used=9 and let two beginUsage through (used=11) — accepted per spec;
 * Redis/shared state is the future seam, no locks here.
 */
export async function check(userId: string): Promise<QuotaStatus> {
  const db = await getDb();
  const now = new Date();
  const dayStart = utcDayStart(now);
  const [row] = await db
    .select({ c: count() })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, dayStart)));
  const used = row.c;
  return {
    allowed: used < FREE_DAILY_LIMIT,
    used,
    limit: FREE_DAILY_LIMIT,
    // Next UTC midnight.
    resetsAt: new Date(dayStart.getTime() + 86_400_000).toISOString(),
  };
}

/**
 * Records consumption at the FIRST upstream text delta: the row's creation
 * consumes the quota slot. Returns the new event id.
 */
export async function beginUsage(
  userId: string,
  charsIn: number,
  model: string,
  mode: Mode,
  strength: Strength,
): Promise<string> {
  const db = await getDb();
  const [row] = await db
    .insert(usageEvents)
    .values({
      userId,
      charsIn,
      model,
      mode,
      strength,
      status: 'streaming',
      correlationId: crypto.randomUUID(),
    })
    .returning({ id: usageEvents.id });
  return row.id;
}

/** Terminal transition streaming → completed. Does not alter quota usage. */
export async function completeUsage(eventId: string, charsOut: number): Promise<void> {
  const db = await getDb();
  await db
    .update(usageEvents)
    .set({ status: 'completed', charsOut })
    .where(eq(usageEvents.id, eventId));
}

/** Terminal transition streaming → aborted. Does not alter quota usage. */
export async function abortUsage(eventId: string): Promise<void> {
  const db = await getDb();
  await db
    .update(usageEvents)
    .set({ status: 'aborted' })
    .where(eq(usageEvents.id, eventId));
}
