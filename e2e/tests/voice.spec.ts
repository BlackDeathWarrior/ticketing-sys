import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { call, login, raw } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, signInOrbit, test } from './fixtures';

/**
 * Voice calls. A call needs a Sarvam key, and the stack under test has none
 * (there is no stand-in for Sarvam), so these tests cover what works without
 * one: the caller's page, the refusal, the settings and the status light.
 * A whole call, with a scripted speech provider, is covered by
 * apps/api/test/voice.int.test.ts.
 */
const VOICE_PAGE = env.widgetDemo.replace(/demo\.html$/, 'voice.html');

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
  });
}

let admin: string;

test.beforeAll(async () => {
  admin = (await login()).accessToken;
});

test.afterAll(async () => {
  // Leave voice switched off, as a stack without a key should be.
  await call(admin, 'PUT', '/settings/channels/sarvam', { enabled: false });
});

test.describe('voice calls', () => {
  test('the call page says calls are recorded, and refuses politely without a key', async ({
    page,
  }) => {
    await page.goto(VOICE_PAGE);
    const box = page.getByRole('region', { name: 'Voice call' });
    await expect(box.getByRole('heading', { name: 'Talk to us' })).toBeVisible();
    await expect(box).toContainText('Calls are recorded and transcribed');
    await expect(box).toContainText('Recordings are deleted after 30 days');
    await shot(page, 'voice-call-page');

    await box.getByRole('button', { name: 'Start call' }).click();
    await expect(box.getByRole('alert')).toContainText(
      'Voice calls are not available right now. Please use the chat.',
    );
    // Nothing started: the caller can try again, and no microphone was opened.
    await expect(box.getByRole('button', { name: 'Start call' })).toBeEnabled();
    await expect(box.getByRole('button', { name: 'End call' })).toBeHidden();
  });

  test('an admin sets voice up, and the light says the key is missing', async ({ page }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/channels`);
    const card = page.getByRole('region', { name: 'Sarvam voice' });
    const form = card.getByRole('form', { name: 'Sarvam voice settings' });
    await expect(form.getByLabel('Greeting (must say the call is recorded)')).toHaveValue(
      /This call is recorded/,
    );
    await expect(form.getByLabel('Longest call (minutes)')).toHaveValue('10');

    await form.getByLabel('Voice on').selectOption('yes');
    await form.getByLabel('Longest call (minutes)').fill('5');
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(form.getByRole('status')).toContainText('Saved.');

    // Switched on without a key: the light is not green, and it says why.
    const checks = card.getByRole('list', { name: 'Voice checks' });
    await expect(checks.locator('li', { hasText: 'Sarvam key' })).toHaveAttribute(
      'data-state',
      'down',
    );
    await expect(checks.locator('li', { hasText: 'Sarvam key' })).toContainText(
      'Not saved. Calls cannot start.',
    );
    await expect(checks.locator('li', { hasText: 'Lines' })).toContainText('0 of 5 in use');
    const saved = await call<{ config: { maxCallMinutes: number } }>(
      admin,
      'GET',
      '/settings/channels/sarvam',
    );
    expect(saved.config.maxCallMinutes).toBe(5);
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'orbit-settings-voice');
  });

  test('recordings are for supervisors, and call lists need a ticket', async () => {
    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    const id = randomUUID();
    expect((await raw(agent, 'GET', `/voice/calls/${id}/recording`)).status).toBe(403);
    expect((await raw(admin, 'GET', `/voice/calls/${id}/recording`)).status).toBe(404);
    expect((await raw(admin, 'GET', `/tickets/${id}/voice-calls`)).status).toBe(404);
  });

  test('the call page fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(VOICE_PAGE);
    await expect(page.getByRole('button', { name: 'Start call' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'voice-call-page-phone');
  });
});
