import type { Browser } from '@playwright/test';
import { chatIdentity, login } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

/**
 * A sandbox shopper (any @shopper.example address) owns any DS-9xxxx order in
 * the Demo Store sample server, so each run gets a fresh customer and order.
 */
function shopper() {
  const stamp = Date.now().toString(36);
  const order = `DS-9${String(Date.now()).slice(-4)}`;
  return { name: `Rafa Moreno ${stamp}`, email: `rafa.${stamp}@shopper.example`, order };
}

/**
 * A signed-in shopper on the page that stands in for a site: company tools act
 * only for a visitor the site vouches for, never for a typed email (ADR 0028).
 */
async function visitorSays(browser: Browser, s: ReturnType<typeof shopper>, text: string) {
  const visitor = await browser.newPage();
  await visitor.goto(env.widgetSite);
  await visitor.evaluate(
    (token) =>
      (window as unknown as { tmsChat: { identify(t: string): void } }).tmsChat.identify(token),
    chatIdentity(s),
  );
  await visitor.getByRole('button', { name: 'Need help?' }).click();
  await visitor.getByLabel('Message').fill(text);
  await visitor.getByRole('button', { name: 'Send' }).click();
  return visitor;
}

test.describe('Company tools and approvals', () => {
  test('answers an order question from the order system', async ({ browser, page }) => {
    const s = shopper();
    const visitor = await visitorSays(browser, s, `Where is my order ${s.order}?`);
    await expect(visitor.locator('.msg.ai').first()).toContainText(
      `Order ${s.order} is delivered`,
      {
        timeout: 30_000,
      },
    );
    await visitor.close();

    await signInOrbit(page);
    const row = page.locator('tr[data-ticket]', { hasText: s.name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    const drawer = await openTicket(page, (await row.getAttribute('data-ticket'))!);
    const actions = drawer.getByRole('region', { name: 'Company actions' });
    await expect(actions).toContainText('Order status');
    await expect(actions).toContainText('Done');
    // The customer's email was filled in by TMS and isn't shown as an argument.
    await expect(actions).toContainText(`order id ${s.order}`);
    await expect(actions).not.toContainText(s.email);
  });

  test('a refund waits for the team that owns the ticket; approving it runs it and tells the customer', async ({
    browser,
    page,
  }) => {
    const s = shopper();
    const visitor = await visitorSays(
      browser,
      s,
      `I was charged twice for order ${s.order}. Can you refund the extra charge?`,
    );
    await expect(visitor.getByText(/to our team for approval/)).toBeVisible({ timeout: 30_000 });

    // The request belongs to the ticket's team (ADR 0031): web chats go to Orders, and Maya leads it.
    await signInOrbit(page, AGENTS.maya.email, SAMPLE_PASSWORD);
    await page.getByRole('link', { name: /Approvals/ }).click();
    await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
    const card = page.locator('[data-approval]', { hasText: s.order });
    await expect(card).toBeVisible({ timeout: 20_000 });
    await expect(card).toContainText('Issue refund');
    await expect(card).toContainText(s.name);
    await expect(card).toContainText('charged twice');
    await expect(card).not.toContainText(s.email);
    await card.getByLabel(/^Reason/).fill('The second charge is on your statement.');
    await card.getByLabel(/^Note for colleagues/).fill('Duplicate charge on the statement');
    await card.getByRole('button', { name: 'Approve' }).click();
    await expect(card).toHaveCount(0);

    await expect(visitor.getByText(/has been issued \(reference RF-\d+\)/)).toBeVisible({
      timeout: 30_000,
    });
    await visitor.close();

    await page.getByRole('tab', { name: /Decided/ }).click();
    const decided = page.locator('[data-approval]', { hasText: s.order });
    await expect(decided).toContainText('Approved');
    await expect(decided).toContainText('By Maya Lindqvist');
  });

  test('admins manage tools in Settings; agents cannot', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/tools`);
    const server = page.getByRole('region', { name: 'Demo Store systems' });
    await expect(server).toBeVisible();
    await expect(server.getByText('Stored: ••••oken')).toBeVisible();
    const refund = server.locator('[data-tool="issue_refund"]');
    await expect(refund.getByLabel('Risk')).toHaveValue('transactional');
    await expect(refund.getByRole('button', { name: 'Test' })).toBeDisabled();

    const status = server.locator('[data-tool="order_status"]');
    await status.getByRole('button', { name: 'Test' }).click();
    const dialog = page.getByRole('dialog', { name: /Test Order status/ });
    await dialog.getByLabel(/Customer email/).fill('maria.lopez@example.com');
    await dialog.getByLabel('Arguments (JSON)').fill('{"order_id": "DS-20517"}');
    await dialog.getByRole('button', { name: 'Run test' }).click();
    await expect(dialog.getByRole('status', { name: 'Test result' })).toContainText('"shipped"');

    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    const res = await fetch(`${env.api}/api/v1/tools/servers`, {
      headers: { authorization: `Bearer ${agent}` },
    });
    expect(res.status).toBe(403);
  });

  test('the approvals inbox and tool settings fit a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/approvals`);
    await expect(page.getByRole('heading', { name: 'Approvals', level: 1 })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.goto(`${env.orbit}/#/settings/tools`);
    await expect(page.getByRole('region', { name: 'Demo Store systems' })).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });
});
