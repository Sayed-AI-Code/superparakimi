/**
 * Fixed ports for the Playwright smoke, in one dependency-free module.
 *
 * These are shared by playwright.config.ts, global-setup.ts and the servers
 * themselves. They live here rather than inline so the port the app is told to
 * connect to (webServer.env.DATABASE_URL) cannot drift from the port the
 * server actually binds — a mismatch there shows up as a connection refused
 * deep inside a server action, not as a config error.
 *
 * Chosen above the 3100 range to avoid colliding with a developer's own dev
 * server on 3000/3001.
 */
export const APP_PORT = 3113;
export const PG_PORT = 3112;
export const MOCK_PORT = 3114;

export const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
export const DATABASE_URL = `postgres://postgres@127.0.0.1:${PG_PORT}/postgres`;
export const MOCK_BASE_URL = `http://127.0.0.1:${MOCK_PORT}/v1`;

/**
 * The database the smoke runs against: whatever DATABASE_URL the environment
 * provides, else the pglite-socket server globalSetup boots on PG_PORT.
 *
 * CI sets DATABASE_URL to a postgres:16 service, so the pipeline tests a real
 * standalone Postgres and the embedded engine is only the local convenience.
 * Both the config and globalSetup call this rather than deciding separately —
 * if they disagreed, the app would connect to a server globalSetup never
 * started, and the failure would look like a flaky database.
 */
export function e2eDatabaseUrl(fromEnv?: string): string {
  return fromEnv && fromEnv.length > 0 ? fromEnv : DATABASE_URL;
}

/**
 * Whether globalSetup must boot the embedded Postgres. It must not boot one
 * when the environment already points at a real server, and it must not skip
 * booting when nothing is listening — hence one shared predicate.
 */
export function bootsEmbeddedPg(fromEnv?: string): boolean {
  return !(fromEnv && fromEnv.length > 0);
}
