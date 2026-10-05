import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
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
