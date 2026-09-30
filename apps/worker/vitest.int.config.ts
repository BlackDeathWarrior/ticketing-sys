import { defineConfig } from 'vitest/config';

/** Runs against TEST_DATABASE_URL / TEST_REDIS_URL; see apps/api/vitest.int.config.ts. */
export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
