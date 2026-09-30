import { defineConfig } from 'vitest/config';

// Unit tests only; integration tests run with vitest.int.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
  },
});
