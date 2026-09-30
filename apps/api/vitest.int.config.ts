import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration tests run against a real Postgres and Redis:
 *   TEST_DATABASE_URL (default postgres://tms:tms@localhost:5432/tms_test)
 *   TEST_REDIS_URL    (default redis://localhost:6379/15)
 * The database is wiped and migrated once per run by test/global-setup.ts.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.int.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
