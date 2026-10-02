import { call, login } from '../api';
import { env } from '../env';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  advanceTo,
  appEnv,
  garment,
  newShopper,
  placeOrder,
  signedIn,
  signInAdmin,
  SKIP_REASON,
  stamp,
  STORE_IMAGE_ERRORS,
} from './garment';

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

interface StaffTicket {
  id: string;
  subject: string;
  channel: string;
  externalRef: string | null;
  tags: string[];
  category: { name: string } | null;
  metadata: Record<string, unknown>;
  integration: { name: string } | null;
  customer: { displayName: string; primaryEmail: string | null };
}

test.describe('Ethnic Threads: help with an order', () => {
  test.skip(!garment.site, SKIP_REASON);

  test('the question reaches the desk with the order attached; the answer comes back to the shopper', async ({
    browser,
    page,
  }) => {
    const shopper = await newShopper();
    const order = await placeOrder(shopper, 'upi');
    await advanceTo(order.id, 'shipped');
    // A newer order too: the answer must be about the one that was asked about.
    await placeOrder(shopper, 'cod');

    const site = await signedIn(browser, shopper);
    await site.goto(`${garment.site}/orders/${order.id}`);
    await site.getByRole('button', { name: /Get help with this order/ }).click();
    const form = site.getByRole('form', { name: 'Get help with this order' });
    await form.getByLabel('What is it about').selectOption('where');
    await form.getByLabel('Tell us more').fill('Where is my order? I need it by the weekend.');
    await form.getByRole('button', { name: 'Send to support' }).click();
    const reference = (await site.getByTestId('request-reference').textContent())!;
    expect(reference).toMatch(/^TMS-\d+$/);

    // What the desk received: who, which order, and the order's facts from the shop's records.
    const admin = (await login()).accessToken;
    const ticket = await call<StaffTicket>(admin, 'GET', `/tickets/${reference}`);
    expect(ticket.subject).toBe(`Where is my order? Order ${order.id}`);
    expect(ticket.channel).toBe('api');
    expect(ticket.integration?.name).toBe('Ethnic Threads');
    expect(ticket.externalRef).toBe(order.id);
    expect(ticket.category?.name).toBe('Orders and delivery');
    expect(ticket.tags).toEqual(expect.arrayContaining(['order', 'where']));
    expect(ticket.customer).toMatchObject({
      displayName: shopper.name,
      primaryEmail: shopper.email,
    });
    expect(ticket.metadata).toMatchObject({
      form: 'order_help',
      order_id: order.id,
      status: 'shipped',
      carrier: 'SwiftShip',
      total: order.total,
      payment_status: 'paid',
    });

    await signInOrbit(page);
    const drawer = await openTicket(page, reference);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Context from Ethnic Threads');
    await expect(context).toContainText(order.id);
    await expect(context).toContainText('SwiftShip');

    // The AI looked the order up for this customer and drafted an answer; a person sends it.
    const draft = drawer.getByRole('group', { name: 'AI draft awaiting review' });
    await expect(draft).toBeVisible({ timeout: 40_000 });
    await expect(drawer).toContainText(`Order ${order.id} is shipped with SwiftShip`);
    await draft.getByRole('button', { name: 'Send draft' }).click();

    // The shopper finds it under Help, signed in: no link or token needed.
    await site.getByRole('link', { name: 'Follow this request' }).click();
    await expect(site).toHaveURL(new RegExp(`/requests/${reference}$`));
    const conversation = site.getByRole('list', { name: 'Conversation' });
    await expect(conversation).toContainText(`Order ${order.id} is shipped with SwiftShip`, {
      timeout: 30_000,
    });
    await expect(site.getByRole('link', { name: `Order ${order.id}` })).toBeVisible();

    // They write back; then it is solved and they rate it.
    const followUp = `Thank you! (${stamp()})`;
    await site.getByLabel('Add a message').fill(followUp);
    await site.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(conversation).toContainText(followUp);
    await expect(drawer.getByRole('region', { name: 'Conversation' })).toContainText(followUp, {
      timeout: 20_000,
    });
    await call(admin, 'POST', `/tickets/${ticket.id}/transition`, {
      status: 'resolved',
      resolution: 'Told the shopper where the order is.',
    });
    await expect(site.getByTestId('request-status')).toHaveText('Resolved', { timeout: 30_000 });
    await site.getByRole('radio', { name: '5 out of 5' }).click();
    await site.getByRole('button', { name: 'Send rating' }).click();
    await expect(site.getByText('Thank you for the rating.')).toBeVisible();

    // The request is listed on the order's own page and under Help.
    await site.goto(`${garment.site}/orders/${order.id}`);
    await expect(
      site.getByRole('region', { name: 'Your requests about this order' }),
    ).toContainText(reference);
    await site.goto(`${garment.site}/requests`);
    await expect(site.getByRole('link', { name: new RegExp(reference) })).toContainText(
      `Order ${order.id}`,
    );

    // The shop's admin sees the same story, told by the desk's webhooks, and can only read.
    const backRoom = await browser.newPage();
    await signInAdmin(backRoom);
    const panel = backRoom.getByRole('region', { name: 'Support desk', exact: true });
    await expect(panel.getByLabel('Support desk activity')).toContainText('5 out of 5', {
      timeout: 20_000,
    });
    await panel.getByRole('link', { name: new RegExp(reference) }).click();
    await expect(backRoom.getByText(/reading this as the shop's admin/)).toBeVisible();
    await expect(backRoom.getByLabel('Add a message')).toHaveCount(0);
    await backRoom.close();

    // Another shopper cannot open it.
    const other = await signedIn(browser, await newShopper('Ravi Menon'));
    await other.goto(`${garment.site}/requests/${reference}`);
    await expect(other.getByRole('alert')).toContainText('could not find that request');
    await other.close();
    await site.close();
  });

  test('a guest writes in from the contact form and follows the request by its link', async ({
    browser,
  }) => {
    const guest = await browser.newPage();
    await guest.goto(`${garment.site}/contact`);
    await guest.locator('#contact-name').fill('Passing Visitor');
    await guest.locator('#contact-email').fill(`visitor.${stamp()}@shopper.example`);
    await guest.locator('#contact-subject').selectOption('Product question');
    const question = `Do you deliver to Pune? (${stamp()})`;
    await guest.locator('#contact-message').fill(question);
    await guest.getByRole('button', { name: /Send message/ }).click();
    const reference = (await guest.getByTestId('request-reference').textContent())!;
    await guest.getByRole('link', { name: 'Follow this request' }).click();
    await expect(guest).toHaveURL(new RegExp(`/requests/${reference}#[0-9a-f]{32}$`));
    await expect(guest.getByRole('list', { name: 'Conversation' })).toContainText(question);

    // Without the link's token it is not there.
    const stranger = await browser.newPage();
    await stranger.goto(`${garment.site}/requests/${reference}`);
    await expect(stranger.getByRole('alert')).toContainText('could not find that request');
    await stranger.close();
    await guest.close();
  });

  test("the shop's key lists one shopper's tickets, and cannot reach a ticket it did not raise", async () => {
    const shopper = await newShopper();
    const order = await placeOrder(shopper);
    const settings = appEnv();
    const key = settings.SUPPORT_API_KEY_WEB!;
    const raise = (customer: Record<string, string>, externalRef?: string) =>
      fetch(`${env.api}/api/v1/integration/tickets`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          customer,
          subject: 'A question',
          body: 'Hello',
          externalRef,
          ai: 'off',
        }),
      }).then((r) => r.json() as Promise<{ reference: string }>);
    const mine = await raise({ externalId: shopper.id, email: shopper.email }, order.id);
    await raise({ externalId: `someone-else-${stamp()}` });

    const listed = await fetch(
      `${env.api}/api/v1/integration/tickets?customer=${encodeURIComponent(shopper.id)}`,
      { headers: { authorization: `Bearer ${key}` } },
    ).then(
      (r) =>
        r.json() as Promise<{
          total: number;
          items: Array<{ reference: string; customer: { externalId: string | null } }>;
        }>,
    );
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      reference: mine.reference,
      customer: { externalId: shopper.id },
    });

    // A ticket raised in Orbit Desk belongs to no integration.
    const admin = (await login()).accessToken;
    const customer = await call<{ id: string }>(admin, 'POST', '/customers', {
      displayName: `Walk-in ${stamp()}`,
      email: `walkin.${stamp()}@shopper.example`,
    });
    const other = await call<{ reference: string }>(admin, 'POST', '/tickets', {
      customerId: customer.id,
      subject: 'Raised by an agent',
      description: 'Not from the shop.',
    });
    const res = await fetch(`${env.api}/api/v1/integration/tickets/${other.reference}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(404);
  });
});
