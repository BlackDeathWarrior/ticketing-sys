import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, login } from '../api';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  advanceTo,
  garment,
  newShopper,
  openChat,
  openIncident,
  placeOrder,
  say,
  setSwitches,
  shopApi,
  signedIn,
  signInAdmin,
  someProductId,
  STORE_IMAGE_ERRORS,
  waitFor,
} from './garment';

/**
 * Captures the shop demo's screens for docs/testing/TEST_REPORT.md and the
 * runbook. It makes its own shopper, orders and tickets. Skipped unless
 * SCREENSHOTS=1 and GARMENT_URL are set.
 */
const dir = fileURLToPath(new URL('../../../docs/testing/screenshots', import.meta.url));
const shot = (name: string) => path.join(dir, `shop-${name}.png`);
const desktop = { viewport: { width: 1440, height: 1000 } };

test.use({ allowedConsoleErrors: [...STORE_IMAGE_ERRORS, /402/] });

test.describe('Ethnic Threads shop screenshots', () => {
  test.skip(
    !process.env.SCREENSHOTS || !garment.site,
    'set SCREENSHOTS=1 and GARMENT_URL to capture the demo images',
  );
  test.beforeAll(() => mkdirSync(dir, { recursive: true }));
  test.afterAll(async () => {
    if (garment.site) await setSwitches({ payments_down: false, carrier_delay: false });
  });

  test('the shop and the desk', async ({ browser, page }) => {
    test.setTimeout(240_000);
    const admin = (await login()).accessToken;
    const shopper = await newShopper('Asha Verma');

    // ---- The shop ----
    const site = await signedIn(browser, shopper);
    await site.setViewportSize(desktop.viewport);
    await site.goto(garment.site);
    await expect(site.locator('article').first()).toBeVisible({ timeout: 30_000 });
    await site.waitForTimeout(1500);
    await site.screenshot({ path: shot('storefront') });

    await site.locator('article').nth(1).click();
    const product = site.getByRole('dialog').first();
    await product.getByRole('button', { name: 'Add to cart' }).click();
    await site.waitForTimeout(400);
    await site.screenshot({ path: shot('product') });
    await product.getByRole('button', { name: /Buy now/ }).click();
    await site.getByLabel('Phone number').fill('98300 55555');
    await site.getByLabel('Address line 1').fill('12 MG Road');
    await site.getByLabel('City').fill('Bengaluru');
    await site.getByLabel('State').fill('Karnataka');
    await site.getByLabel('PIN code').fill('560001');
    await site.getByLabel('UPI').check();
    await expect(site.getByRole('button', { name: 'Place order' })).toBeEnabled();
    await site.waitForTimeout(300);
    await site.screenshot({ path: shot('checkout'), fullPage: true });

    // An order on its way, asked about in the chat.
    const shipped = await placeOrder(shopper, 'upi');
    await advanceTo(shipped.id, 'shipped');
    await site.goto(`${garment.site}/orders/${shipped.id}`);
    await expect(site.getByTestId('order-status')).toBeVisible();
    const panel = await openChat(site);
    await say(panel, `Where is my order ${shipped.id}?`);
    await expect(panel.locator('.msg.ai').first()).toBeVisible({ timeout: 40_000 });
    await site.waitForTimeout(500);
    await site.screenshot({ path: shot('order-and-chat') });

    // Help with the order: the request, and the AI's draft in Orbit Desk.
    const help = await shopApi<{ reference: string }>(
      'POST',
      '/support/tickets',
      {
        kind: 'order',
        orderId: shipped.id,
        issue: 'where',
        message: 'Where is my order? I need it by the weekend.',
        requestId: `shot-${Date.now()}`,
      },
      shopper.token,
    );
    await signInOrbit(page);
    const drawer = await openTicket(page, help.body.reference);
    await expect(drawer.getByRole('group', { name: 'AI draft awaiting review' })).toBeVisible({
      timeout: 40_000,
    });
    await drawer.getByRole('group', { name: 'AI draft awaiting review' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('orbit-order-help') });
    await drawer
      .getByRole('group', { name: 'AI draft awaiting review' })
      .getByRole('button', { name: 'Send draft' })
      .click();
    await page.keyboard.press('Escape');
    await site.goto(`${garment.site}/requests/${help.body.reference}`);
    await expect(site.getByRole('list', { name: 'Conversation' })).toContainText('SwiftShip', {
      timeout: 30_000,
    });
    await site.waitForTimeout(300);
    await site.screenshot({ path: shot('request') });
    await site.setViewportSize({ width: 390, height: 844 });
    await site.goto(`${garment.site}/orders/${shipped.id}`);
    await expect(site.getByTestId('order-status')).toBeVisible();
    await site.waitForTimeout(400);
    await site.screenshot({ path: shot('order-phone') });
    await site.setViewportSize(desktop.viewport);

    // A refund waiting for a supervisor.
    const delivered = await placeOrder(shopper, 'upi');
    await advanceTo(delivered.id, 'delivered');
    await site.goto(`${garment.site}/orders/${delivered.id}`);
    const chat = await openChat(site);
    await say(chat, `I want a refund for order ${delivered.id}, it arrived torn.`);
    await expect(chat.getByText(/for approval/)).toBeVisible({ timeout: 40_000 });
    await page.getByRole('link', { name: /Approvals/ }).click();
    await expect(page.locator('[data-approval]', { hasText: delivered.id })).toBeVisible({
      timeout: 20_000,
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-approval') });

    // Payments fail: the checkout, the back room, the incident ticket.
    await setSwitches({ payments_down: true });
    const productId = await someProductId();
    for (let i = 0; i < 2; i++) {
      const tried = await shopApi<{ reason?: string }>(
        'POST',
        '/orders',
        {
          items: [{ productId, quantity: 1 }],
          address: {
            name: 'Asha Verma',
            phone: '9830055555',
            line1: '12 MG Road',
            city: 'Bengaluru',
            state: 'Karnataka',
            pincode: '560001',
          },
          payment: 'upi',
        },
        shopper.token,
      );
      expect(tried.status).toBe(402);
    }
    const incident = await waitFor('the payments incident', async () => {
      const found = await openIncident('shop.payments_failing');
      return found && found.occurrences >= 2 ? found : undefined;
    });
    const backRoom = await browser.newPage(desktop);
    await signInAdmin(backRoom);
    await expect(backRoom.getByLabel('Open incidents')).toContainText('Payments are failing', {
      timeout: 20_000,
    });
    await backRoom.waitForTimeout(500);
    await backRoom.screenshot({ path: shot('operations'), fullPage: true });
    await backRoom.close();

    await page.goto(`${process.env.ORBIT_URL ?? 'http://localhost:8081'}/`);
    const incidentDrawer = await openTicket(page, incident.ticket!);
    await expect(incidentDrawer).toContainText('Payments are failing at checkout');
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('orbit-incident') });
    await page.keyboard.press('Escape');
    await setSwitches({ payments_down: false });

    // The chat ticket with the calls the AI made, and the queue.
    const chats = await call<{ items: Array<{ id: string; reference: string }> }>(
      admin,
      'GET',
      '/tickets?channel=webchat&limit=30',
    );
    for (const ticket of chats.items) {
      const calls = await call<unknown[]>(admin, 'GET', `/tickets/${ticket.id}/tool-calls`);
      if (!calls.length) continue;
      const chatDrawer = await openTicket(page, ticket.reference);
      await chatDrawer.getByRole('region', { name: 'Company actions' }).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: shot('orbit-chat-tools') });
      await page.keyboard.press('Escape');
      break;
    }
    await page.getByLabel('Search tickets').fill('');
    await page.locator('#queue').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('orbit-queue') });
    await site.close();
  });
});
