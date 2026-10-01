import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { call, login, raw } from './api';
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

const stamp = () => Date.now().toString(36);

interface Workflow {
  statuses: Array<{ key: string; name: string; isActive: boolean }>;
  transitions: Array<{ fromStatus: string; toStatus: string }>;
}

let admin: string;
let workflowBefore: Workflow;

test.beforeAll(async () => {
  admin = (await login()).accessToken;
  workflowBefore = await call<Workflow>(admin, 'GET', '/workflow');
});

test.afterAll(async () => {
  // Put the workflow and the settings back, so other specs see the sample setup.
  await call(admin, 'PUT', '/workflow/transitions', {
    transitions: workflowBefore.transitions.map((t) => ({ from: t.fromStatus, to: t.toStatus })),
  });
  const now = await call<Workflow>(admin, 'GET', '/workflow');
  for (const s of now.statuses) {
    if (s.isActive && !workflowBefore.statuses.some((b) => b.key === s.key)) {
      await raw(admin, 'DELETE', `/workflow/statuses/${s.key}`);
    }
  }
  await call(admin, 'PUT', '/settings/customer-experience', {});
});

async function openSettings(page: Page, tab: string, email?: string) {
  await signInOrbit(page, email);
  await page.goto(`${env.orbit}/#/settings/${tab}`);
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();
}

