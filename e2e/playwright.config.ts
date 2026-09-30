import { defineConfig, devices } from '@playwright/test';

/**
 * Runs against a live stack loaded with `pnpm sample:load`. Defaults match
 * `pnpm docker:up`; override the URLs to point at dev servers instead.
 */
export default defineConfig({
  testDir: './tests',
  // Specs share one database and some watch live updates, so run them in order.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : undefined,
  },
});
