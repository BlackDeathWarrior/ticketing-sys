import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { call, eventually, login, mailpitSearch, mailpitText, raw } from './api';
import { env } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

/**
 * The customer portal ("My requests" in the help center) and ratings, the way
 * a customer meets them: a link in an email, their own requests, a reply, a
 * rating. Outgoing mail is read from Mailpit.
 */
const PORTAL = `${env.helpCenter}#/portal`;

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
  });
}

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e3).toString(36)}`;

let admin: string;

test.beforeAll(async () => {
  admin = (await login()).accessToken;
});

/** A customer who wrote in through the request form. */
async function newRequest(name = 'Nora Quist') {
  const id = stamp();
  const email = `nora.${id}@example.org`;
  const subject = `Kettle stopped heating ${id}`;
  const res = await fetch(`${env.api}/api/v1/public/requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      submissionId: randomUUID(),
      name,
      email,
      subject,
      description: 'The kettle I bought last month no longer heats water.',
    }),
  });
  expect(res.status).toBe(201);
  const { reference } = (await res.json()) as { reference: string };
  const ticket = await call<{ id: string }>(admin, 'GET', `/tickets/${reference}`);
  return { email, subject, reference, id: ticket.id };
}

/** The newest email to an address whose subject contains `subject`; returns its text. */
async function mailTo(email: string, subject: string): Promise<string> {
  const mail = await eventually(`"${subject}" email to ${email}`, async () =>
    (await mailpitSearch(`to:"${email}"`)).find((m) => m.Subject.includes(subject)),
  );
  return mailpitText(mail.ID);
}

/** Signs a customer in the way they would: ask for a link, open the one in the email. */
async function signIn(page: Page, email: string) {
  await page.goto(PORTAL);
  // Going to the same address again doesn't reload the page; start from a clean form.
  await page.reload();
  const form = page.getByRole('form', { name: 'Sign in' });
  await form.getByLabel('Email address').fill(email);
  await form.getByRole('button', { name: 'Email me a link' }).click();
  await expect(page.getByRole('status')).toContainText('Check your email.');
  const link = /https?:\/\/\S+#\/portal\/verify\/\S+/.exec(
    await mailTo(email, 'Your sign-in link'),
  )?.[0];
  expect(link).toBeTruthy();
  await page.goto(link!);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  return link!;
}

