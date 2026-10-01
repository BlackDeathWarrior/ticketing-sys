import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { login, raw } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, signInOrbit, test } from './fixtures';

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
  });
}

async function openChannels(page: Page) {
  await signInOrbit(page);
  await page.goto(`${env.orbit}/#/settings/channels`);
  const overview = page.getByRole('region', { name: 'Channel status' });
  await expect(overview.getByRole('list', { name: 'Channels' })).toBeVisible();
  return overview;
}

test.describe('channel status lights', () => {
  test('every channel shows a light, and email and web chat are working', async ({ page }) => {
    const overview = await openChannels(page);
    const tiles = overview.getByRole('list', { name: 'Channels' }).getByRole('button');
    const tile = (name: string) => tiles.filter({ hasText: new RegExp(`^${name}`) });
    await expect(tiles).toHaveCount(5);

    // Check now tries the mail server (and Meta, when WhatsApp is connected).
    await overview.getByRole('button', { name: 'Check now' }).click();
    await expect(overview.getByText(/Connections last checked just now/)).toBeVisible({
      timeout: 20_000,
    });
    await expect(tile('Email')).toHaveAttribute('data-state', /ok|warning/);
    await expect(tile('Web chat')).toHaveAttribute('data-state', 'ok');
    await expect(tile('Web chat')).toContainText('Working');
    await expect(tile('WhatsApp')).toHaveAttribute('data-state', 'off');
    await expect(tile('Voice')).toContainText('Arrives with Phase 9');
    await shot(page, 'orbit-channel-status');

    // The email card explains its light, check by check.
    const email = page.getByRole('region', { name: 'Email', exact: true });
    const checks = email.getByRole('list', { name: 'Email checks' });
    await expect(checks.locator('li', { hasText: 'Reading the mailbox' })).toHaveAttribute(
      'data-state',
      'ok',
    );
    await expect(checks.locator('li', { hasText: 'Reading the mailbox' })).toContainText(
      'Watching support@tms.local for new mail',
    );
    await expect(checks.locator('li', { hasText: 'Sending email' })).toHaveAttribute(
      'data-state',
      'ok',
    );
    await expect(checks.locator('li', { hasText: 'Background worker' })).toContainText('Running');

    // A tile jumps to its card.
    await tile('Web chat').click();
    await expect(page.getByRole('region', { name: 'Web chat' })).toBeInViewport();
  });

  test.describe('Connect WhatsApp', () => {
    // Nothing is sent to Meta here: the API refuses the form first (400).
    test.use({ allowedConsoleErrors: [/400 \(Bad Request\)/] });

    test('asks for what is missing before it talks to Meta', async ({ page }) => {
      await openChannels(page);
      const card = page.getByRole('region', { name: 'WhatsApp', exact: true });
      await expect(card.getByRole('status').first()).toContainText(/Off/);
      const form = card.getByRole('form', { name: 'Connect WhatsApp' });

      await form.getByLabel('Phone number ID').fill('1055598765');
      await form.getByLabel('WhatsApp Business account ID').fill('2055598765');
      await form.getByRole('button', { name: 'Connect WhatsApp' }).click();
      await expect(form.getByRole('alert')).toContainText('Enter the access token');

      // A verify token can be generated; it is shown so it can be copied into Meta.
      await form.getByRole('button', { name: 'Generate' }).click();
      await expect(form.getByLabel('Webhook verify token')).toHaveValue(/^[0-9a-f]{48}$/);
      await expect(form.getByLabel('Webhook verify token')).toHaveAttribute('type', 'text');
      await expect(form.getByText('Copy it into Meta now')).toBeVisible();

      await form.getByLabel('Phone number ID').fill('+1 555 010 0199');
      await form.getByLabel('Access token').fill('not-a-real-token');
      await form.getByRole('button', { name: 'Connect WhatsApp' }).click();
      await expect(form.getByRole('alert')).toContainText('Digits only');
      await shot(page, 'orbit-settings-whatsapp');
    });
  });

  test('is for admins only', async () => {
    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    expect((await raw(agent, 'GET', '/channels/health')).status).toBe(403);
    expect((await raw(agent, 'POST', '/channels/health/check')).status).toBe(403);
    expect(
      (await raw(agent, 'POST', '/whatsapp/connect', { phoneNumberId: '1', wabaId: '2' })).status,
    ).toBe(403);
  });

  test('fits a phone screen without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const overview = await openChannels(page);
    await expect(overview.getByRole('list', { name: 'Channels' }).getByRole('button')).toHaveCount(
      5,
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'orbit-channel-status-phone');
  });
});
