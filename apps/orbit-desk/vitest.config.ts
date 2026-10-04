import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Plain esbuild JSX: the React plugin's Vite types differ from Vitest's bundled Vite.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@tms/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    // Dates are worded in the viewer's time zone; the tests expect UTC wherever they run.
    env: { TZ: 'UTC' },
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
