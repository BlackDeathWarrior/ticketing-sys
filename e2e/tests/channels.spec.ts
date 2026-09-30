import nodemailer from 'nodemailer';
import { call, eventually, login, mailpitSearch, type TicketRow } from './api';
import { env } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

test.describe('web chat', () => {
  test('a visitor message opens a ticket live, and the agent reply reaches the visitor', async ({
    browser,
    page,
  }) => {
    await signInOrbit(page);
    const stamp = Date.now().toString(36);
    const name = `Rosa Quintero ${stamp}`;
    const text = `Hello! Do you ship to the Canary Islands? (${stamp})`;

    const visitor = await browser.newPage();
    await visitor.goto(env.widgetDemo);
    await visitor.getByRole('button', { name: 'Chat with us' }).click();
    await visitor.getByLabel('Name').fill(name);
    await visitor.getByLabel('Email').fill(`rosa.${stamp}@example.com`);
    await visitor.getByRole('button', { name: 'Start chat' }).click();
    await visitor.getByLabel('Message').fill(text);
    await visitor.getByRole('button', { name: 'Send' }).click();

    // The console shows the new web chat ticket without a reload.
    const row = page.locator('tr[data-ticket]', { hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row).toContainText('Web chat');
    const reference = (await row.getAttribute('data-ticket'))!;

    const drawer = await openTicket(page, reference);
    await expect(drawer.getByText(text, { exact: true })).toBeVisible();
    const reply = `Hi Rosa, yes we do, delivery takes 5–7 days. (${stamp})`;
    await drawer.getByLabel(`Reply to ${name}`).fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    await expect(drawer.locator('li[data-kind="agent"]', { hasText: reply })).toBeVisible();

    await expect(visitor.getByText(reply)).toBeVisible({ timeout: 20_000 });
    await visitor.close();
  });
});

test.describe('email', () => {
  test('a customer email becomes a ticket and the reply is threaded back', async ({ page }) => {
    const stamp = Date.now().toString(36);
    const subject = `Lamp arrived without a plug ${stamp}`;
    const from = `mateo.${stamp}@example.net`;
    const transport = nodemailer.createTransport({
      host: env.smtpHost,
      port: env.smtpPort,
      secure: false,
    });
    await transport.sendMail({
      from: { name: 'Mateo Brandt', address: from },
      to: 'support@tms.local',
      subject,
      text: 'The desk lamp from order 91822 came without the power plug.',
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
    expect(ticket).toMatchObject({ channel: 'email', subject });

    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);
    await expect(drawer.getByText('came without the power plug')).toBeVisible();
    const reply = `Hi Mateo, a plug is on its way (${stamp}).`;
    await drawer.getByLabel('Reply to Mateo Brandt').fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();

    const mail = await eventually('reply in Mailpit', async () =>
      (await mailpitSearch(`to:${from}`)).find((m) => m.Subject.includes(`[${ticket.reference}]`)),
    );
    expect(mail.Subject).toContain(subject);
  });
});
