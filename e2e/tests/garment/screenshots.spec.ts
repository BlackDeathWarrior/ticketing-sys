import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, login } from '../api';
import { env } from '../env';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  appEnv,
  garment,
  newShopper,
  openChat,
  openFirstListing,
  registerShopper,
  signInAdmin,
  STORE_IMAGE_ERRORS,
} from './garment';

/**
 * Captures the Ethnic Threads screens used in docs/testing/TEST_REPORT.md and
 * the runbook. Needs the other garment specs to have run (it shows their
 * tickets). Skipped unless SCREENSHOTS=1 and GARMENT_URL are set.
 */
const dir = fileURLToPath(new URL('../../../docs/testing/screenshots', import.meta.url));
const shot = (name: string) => path.join(dir, `garment-${name}.png`);

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

interface Row {
  id: string;
  reference: string;
  tags: string[];
  status: string;
}

test.describe('Ethnic Threads screenshots', () => {
  test.skip(
    !process.env.SCREENSHOTS || !garment.site,
    'set SCREENSHOTS=1 and GARMENT_URL to capture the demo images',
  );
  test.beforeAll(() => mkdirSync(dir, { recursive: true }));

  test('the storefront', async ({ browser }) => {
    // A shopper: the listing they have open, the report form and the chat.
    const site = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await registerShopper(site, newShopper());
    await openFirstListing(site);
    await site.getByRole('button', { name: 'Report a problem with this listing' }).click();
    const panel = await openChat(site);
    await panel.getByLabel('Message').fill('Is this one in stock, and what is the price?');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('.msg.ai').first()).toBeVisible({ timeout: 40_000 });
    await panel.getByLabel('Message').fill('Why are the prices on the site so old?');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('.msg.ai').nth(1)).toBeVisible({ timeout: 40_000 });
    await site.waitForTimeout(500);
    await site.screenshot({ path: shot('storefront-chat') });

    // The same shopper writes in, is answered, and is asked how it went.
    const admin = (await login()).accessToken;
    await site.goto(`${garment.site}/contact`);
    await site.locator('select[name="subject"]').selectOption('General Feedback');
    await site.getByPlaceholder('How can we help?').fill('Do you deliver the clothes yourselves?');
    await site.getByRole('button', { name: /Send Message/ }).click();
    const reference = (await site.getByTestId('request-reference').textContent())!;
    await site.getByRole('link', { name: 'Follow this request' }).click();
    const ticket = await call<{ id: string }>(admin, 'GET', `/tickets/${reference}`);
    const [conversation] = await call<Array<{ id: string }>>(
      admin,
      'GET',
      `/tickets/${ticket.id}/conversations`,
    );
    await call(admin, 'POST', `/conversations/${conversation!.id}/messages`, {
      body: 'No: Ethnic Threads only shows the listings. The store you buy from delivers your order.',
    });
    await call(admin, 'POST', `/tickets/${ticket.id}/transition`, {
      status: 'resolved',
      resolution: 'Explained who delivers.',
    });
    await expect(site.getByTestId('request-status')).toHaveText('Resolved', { timeout: 30_000 });
    await expect(site.getByText('How did we do?')).toBeVisible();
    await site.waitForTimeout(300);
    await site.screenshot({ path: shot('storefront-request') });
    await site.setViewportSize({ width: 390, height: 844 });
    await site.waitForTimeout(300);
    await site.screenshot({ path: shot('storefront-request-phone') });
    await site.close();

    // The admin: open incidents, latest requests and what the desk reported back.
    const adminSite = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await signInAdmin(adminSite);
    const support = adminSite.getByRole('region', { name: 'Support desk', exact: true });
    await expect(support.getByLabel('Open incidents')).toContainText('Catalogue is', {
      timeout: 20_000,
    });
    await support.scrollIntoViewIfNeeded();
    await adminSite.waitForTimeout(500);
    await support.screenshot({ path: shot('storefront-admin-panel') });

    await adminSite.close();
  });

  test('Orbit Desk', async ({ page }) => {
    const admin = (await login()).accessToken;
    await signInOrbit(page);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    await page.locator('#queue').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('orbit-queue') });

    // A listing report: the listing came with the ticket.
    const listings = await call<{ items: Row[] }>(
      admin,
      'GET',
      '/tickets?channel=api&tag=listing&limit=5',
    );
    if (listings.items[0]) {
      await openTicket(page, listings.items[0].reference);
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot('orbit-listing-report') });
      await page.keyboard.press('Escape');
    }

    // The scraper's failed runs: one ticket, counted.
    const res = await fetch(`${env.api}/api/v1/integration/incidents?limit=50`, {
      headers: { authorization: `Bearer ${appEnv().SUPPORT_API_KEY_EVENTS}` },
    });
    const incidents = (await res.json()) as Array<{ fingerprint: string; ticket: string | null }>;
    const failed = incidents.find((i) => i.fingerprint === 'scraper.run_failed');
    if (failed?.ticket) {
      await openTicket(page, failed.ticket);
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot('orbit-incident') });
      await page.keyboard.press('Escape');
    }

    // A chat the AI answered from the app's own systems.
    const chats = await call<{ items: Row[] }>(admin, 'GET', '/tickets?channel=webchat&limit=30');
    for (const chat of chats.items) {
      const calls = await call<unknown[]>(admin, 'GET', `/tickets/${chat.id}/tool-calls`);
      if (calls.length < 2) continue;
      const drawer = await openTicket(page, chat.reference);
      await drawer.getByRole('region', { name: 'Company actions' }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot('orbit-chat-tools') });
      await page.keyboard.press('Escape');
      break;
    }

    // Keys, the webhook and its deliveries.
    await page.goto(`${env.orbit}/#/settings/integrations`);
    await page
      .getByRole('row', { name: /ethnic-threads/ })
      .getByRole('button', { name: 'Keys and webhooks' })
      .click();
    const hooks = page.getByRole('region', { name: 'Webhooks of Ethnic Threads' });
    await hooks.getByRole('button', { name: 'Deliveries' }).click();
    await expect(hooks.getByRole('region', { name: 'Deliveries' })).toBeVisible();
    await hooks.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('orbit-integration') });
  });
});
