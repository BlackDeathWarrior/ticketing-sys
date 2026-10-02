import { ADMIN } from '../env';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  garment,
  newShopper,
  openChat,
  openFirstListing,
  registerShopper,
  SKIP_REASON,
  stamp,
  STORE_IMAGE_ERRORS,
  waitFor,
} from './garment';

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

interface WorkerStatus {
  running: boolean;
  last_started_at: string | null;
  last_reason: string | null;
}
const workerStatus = async () =>
  (await (await fetch(`${garment.worker}/api/scrape-status`)).json()) as WorkerStatus;

test.describe('Ethnic Threads: the chat on the storefront', () => {
  test.skip(!garment.site, SKIP_REASON);

  test('carries the site’s look and answers from the knowledge base', async ({ browser }) => {
    const shopper = newShopper();
    const site = await browser.newPage();
    await registerShopper(site, shopper);

    const launcher = site.getByRole('button', { name: 'Chat with us' });
    await expect(launcher).toHaveCSS('background-color', 'rgb(139, 26, 26)');
    const panel = await openChat(site);
    // The site knows who this is: no name and email form.
    await panel.getByLabel('Message').fill(`Is browsing Ethnic Threads free? (${stamp()})`);
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('.msg.ai').first()).toContainText(/free/i, { timeout: 40_000 });
    await site.close();
  });

  test('knows which listing is open, and checks the app’s own systems before answering', async ({
    browser,
    page,
  }) => {
    const shopper = newShopper();
    const site = await browser.newPage();
    await registerShopper(site, shopper);
    const title = await openFirstListing(site);

    // The listing on screen: the AI looks it up in the app's catalogue.
    const panel = await openChat(site);
    await panel.getByLabel('Message').fill('Is this one in stock, and what is the price?');
    await panel.getByRole('button', { name: 'Send' }).click();
    const first = panel.locator('.msg.ai').first();
    await expect(first).toContainText(title, { timeout: 40_000 });
    await expect(first).toContainText(/when we last checked on \d{4}-\d{2}-\d{2}/);

    // "Why are prices old?": it asks the app how fresh the catalogue is and what the scraper is doing.
    await panel.getByLabel('Message').fill('Why are the prices on the site so old?');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.locator('.msg.ai').nth(1)).toContainText(/last refreshed on|refreshed on/, {
      timeout: 40_000,
    });

    // The agent's side: the context the widget sent, and the calls the AI made to the app.
    await signInOrbit(page);
    const row = page.locator('tr[data-ticket]', { hasText: shopper.name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const drawer = await openTicket(page, (await row.getAttribute('data-ticket'))!);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Context from Ethnic Threads');
    await expect(context).toContainText(title);
    const actions = drawer.getByRole('region', { name: 'Company actions' });
    await expect(actions).toContainText('Look up a listing');
    await expect(actions).toContainText('Catalogue freshness');
    await expect(actions).toContainText('Scraper status');
    await site.close();
  });

  test('a refresh the shopper asks for waits for a supervisor, then starts a scrape in the app', async ({
    browser,
    page,
  }) => {
    const shopper = newShopper();
    const site = await browser.newPage();
    await registerShopper(site, shopper);
    const before = await workerStatus();

    const panel = await openChat(site);
    await panel.getByLabel('Message').fill('Please refresh the prices, they look out of date.');
    await panel.getByRole('button', { name: 'Send' }).click();
    await expect(panel.getByText(/asked our team to approve a refresh/)).toBeVisible({
      timeout: 40_000,
    });
    // Nothing has run yet: the AI may only ask.
    expect((await workerStatus()).last_started_at).toBe(before.last_started_at);

    await signInOrbit(page, ADMIN.email);
    await page.getByRole('link', { name: /Approvals/ }).click();
    const card = page.locator('[data-approval]', { hasText: shopper.name });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Start a scrape');
    await card.getByLabel('Note (internal, optional)').fill('Catalogue is stale');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveCount(0);

    // The app's worker really started a run, and says who asked.
    const after = await waitFor('the worker to start a scrape', async () => {
      const status = await workerStatus();
      return status.last_started_at !== before.last_started_at ? status : undefined;
    });
    expect(after.last_reason).toMatch(/^support-desk/);
    await expect(panel.getByText(/the catalogue refresh has started/)).toBeVisible({
      timeout: 40_000,
    });

    await site.close();
  });
});