test.describe('customer portal', () => {
  test('a customer signs in by email, replies, and rates the solved request', async ({
    browser,
    page,
  }) => {
    const mine = await newRequest();
    const customer = await browser.newPage();
    const link = await signIn(customer, mine.email);

    // Their requests, and only theirs.
    const list = customer.getByRole('list', { name: 'Your requests' });
    await expect(list.getByRole('link')).toHaveCount(1);
    await expect(list.getByRole('link')).toContainText(mine.subject);
    await expect(list.getByRole('link')).toContainText('Open');
    await shot(customer, 'portal-requests');
    await list.getByRole('link').click();
    await expect(customer.getByRole('heading', { level: 1, name: mine.subject })).toBeVisible();
    const thread = customer.getByRole('list', { name: 'Messages' });
    await expect(thread.locator('li[data-from="you"]')).toContainText('no longer heats water');
    // Not solved yet: nothing to rate.
    await expect(customer.getByRole('form', { name: 'Rate this request' })).toHaveCount(0);

    // The customer adds a reply; the agent sees where it came from.
    const reply = customer.getByRole('form', { name: 'Reply' });
    await reply.getByLabel('Add a reply').fill('It is the 1.7 litre model, bought on 2 September.');
    await reply.getByRole('button', { name: 'Send reply' }).click();
    await expect(reply.getByRole('status')).toContainText('Your reply was added.');
    await expect(thread.locator('li[data-from="you"]')).toHaveCount(2);

    await signInOrbit(page);
    const drawer = await openTicket(page, mine.reference);
    const fromPortal = drawer.locator('li[data-kind="customer"]', { hasText: '1.7 litre model' });
    await expect(fromPortal).toContainText('From the portal');

    // The agent answers and resolves; the answer shows in the portal under their first name.
    const conv = (
      await call<Array<{ id: string }>>(admin, 'GET', `/tickets/${mine.id}/conversations`)
    )[0]!;
    await call(admin, 'POST', `/conversations/${conv.id}/messages`, {
      body: 'Thanks. That model is under warranty: a replacement ships tomorrow.',
    });
    await call(admin, 'POST', `/tickets/${mine.id}/transition`, { status: 'resolved' });
    await customer.reload();
    await expect(customer.locator('main [data-status]')).toContainText('Solved');
    await expect(
      customer.getByRole('list', { name: 'Messages' }).locator('li[data-from="support"]').last(),
    ).toContainText('a replacement ships tomorrow');
    await expect(customer.getByRole('list', { name: 'Messages' })).toContainText(
      'Administrator from Support',
    );

    // Solved: the customer rates it, then changes their mind.
    const rating = customer.getByRole('form', { name: 'Rate this request' });
    await rating.getByRole('button', { name: 'Send rating' }).click();
    await expect(rating.getByRole('alert')).toContainText('Choose a rating first.');
    await rating.getByRole('radio', { name: /^4/ }).check();
    await rating.getByLabel("Anything you'd like to add? (optional)").fill('Fast, thank you.');
    await shot(customer, 'portal-request');
    await rating.getByRole('button', { name: 'Send rating' }).click();
    const done = customer.getByRole('region', { name: 'Rating' });
    await expect(done).toContainText('You rated this request 4 out of 5 (Happy).');
    await done.getByRole('button', { name: 'Change my rating' }).click();
    await customer.getByRole('radio', { name: /^5/ }).check();
    await customer.getByRole('button', { name: 'Update rating' }).click();
    await expect(done).toContainText('You rated this request 5 out of 5 (Very happy).');

    // The agent sees the rating on the ticket without refreshing.
    const panel = drawer.getByRole('region', { name: 'Customer rating' });
    await expect(panel).toContainText('5 / 5 · Very happy');
    await expect(panel).toContainText('Fast, thank you.');
    await expect(panel).toContainText('Given in the portal');

    // The list shows the rating; signing out ends the session.
    await customer.getByRole('link', { name: '← All my requests' }).click();
    await expect(list.getByRole('link')).toContainText('you rated it 5/5');
    await customer.getByRole('button', { name: 'Sign out' }).click();
    await expect(customer.getByRole('form', { name: 'Sign in' })).toBeVisible();

    // The emailed link worked once.
    await customer.goto(link);
    await expect(customer.getByRole('alert')).toContainText('expired or was already used');
    await customer.close();
  });

  test.describe('refusals', () => {
    // A spent link and someone else's request are answered with 401 and 404.
    test.use({ allowedConsoleErrors: [/40[14] \((Unauthorized|Not Found)\)/] });

    test('an unknown address gets the same answer and no email; other people’s requests stay hidden', async ({
      page,
    }) => {
      const stranger = `nobody.${stamp()}@example.org`;
      await page.goto(PORTAL);
      const form = page.getByRole('form', { name: 'Sign in' });
      await form.getByLabel('Email address').fill(stranger);
      await form.getByRole('button', { name: 'Email me a link' }).click();
      await expect(page.getByRole('status')).toContainText('Check your email.');
      await expect(page.getByRole('status')).toContainText(stranger);

      const mine = await newRequest('Nora Quist');
      const theirs = await newRequest('Otto Other');
      await signIn(page, mine.email);
      await page.goto(`${env.helpCenter}#/portal/tickets/${theirs.reference}`);
      await expect(page.getByRole('alert')).toContainText('Request not found');
      await expect(page.locator('body')).not.toContainText(theirs.subject);
      expect(await mailpitSearch(`to:"${stranger}"`)).toHaveLength(0);

      // A portal session is not a staff session, and the other way round.
      const session = await page.evaluate(
        () => (JSON.parse(sessionStorage.getItem('tms.portal')!) as { token: string }).token,
      );
      expect((await raw(session, 'GET', '/tickets')).status).toBe(401);
      expect((await raw(admin, 'GET', '/portal/tickets')).status).toBe(401);
    });
  });

  test('the survey email rates one request without signing in', async ({ page }) => {
    const mine = await newRequest();
    await call(admin, 'POST', `/tickets/${mine.id}/transition`, { status: 'resolved' });
    const text = await mailTo(mine.email, 'How did we do?');
    expect(text).toContain(mine.reference);
    const link = /https?:\/\/\S+#\/rate\/\S+/.exec(text)?.[0];
    expect(link).toBeTruthy();

    await page.goto(link!);
    await expect(page.getByRole('heading', { level: 1, name: 'Rate your request' })).toBeVisible();
    await expect(page.locator('[data-reference]')).toHaveText(mine.reference);
    await expect(page.getByText(mine.subject)).toBeVisible();
    await page.getByRole('radio', { name: /^2/ }).check();
    await shot(page, 'portal-rate');
    await page.getByRole('button', { name: 'Send rating' }).click();
    await expect(page.getByRole('status')).toContainText(
      'You rated this request 2 out of 5 (Unhappy).',
    );
    const saved = await call<{ rating: { rating: number; source: string } }>(
      admin,
      'GET',
      `/tickets/${mine.id}/rating`,
    );
    expect(saved.rating).toMatchObject({ rating: 2, source: 'email' });
    // Opening the link again shows the rating already given.
    await page.reload();
    await expect(page.getByRole('status')).toContainText('2 out of 5');
  });

  test('a chat visitor is asked in the chat window when their ticket is solved', async ({
    page,
  }) => {
    const name = `Vik ${stamp()}`;
    await page.goto(env.widgetDemo);
    await page.getByRole('button', { name: 'Chat with us' }).click();
    await page.getByLabel('Name').fill(name);
    await page.getByRole('button', { name: 'Start chat' }).click();
    await page.getByLabel('Message').fill('Hello, do you ship to Norway?');
    await page.getByRole('button', { name: 'Send' }).click();

    const ticket = await eventually('the chat ticket', async () => {
      const found = await call<{
        items: Array<{ id: string; reference: string; customer: { displayName: string } }>;
      }>(admin, 'GET', '/tickets?channel=webchat&limit=20');
      return found.items.find((t) => t.customer.displayName === name);
    });
    // Wait for the AI's turn to finish before resolving, so nothing reopens it.
    await eventually('the AI to answer or hand over', async () => {
      const runs = await call<Array<{ kind: string }>>(
        admin,
        'GET',
        `/tickets/${ticket.id}/ai-runs`,
      );
      return runs.some((r) => r.kind === 'turn');
    });
    const resolved = await eventually('the ticket to be resolved', async () => {
      const r = await raw(admin, 'POST', `/tickets/${ticket.id}/transition`, {
        status: 'resolved',
      });
      return r.status === 201;
    });
    expect(resolved).toBe(true);

    const prompt = page.getByRole('group', { name: 'Rate our support' });
    await expect(prompt).toContainText(
      `Your request ${ticket.reference} is solved. How did we do?`,
    );
    await shot(page, 'widget-rating');
    await prompt.getByRole('button', { name: '5 out of 5' }).click();
    await expect(page.getByText('Thanks for your rating: 5 out of 5.')).toBeVisible();
    const saved = await call<{ rating: { rating: number; source: string } }>(
      admin,
      'GET',
      `/tickets/${ticket.id}/rating`,
    );
    expect(saved.rating).toMatchObject({ rating: 5, source: 'chat' });
  });

  test('the portal fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const mine = await newRequest();
    await signIn(page, mine.email);
    await page.getByRole('list', { name: 'Your requests' }).getByRole('link').click();
    await expect(page.getByRole('form', { name: 'Reply' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'portal-request-phone');
  });
});
