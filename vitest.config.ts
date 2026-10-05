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
    // Parallelism is switched off ONLY when the database is shared.
    //
    // Nine suites call resetTestDb(), which TRUNCATEs users, accounts,
    // sessions, verification_tokens and usage_events in beforeEach. Vitest
    // parallelises FILES across worker processes by default, so with one
    // DATABASE_URL_TEST every worker truncates the same tables while the
    // others are mid-flight — a row inserted by worker A vanishes under worker
    // B's insert and the FK on usage_events.user_id fires. It never reproduces
    // locally because without DATABASE_URL_TEST each worker boots its own
    // in-process PGlite and nothing is shared: the race is structurally
    // impossible right up until CI, which sets that variable.
    //
    // So the selector is the same one db/index.ts uses. Local keeps its
    // parallelism; CI pays roughly a minute of serial time for a suite that
    // then cannot truncate itself into failure. The upgrade that keeps CI fast
    // AND parallel is one schema per worker with search_path pinned per
    // connection — deferred, because it cannot be verified on a host with no
    // Postgres and no Docker, and a wrong isolation boundary is worse than
    // serial.
    fileParallelism: !process.env.DATABASE_URL_TEST,
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
