import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    env: {
      DATABASE_URL_TEST:
        process.env.DATABASE_URL_TEST ??
        'postgresql://postgres:postgres@localhost:5432/superparakimi_test',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
