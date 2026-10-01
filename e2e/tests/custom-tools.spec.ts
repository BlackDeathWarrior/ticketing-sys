import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { call, login, raw } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, signInOrbit, test } from './fixtures';

/** The sample server as the API container reaches it (compose host name). */
const SAMPLE_HOST = process.env.SAMPLE_SYSTEM_URL ?? 'http://fake-providers:4010';

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
  });
}

const stamp = () => Date.now().toString(36);

async function openTools(page: Page, email?: string, password?: string) {
  await signInOrbit(page, email, password);
  await page.goto(`${env.orbit}/#/settings/tools`);
  const card = page.getByRole('region', { name: 'Custom tools', exact: true });
  await expect(card).toBeVisible();
  return card;
}

test.describe('custom tools', () => {
  // Refused addresses (400), a delete with history (409) and missing rights (403) are expected.
  test.use({
    allowedConsoleErrors: [/40[039] \((Bad Request|Forbidden|Conflict)\)/],
  });

  test.afterAll(async () => {
    const admin = (await login()).accessToken;
    await raw(admin, 'DELETE', '/roles/team_lead/permissions/tool:create');
  });

  test('an admin creates a custom tool, tests it, switches it on and edits it', async ({
    page,
  }) => {
    const card = await openTools(page);
    // The sample data ships one custom tool.
    await expect(card.locator('[data-tool="systems_status"]')).toContainText(
      'Store systems status',
    );

    const name = `health_${stamp()}`;
    await card.getByRole('button', { name: 'New custom tool' }).click();
    const dialog = page.getByRole('dialog', { name: 'New custom tool' });
    await dialog.getByLabel('Title').fill('Warehouse check');
    await dialog.getByLabel('Name for the AI').fill(name);
    await dialog.getByLabel(/What it does/).fill('Checks that the warehouse system is answering.');

    // An internal address is refused, with the reason.
    await dialog.getByLabel('Address').fill('http://10.0.0.5/health');
    await dialog.getByRole('button', { name: 'Create tool' }).click();
    await expect(dialog.getByRole('alert')).toContainText('not reachable from the public internet');

    // A placeholder needs a matching value.
    await dialog.getByLabel('Address').fill(`${SAMPLE_HOST}/{path}`);
    await dialog.getByRole('button', { name: 'Create tool' }).click();
    await expect(dialog.getByRole('alert')).toContainText('{path} is in the URL');
    await dialog.getByRole('button', { name: 'Add a value' }).click();
    const value = dialog.getByRole('group', { name: 'Value 1' });
    await value.getByLabel('Name').fill('path');
    await value.getByLabel('What it is').fill('Which check to run, e.g. health');
    await dialog.getByLabel('Title').scrollIntoViewIfNeeded();
    await shot(page, 'orbit-custom-tool-new');
    await dialog.getByRole('button', { name: 'Create tool' }).click();
    await expect(dialog).toBeHidden();

    const row = card.locator(`[data-tool="${name}"]`);
    await expect(row).toContainText('Warehouse check');
    await expect(row).toContainText(`${SAMPLE_HOST}/{path}`);
    await expect(row.getByLabel('AI may use it')).toHaveValue('no');

    await row.getByRole('button', { name: 'Test' }).click();
    const testing = page.getByRole('dialog', { name: /Test Warehouse check/ });
    await testing.getByLabel('Arguments (JSON)').fill('{"path": "health"}');
    await testing.getByRole('button', { name: 'Run test' }).click();
    await expect(testing.getByRole('status', { name: 'Test result' })).toContainText(
      '"status": "ok"',
    );
    await testing.getByRole('button', { name: 'Close' }).click();

    await row.getByLabel('AI may use it').selectOption('yes');
    await expect(row.getByLabel('AI may use it')).toHaveValue('yes');

    await row.getByRole('button', { name: 'Edit' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit Warehouse check' });
    await expect(edit.getByLabel('Name for the AI')).toBeDisabled();
    await edit.getByLabel('Title').fill('Warehouse system check');
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(row).toContainText('Warehouse system check');
    await shot(page, 'orbit-custom-tools');

    // It has been used, so it can only be switched off.
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toContainText('switch it off instead');
    await row.getByLabel('AI may use it').selectOption('no');
    await expect(row.getByLabel('AI may use it')).toHaveValue('no');
  });

  test('a team lead can create custom tools only after an admin allows the role', async ({
    page,
    browser,
  }) => {
    const leadToken = (await login(AGENTS.maya.email, SAMPLE_PASSWORD)).accessToken;
    expect((await raw(leadToken, 'GET', '/tools/custom')).status).toBe(403);

    await openTools(page);
    const creators = page.getByRole('region', { name: 'Who can create custom tools' });
    await expect(creators.getByLabel('Administrator')).toBeChecked();
    await expect(creators.getByLabel('Administrator')).toBeDisabled();
    await expect(creators.getByLabel('Team lead')).not.toBeChecked();
    await creators.getByLabel('Team lead').check();
    await expect(creators.getByLabel('Team lead')).toBeChecked();
    await shot(page, 'orbit-tool-creators');

    // The team lead now sees Settings, with the custom tools and nothing else.
    const lead = await browser.newPage();
    const card = await openTools(lead, AGENTS.maya.email, SAMPLE_PASSWORD);
    await expect(lead.getByRole('tab')).toHaveCount(1);
    await expect(lead.getByRole('region', { name: 'Add an MCP server' })).toHaveCount(0);
    await expect(lead.getByRole('region', { name: 'Who can create custom tools' })).toHaveCount(0);

    const name = `lead_${stamp()}`;
    await card.getByRole('button', { name: 'New custom tool' }).click();
    const dialog = lead.getByRole('dialog', { name: 'New custom tool' });
    await dialog.getByLabel('Title').fill('Lead’s check');
    await dialog.getByLabel('Name for the AI').fill(name);
    await dialog.getByLabel(/What it does/).fill('Checks that the sample system answers.');
    await dialog.getByLabel('Address').fill(`${SAMPLE_HOST}/health`);
    await dialog.getByRole('button', { name: 'Create tool' }).click();
    const row = card.locator(`[data-tool="${name}"]`);
    await expect(row).toContainText(`Created by ${AGENTS.maya.name}`);
    await lead.close();

    // Keys and MCP servers stay with administrators.
    expect((await raw(leadToken, 'GET', '/tools/servers')).status).toBe(403);
    expect(
      (await raw(leadToken, 'PUT', `/settings/secrets/tool.custom_${name}.token`, { value: 'k' }))
        .status,
    ).toBe(403);

    await creators.getByLabel('Team lead').uncheck();
    await expect(creators.getByLabel('Team lead')).not.toBeChecked();
    await expect
      .poll(async () => (await raw(leadToken, 'GET', '/tools/custom')).status, { timeout: 15_000 })
      .toBe(403);

    // Tidy up: the tool was never used, so it can go.
    const admin = (await login()).accessToken;
    const tools = await call<Array<{ id: string; name: string }>>(admin, 'GET', '/tools/custom');
    await raw(admin, 'DELETE', `/tools/custom/${tools.find((t) => t.name === name)!.id}`);
  });

  test('an admin adds another MCP server, gives it its key and tries a tool', async ({ page }) => {
    await openTools(page);
    const name = `Second store ${stamp()}`;
    const form = page.getByRole('form', { name: 'Add an MCP server' });
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('URL').fill(`${SAMPLE_HOST}/mcp`);
    await form.getByRole('button', { name: 'Add server' }).click();

    const server = page.getByRole('region', { name });
    await expect(server).toBeVisible();
    // Without its key the server refuses us, and the card says so.
    await server.getByRole('button', { name: 'Sync tools' }).click();
    await expect(server.getByText(/Last sync failed/)).toBeVisible();

    await server.getByLabel(/Token/).fill('demo-store-token');
    await server.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(server.getByText('Stored: ••••oken')).toBeVisible();
    await server.getByRole('button', { name: 'Sync tools' }).click();
    await expect(server.getByRole('status')).toContainText('Tools refreshed.');
    const status = server.locator('[data-tool="order_status"]');
    // New tools start switched off, with the customer argument found for us.
    await expect(status.getByLabel('AI may use it')).toHaveValue('no');
    await expect(status.getByLabel('Customer email goes in')).toHaveValue('email');

    await status.getByRole('button', { name: 'Test' }).click();
    const dialog = page.getByRole('dialog', { name: /Test Order status/ });
    await dialog.getByLabel(/Customer email/).fill('maria.lopez@example.com');
    await dialog.getByLabel('Arguments (JSON)').fill('{"order_id": "DS-20517"}');
    await dialog.getByRole('button', { name: 'Run test' }).click();
    await expect(dialog.getByRole('status', { name: 'Test result' })).toContainText('"shipped"');
    await dialog.getByRole('button', { name: 'Close' }).click();

    // Leave the stack as it was: this copy stays off.
    await server.getByRole('button', { name: 'Disable' }).click();
    await expect(server.getByRole('button', { name: 'Enable' })).toBeVisible();
  });

  test('fits a phone screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const card = await openTools(page);
    await card.getByRole('button', { name: 'New custom tool' }).click();
    const dialog = page.getByRole('dialog', { name: 'New custom tool' });
    await dialog.getByRole('button', { name: 'Add a value' }).click();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
