import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `.tsx` is here so component tests under tests/unit can render with
    // @testing-library/react in jsdom (see the @vitest-environment docblock
    // at the top of those files). Without it Vitest silently reports "No test
    // files found" for a perfectly good .tsx suite.
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
    // `globals` is deliberately NOT enabled. Without it, @testing-library/react's
    // automatic afterEach(cleanup) never registers, so rendered trees accumulate
    // in jsdom's document.body across a file — a `getByRole('button', {name})`
    // can then match a leftover render from an earlier test and pass while the
    // component under test is broken. Two tests here were unsound that way
    // before it was caught. Consequence: every jsdom suite MUST call
    // `afterEach(cleanup)` itself. The structural fix is `setupFiles` scoped to
    // the jsdom suites (or `test.projects`); deferred to Task 12 so this config
    // is not changed under a passing suite.
    // DATABASE_URL_TEST deliberately NOT defaulted here: its presence is
    // the selector for the real-Postgres (CI) backend in getDb(); local
    // runs leave it unset and get in-process PGlite.
    server: {
      deps: {
        // next-auth / @auth/core ship extensionless imports (next/server,
        // next/headers) that Node's ESM loader cannot resolve when Vitest
        // externalizes them; let Vite bundle these two instead.
        inline: [/next-auth/, /@auth\/core/],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
