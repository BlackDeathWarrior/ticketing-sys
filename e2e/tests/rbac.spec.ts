import { findTicket, login, raw } from './api';
import { AGENTS, SAMPLE_PASSWORD } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

test.describe('an agent without reporting or assignment rights', () => {
  test('sees the queue but not team reports, and cannot reassign', async ({ page }) => {
    const { accessToken } = await signInOrbit(page, AGENTS.jonah.email);
    expect((await raw(accessToken, 'GET', '/reports/overview')).status).toBe(403);

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Jonah');
    await expect(page.getByText('Team load')).toHaveCount(0);
    await expect(page.getByText('Ticket volume')).toHaveCount(0);
    await expect(page.locator('[aria-labelledby="activity-title"]')).toHaveCount(0);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();

    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Shipment tracking page shows every container as "lost"');
    const drawer = await openTicket(page, t.reference);
    await expect(drawer.getByRole('combobox', { name: 'Assignee' })).toHaveCount(0);
    await expect(drawer.getByText('Jonah Reyes', { exact: true }).first()).toBeVisible();
    await expect(drawer.getByLabel('Priority')).toBeEnabled();
  });

  test('the API refuses assignment for an agent', async () => {
    const agent = (await login(AGENTS.jonah.email, SAMPLE_PASSWORD)).accessToken;
    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Charged three times for order 55120');
    const res = await raw(agent, 'POST', `/tickets/${t.id}/assign`, { assigneeId: null });
    expect(res.status).toBe(403);
  });
});
