import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // DATABASE_URL_TEST deliberately NOT defaulted here: its presence is
    // the selector for the real-Postgres (CI) backend in getDb(); local
    // runs leave it unset and get in-process PGlite.
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
