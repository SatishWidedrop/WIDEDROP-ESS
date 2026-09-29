import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@widedrop/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    // Integration tests share one Postgres schema; run files serially.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
