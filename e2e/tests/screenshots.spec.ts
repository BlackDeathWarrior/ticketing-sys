import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findTicket, login } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInConsole, signInOrbit, test } from './fixtures';

/**
 * Captures the screens used in docs/testing/TEST_REPORT.md. Skipped unless
 * SCREENSHOTS=1, so normal runs don't rewrite the committed images.
 */
const dir = fileURLToPath(new URL('../../docs/testing/screenshots', import.meta.url));
const shot = (name: string) => path.join(dir, `${name}.png`);

test.describe('report screenshots', () => {
  test.skip(!process.env.SCREENSHOTS, 'set SCREENSHOTS=1 to capture report images');
  test.beforeAll(() => mkdirSync(dir, { recursive: true }));

  test('Orbit Desk', async ({ page }) => {
    await signInOrbit(page);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    await page.waitForTimeout(500);
    await page.screenshot({ path: shot('orbit-dashboard'), fullPage: false });
    await page.locator('#queue').scrollIntoViewIfNeeded();
    await page.screenshot({ path: shot('orbit-queue') });

    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Shipment tracking page shows every container as "lost"');
    await openTicket(page, t.reference);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-drawer') });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'New ticket' }).click();
    const dialog = page.getByRole('dialog', { name: 'New ticket' });
    await dialog.getByLabel('Subject').fill('Bulk discount for 20 cargo bikes');
    await dialog.getByLabel('Customer', { exact: true }).fill('River');
    await expect(dialog.getByRole('button', { name: /Ravi Menon/ })).toBeVisible();
    await page.screenshot({ path: shot('orbit-new-ticket') });
  });

  test('Orbit Desk AI agent', async ({ page }) => {
    const admin = (await login()).accessToken;
    await signInOrbit(page);
    const answered = await findTicket(
      admin,
      'Chat: When will my refund reach my card? I returned the helmet last week.',
    );
    await openTicket(page, answered.reference);
    await page.getByText(/AI activity · \d+ steps?/).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('orbit-ai-answered') });
    await page.keyboard.press('Escape');

    const drafted = await findTicket(admin, 'Invoice address for company purchase');
    await openTicket(page, drafted.reference);
    await expect(page.getByRole('group', { name: 'AI draft awaiting review' })).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: shot('orbit-ai-draft') });
    await page.keyboard.press('Escape');

    // A fresh page load clears the ticket search left by the drawer steps.
    await page.goto(`${env.orbit}/#/settings/ai`);
    await page.reload();
    await page.getByRole('button', { name: 'Run' }).click();
    await expect(page.getByRole('status', { name: 'Agent result' })).toBeVisible();
    // Full-page captures draw fixed bars where the page is scrolled to.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-ai-settings'), fullPage: true });
  });

  test('Orbit Desk knowledge base', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/kb`);
    await page.getByLabel('Search the knowledge base').fill('when will my refund reach my card');
    await page.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('list', { name: 'Knowledge base results' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-kb'), fullPage: true });
  });

  test('Orbit Desk settings', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/providers`);
    await expect(page.getByRole('row', { name: /Demo model \(scripted\)/ })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-settings-providers') });
    await page.getByRole('tab', { name: 'Models & roles' }).click();
    await expect(page.getByRole('region', { name: 'AI agent (chat and email)' })).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-settings-models'), fullPage: true });
  });

  test('Orbit Desk on a phone', async ({ browser }) => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await signInOrbit(page);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    await page.screenshot({ path: shot('orbit-phone') });
    await page.close();
  });

  test('help center request form', async ({ page, browser }) => {
    const customer = await browser.newPage();
    await customer.goto(env.helpCenter);
    await expect(customer.getByRole('button', { name: 'Start a chat' })).toBeVisible();
    await customer.screenshot({ path: shot('help-center'), fullPage: true });

    const form = customer.getByRole('form', { name: 'Submit a request' });
    await form.getByLabel('Your name').fill('Ines Duarte');
    await form.getByLabel('Email').fill(`ines.duarte.${Date.now().toString(36)}@example.org`);
    await form.getByLabel('Topic').selectOption({ label: 'Returns' });
    await form.getByLabel('Order number').fill('DS-51877');
    await form.getByLabel('Subject').fill('Cracked phone case in my order');
    await form
      .getByLabel('How can we help?')
      .fill(
        'The phone case in order DS-51877 arrived with a crack along one side. Photo attached.',
      );
    await form.locator('input[type="file"]').setInputFiles({
      name: 'cracked-case.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.alloc(184_000, 1),
    });
    await customer.screenshot({ path: shot('help-center-filled'), fullPage: true });
    await form.getByRole('button', { name: 'Send request' }).click();
    await expect(customer.getByRole('heading', { name: 'Request received' })).toBeVisible();
    const reference = (await customer.locator('[data-reference]').textContent())!;
    await customer.screenshot({ path: shot('help-center-receipt') });
    await customer.close();

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await phone.goto(env.helpCenter);
    await expect(phone.getByRole('button', { name: 'Start a chat' })).toBeVisible();
    await phone.screenshot({ path: shot('help-center-phone') });
    await phone.close();

    await signInOrbit(page);
    await page.getByLabel('Channel').selectOption({ label: 'Web form' });
    await expect(page.locator(`tr[data-ticket="${reference}"]`)).toBeVisible();
    await openTicket(page, reference);
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-web-form') });
  });

  test('tools and approvals', async ({ page, browser }) => {
    const admin = (await login()).accessToken;
    // Sample data: Kenji Watanabe's refund waits for approval; María López's order was looked up.
    const refund = await findTicket(
      admin,
      'Chat: I was charged twice for order DS-20533. Can you refund the extra charge?',
    );
    const lookup = await findTicket(admin, 'Chat: Hi, where is my order DS-20517?');

    const supervisor = await browser.newPage();
    await signInOrbit(supervisor, AGENTS.priya.email, SAMPLE_PASSWORD);
    await supervisor.goto(`${env.orbit}/#/approvals`);
    await expect(supervisor.locator('[data-approval]', { hasText: 'DS-20533' })).toBeVisible();
    await supervisor.waitForTimeout(300);
    await supervisor.screenshot({ path: shot('orbit-approvals'), fullPage: true });
    await openTicket(supervisor, refund.reference);
    await supervisor.getByRole('region', { name: 'Company actions' }).scrollIntoViewIfNeeded();
    await supervisor.waitForTimeout(300);
    await supervisor.screenshot({ path: shot('orbit-drawer-approval') });
    await supervisor.close();

    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/tools`);
    await page.reload();
    await expect(page.getByRole('region', { name: 'Demo Store systems' })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: shot('orbit-tools-settings'), fullPage: true });
    await page.goto(env.orbit);
    await openTicket(page, lookup.reference);
    await page.getByRole('region', { name: 'Company actions' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-drawer-lookup') });
  });

  test('handover, routing and SLA', async ({ page }) => {
    const admin = (await login()).accessToken;
    // Sample: Nina Petrova asked for a person; routing gave it to an online agent.
    const handed = await findTicket(
      admin,
      'Chat: I would like to talk to a real person about my damaged cargo bike, please.',
    );
    await signInOrbit(page);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    await page.getByRole('link', { name: /SLA at risk/ }).click();
    await expect(page.locator('[data-sla]').first()).toBeVisible();
    await page.locator('#queue').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-sla-queue') });

    await page.getByRole('link', { name: /All tickets/ }).click();
    const drawer = await openTicket(page, handed.reference);
    await expect(drawer.getByRole('region', { name: 'Handover context' })).toContainText(
      'Next step',
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-handover') });
    await drawer.getByRole('region', { name: 'Handover context' }).scrollIntoViewIfNeeded();
    await drawer.getByRole('tab', { name: 'AI | People' }).click();
    await drawer.getByRole('region', { name: 'Conversation' }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-lanes') });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: /^Notifications/ }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: shot('orbit-notifications') });
    await page.keyboard.press('Escape');

    for (const tab of ['routing', 'sla']) {
      await page.goto(`${env.orbit}/#/settings/${tab}`);
      await page.reload();
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await page.waitForTimeout(400);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: shot(`orbit-settings-${tab}`), fullPage: true });
    }
  });

  test('basic console, widget and Mailpit', async ({ page, browser }) => {
    await signInConsole(page);
    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Exchange hiking boots for a larger size');
    await page.goto(`${env.console}/tickets/${t.reference}`);
    await expect(page.getByText('exchange label EX-2231')).toBeVisible();
    await page.screenshot({ path: shot('console-ticket') });

    const visitor = await browser.newPage();
    await visitor.goto(env.widgetDemo);
    await visitor.getByRole('button', { name: 'Chat with us' }).click();
    await visitor.getByLabel('Name').fill('Rosa Quintero');
    await visitor.getByRole('button', { name: 'Start chat' }).click();
    await visitor.getByLabel('Message').fill('Hello! Do you ship to the Canary Islands?');
    await visitor.getByRole('button', { name: 'Send' }).click();
    await expect(visitor.getByText('Do you ship to the Canary Islands?')).toBeVisible();
    await visitor.screenshot({ path: shot('widget') });
    await visitor.goto(env.mailpit);
    await visitor.waitForTimeout(1000);
    await visitor.screenshot({ path: shot('mailpit') });
    await visitor.close();
  });
});
