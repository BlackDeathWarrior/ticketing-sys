import type { Browser, Page } from '@playwright/test';
import nodemailer from 'nodemailer';
import { call, eventually, login, mailpitSearch, type TicketRow } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

/** Opens the widget demo page and sends one message as a new visitor. */
async function visitorSays(browser: Browser, name: string, text: string) {
  const visitor = await browser.newPage();
  await visitor.goto(env.widgetDemo);
  await visitor.getByRole('button', { name: 'Chat with us' }).click();
  await visitor.getByLabel('Name').fill(name);
  await visitor.getByLabel('Email').fill(`${name.toLowerCase().replace(/\W+/g, '.')}@example.com`);
  await visitor.getByRole('button', { name: 'Start chat' }).click();
  await visitor.getByLabel('Message').fill(text);
  await visitor.getByRole('button', { name: 'Send' }).click();
  return visitor;
}

async function ticketFor(page: Page, name: string) {
  const row = page.locator('tr[data-ticket]', { hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  return (await row.getAttribute('data-ticket'))!;
}

test.describe('AI agent', () => {
  test('answers a web chat from the knowledge base, visibly marked as AI', async ({
    browser,
    page,
  }) => {
    const stamp = Date.now().toString(36);
    const name = `Iris Lindgren ${stamp}`;
    await signInOrbit(page);
    const visitor = await visitorSays(browser, name, 'When will my refund reach my card?');

    // The visitor gets the answer, labelled as the AI assistant.
    const answer = visitor.locator('.msg.ai').first();
    await expect(answer).toContainText('AI assistant', { timeout: 30_000 });
    await expect(answer).toContainText('Thanks for your message.');

    const drawer = await openTicket(page, await ticketFor(page, name));
    const aiMessage = drawer.locator('li[data-kind="ai"]').first();
    await expect(aiMessage).toContainText('AI agent');
    await expect(aiMessage).toHaveAttribute('data-ai', 'true');
    await expect(aiMessage.getByText('AI', { exact: true }).first()).toBeVisible();
    await expect(aiMessage).toContainText(/Confidence \d+% · from /);
    await expect(drawer.getByLabel('AI classification')).toContainText('Billing', {
      timeout: 20_000,
    });
    await drawer.getByText(/AI activity · \d+ steps?/).click();
    await expect(drawer.getByLabel('AI activity')).toContainText('Answered');
    await visitor.close();
  });

  test('drafts when unsure; an agent edits and sends the draft', async ({ browser, page }) => {
    const stamp = Date.now().toString(36);
    const name = `Pablo Serra ${stamp}`;
    await signInOrbit(page, AGENTS.jonah.email, SAMPLE_PASSWORD);
    const visitor = await visitorSays(browser, name, 'What do penguins eat in winter?');

    const drawer = await openTicket(page, await ticketFor(page, name));
    const draft = drawer.getByRole('group', { name: 'AI draft awaiting review' });
    await expect(draft).toBeVisible({ timeout: 30_000 });
    // The visitor sees nothing until a person approves it.
    await expect(visitor.locator('.msg.ai')).toHaveCount(0);

    await draft.getByRole('button', { name: 'Edit' }).click();
    const edited = `We don't sell penguin food, but happy to help with bikes! (${stamp})`;
    await draft.getByLabel('Edit the draft').fill(edited);
    await draft.getByRole('button', { name: 'Send edited reply' }).click();
    await expect(visitor.getByText(edited)).toBeVisible({ timeout: 20_000 });
    await visitor.close();
  });

  test('drafts email replies; approving sends the email', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const subject = `Charged twice for my order ${stamp}`;
    const from = `hana.${stamp}@example.net`;
    const transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: false,
    });
    await transport.sendMail({
      from: { name: 'Hana Sato', address: from },
      to: 'support@tms.local',
      subject,
      text: 'I was charged twice for the same order. Can you refund the duplicate charge?',
    });
    transport.close();

    const admin = (await login()).accessToken;
    const ticket = await eventually(
      'email ticket',
      async () =>
        (
          await call<{ items: TicketRow[] }>(
            admin,
            'GET',
            `/tickets?q=${encodeURIComponent(subject)}`,
          )
        ).items[0],
      90_000,
    );
    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);
    const draft = drawer.getByRole('group', { name: 'AI draft awaiting review' });
    await expect(draft).toBeVisible({ timeout: 30_000 });
    await draft.getByRole('button', { name: 'Send draft' }).click();

    const mail = await eventually(
      'the approved reply in Mailpit',
      async () => (await mailpitSearch(`to:${from}`))[0],
      30_000,
    );
    expect(mail.Subject).toContain(`Re: ${subject}`);
  });

  test('admins tune AI behaviour and try the agent; agents cannot', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/ai`);
    await expect(page.getByRole('form', { name: 'AI behaviour' })).toBeVisible();
    await expect(page.locator('#ai-mode-email')).toHaveValue('draft');
    const tryIt = page.getByRole('form', { name: 'Try the agent' });
    await tryIt.getByLabel('Customer message').fill('When will my refund reach my card?');
    await tryIt.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByRole('status', { name: 'Agent result' })).toContainText('Answered');

    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    const res = await fetch(`${env.api}/api/v1/settings/ai`, {
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(res.status).toBe(403);
  });
});
