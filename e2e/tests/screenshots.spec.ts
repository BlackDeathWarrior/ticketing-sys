import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTicket, login } from './api';
import { env } from './env';
import { expect, openTicket, signInConsole, signInOrbit, test } from './fixtures';

/**
 * Captures the screens used in docs/testing/TEST_REPORT.md. Skipped unless
 * SCREENSHOTS=1, so normal runs don't rewrite the committed images.
 */
const dir = fileURLToPath(new URL('../../docs/testing/screenshots', import.meta.url));
const shot = (name: string) => path.join(dir, `${name}.png`);

test.describe('report screenshots', () => {
  test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture report images');
  test.beforeAll(() => mkdirSync(dir, { recursive: true }));

  test('Orbit Desk', async ({ page }) => {
    await signInOrbit(page);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('orbit-dashboard'), fullPage: false });
    await page.locator('#queue').scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot('orbit-queue') });

    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Shipment tracking page shows every container as "lost"');
    await openTicket(page, t.reference);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-drawer') });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'New ticket' }).click();
    const dialog = page.getByRole('dialog', { name: 'New ticket' });
    await dialog.getByLabel('Subject').fill('Bulk discount for 20 cargo bikes');
    await dialog.getByLabel('Customer', { exact: true }).fill('River');
    await expect(dialog.getByRole('button', { name: /Ravi Menon/ })).toBeVisible();
    await page.screenshot({ path: shot('orbit-new-ticket') });
  });

  test('Orbit Desk knowledge base', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/kb`);
    await page.getByLabel('Search the knowledge base').fill('when will my refund reach my card');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Knowledge base results' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-kb'), fullPage: true });
  });

  test('Orbit Desk settings', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/providers`);
    await expect(page.getByRole('row', { name: /Demo model \(scripted\)/ })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-settings-providers') });
    await page.getByRole('tab', { name: 'Models & roles' }).click();
    await expect(page.getByRole('region', { name: 'AI agent (chat and email)' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-settings-models'), fullPage: true });
  });

  test('Orbit Desk on a phone', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await signInOrbit(page);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    await page.screenshot({ path: shot('orbit-phone') });
    await page.close();
  });

  test('basic console, widget and Mailpit', async ({ page, browser }) => {
    await signInConsole(page);
    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Exchange hiking boots for a larger size');
    await page.goto(`${env.console}/tickets/${t.reference}`);
    await expect(page.getByText('exchange label EX-2231')).toBeVisible();
    await page.screenshot({ path: shot('console-ticket') });

    const visitor = await browser.newPage();
    await visitor.goto(env.widgetDemo);
    await visitor.getByRole('button', { name: 'Chat with us' }).click();
    await visitor.getByLabel('Name').fill('Rosa Quintero');
    await visitor.getByRole('button', { name: 'Start chat' }).click();
    await visitor.getByLabel('Message').fill('Hello! Do you ship to the Canary Islands?');
    await visitor.getByRole('button', { name: 'Send' }).click();
    await expect(visitor.getByText('Do you ship to the Canary Islands?')).toBeVisible();
    await visitor.screenshot({ path: shot('widget') });
    await visitor.goto(env.mailpit);
    await visitor.waitForTimeout(1000);
    await visitor.screenshot({ path: shot('mailpit') });
    await visitor.close();
  });
});
