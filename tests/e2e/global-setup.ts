import { startE2ePostgres, type E2ePostgres } from './pg-server';
import { MOCK_PORT, bootsEmbeddedPg, e2eDatabaseUrl } from './ports';
import { startMockUpstream, type MockUpstream } from './mock-upstream';

let upstream: MockUpstream | null = null;
let postgres: E2ePostgres | null = null;

/**
 * Boots the two servers the smoke needs, once for the whole run: a database
 * and the mocked OpenRouter-compatible upstream.
 *
 * Playwright runs this BEFORE it starts webServer, which is what makes the
 * arrangement work — the app under `next start` must find a listening database
 * on its first request, not on the second.
 *
 * If the environment already names a database (CI's postgres:16 service) this
 * boots nothing but the mock and takes the URL at face value; otherwise it
 * brings up the embedded Postgres on PG_PORT. CI should not be able to reach a
 * green run by pointing at a server nobody started.
 *
 * Both URLs reach the app through playwright.config.ts `webServer.env`, not
 * from here: values set in this process do not cross into the app process, and
 * a missing OPENROUTER_BASE_URL would have the smoke calling the real
 * OpenRouter — spending money and making the run non-deterministic.
 */
export default async function globalSetup() {
  const url = e2eDatabaseUrl(process.env.DATABASE_URL);
  if (bootsEmbeddedPg(process.env.DATABASE_URL)) {
    postgres = await startE2ePostgres();
    console.log(`e2e postgres (embedded) on ${postgres.url}`);
  } else {
    console.log(`e2e postgres: using provided DATABASE_URL (${url.replace(/:[^:/@]*@/, ':***@')})`);
  }
  upstream = await startMockUpstream(MOCK_PORT);

  return async () => {
    await upstream?.close();
    upstream = null;
    await postgres?.stop();
    postgres = null;
  };
}
