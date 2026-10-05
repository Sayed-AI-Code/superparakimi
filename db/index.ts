import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { neon } from '@neondatabase/serverless';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';

import * as schema from './schema';

export * from './schema';

// Common supertype of NeonHttpDatabase and PgliteDatabase (both extend
// PgDatabase<HKT, TSchema>; in drizzle-orm 0.45 the HKT generic comes first).
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

const migrationsFolder = path.join(import.meta.dirname, '..', 'drizzle');

let dbPromise: Promise<DB> | null = null;

async function createDb(): Promise<DB> {
  if (process.env.NODE_ENV === 'test') {
    // Local tests run against in-process Postgres (PGlite), migrations applied
    // once per process by the drizzle pglite migrator.
    const client = new PGlite();
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder });
    return db;
  }
  return drizzleNeonHttp(neon(process.env.DATABASE_URL!), { schema });
}

export function getDb(): Promise<DB> {
  dbPromise ??= createDb();
  return dbPromise;
}

export async function resetTestDb(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetTestDb is test-only');
  }
  const db = await getDb();
  await db.execute(
    'TRUNCATE TABLE users, accounts, sessions, verification_tokens, usage_events RESTART IDENTITY CASCADE',
  );
}
