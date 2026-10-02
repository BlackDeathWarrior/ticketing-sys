import { call, login } from '../api';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  advanceTo,
  garment,
  newShopper,
  openChat,
  orderOf,
  placeOrder,
  say,
  signedIn,
  SKIP_REASON,
  STORE_IMAGE_ERRORS,
  waitFor,
} from './garment';

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

interface Row {
  id: string;
  reference: string;
  handling: string;
  customer: { displayName: string };
}

const chatTicket = async (admin: string, customerName: string) =>
  (await call<{ items: Row[] }>(admin, 'GET', '/tickets?channel=webchat&limit=50')).items.find(
    (t) => t.customer.displayName === customerName,
  );

test.describe('Ethnic Threads: the chat in the shop', () => {
  test.skip(!garment.site, SKIP_REASON);

  test('carries the shop’s look and answers from the knowledge base', async ({ browser }) => {
    const page = await browser.newPage();
    await page.goto(garment.site);
    const launcher = page.getByRole('button', { name: 'Chat with us' });
    await expect(launcher).toHaveCSS('background-color', 'rgb(139, 26, 26)');
    await launcher.click();
    const panel = page.getByRole('dialog', { name: 'Ethnic Threads support' });
    // Not signed in: the widget asks who this is, and what they type proves nothing.
    await panel.getByLabel('Name').fill('Curious Visitor');
    await panel.getByLabel('Email').fill('curious@shopper.example');
    await panel.getByRole('button', { name: 'Start chat' }).click();
    await say(panel, 'How much does standard delivery cost?');
    await expect(panel.locator('.msg.ai').first()).toContainText('₹49', { timeout: 40_000 });
    await page.close();
  });

  test('looks up the signed-in shopper’s own order, and cancels it when asked', async ({
    browser,
    page,
  }) => {
    const shopper = await newShopper(`Asha ${Date.now().toString(36)}`);
    const shipped = await placeOrder(shopper, 'cod');
    await advanceTo(shipped.id, 'shipped');

    const site = await signedIn(browser, shopper);
    await site.goto(`${garment.site}/orders/${shipped.id}`);
    // Signed in: no name form, the shop vouches for who this is.
    const panel = await openChat(site);
    await say(panel, `Where is my order ${shipped.id}?`);
    const answer = panel.locator('.msg.ai').first();
    await expect(answer).toContainText(`Order ${shipped.id} is shipped with SwiftShip`, {
      timeout: 40_000,
    });
    await expect(answer).toContainText(/the tracking number is SW\d+/);

    // A second order, still in the warehouse: the AI cancels it on request, and the money comes back.
    const fresh = await placeOrder(shopper, 'card');
    await say(panel, `Please cancel my order ${fresh.id}, I ordered it by mistake.`);
    await expect(panel.locator('.msg.ai').nth(1)).toContainText(
      new RegExp(
        `Order ${fresh.id} is cancelled\\. Your refund of [\\d.]+ INR \\(reference RF-\\d+\\)`,
      ),
      { timeout: 40_000 },
    );
    const cancelled = await orderOf(shopper, fresh.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.payment.status).toBe('refunded');

    // The agent's side: what the widget said the shopper was looking at, and the calls the AI made.
    const admin = (await login()).accessToken;
    const ticket = await waitFor('the chat ticket', () => chatTicket(admin, shopper.name));
    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Context from Ethnic Threads');
    await expect(context).toContainText(shipped.id);
    const actions = drawer.getByRole('region', { name: 'Company actions' });
    await expect(actions).toContainText('Order status');
    await expect(actions).toContainText('Cancel an order');
    // The customer's email was filled in by TMS, and is not shown as something the AI chose.
    await expect(actions).toContainText(`order id ${shipped.id}`);
    await expect(actions).not.toContainText(shopper.email);
    await site.close();
  });

  test('tells a visitor who only typed someone’s email nothing about that person’s order', async ({
    browser,
  }) => {
    const owner = await newShopper();
    const order = await placeOrder(owner, 'cod');
    await advanceTo(order.id, 'shipped');

    // Not signed in. They give the owner's email and the right order number.
    const name = `Impostor ${Date.now().toString(36)}`;
    const visitor = await browser.newPage();
    await visitor.goto(garment.site);
    await visitor.getByRole('button', { name: 'Chat with us' }).click();
    const panel = visitor.getByRole('dialog', { name: 'Ethnic Threads support' });
    await panel.getByLabel('Name').fill(name);
    await panel.getByLabel('Email').fill(owner.email);
    await panel.getByRole('button', { name: 'Start chat' }).click();
    await say(panel, `Where is my order ${order.id}?`);

    // The AI was refused the lookup and handed over; the chat says a person will reply.
    const admin = (await login()).accessToken;
    const ticket = await waitFor('the visitor to be handed over', async () => {
      const t = await chatTicket(admin, name);
      return t?.handling === 'handed_over' ? t : undefined;
    });
    const calls = await call<Array<{ status: string }>>(
      admin,
      'GET',
      `/tickets/${ticket.id}/tool-calls`,
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.status !== 'ok')).toBe(true);
    await expect(panel).not.toContainText('SwiftShip');
    await expect(panel).not.toContainText('shipped');
    await visitor.close();
  });

  test('a refund the shopper asks for waits for a supervisor, then really refunds the order', async ({
    browser,
    page,
  }) => {
    const shopper = await newShopper(`Asha ${Date.now().toString(36)}`);
    const order = await placeOrder(shopper, 'upi');
    await advanceTo(order.id, 'delivered');

    const site = await signedIn(browser, shopper);
    await site.goto(`${garment.site}/orders/${order.id}`);
    const panel = await openChat(site);
    await say(panel, `I want a refund for order ${order.id}, it arrived torn.`);
    await expect(panel.getByText(/sent your refund request .* for approval/)).toBeVisible({
      timeout: 40_000,
    });
    // Nothing has been refunded yet: the AI may only ask.
    expect((await orderOf(shopper, order.id)).refund).toBeNull();

    await signInOrbit(page);
    await page.getByRole('link', { name: /Approvals/ }).click();
    const card = page.locator('[data-approval]', { hasText: order.id });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Refund an order');
    await expect(card).toContainText(shopper.name);
    await expect(card).not.toContainText(shopper.email);
    await card.getByLabel('Note (internal, optional)').fill('Photo shows the tear');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveCount(0);

    // The shop refunded it, the shopper is told in the chat, and the order page shows it.
    await expect(panel.getByText(/has been issued \(reference RF-\d+\)/)).toBeVisible({
      timeout: 40_000,
    });
    const refunded = await orderOf(shopper, order.id);
    expect(refunded.status).toBe('refunded');
    expect(refunded.refund?.amount).toBe(order.total);
    await expect(site.getByTestId('order-status')).toHaveText('Refunded', { timeout: 20_000 });
    await expect(site.getByTestId('refund')).toContainText(refunded.refund!.id);
    await site.close();
  });
});
