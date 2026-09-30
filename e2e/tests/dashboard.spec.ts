import type { OverviewReport } from '@tms/shared';
import { call, login, type TicketRow } from './api';
import { AGENTS } from './env';
import { expect, signInOrbit, test } from './fixtures';

type Page = { items: TicketRow[]; total: number };

test.describe('Orbit Desk dashboard on sample data', () => {
  test('KPIs, queue health and team load match the API', async ({ page }) => {
    const { accessToken } = await signInOrbit(page);
    const overview = await call<OverviewReport>(accessToken, 'GET', '/reports/overview');
    // The sample data guarantees a non-trivial picture.
    expect(overview.open).toBeGreaterThanOrEqual(20);
    expect(overview.byAssignee.length).toBeGreaterThanOrEqual(5);

    const kpi = (id: string) => page.locator(`[data-kpi="${id}"]`);
    await expect(kpi('open')).toContainText(String(overview.open));
    await expect(kpi('unassigned')).toContainText(String(overview.unassigned));
    await expect(kpi('resolved')).toContainText(String(overview.resolvedLast7Days));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Administrator');
    await expect(page.getByText(`${overview.open} open tickets across`)).toBeVisible();

    for (const s of overview.byStatus.filter(
      (x) => x.category === 'open' || x.category === 'pending',
    )) {
      await expect(page.locator(`[data-status="${s.status}"]`)).toContainText(String(s.count));
    }
    const load = page.locator('[aria-labelledby="load-title"]');
    for (const a of overview.byAssignee) {
      await expect(load).toContainText(`${a.name}`);
      await expect(load).toContainText(`${a.open} open`);
    }
    await expect(page.locator('[aria-labelledby="activity-title"] li')).toHaveCount(
      overview.activity.length,
    );
  });

  test('sidebar views filter the queue like the API does', async ({ page }) => {
    const { accessToken } = await signInOrbit(page);
    const open = 'new,ai_handling,human_assigned,in_progress,pending_customer';
    const total = async (q: string) =>
      (await call<Page>(accessToken, 'GET', `/tickets?${q ? `${q}&` : ''}limit=1`)).total;

    const expectations: Array<[string, string]> = [
      ['All tickets', ''],
      ['Unassigned', `assigneeId=none&status=${open}`],
      ['Urgent', `priority=urgent&status=${open}`],
    ];
    for (const [label, query] of expectations) {
      const n = await total(query);
      const link = page
        .getByRole('navigation')
        .getByRole('link', { name: new RegExp(`^${label}`) });
      await expect(link).toContainText(String(n));
      await link.click();
      await expect(page.getByRole('heading', { name: label, level: 2, exact: true })).toBeVisible();
      await expect(page.locator('tr[data-ticket]')).toHaveCount(Math.min(n, 200));
    }

    // Every urgent-view row is urgent and unfinished.
    const rows = page.locator('tr[data-ticket]');
    for (const row of await rows.all()) {
      await expect(row).toContainText('Urgent');
      await expect(row).not.toContainText(/Resolved|Closed/);
    }
  });

  test('"Assigned to me" shows only the signed-in agent\'s tickets', async ({ page }) => {
    const { accessToken } = await signInOrbit(page, AGENTS.maya.email);
    const mine = await call<Page>(accessToken, 'GET', '/tickets?assigneeId=me&limit=200');
    expect(mine.total).toBeGreaterThan(0);
    await page.getByRole('link', { name: /^Assigned to me/ }).click();
    await expect(page.locator('tr[data-ticket]')).toHaveCount(mine.total);
    for (const t of mine.items)
      await expect(page.locator(`tr[data-ticket="${t.reference}"]`)).toContainText('Maya');
  });

  test('search matches subjects and TMS numbers; status tabs narrow the list', async ({ page }) => {
    const { accessToken } = await signInOrbit(page);
    const search = page.getByLabel('Search tickets');

    await search.fill('refund');
    const hits = await call<Page>(accessToken, 'GET', '/tickets?q=refund&limit=200');
    expect(hits.total).toBeGreaterThan(0);
    await expect(page.locator('tr[data-ticket]')).toHaveCount(hits.total);
    for (const row of await page.locator('tr[data-ticket]').all()) {
      await expect(row).toContainText(/refund/i);
    }

    const [first] = (await call<Page>(accessToken, 'GET', '/tickets?limit=1')).items;
    await search.fill(first!.reference);
    await expect(page.locator('tr[data-ticket]')).toHaveCount(1);
    await expect(page.locator(`tr[data-ticket="${first!.reference}"]`)).toBeVisible();

    await search.fill('zzzz-no-such-ticket');
    await expect(page.getByText('No tickets in this part of the sky')).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(search).toHaveValue('');

    const resolvedTab = page.getByRole('tab', { name: /^Resolved/ });
    await resolvedTab.click();
    for (const row of await page.locator('tr[data-ticket]').all()) {
      await expect(row).toContainText(/Resolved|Closed/);
    }
  });

  test('clicking an activity entry opens that ticket', async ({ page }) => {
    const { accessToken } = await signInOrbit(page);
    const overview = await call<OverviewReport>(accessToken, 'GET', '/reports/overview');
    const ref = overview.activity[0]!.ticket!.reference;
    await page
      .locator('[aria-labelledby="activity-title"]')
      .getByRole('button', { name: ref })
      .first()
      .click();
    await expect(page.getByRole('dialog').getByText(ref, { exact: true })).toBeVisible();
  });

  test('a ticket created elsewhere appears without a reload', async ({ page }) => {
    await signInOrbit(page);
    const admin = (await login()).accessToken;
    const customers = await call<{ items: Array<{ id: string }> }>(
      admin,
      'GET',
      '/customers?limit=1',
    );
    const subject = `Live update check ${Date.now().toString(36)}`;
    const t = await call<TicketRow>(admin, 'POST', '/tickets', {
      customerId: customers.items[0]!.id,
      subject,
      priority: 'high',
    });
    await expect(page.locator(`tr[data-ticket="${t.reference}"]`)).toContainText(subject, {
      timeout: 15_000,
    });
  });
});
