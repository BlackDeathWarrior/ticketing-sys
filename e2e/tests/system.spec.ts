import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Queue } from 'bullmq';
import { call, login, raw } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, signInOrbit, test } from './fixtures';

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
    fullPage: true,
  });
}

interface QueueRow {
  name: string;
  failed: number;
  jobs: Array<{ id: string; about: string | null; reason: string }>;
}

let admin: string;
const queued: string[] = [];

test.beforeAll(async () => {
  admin = (await login()).accessToken;
});

test.afterAll(async () => {
  // Back to the default retention periods, and no failed job left behind by a failed run.
  await call(admin, 'PUT', '/settings/retention', {});
  for (const id of queued) await raw(admin, 'DELETE', `/system/jobs/ai-turns/followup--${id}`);
});

async function openSystem(page: Page) {
  await signInOrbit(page);
  await page.goto(`${env.orbit}/#/settings/system`);
  await expect(page.getByRole('heading', { name: 'Background work' })).toBeVisible();
}

/**
 * Queues an AI follow-up for an approval that doesn't exist: the worker can't
 * find it, and with one attempt allowed the job fails for good.
 */
async function failAJob(): Promise<string> {
  const approvalId = randomUUID();
  queued.push(approvalId);
  const url = new URL(env.redis);
  const queue = new Queue('ai-turns', {
    connection: { host: url.hostname, port: Number(url.port || 6379) },
  });
  try {
    await queue.add(
      'followup',
      { kind: 'followup', approvalId },
      { jobId: `followup--${approvalId}`, attempts: 1 },
    );
  } finally {
    await queue.close();
  }
  await expect
    .poll(async () => (await failedJob(approvalId)) !== undefined, { timeout: 20_000 })
    .toBe(true);
  return approvalId;
}

async function failedJob(approvalId: string) {
  const queues = await call<QueueRow[]>(admin, 'GET', '/system/jobs');
  return queues
    .find((q) => q.name === 'ai-turns')
    ?.jobs.find((j) => j.about?.includes(approvalId) ?? false);
}

test.describe('system settings', () => {
  test('an admin sees a failed job, retries it and removes it', async ({ page }) => {
    const approvalId = await failAJob();
    await openSystem(page);

    // Every kind of background work is listed, in words.
    const table = page.getByRole('table');
    await expect(table.getByText('AI answers')).toBeVisible();
    await expect(table.getByText('Knowledge base indexing')).toBeVisible();
    await expect(page.getByText(/failed after every retry/)).toBeVisible();

    const failed = page.getByRole('region', { name: 'Failed: AI answers' });
    const row = failed.getByRole('listitem').filter({ hasText: approvalId });
    await expect(row).toContainText('1 attempt');
    await expect(row).toContainText(/not found/i);
    await shot(page, 'orbit-system-jobs');

    // Retry: the cause is still there, so it fails again and comes back.
    const before = await failedJob(approvalId);
    await row.getByRole('button', { name: 'Retry' }).click();
    await expect
      .poll(async () => (await failedJob(approvalId))?.reason, { timeout: 20_000 })
      .toBe(before!.reason);
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(row).toContainText('2 attempts');

    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
    expect(await failedJob(approvalId)).toBeUndefined();
  });

  test('an admin changes how long data is kept and runs the clean-up', async ({ page }) => {
    await openSystem(page);
    const form = page.getByRole('form', { name: 'Retention' });
    await expect(form.getByLabel('Log of AI model calls (days)')).toHaveValue('90');
    await expect(form).toContainText('Call recordings are kept 30 days');

    await form.getByLabel('Log of AI model calls (days)').fill('120');
    await form.getByRole('button', { name: 'Save retention' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    await page.reload();
    await expect(form.getByLabel('Log of AI model calls (days)')).toHaveValue('120');

    // The sample data is new, so a run finds nothing old enough.
    await form.getByRole('button', { name: 'Run now' }).click();
    await expect(form.getByRole('status')).toHaveText(/^Done: /);
    await expect(form.locator('[data-last-run]')).toContainText(/Last run .*(now|second|minute)/);
    await shot(page, 'orbit-system-retention');

    // Too short a period is refused by the API, not only by the field.
    const refused = await raw(admin, 'PUT', '/settings/retention', { llmCallsDays: 1 });
    expect(refused.status).toBe(400);
  });

  test('is for admins only', async ({ page }) => {
    const supervisor = (await login(AGENTS.priya.email, SAMPLE_PASSWORD)).accessToken;
    expect((await raw(supervisor, 'GET', '/system/jobs')).status).toBe(403);
    expect((await raw(supervisor, 'GET', '/settings/retention')).status).toBe(403);
    expect((await raw(supervisor, 'POST', '/system/retention/run')).status).toBe(403);
    await signInOrbit(page, AGENTS.priya.email);
    await page.goto(`${env.orbit}/#/settings`);
    await expect(page.getByRole('tab', { name: 'System' })).toHaveCount(0);
  });

  test('fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openSystem(page);
    await expect(page.getByRole('form', { name: 'Retention' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'orbit-system-phone');
  });
});

test.describe('sign-in protection', () => {
  // The page shows the refusals it gets: wrong password, then locked.
  test.use({ allowedConsoleErrors: [/401 \(Unauthorized\)|429 \(Too Many Requests\)/] });

  test('ten wrong passwords lock an address for a while, even for the right one', async ({
    page,
  }) => {
    // Nobody has this address, so nobody else is locked out by the test.
    const email = `nobody.${Date.now().toString(36)}@tms.example`;
    const attempt = () =>
      fetch(`${env.api}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'not-the-password' }),
      });
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);
    const locked = await attempt();
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);

    await page.goto(env.orbit);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText(/Too many failed sign-in attempts/);
    await shot(page, 'orbit-sign-in-locked');

    // Other people signing in from the same place are not affected.
    expect((await login()).accessToken).toBeTruthy();
  });

  test('the API sends the security headers', async () => {
    const res = await fetch(`${env.api}/api/v1/health/live`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBeTruthy();
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
