import path from 'node:path';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';

import * as schema from '../../db/schema';
import { PG_PORT } from './ports';

export type E2ePostgres = {
  url: string;
  stop: () => Promise<void>;
};

/**
 * Boots a real Postgres server for the smoke, on the real wire protocol.
 *
 * Why this exists rather than reusing the app's dev-only in-process PGlite:
 * the smoke is meant to run the PRODUCTION build (`next start`), and in
 * production `selectRuntimeBackend` requires a DATABASE_URL and refuses to
 * fall back to an ephemeral database. That guard is correct and is not
 * weakened here — instead of routing around it, this satisfies it with a real
 * server the app connects to over TCP with node-postgres, the same driver
 * family CI uses against postgres:16.
 *
 * PGlite is the engine because this machine has neither Docker nor a Postgres
 * binary; `pglite-socket` republishes it as a listening PostgreSQL server, so
 * the app still speaks the ordinary `postgres://` contract. The honest limits:
 * it is PGlite's Postgres build rather than a standalone postgres:16, and the
 * server multiplexes connections in-process, so connection-pool behaviour is
 * not identical to a real cluster. Neon's HTTP driver is still not exercised
 * anywhere — that needs real credentials.
 *
 * Migrations run here, before the server starts listening, so the app never
 * has to own DDL (see the note in db/index.ts).
 */
export async function startE2ePostgres(port = PG_PORT): Promise<E2ePostgres> {
  const db = await PGlite.create();
  const db2 = drizzle(db, { schema });
  await migrate(db2, { migrationsFolder: path.join(process.cwd(), 'drizzle') });

  const server = new PGLiteSocketServer({
    db,
    port,
    host: '127.0.0.1',
    // PGlite executes one query at a time. Accepting more sockets than that
    // does not buy concurrency, it only produces resets, so the server takes
    // one connection and the app's pool is pinned to match (PG_POOL_MAX=1).
    maxConnections: 1,
  });
  await server.start();

  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: async () => {
      await server.stop();
      await db.close();
    },
  };
}
