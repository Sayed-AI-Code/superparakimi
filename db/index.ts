import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { neon } from '@neondatabase/serverless';
import { sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { drizzle as drizzleNeonHttp } from 'drizzle-orm/neon-http';
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres';
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { Pool } from 'pg';

import * as schema from './schema';

export * from './schema';

// Common supertype of NeonHttpDatabase, NodePgDatabase and PgliteDatabase —
// in drizzle-orm 0.45 PgDatabase's first generic is the query-result HKT,
// and each driver's HKT extends PgQueryResultHKT.
export type DB = PgDatabase<PgQueryResultHKT, typeof schema>;

// migrationsFolder is resolved lazily (inside createDb) rather than at
// module scope: Next 16's Turbopack page-data worker evaluates statically
// imported modules with import.meta.dirname === undefined, and any route
// that imports this module (via lib/auth) would fail `next build`.
// Migration only runs under NODE_ENV=test (Vitest), where import.meta
// .dirname is valid.
function migrationsFolder(): string {
  return path.join(import.meta.dirname, '..', 'drizzle');
}

export type TestBackend = 'node-postgres' | 'pglite';

// Backend-selection seam for the test branch: CI provisions a real
// postgres:16 service and sets DATABASE_URL_TEST (TCP via node-postgres);
// local runs leave it unset and get in-process PGlite.
export function selectTestBackend(databaseUrlTest: string | undefined): TestBackend {
  return databaseUrlTest ? 'node-postgres' : 'pglite';
}

let dbPromise: Promise<DB> | null = null;

async function createDb(): Promise<DB> {
  if (process.env.NODE_ENV === 'test') {
    const testUrl = process.env.DATABASE_URL_TEST;
    if (selectTestBackend(testUrl) === 'node-postgres') {
      const pool = new Pool({ connectionString: testUrl });
      const db = drizzleNodePg(pool, { schema });
      await migrateNodePg(db, { migrationsFolder: migrationsFolder() });
      return db;
    }
    const client = new PGlite();
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder: migrationsFolder() });
    return db;
  }
  return drizzleNeonHttp(neon(process.env.DATABASE_URL!), { schema });
}

// Memoized singleton. The memo is cleared on rejection so one transient
// boot failure does not poison every later getDb() for the process.
export function getDb(): Promise<DB> {
  dbPromise ??= createDb().catch((error: unknown) => {
    dbPromise = null;
    throw error;
  });
  return dbPromise;
}

export async function resetTestDb(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetTestDb is test-only');
  }
  const db = await getDb();
  await db.execute(
    sql`TRUNCATE TABLE users, accounts, sessions, verification_tokens, usage_events RESTART IDENTITY CASCADE`,
  );
}
