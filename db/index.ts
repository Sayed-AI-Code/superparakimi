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

/**
 * Migrations folder for the development branch, resolved from cwd rather than
 * import.meta.dirname. Under Turbopack the bundled module's import.meta.dirname
 * is not a real filesystem directory (it surfaces as a URL), and handing it to
 * the migrator fails with `The "path" argument must be of type string...
 * Received an instance of URL` on the very first CREATE SCHEMA. The dev server
 * always runs from the project root, so cwd is both stable and verified — the
 * Vitest branch keeps import.meta.dirname, which is proven there.
 */
function migrationsFolderFromCwd(): string {
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

export type ProductionDriver = 'neon-http' | 'node-postgres';

/**
 * Which driver a real (non-ephemeral) DATABASE_URL is served with.
 *
 * Neon's serverless driver speaks Neon's own HTTP proxy protocol, so it cannot
 * be pointed at an ordinary Postgres server — a `postgres://` URL to a
 * non-Neon host has to go through node-postgres instead. Neon endpoints keep
 * the HTTP driver exactly as before; everything else (a local or self-hosted
 * Postgres, and the pglite-socket server the Playwright smoke boots) uses the
 * pg wire protocol.
 *
 * The point of this is not convenience: it is what lets the smoke run the
 * production build against a real Postgres server over TCP instead of being
 * pinned to the dev-only in-process branch. `neon` in selectRuntimeBackend
 * means "a real database, not an ephemeral one"; the driver choice lives here.
 */
export function productionDriver(databaseUrl: string | undefined): ProductionDriver {
  if (!databaseUrl) {
    throw new Error('productionDriver requires a DATABASE_URL.');
  }
  const { hostname } = new URL(databaseUrl);
  return /(^|\.)neon\.(tech|test)$/i.test(hostname) ? 'neon-http' : 'node-postgres';
}

/**
 * Backend selection for the running app, split out as a pure function so the
 * production guard is testable without opening a connection.
 *
 * The development-only PGlite branch exists so `next dev` boots on a machine
 * with no local Postgres and no Neon credentials — a developer cloning this
 * repo gets a working app server without provisioning anything. The Playwright
 * smoke does NOT rely on this branch: it boots a real Postgres server over TCP
 * (tests/e2e/pg-server.ts) and runs the production build against it, so the
 * smoke exercises the same node-postgres path production uses.
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

/**
 * Data location for the development-only PGlite instance.
 *
 * Defaults to IN-MEMORY. A host-directory dataDir was tried first and does
 * not work under Turbopack: PGlite's emscripten VFS hands the bundler's path
 * to `fs` as a URL and every write dies with `The "path" argument must be of
 * type string or an instance of Buffer or URL. Received an instance of URL`,
 * surfacing as a failed `CREATE SCHEMA` on the first INSERT — i.e. every
 * signup returned the generic error. Memory mode uses MEMFS and touches no
 * host path at all.
 *
 * The cost is honest and stated: the development database is wiped when the
 * dev server restarts. For a single long-lived `next dev` process serving the
 * Playwright smoke that is exactly what we want (no stale state between runs,
 * nothing to clean up, no risk of pointing a smoke at real data). Set
 * DEV_PGLITE_DIR to a path to opt into persistence while debugging locally —
 * accepting the Turbopack limitation above.
 */
export function devPgliteDataDir(): string | undefined {
  return process.env.DEV_PGLITE_DIR || undefined;
}

/**
 * The singleton lives on globalThis, keyed by Symbol.for, rather than in a
 * module-scoped variable.
 *
 * The production server evaluates this module more than once: the app-route
 * runtime and the app-page runtime are separate bundles with separate module
 * registries, so a module-scoped memo hands out one pool per runtime. Measured
 * against the smoke: two ESTABLISHED sockets to the database for a single
 * authenticated page view. Against a real server that is simply twice the
 * connections you think you have; against the single-backend Postgres the smoke
 * boots it is fatal, because two in-flight connections corrupt its protocol
 * multiplexer and every later query dies with ECONNRESET.
 *
 * globalThis is shared by both bundles in the one server process, so this
 * collapses them onto a single pool. Symbol.for is used, not Symbol(), so the
 * key is identical in every copy of the module.
 */
const DB_KEY = Symbol.for('superparakimi.db');

type DbRegistry = { [DB_KEY]?: Promise<DB> };

/**
 * Connection-pool size for the node-postgres driver.
 *
 * Configurable rather than fixed because the engine behind the smoke is
 * PGlite, which is single-connection at heart: `pglite-socket` accepts extra
 * sockets, but two queries actually in flight at once resets the connection
 * (`read ECONNRESET` at pool max 2 and above, clean at max 1 — measured). So
 * the smoke sets PG_POOL_MAX=1 and lets pg queue its own queries.
 *
 * Production keeps a real pool. Defaulting high here and pinning low in the
 * test config is the direction that matters: a low default would silently
 * serialize a deployed app to make a test pass.
 */
export function pgPoolMax(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 10;
}

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
    // Memory by default — see devPgliteDataDir for why a host directory
    // cannot be used under Turbopack.
    const client = new PGlite(devPgliteDataDir());
    const db = drizzlePglite(client, { schema });
    await migratePglite(db, { migrationsFolder: migrationsFolderFromCwd() });
    return db;
  }
  const databaseUrl = process.env.DATABASE_URL!;
  if (productionDriver(databaseUrl) === 'node-postgres') {
    // A real Postgres over the wire protocol. Migrations are deliberately NOT
    // run here: schema ownership stays with the deployment (drizzle-kit in
    // CI/release) and, for the smoke, with the pglite-socket server that boots
    // before this process. Auto-migrating on request would let a replica race
    // the primary through the same DDL.
    const pool = new Pool({
      connectionString: databaseUrl,
      max: pgPoolMax(process.env.PG_POOL_MAX),
    });
    return drizzleNodePg(pool, { schema });
  }
  return drizzleNeonHttp(neon(databaseUrl), { schema });
}

// Memoized on globalThis — see DB_KEY for why a module-scoped memo is not
// enough. The memo is cleared on rejection so one transient boot failure does
// not poison every later getDb() for the process.
export function getDb(): Promise<DB> {
  const registry = globalThis as unknown as DbRegistry;
  registry[DB_KEY] ??= createDb().catch((error: unknown) => {
    delete registry[DB_KEY];
    throw error;
  });
  return registry[DB_KEY]!;
}

export async function resetTestDb(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('resetTestDb is test-only');
  }
  const db = await getDb();
  await db.execute(
    sql`TRUNCATE TABLE users, accounts, sessions, verification_tokens, usage_events, rate_limit_buckets RESTART IDENTITY CASCADE`,
  );
}
