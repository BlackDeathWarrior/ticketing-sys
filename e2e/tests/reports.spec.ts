import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { login, raw } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

/** The byte-order mark the CSV starts with, so spreadsheet apps read it as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string, fullPage = false) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
    fullPage,
  });
}

async function openReports(page: Page, email?: string) {
  await signInOrbit(page, email);
  await page.getByRole('link', { name: 'Reports' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'The AI and the team' })).toBeVisible();
  // The figures have loaded.
  await expect(page.getByRole('region', { name: 'Key figures' }).locator('article')).toHaveCount(4);
}

/** The value of a key figure, as shown. */
const kpi = (page: Page, id: string) => page.locator(`[data-kpi="${id}"]`);

test.describe('reports', () => {
  test('shows what the AI resolved, passed on and how customers rated both', async ({ page }) => {
    await openReports(page);
    // The sample data has three chats the AI resolved alone, and twelve ratings
    // (other specs may have added to both).
    await expect(kpi(page, 'ai-resolved')).toContainText(/\d+%/);
    const aiResolved = Number(
      /(\d+) of \d+ resolved tickets/.exec((await kpi(page, 'ai-resolved').textContent())!)?.[1],
    );
    expect(aiResolved).toBeGreaterThanOrEqual(3);
    await expect(kpi(page, 'handover')).toContainText(/of \d+ tickets the AI worked on/);
    await expect(kpi(page, 'time-saved')).toContainText(`${aiResolved} tickets × 10 min each`);
    await expect(kpi(page, 'csat')).toContainText(/\d\.\d \/ 5/);
    await expect(kpi(page, 'csat')).toContainText(/1[2-9] ratings|[2-9]\d ratings/);

    const who = page.getByRole('region', { name: 'Who resolved them' });
    await expect(who.locator('[data-segment="ai"]')).toContainText(
      new RegExp(`^The AI alone${aiResolved} · [0-9]+%$`),
    );
    await expect(who.locator('[data-segment="human"]')).toContainText('A person');

    // The chart has a legend, and the same numbers as a table.
    const chart = page.getByRole('region', { name: 'Resolved per day' });
    await expect(chart.getByRole('img')).toHaveAttribute('aria-label', /Stacked bar chart/);
    await expect(chart.getByRole('list', { name: 'Legend' })).toContainText('The AI alone');
    await chart.getByRole('button', { name: 'View table' }).click();
    await expect(chart.getByRole('columnheader', { name: 'Resolved by the AI' })).toBeVisible();
    await chart.getByRole('button', { name: 'View chart' }).click();

    const compare = page.getByRole('region', { name: 'Side by side' });
    for (const row of [
      'First reply',
      'Time to final answer',
      'SLA targets met',
      'Customer rating',
    ]) {
      await expect(compare.getByRole('row', { name: new RegExp(row) })).toBeVisible();
    }
    await expect(compare.getByRole('row', { name: /Customer rating/ })).toContainText(/4\.\d \/ 5/);

    const cost = page.getByRole('region', { name: 'AI cost' });
    await expect(cost.getByRole('list', { name: 'Cost by provider' })).toContainText(
      'Demo model (scripted)',
    );
    await expect(
      page.getByRole('region', { name: 'By channel' }).getByRole('row', { name: /Web chat/ }),
    ).toBeVisible();
    await shot(page, 'orbit-reports', true);
  });

  test('filters the figures and the ticket list, and opens a ticket from it', async ({ page }) => {
    await openReports(page);
    const filters = page.getByRole('form', { name: 'Report filters' });
    const tickets = page.getByRole('region', { name: 'Tickets', exact: true });

    await filters.getByLabel('Channel').selectOption({ label: 'Web chat' });
    // On web chat, the AI-resolved chats are most of what was resolved.
    await expect(kpi(page, 'ai-resolved')).toContainText(/[3-9] of \d+ resolved tickets/);
    await expect(page.getByRole('region', { name: 'By channel' }).getByRole('row')).toHaveCount(2);

    await tickets.getByLabel('Handled by').selectOption({ label: 'AI' });
    await expect(tickets.locator('tbody tr').first()).toContainText('AI');
    const rated = tickets.locator('tbody tr', { hasText: /[45] \/ 5/ }).first();
    await expect(rated).toContainText('Resolved');
    const reference = (await rated.getAttribute('data-ticket'))!;
    await rated.getByRole('button').click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(reference, { exact: true })).toBeVisible();
    // The customer's rating is on the ticket, read-only.
    await expect(drawer.getByRole('region', { name: 'Customer rating' })).toContainText(
      /[45] \/ 5 · (Happy|Very happy)/,
    );
    await expect(drawer.getByRole('region', { name: 'Customer rating' })).toContainText(
      'Given in the chat',
    );
    await page.keyboard.press('Escape');

    // Custom dates wait until both are chosen.
    await filters.getByLabel('Period').selectOption({ label: 'Custom dates' });
    await expect(page.getByText('Choose the first and last day of the period.')).toBeVisible();
    await filters.getByLabel('From').fill('2020-01-01');
    await filters.getByLabel('To', { exact: true }).fill('2020-01-31');
    await expect(kpi(page, 'ai-resolved')).toContainText('0 of 0 resolved tickets');
    await expect(tickets.getByText('No tickets match.')).toBeVisible();
  });

  test('exports the ticket list as CSV, for people allowed to', async ({ page }) => {
    await openReports(page, AGENTS.maya.email);
    const tickets = page.getByRole('region', { name: 'Tickets', exact: true });
    const download = page.waitForEvent('download');
    await tickets.getByRole('button', { name: 'Export CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('tickets.csv');
    const lines = readFileSync(await file.path(), 'utf8')
      .replace(BOM, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toMatch(/^Ticket,Subject,Channel,Status,/);
    expect(lines.length).toBeGreaterThan(40);
    expect(lines.some((l) => l.includes(',AI,'))).toBe(true);

    // Agents have no Reports link, and the API refuses them.
    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    expect((await raw(agent, 'GET', '/reports/performance')).status).toBe(403);
    expect((await raw(agent, 'GET', '/reports/tickets')).status).toBe(403);
    const lead = (await login(AGENTS.maya.email, SAMPLE_PASSWORD)).accessToken;
    expect((await raw(lead, 'GET', '/reports/performance?days=7')).status).toBe(200);
  });

  test('is hidden from agents', async ({ page }) => {
    await signInOrbit(page, AGENTS.jonah.email);
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Reports' })).toHaveCount(0);
  });

  test('shows a low rating on the ticket, with the customer’s comment', async ({ page }) => {
    await signInOrbit(page);
    await page.getByLabel('Search tickets').fill('Dealer login shows wrong price tier');
    const row = page.locator('tr[data-ticket]', { hasText: 'Dealer login shows wrong price tier' });
    const drawer = await openTicket(page, (await row.getAttribute('data-ticket'))!);
    const rating = drawer.getByRole('region', { name: 'Customer rating' });
    await expect(rating).toContainText('1 / 5 · Very unhappy');
    await expect(rating).toContainText('I still see the wrong tier on some products.');
    await expect(rating).toContainText('Given in the portal');
    await rating.scrollIntoViewIfNeeded();
    await shot(page, 'orbit-ticket-rating');
  });

  test('fits a phone screen without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/reports`);
    await expect(page.getByRole('region', { name: 'Key figures' }).locator('article')).toHaveCount(
      4,
    );
    await expect(
      page.getByRole('region', { name: 'Resolved per day' }).getByRole('img'),
    ).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, 'orbit-reports-phone');
  });
});
