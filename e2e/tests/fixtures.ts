import { test as base, expect, type Page } from '@playwright/test';
import { login, type Tokens } from './api';
import { ADMIN, env } from './env';

type Fixtures = {
  /** Console errors and uncaught exceptions seen during the test. */
  consoleErrors: string[];
  /** Patterns for console errors a test expects (e.g. a 401 on a bad login). */
  allowedConsoleErrors: RegExp[];
};

export const test = base.extend<Fixtures>({
  allowedConsoleErrors: [[], { option: true }],
  consoleErrors: [
    async ({ page, allowedConsoleErrors }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      const unexpected = errors.filter((e) => !allowedConsoleErrors.some((re) => re.test(e)));
      expect(unexpected, 'unexpected browser console errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Signs a page into Orbit Desk by seeding its token store before the app loads. */
export async function signInOrbit(page: Page, email = ADMIN.email, password?: string) {
  const tokens: Tokens = await login(email, password ?? passwordFor(email));
  await page.addInitScript((t) => {
    localStorage.setItem('orbit.tokens', JSON.stringify(t));
  }, tokens);
  await page.goto(env.orbit);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    /Good (morning|afternoon|evening)/,
  );
  return tokens;
}

/** Same for the basic console (apps/web), which keeps tokens under another key. */
export async function signInConsole(page: Page, email = ADMIN.email) {
  const tokens = await login(email, passwordFor(email));
  await page.addInitScript((t) => {
    localStorage.setItem('tms.tokens', JSON.stringify(t));
  }, tokens);
  return tokens;
}

function passwordFor(email: string) {
  return email === ADMIN.email ? ADMIN.password : 'Sample-Passw0rd!';
}

/** Opens a ticket's drawer from the queue by its reference. */
export async function openTicket(page: Page, reference: string) {
  await page.getByLabel('Search tickets').fill(reference);
  const row = page.locator(`tr[data-ticket="${reference}"]`);
  await row.click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText(reference, { exact: true })).toBeVisible();
  return drawer;
}
