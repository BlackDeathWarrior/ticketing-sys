import { call, login, raw } from '../api';
import { env } from '../env';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  ADDRESS,
  appEnv,
  garment,
  incidents,
  newShopper,
  openChat,
  openIncident,
  orderOf,
  placeOrder,
  say,
  setSwitches,
  shopApi,
  signedIn,
  signInAdmin,
  SKIP_REASON,
  stamp,
  STORE_IMAGE_ERRORS,
  waitFor,
} from './garment';

test.use({ allowedConsoleErrors: [...STORE_IMAGE_ERRORS, /402/] });

interface StaffTicket {
  id: string;
  reference: string;
  status: string;
  priority: string;
  tags: string[];
  slaState: string | null;
  handling: string;
  resolution: string | null;
  team: { name: string } | null;
  assignee: { name: string } | null;
  customer: { displayName: string };
}

test.describe('Ethnic Threads: when something in the shop goes wrong', () => {
  test.skip(!garment.site, SKIP_REASON);

  test.afterEach(async () => {
    // The switches are the shop's own; leave it working for the next spec.
    if (garment.site) await setSwitches({ payments_down: false, carrier_delay: false });
  });

  test('payments fail: shoppers are told, one urgent ticket counts every failure, and it closes when they work again', async ({
    browser,
    page,
  }) => {
    const before = await openIncident('shop.payments_failing');
    expect(before, 'payments should be working when this spec starts').toBeUndefined();

    // The shop's admin switches the simulated problem on, in the shop's back room.
    const backRoom = await browser.newPage();
    await signInAdmin(backRoom);
    await backRoom.getByRole('switch', { name: 'Payments are failing' }).click();
    await expect(backRoom.getByTestId('shop-status')).toContainText('Payments failing');

    // A shopper tries to pay by UPI, twice.
    const shopper = await newShopper();
    const site = await signedIn(browser, shopper);
    await site.goto(garment.site);
    await site.locator('article').first().click();
    await site
      .getByRole('dialog')
      .first()
      .getByRole('button', { name: /Buy now/ })
      .click();
    await site.getByLabel('Phone number').fill(ADDRESS.phone);
    await site.getByLabel('Address line 1').fill(ADDRESS.line1);
    await site.getByLabel('City').fill(ADDRESS.city);
    await site.getByLabel('State').fill(ADDRESS.state);
    await site.getByLabel('PIN code').fill(ADDRESS.pincode);
    await site.getByLabel('UPI').check();
    const place = site.getByRole('button', { name: 'Place order' });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await place.click();
      await expect(site.getByRole('alert')).toContainText('you have not been charged');
      await waitFor(`failure ${attempt} to be counted`, async () => {
        const now = await openIncident('shop.payments_failing');
        return now && now.occurrences >= attempt ? now : undefined;
      });
    }
    // Nothing was ordered, and the cart is still there.
    expect(
      (await shopApi<{ orders: unknown[] }>('GET', '/orders', undefined, shopper.token)).body
        .orders,
    ).toEqual([]);

    // The desk: one incident, one urgent ticket for Operations, with the count.
    const incident = (await openIncident('shop.payments_failing'))!;
    expect(incident.title).toBe('Payments are failing at checkout');
    expect(incident.severity).toBe('critical');
    const admin = (await login()).accessToken;
    const ticket = await waitFor('the incident ticket to be routed', async () => {
      const t = await call<StaffTicket>(admin, 'GET', `/tickets/${incident.ticket}`);
      return t.team ? t : undefined;
    });
    expect(ticket.priority).toBe('urgent');
    expect(ticket.tags).toContain('incident');
    expect(ticket.team?.name).toBe('Operations');
    expect(ticket.handling).not.toBe('ai');

    await signInOrbit(page);
    const drawer = await openTicket(page, incident.ticket!);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Incident reported by Ethnic Threads');
    await expect(context.getByRole('list', { name: 'Incident reports' })).toContainText(
      `reported ${incident.occurrences} times`,
    );
    await expect(context).toContainText('shop.payments_failing');

    // The shop's admin sees it too; the AI can tell a shopper what is going on.
    await expect(backRoom.getByLabel('Open incidents')).toContainText(
      'Payments are failing at checkout',
      { timeout: 20_000 },
    );

    // Cash on delivery still works, as the shopper was told.
    await site.getByLabel('Cash on delivery').check();
    await place.click();
    await expect(site).toHaveURL(/\/orders\/ET-\d+\?placed=1$/);

    // Payments work again: the shop says so, and the ticket nobody had touched resolves itself.
    await backRoom.getByRole('switch', { name: 'Payments are failing' }).click();
    await expect(backRoom.getByTestId('shop-status')).toContainText('Payments working');
    await waitFor('the incident to resolve', async () =>
      (await incidents()).find((i) => i.ticket === incident.ticket)?.status === 'resolved'
        ? true
        : undefined,
    );
    const closed = await call<StaffTicket>(admin, 'GET', `/tickets/${incident.ticket}`);
    expect(closed.status).toBe('resolved');
    expect(closed.resolution).toContain('Ethnic Threads reported that this has recovered');
    await expect(backRoom.getByLabel('Open incidents')).toContainText('No open incidents', {
      timeout: 30_000,
    });
    await expect(drawer.getByRole('radio', { name: 'Resolved' })).toBeChecked({ timeout: 20_000 });
    await backRoom.close();
    await site.close();
  });

  test('the carrier is delayed: the order page says so, the AI says so, the desk has a ticket, and it all clears', async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const shopper = await newShopper(`Asha ${stamp()}`);
    await setSwitches({ carrier_delay: true });
    const order = await placeOrder(shopper, 'upi');

    // The warehouse still packs and ships; then the order stops with the carrier.
    const site = await signedIn(browser, shopper);
    await site.goto(`${garment.site}/orders/${order.id}`);
    await expect(site.getByRole('status')).toContainText('delayed with the carrier', {
      timeout: 60_000,
    });
    await expect(site.getByTestId('order-status')).toHaveText('Shipped');

    const incident = await waitFor('the delay to be reported', () =>
      openIncident('shop.shipping_delayed'),
    );
    expect(incident.title).toBe('Orders are delayed with the carrier');

    // Asked in the chat, the AI looks the order up and says it is late.
    const panel = await openChat(site);
    await say(panel, `Where is my order ${order.id}?`);
    await expect(panel.locator('.msg.ai').first()).toContainText(
      'it is delayed with the carrier at the moment',
      { timeout: 40_000 },
    );

    // The carrier moves again: the order goes on to be delivered and the incident resolves.
    await setSwitches({ carrier_delay: false });
    await expect(site.getByRole('status')).toHaveCount(0, { timeout: 20_000 });
    await expect(site.getByTestId('order-status')).toHaveText('Delivered', { timeout: 60_000 });
    await waitFor('the delay incident to resolve', async () =>
      (await incidents()).find((i) => i.ticket === incident.ticket)?.status === 'resolved'
        ? true
        : undefined,
    );
    expect((await orderOf(shopper, order.id)).delayed).toBe(false);
    await site.close();
  });

  test('a test delivery from Settings reaches the shop, signed; a forged one is refused', async ({
    browser,
    page,
  }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/integrations`);
    await page
      .getByRole('row', { name: /ethnic-threads/ })
      .getByRole('button', { name: 'Keys and webhooks' })
      .click();
    const card = page.getByRole('region', { name: 'Webhooks of Ethnic Threads' });
    await card.getByRole('button', { name: 'Send a test' }).click();
    await expect(card.getByRole('status')).toContainText('The test was delivered');

    const backRoom = await browser.newPage();
    await signInAdmin(backRoom);
    await expect(backRoom.getByLabel('Support desk activity')).toContainText('Test delivery', {
      timeout: 20_000,
    });
    const forged = await fetch(`${garment.shop}/api/support/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tms-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
      },
      body: JSON.stringify({ id: `forged-${stamp()}`, type: 'ticket.created', data: {} }),
    });
    expect(forged.status).toBe(401);

    await card.getByRole('button', { name: 'Deliveries' }).click();
    const log = card.getByRole('region', { name: 'Deliveries' });
    await expect(log.getByRole('row', { name: /Delivered/ }).first()).toBeVisible();
    await backRoom.close();
  });

  test('keys are limited to their job, their rate, and can be switched off at once', async () => {
    const settings = appEnv();
    const ticketsWith = (key: string) =>
      fetch(`${env.api}/api/v1/integration/tickets?limit=1`, {
        headers: { authorization: `Bearer ${key}` },
      });

    // The key that reports incidents cannot read shoppers' tickets.
    expect((await ticketsWith(settings.SUPPORT_API_KEY_EVENTS!)).status).toBe(403);
    expect((await ticketsWith(settings.SUPPORT_API_KEY_WEB!)).status).toBe(200);
    // A staff route refuses any key; the shop's tools refuse a shopper's session.
    const staff = await fetch(`${env.api}/api/v1/tickets?limit=1`, {
      headers: { authorization: `Bearer ${settings.SUPPORT_API_KEY_WEB}` },
    });
    expect(staff.status).toBe(403);
    const shopper = await newShopper();
    expect(
      (await shopApi('GET', '/support/tools/shop-status', undefined, shopper.token)).status,
    ).toBe(401);

    // A key of its own, so this can run again: five calls a minute, then no more.
    const admin = (await login()).accessToken;
    const integrations = await call<Array<{ id: string; slug: string }>>(
      admin,
      'GET',
      '/integrations',
    );
    const id = integrations.find((i) => i.slug === 'ethnic-threads')!.id;
    const made = await call<{ id: string; key: string }>(
      admin,
      'POST',
      `/integrations/${id}/keys`,
      {
        name: `E2E limited ${stamp()}`,
        scopes: ['integration:ticket'],
        rateLimitPerMinute: 5,
      },
    );
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await ticketsWith(made.key)).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);

    const revoked = await raw(admin, 'POST', `/integrations/keys/${made.id}/revoke`);
    expect(revoked.status).toBe(200);
    expect((await ticketsWith(made.key)).status).toBe(401);
  });

  test('an urgent chat that asks for a person breaches its two-minute answer time', async ({
    browser,
    page,
  }) => {
    test.setTimeout(240_000);
    const shopper = await newShopper(`Asha ${stamp()}`);
    await placeOrder(shopper);
    const site = await signedIn(browser, shopper);
    await site.goto(garment.site);
    const panel = await openChat(site);
    await say(panel, 'This is urgent: I want to talk to a real person about my payment, please.');

    const admin = (await login()).accessToken;
    const ticket = await waitFor('the handed-over ticket', async () => {
      const found = await call<{ items: StaffTicket[] }>(
        admin,
        'GET',
        '/tickets?channel=webchat&limit=50',
      );
      const mine = found.items.find((t) => t.customer.displayName === shopper.name);
      return mine?.handling === 'handed_over' ? mine : undefined;
    });
    // The shopper is told a person will answer; that is a notice, not the answer.
    await expect(panel.locator('.msg.ai').first()).toContainText("I'm passing this to", {
      timeout: 20_000,
    });

    // Nobody answers: the urgent policy gives two minutes.
    const late = await waitFor(
      'the answer time to be breached',
      async () => {
        const now = await call<StaffTicket>(admin, 'GET', `/tickets/${ticket.id}`);
        return now.slaState === 'breached' ? now : undefined;
      },
      200_000,
    );
    expect(late.priority).toBe('urgent');

    await signInOrbit(page);
    const drawer = await openTicket(page, late.reference);
    const sla = drawer.getByRole('region', { name: 'SLA' });
    await expect(sla).toContainText('First response');
    await expect(sla.locator('[data-state="breached"]').first()).toBeVisible();
    await site.close();
  });
});
