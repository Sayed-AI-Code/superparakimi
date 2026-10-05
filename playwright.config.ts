import { defineConfig, devices } from '@playwright/test';

import { APP_ORIGIN, MOCK_BASE_URL, bootsEmbeddedPg, e2eDatabaseUrl } from './tests/e2e/ports';

/**
 * Playwright config for the single slice-1 smoke (spec §10).
 *
 * It runs the PRODUCTION build (`next build` then `next start`) rather than
 * `next dev`, and that choice is load-bearing rather than stylistic:
 *
 * 1. In this environment the development client never hydrates — neither
 *    Turbopack nor webpack attaches React to the DOM, with no page error and
 *    every chunk served 200, while the HMR websocket handshake fails
 *    (ERR_INVALID_HTTP_RESPONSE) on the same port. The production build
 *    hydrates correctly. A smoke that cannot click a button proves nothing, so
 *    it runs the artifact we actually ship.
 * 2. `next start` runs with NODE_ENV=production, where selectRuntimeBackend
 *    demands a real DATABASE_URL. globalSetup satisfies it with a real
 *    Postgres server over TCP, so the smoke exercises the node-postgres path
 *    production uses instead of the development-only in-process branch.
 *
 * Honest gap, unchanged: Neon's HTTP driver is not exercised by this smoke or
 * by anything else without real credentials, and the server here is PGlite
 * republished on the wire rather than a standalone postgres:16.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './tests/e2e/global-setup.ts',
  use: {
    baseURL: APP_ORIGIN,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npx next start --port ${Number(new URL(APP_ORIGIN).port)}`,
    url: APP_ORIGIN,
    timeout: 180_000,
    // Never reuse: a leftover `next start` serves the PREVIOUS build, so a
    // reused server can pass a smoke against code that is no longer on disk.
    // The build costs about a second, which is cheaper than that lie.
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      AUTH_SECRET: 'playwright-only-secret-not-for-production-use',
      OPENROUTER_API_KEY: 'sk-or-playwright-mock-key',
      OPENROUTER_BASE_URL: MOCK_BASE_URL,
      PARAPHRASE_MODEL: 'openai/gpt-4o-mini',
      DATABASE_URL: e2eDatabaseUrl(process.env.DATABASE_URL),
      // Only the embedded engine needs a serialized pool — PGlite runs one
      // query at a time and a wider pg pool resets (clean at 1, ECONNRESET at
      // 2, measured). CI's postgres:16 takes the default production pool.
      ...(bootsEmbeddedPg(process.env.DATABASE_URL) ? { PG_POOL_MAX: '1' } : {}),
    },
  },
});
