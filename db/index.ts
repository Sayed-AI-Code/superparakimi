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
  // Under Vitest this module lives in <root>/db, so the migrations sit one
  // level up. Under the dev server it may be evaluated by a worker with
  // import.meta.dirname undefined, and there cwd IS the project root — so the
  // fallback must NOT append '..'. Getting this wrong points the migrator at
  // <root>/../drizzle and fails every boot with a missing-folder error.
  if (import.meta.dirname) return path.join(import.meta.dirname, '..', 'drizzle');
  return path.join(process.cwd(), 'drizzle');
}

export type TestBackend = 'node-postgres' | 'pglite';

// Backend-selection seam for the test branch: CI provisions a real
// postgres:16 service and sets DATABASE_URL_TEST (TCP via node-postgres);
// local runs leave it unset and get in-process PGlite.
export function selectTestBackend(databaseUrlTest: string | undefined): TestBackend {
  return databaseUrlTest ? 'node-postgres' : 'pglite';
}

export type RuntimeBackend = 'neon' | 'dev-pglite';

/**
 * Backend selection for the running app, split out as a pure function so the
 * production guard is testable without opening a connection.
 *
 * The development-only PGlite branch exists because `next dev` has no other
 * backend when DATABASE_URL is unset, which made the Playwright smoke
 * impossible on a machine with no local Postgres and no Neon credentials. The
 * E2E browser talks only to the dev server, and the dev server owns its own
 * in-process database, so nothing external ever needs to see that data.
 *
 * It is gated on NODE_ENV === 'development' deliberately: falling through to
 * an ephemeral database in production would look like a successful boot and
 * then lose every row on the next cold start. An unset DATABASE_URL in
 * production is a hard error instead, naming the variable. This is a
 * test-shaped accommodation living in production routing, authorized by the
 * controller and surfaced to the human partner; the proper slice-2 shape is a
 * real Postgres in every environment.
 */
export function selectRuntimeBackend(
  nodeEnv: string | undefined,
  databaseUrl: string | undefined,
): RuntimeBackend {
  if (databaseUrl) return 'neon';
  if (nodeEnv === 'development') return 'dev-pglite';
  throw new Error(
    'DATABASE_URL is required outside development; refusing to start against an ephemeral database.',
  );
}

/** Directory backing the development-only PGlite instance. */
export function devPgliteDir(): string {
  return process.env.DEV_PGLITE_DIR ?? path.join(process.cwd(), '.e2e-db');
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
  const backend = selectRuntimeBackend(process.env.NODE_ENV, process.env.DATABASE_URL);
  if (backend === 'dev-pglite') {
    // Development only — see selectRuntimeBackend for the gating rationale.
    const client = new PGlite(devPgliteDir());
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
