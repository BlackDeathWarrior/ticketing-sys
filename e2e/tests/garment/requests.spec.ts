import { call, login } from '../api';
import { env } from '../env';
import { expect, openTicket, signInOrbit, test } from '../fixtures';
import {
  appEnv,
  garment,
  newShopper,
  openFirstListing,
  registerShopper,
  signInAdmin,
  SKIP_REASON,
  stamp,
  STORE_IMAGE_ERRORS,
} from './garment';

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

test.describe('Ethnic Threads: requests from the storefront', () => {
  test.skip(!garment.site, SKIP_REASON);

  test('a shopper writes in; the AI drafts, an agent sends it, the shopper reads, answers and rates', async ({
    browser,
    page,
  }) => {
    const shopper = newShopper();
    const site = await browser.newPage();
    await registerShopper(site, shopper);

    // The contact form knows who is using this browser.
    await site.goto(`${garment.site}/contact`);
    await expect(site.getByPlaceholder('John Doe')).toHaveValue(shopper.name);
    await expect(site.getByPlaceholder('john@example.com')).toHaveValue(shopper.email);
    await site.locator('select[name="subject"]').selectOption('General Feedback');
    const question = `Can I place an order and pay on Ethnic Threads? (${stamp()})`;
    await site.getByPlaceholder('How can we help?').fill(question);
    await site.getByRole('button', { name: /Send Message/ }).click();

    const reference = (await site.getByTestId('request-reference').textContent())!;
    expect(reference).toMatch(/^TMS-\d+$/);
    await site.getByRole('link', { name: 'Follow this request' }).click();
    await expect(site).toHaveURL(new RegExp(`/requests/${reference}#[0-9a-f]{32}$`));
    const conversation = site.getByRole('list', { name: 'Conversation' });
    await expect(conversation).toContainText(question);

    // In Orbit Desk the ticket says which app sent it and from which form.
    await signInOrbit(page);
    const drawer = await openTicket(page, reference);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Context from Ethnic Threads');
    await expect(context).toContainText('contact');

    // A form request is not a live chat: the AI drafts, a person sends.
    const draft = drawer.getByRole('group', { name: 'AI draft awaiting review' });
    await expect(draft).toBeVisible({ timeout: 40_000 });
    await expect(drawer).toContainText('Ethnic Threads is not a shop');
    // Until then the shopper sees nothing of it.
    await expect(conversation).not.toContainText('not a shop');
    await draft.getByRole('button', { name: 'Send draft' }).click();

    // The shopper's page hears about the reply (the app's webhook receiver) and shows it.
    await expect(conversation).toContainText('Ethnic Threads is not a shop', { timeout: 30_000 });

    // They write back from the same page; the agent sees it on the ticket.
    const followUp = `Thanks, that is clear. (${stamp()})`;
    await site.getByLabel('Add a message').fill(followUp);
    await site.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(conversation).toContainText(followUp);
    await expect(drawer.getByRole('region', { name: 'Conversation' })).toContainText(followUp, {
      timeout: 20_000,
    });

    // Solved: the shopper is asked how it went, and the rating goes back to the desk.
    const admin = (await login()).accessToken;
    const ticket = await call<{ id: string }>(admin, 'GET', `/tickets/${reference}`);
    await call(admin, 'POST', `/tickets/${ticket.id}/transition`, {
      status: 'resolved',
      resolution: 'Explained that Ethnic Threads links to the stores.',
    });
    await expect(site.getByTestId('request-status')).toHaveText('Resolved', { timeout: 30_000 });
    await site.getByRole('radio', { name: '5 out of 5' }).click();
    await site.getByLabel('Comment').fill('Quick and clear');
    await site.getByRole('button', { name: 'Send rating' }).click();
    await expect(site.getByText('Thank you for the rating.')).toBeVisible();

    // "My Requests" remembers it in this browser.
    await site.goto(`${garment.site}/requests`);
    await expect(site.getByRole('link', { name: new RegExp(reference) })).toBeVisible();

    // The app's admin sees the same story, told by the desk's webhooks.
    const adminSite = await browser.newPage();
    await signInAdmin(adminSite);
    const panel = adminSite.getByRole('region', { name: 'Support desk', exact: true });
    await expect(panel.getByRole('link', { name: new RegExp(reference) })).toBeVisible({
      timeout: 20_000,
    });
    const activity = panel.getByLabel('Support desk activity');
    await expect(activity).toContainText('5 out of 5', { timeout: 20_000 });
    await expect(activity).toContainText(reference);

    // Someone without the link's token cannot read it.
    const stranger = await browser.newPage();
    await stranger.goto(`${garment.site}/requests/${reference}`);
    await expect(stranger.getByRole('alert')).toContainText('could not find that request');
    await stranger.close();
    await adminSite.close();
    await site.close();
  });

  test('a listing report carries the listing, from the app’s own catalogue', async ({
    browser,
    page,
  }) => {
    const shopper = newShopper();
    const site = await browser.newPage();
    await registerShopper(site, shopper);
    const title = await openFirstListing(site);

    await site.getByRole('button', { name: 'Report a problem with this listing' }).click();
    const form = site.getByRole('form', { name: 'Report a problem' });
    await form.getByLabel('What is wrong').selectOption('wrong-price');
    await expect(form.getByLabel('Your name')).toHaveValue(shopper.name);
    const note = `The store shows a higher price. (${stamp()})`;
    await form.getByLabel('What did you see').fill(note);
    await form.getByRole('button', { name: 'Send report' }).click();
    const reference = (await site.getByTestId('request-reference').textContent())!;

    const admin = (await login()).accessToken;
    const ticket = await call<{
      subject: string;
      channel: string;
      externalRef: string;
      tags: string[];
      category: { name: string } | null;
      metadata: Record<string, unknown>;
      integration: { name: string } | null;
    }>(admin, 'GET', `/tickets/${reference}`);
    expect(ticket.subject).toBe(`Wrong price: ${title}`.slice(0, 300));
    expect(ticket.channel).toBe('api');
    expect(ticket.integration?.name).toBe('Ethnic Threads');
    expect(ticket.category?.name).toBe('Listings');
    expect(ticket.tags).toEqual(expect.arrayContaining(['listing', 'wrong-price']));
    // The listing's facts, as the app's catalogue has them.
    expect(ticket.metadata).toMatchObject({ form: 'listing_report', issue: 'Wrong price', title });
    expect(ticket.metadata.product_id).toBe(ticket.externalRef);
    expect(typeof ticket.metadata.price_current).toBe('number');
    expect(String(ticket.metadata.scraped_at)).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    await signInOrbit(page);
    const drawer = await openTicket(page, reference);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText('Context from Ethnic Threads');
    await expect(context).toContainText(ticket.externalRef);
    await expect(context).toContainText('Wrong price');
    await expect(drawer.getByRole('region', { name: 'Conversation' })).toContainText(note);
    await site.close();
  });

  test('the app’s key reads only the app’s own tickets', async () => {
    // A ticket raised in Orbit Desk belongs to no integration.
    const admin = (await login()).accessToken;
    const customer = await call<{ id: string }>(admin, 'POST', '/customers', {
      displayName: `Walk-in ${stamp()}`,
      email: `walkin.${stamp()}@shopper.example`,
    });
    const other = await call<{ reference: string }>(admin, 'POST', '/tickets', {
      customerId: customer.id,
      subject: 'Raised by an agent',
      description: 'Not from the app.',
    });
    const settings = appEnv();
    const res = await fetch(`${env.api}/api/v1/integration/tickets/${other.reference}`, {
      headers: { authorization: `Bearer ${settings.SUPPORT_API_KEY_WEB}` },
    });
    expect(res.status).toBe(404);
  });
});
