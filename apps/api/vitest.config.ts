import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: here,
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
    // Integration tests share one Postgres schema, so two files running at
    // once truncate each other's fixtures. One worker, one file at a time.
    //
    // `poolOptions.forks.singleFork` said this until Vitest 4 removed it — and
    // removed it silently, as a deprecation warning rather than an error, so
    // the suite went from serial to parallel with no signal beyond a hundred
    // tests failing at once.
    pool: 'forks',
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
