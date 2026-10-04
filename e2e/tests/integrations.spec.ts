import { env } from './env';
import { expect, signInOrbit, test } from './fixtures';

const stamp = () => Date.now().toString(36);

/** Asks the API who a key is, the way an integration would. */
async function whoAmI(key: string) {
  const res = await fetch(`${env.api}/api/v1/integration`, {
    headers: { authorization: `Bearer ${key}` },
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

test.describe('integrations and API keys', () => {
  test('an admin connects an app, creates a key that works, and revokes it', async ({ page }) => {
    const name = `Storefront ${stamp()}`;
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/integrations`);

    // Add the integration: the identifier follows the name.
    await page.getByRole('button', { name: 'Add integration' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill(name);
    await expect(dialog.getByLabel(/^Identifier/)).toHaveValue(
      name.toLowerCase().replace(/ /g, '-'),
    );
    await dialog.getByRole('button', { name: 'Add integration' }).click();

    // Its keys open straight away.
    const keys = page.getByRole('region', { name: `API keys of ${name}` });
    await expect(keys).toContainText('No keys yet.');

    await keys.getByRole('button', { name: 'Create key' }).click();
    await dialog.getByLabel('Name', { exact: true }).fill('Backend');
    await dialog.getByLabel(/Report incidents and recoveries/).check();
    await dialog.getByRole('button', { name: 'Create key' }).click();

    // The key is on screen once, and it works.
    const shown = keys.getByTestId('new-api-key');
    await expect(shown).toHaveText(/^tms_sk_[A-Za-z0-9_-]{43}$/);
    const key = (await shown.textContent())!;
    const me = await whoAmI(key);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      integration: { name },
      key: { name: 'Backend', scopes: ['integration:ticket', 'integration:event'] },
    });

    // Once dismissed, only the start of the key remains.
    await keys.getByRole('button', { name: 'Done' }).click();
    await expect(shown).toHaveCount(0);
    const row = keys.getByRole('row', { name: /Backend/ });
    await expect(row).toContainText(`${key.slice(0, 15)}…`);
    await expect(row).toContainText('Active');
    await expect(keys).not.toContainText(key);

    // Revoking stops it on the next request.
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Revoke' }).click();
    await expect(row).toContainText('Revoked');
    expect((await whoAmI(key)).status).toBe(401);
  });
});