test.describe('admin pages', () => {
  test.describe('People', () => {
    // A team with open tickets can't be deleted: the API answers 409 and the page says why.
    test.use({ allowedConsoleErrors: [/409 \(Conflict\)/] });

    test('an admin adds a user and a team, changes them, and switches the user off', async ({
      page,
    }) => {
      const id = stamp();
      const email = `ada.${id}@tms.example`;
      const team = `Night shift ${id}`;
      await openSettings(page, 'people');
      const users = page.getByRole('region', { name: 'Users' });
      const teams = page.getByRole('region', { name: 'Teams' });
      await expect(users.locator('tr[data-user]')).not.toHaveCount(0);

      // A team first, so the new user can join it.
      await teams.getByRole('button', { name: 'Add team' }).click();
      const teamForm = page.getByRole('form', { name: 'Add team' });
      await teamForm.getByLabel('Team name').fill(team);
      await teamForm.getByLabel('What the team handles (optional)').fill('Evenings and weekends');
      await teamForm.getByLabel('Jonah Reyes').check();
      await teamForm.getByRole('button', { name: 'Add team' }).click();
      const teamRow = teams.locator(`li[data-team="${team}"]`);
      await expect(teamRow).toContainText('Evenings and weekends · Jonah Reyes');

      await users.getByRole('button', { name: 'Add user' }).click();
      const form = page.getByRole('form', { name: 'Add user' });
      await form.getByLabel('Name').fill('Ada Park');
      await form.getByLabel('Email').fill(email);
      await form.getByLabel('Password').pressSequentially('short');
      await form.getByLabel('Role').selectOption({ label: 'Team lead' });
      await form.getByLabel(team).check();
      await form.getByRole('button', { name: 'Add user' }).click();
      // The browser asks for ten characters before anything is sent.
      expect(
        await form.getByLabel('Password').evaluate((el: HTMLInputElement) => el.validity.tooShort),
      ).toBe(true);
      await form.getByLabel('Password').fill(SAMPLE_PASSWORD);
      await form.getByRole('button', { name: 'Add user' }).click();

      const row = users.locator(`tr[data-user="${email}"]`);
      await expect(row).toContainText('Ada Park');
      await expect(row).toContainText('Team lead');
      await expect(row).toContainText(team);
      await expect(teamRow).toContainText('Ada Park');
      await shot(page, 'orbit-settings-people');
      // She can sign in, with a team lead's permissions.
      const ada = (await login(email, SAMPLE_PASSWORD)).accessToken;
      expect((await raw(ada, 'GET', '/reports/performance')).status).toBe(200);

      // Change her role, then switch her off: the account stays, signing in stops.
      await row.getByRole('button', { name: 'Edit' }).click();
      const edit = page.getByRole('form', { name: 'Edit user' });
      await expect(edit.getByLabel('Email')).toBeDisabled();
      await edit.getByLabel('Role').selectOption({ label: 'Agent' });
      await edit.getByLabel('Can sign in').uncheck();
      await edit.getByRole('button', { name: 'Save user' }).click();
      await expect(row).toContainText('Agent');
      await expect(row).toContainText('Switched off');
      await expect(login(email, SAMPLE_PASSWORD)).rejects.toThrow(/401/);

      // Rename the team and empty it, then delete it.
      await teamRow.getByRole('button', { name: 'Edit' }).click();
      const editTeam = page.getByRole('form', { name: 'Edit team' });
      await editTeam.getByLabel('Team name').fill(`${team} B`);
      await editTeam.getByLabel('Jonah Reyes').uncheck();
      await editTeam.getByRole('button', { name: 'Save team' }).click();
      const renamed = teams.locator(`li[data-team="${team} B"]`);
      await expect(renamed).toBeVisible();
      await expect(renamed).not.toContainText('Jonah Reyes');

      // A team with open tickets says why it can't go.
      page.on('dialog', (d) => void d.accept());
      await teams.locator('li[data-team="Orders"]').getByRole('button', { name: 'Delete' }).click();
      await expect(teams.getByRole('alert')).toContainText(/Orders still has \d+ open tickets?/);
      await renamed.getByRole('button', { name: 'Delete' }).click();
      await expect(renamed).toHaveCount(0);
      await expect(teams.locator('li[data-team="Orders"]')).toBeVisible();
    });

    test('an admin can’t demote or switch off their own account', async ({ page }) => {
      await openSettings(page, 'people');
      const mine = page.locator('tr[data-user]', { hasText: '(you)' });
      await mine.getByRole('button', { name: 'Edit' }).click();
      const edit = page.getByRole('form', { name: 'Edit user' });
      await expect(edit.getByLabel('Role')).toBeDisabled();
      await expect(edit.getByLabel('Can sign in')).toBeDisabled();
    });
  });

  test('categories: add, rename and switch off; the request form follows', async ({ page }) => {
    const name = `Warranty ${stamp()}`;
    await openSettings(page, 'tickets');
    const categories = page.getByRole('region', { name: 'Categories' });
    await categories.getByRole('button', { name: 'Add category' }).click();
    const form = page.getByRole('form', { name: 'Category' });
    await form.getByLabel('Name').fill(name);
    await form.getByRole('button', { name: 'Save' }).click();
    const row = categories.locator(`li[data-category="${name}"]`);
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: 'Add sub-category' }).click();
    await form.getByLabel('Name').fill(`Out of ${name}`);
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(categories.locator(`li[data-category="Out of ${name}"]`)).toBeVisible();

    await row.getByRole('button', { name: 'Rename' }).click();
    await form.getByLabel('Name').fill(`${name} claims`);
    await form.getByRole('button', { name: 'Save' }).click();
    const renamed = categories.locator(`li[data-category="${name} claims"]`);
    await expect(renamed).toBeVisible();

    // Customers can choose it on the request form, until it is switched off.
    const offered = async () =>
      (await (await fetch(`${env.api}/api/v1/public/request-form`)).json()).categories.some(
        (c: { name: string }) => c.name === `${name} claims`,
      );
    expect(await offered()).toBe(true);
    await renamed.getByRole('button', { name: 'Switch off' }).click();
    await expect(renamed).toContainText('Switched off: kept on old tickets only');
    expect(await offered()).toBe(false);
    await expect(renamed.getByRole('button', { name: 'Switch on' })).toBeVisible();
  });

  test('workflow: add a status, tick its moves and save', async ({ page }) => {
    const name = `Waiting on supplier ${stamp()}`;
    const key = name.toLowerCase().replace(/ /g, '_');
    await openSettings(page, 'tickets');
    const statuses = page.getByRole('region', { name: 'Statuses' });
    const moves = page.getByRole('region', { name: 'Allowed moves' });
    await expect(statuses.locator('tr[data-status="new"]')).toContainText('new tickets start here');

    await statuses.getByRole('button', { name: 'Add status' }).click();
    const form = page.getByRole('form', { name: 'Status' });
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Stage').selectOption({ label: 'Waiting' });
    await expect(form.getByText(`Key: ${key}.`)).toBeVisible();
    await form.getByRole('button', { name: 'Add status' }).click();
    await expect(statuses.locator(`tr[data-status="${key}"]`)).toContainText('Waiting');

    // A new status has no way in or out yet, and the page says so.
    const warnings = moves.getByRole('list', { name: 'Workflow warnings' });
    await expect(warnings).toContainText(`Tickets can’t leave “${name}”.`);
    await expect(warnings).toContainText(`Nothing leads to “${name}”.`);
    await expect(moves.getByRole('button', { name: 'Save workflow' })).toBeDisabled();

    await moves.getByRole('checkbox', { name: `In Progress to ${name}` }).check();
    await moves.getByRole('checkbox', { name: `${name} to In Progress` }).check();
    await expect(warnings).toHaveCount(0);
    await shot(page, 'orbit-settings-workflow');
    await moves.getByRole('button', { name: 'Save workflow' }).click();
    await expect(moves.getByRole('status')).toContainText('Workflow saved.');

    const saved = await call<Workflow>(admin, 'GET', '/workflow');
    expect(saved.transitions).toContainEqual({ fromStatus: 'in_progress', toStatus: key });
    expect(saved.transitions).toContainEqual({ fromStatus: key, toStatus: 'in_progress' });
    // The moves that were there before are still there.
    expect(saved.transitions).toContainEqual({ fromStatus: 'new', toStatus: 'ai_handling' });

    // Switching it off keeps it for old tickets and takes it out of the grid.
    page.on('dialog', (d) => void d.accept());
    await statuses
      .locator(`tr[data-status="${key}"]`)
      .getByRole('button', { name: 'Switch off' })
      .click();
    await expect(statuses.locator(`tr[data-status="${key}"]`)).toContainText('switched off');
    await expect(moves.getByRole('columnheader', { name })).toHaveCount(0);
  });

  test('customers: portal, ratings and the time-saved estimate', async ({ page }) => {
    await openSettings(page, 'customers');
    const form = page.getByRole('form', { name: 'Customer settings' });
    await expect(form.getByLabel('Portal on')).toHaveValue('yes');
    await expect(form.getByLabel('Ask by email (email and request-form tickets)')).toHaveValue(
      'yes',
    );
    await form.getByLabel('Minutes of agent work per ticket').fill('25');
    await form.getByRole('button', { name: 'Save settings' }).click();
    await expect(form.getByRole('status')).toContainText('Saved.');
    await shot(page, 'orbit-settings-customers');

    // Reports use the new estimate: every AI-resolved ticket now counts for 25 minutes.
    await page.goto(`${env.orbit}/#/reports`);
    await expect(page.locator('[data-kpi="time-saved"]')).toContainText(
      /\d+ tickets × 25 min each/,
    );
  });

  test('is limited by permission', async ({ page }) => {
    // A team lead manages no settings at all; a supervisor neither.
    const lead = (await login(AGENTS.maya.email, SAMPLE_PASSWORD)).accessToken;
    expect((await raw(lead, 'POST', '/users', {})).status).toBe(403);
    expect(
      (
        await raw(lead, 'PATCH', `/teams/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, {
          name: 'x',
        })
      ).status,
    ).toBe(403);
    expect((await raw(lead, 'PUT', '/workflow/transitions', { transitions: [] })).status).toBe(403);
    expect((await raw(lead, 'GET', '/settings/customer-experience')).status).toBe(403);
    await signInOrbit(page, AGENTS.maya.email);
    await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
  });

  test('the new tabs fit a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInOrbit(page);
    for (const tab of ['people', 'tickets', 'customers']) {
      await page.goto(`${env.orbit}/#/settings/${tab}`);
      await expect(page.getByRole('tabpanel')).toBeVisible();
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${tab} overflows`).toBeLessThanOrEqual(0);
    }
    await shot(page, 'orbit-settings-customers-phone');
  });
});
