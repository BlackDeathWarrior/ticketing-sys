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

test.describe('email', () => {});
