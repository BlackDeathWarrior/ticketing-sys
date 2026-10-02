import type { Browser } from '@playwright/test';
import { call, eventually, findTicket, login, type TicketRow } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

async function visitorSays(browser: Browser, name: string, text: string) {
  const visitor = await browser.newPage();
  await visitor.goto(env.widgetDemo);
  await visitor.getByRole('button', { name: 'Chat with us' }).click();
  await visitor.getByLabel('Name').fill(name);
  await visitor.getByRole('button', { name: 'Start chat' }).click();
  await visitor.getByLabel('Message').fill(text);
  await visitor.getByRole('button', { name: 'Send' }).click();
  return visitor;
}

test.describe('Handover, take-over and hand-back', () => {
  // The second take-over is refused on purpose.
  test.use({ allowedConsoleErrors: [/409 \(Conflict\)/] });

  test('a visitor asks for a person: routed with a context pack; an agent takes over, replies and hands back', async ({
    browser,
    page,
  }) => {
    const name = `Greta Holm ${Date.now().toString(36)}`;
    const visitor = await visitorSays(browser, name, 'Can I talk to a real person please?');
    // "…to a member of our team", or to a colleague by name when routing chose one.
    await expect(visitor.getByText(/I'm passing this to/)).toBeVisible({ timeout: 30_000 });

    const admin = (await login()).accessToken;
    const ticket = await eventually('chat ticket', async () =>
      (
        await call<{ items: TicketRow[] }>(
          admin,
          'GET',
          `/tickets?q=${encodeURIComponent('Chat: Can I talk')}&limit=50`,
        )
      ).items.find(
        (t) =>
          (t as unknown as { customer: { displayName: string } }).customer.displayName === name,
      ),
    );

    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);
    const context = drawer.getByRole('region', { name: 'Handover context' });
    await expect(context).toContainText('Handover from the customer', { timeout: 20_000 });
    await expect(context).toContainText('Next step');
    await expect(context).toContainText(/routed to|waiting in/);
    const bar = drawer.getByRole('group', { name: 'Who is answering' });
    await expect(bar).toContainText('Waiting for a person');

    await bar.getByRole('button', { name: 'Take over' }).click();
    await expect(bar).toContainText('You are replying');
    const reply = `Hi, this is the admin. How can I help? (${Date.now().toString(36)})`;
    await drawer.getByLabel(/^Reply to /).fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    await expect(visitor.getByText(reply)).toBeVisible({ timeout: 20_000 });

    // Lanes: the reply sits in the people lane after the AI's handover message.
    await drawer.getByRole('tab', { name: 'AI | People' }).click();
    await expect(drawer.locator('li[data-switch="human"]')).toBeVisible();
    await expect(drawer.locator('li[data-lane="human"]', { hasText: reply })).toBeVisible();

    await bar.getByRole('button', { name: 'Hand back to AI' }).click();
    await expect(bar).toContainText('AI is replying');
    await visitor.close();
  });

  test('two people cannot hold one conversation: the second is told who has it', async ({
    page,
  }) => {
    const admin = (await login()).accessToken;
    const jonah = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    // Sample: Tom Whitaker's refund chat, answered by the AI.
    const t = await findTicket(
      admin,
      'Chat: When will my refund reach my card? I returned the helmet last week.',
    );
    const [conv] = await call<Array<{ id: string }>>(
      admin,
      'GET',
      `/tickets/${t.id}/conversations`,
    );
    const taken = await fetch(`${env.api}/api/v1/conversations/${conv!.id}/take-over`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jonah}` },
    });
    expect(taken.status).toBe(200);

    await signInOrbit(page);
    const drawer = await openTicket(page, t.reference);
    const bar = drawer.getByRole('group', { name: 'Who is answering' });
    await expect(bar).toContainText('Jonah Reyes is replying');
    await bar.getByRole('button', { name: 'Take over' }).click();
    await expect(bar.getByRole('alert')).toHaveText(
      'Jonah Reyes is already answering this conversation',
    );
  });

  test('a notification opens its ticket', async ({ page }) => {
    const admin = (await login()).accessToken;
    const jonah = await call<Array<{ id: string; email: string }>>(admin, 'GET', '/users');
    const jonahId = jonah.find((u) => u.email === AGENTS.jonah.email)!.id;
    const t = await findTicket(admin, 'Exchange hiking boots for a larger size');
    await call(admin, 'POST', `/tickets/${t.id}/assign`, { assigneeId: jonahId });

    await signInOrbit(page, AGENTS.jonah.email, SAMPLE_PASSWORD);
    const bell = page.getByRole('button', { name: /^Notifications, \d+ unread/ });
    await expect(bell).toBeVisible({ timeout: 20_000 });
    await bell.click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await panel
      .getByRole('button', { name: new RegExp(`${t.reference} was assigned to you`) })
      .first()
      .click();
    await expect(page.getByRole('dialog').getByText(t.reference, { exact: true })).toBeVisible();
  });
});

test.describe('SLA and AI-vs-human views', () => {
  test('the SLA at risk view lists late tickets and the drawer shows their timers', async ({
    page,
  }) => {
    await signInOrbit(page);
    await page.getByRole('link', { name: /SLA at risk/ }).click();
    const late = page.locator('tr[data-ticket]', { has: page.locator('[data-sla="breached"]') });
    await expect(late.first()).toBeVisible();
    const ref = (await late.first().getAttribute('data-ticket'))!;
    const drawer = await openTicket(page, ref);
    const sla = drawer.getByRole('region', { name: 'SLA' });
    await expect(sla).toContainText('First response');
    await expect(sla).toContainText('Resolution');
    await expect(sla.locator('[data-state="breached"]').first()).toBeVisible();
  });

  test('filters by who is handling, and history by who acted', async ({ page }) => {
    await signInOrbit(page);
    await page.getByLabel('Handled by').selectOption({ label: 'AI handling' });
    const rows = page.locator('tr[data-ticket]');
    await expect(rows.first()).toBeVisible();
    const count = await rows.count();
    await expect(page.locator('tr[data-ticket] [data-handling="ai"]')).toHaveCount(count);

    const drawer = await openTicket(page, (await rows.first().getAttribute('data-ticket'))!);
    const history = drawer.getByRole('region', { name: 'History' });
    await history.getByText('History').click();
    await history.getByRole('tab', { name: 'AI' }).click();
    const entries = history.getByRole('list', { name: 'History entries' }).locator('li');
    await expect(entries.first()).toBeVisible();
    await expect(history.locator('li[data-actor]:not([data-actor="ai"])')).toHaveCount(0);
  });

  test('admins manage routing and SLA; the drawer and settings fit a phone', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/routing`);
    await expect(page.locator('[data-rule="Hindi conversations"]')).toContainText('needs “hindi”');
    await expect(page.locator('[data-agent="Jonah Reyes"]')).toBeVisible();
    await page.goto(`${env.orbit}/#/settings/sla`);
    await expect(page.locator('[data-policy="Standard"]')).toContainText('Support hours (India)');

    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto(`${env.orbit}/#/settings/routing`);
    await page.reload();
    await expect(page.locator('[data-agent="Jonah Reyes"]')).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    const res = await fetch(`${env.api}/api/v1/routing/rules`, {
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(res.status).toBe(403);
  });
});
