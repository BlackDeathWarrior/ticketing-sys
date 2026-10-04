import { call, login, raw } from './api';
import { AGENTS, env, SAMPLE_PASSWORD } from './env';
import { expect, signInOrbit, test } from './fixtures';

/** LiteLLM reaches the scripted fake LLM by its compose hostname. */
const FAKE_LLM_URL = process.env.FAKE_LLM_URL ?? 'http://fake-providers:4010/v1';

async function openSettings(page: import('@playwright/test').Page) {
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();
  // Settings opens on a person's own settings; the keys are under AI providers.
  await page.getByRole('tab', { name: 'AI providers' }).click();
}

test.describe('Settings: AI, channels and keys', () => {
  test('shows the demo provider with a masked key and tests it', async ({ page }) => {
    await signInOrbit(page);
    await openSettings(page);
    const row = page.getByRole('row', { name: /Demo model \(scripted\)/ });
    await expect(row).toBeVisible();
    await expect(row.getByText('••••demo')).toBeVisible();
    await row.getByRole('button', { name: 'Test' }).click();
    await expect(page.getByRole('status')).toContainText('answered');
    await expect(row.getByText('Connected')).toBeVisible();
    // The key itself never reaches the page.
    await expect(page.locator('body')).not.toContainText('not-a-real-key-scripted-demo');
  });

  test('adds a provider and a model, then routes a role to it', async ({ page }) => {
    const admin = (await login()).accessToken;
    const label = `E2E provider ${Date.now().toString(36)}`;
    await signInOrbit(page);
    await openSettings(page);

    await page.getByRole('button', { name: 'Add provider' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('#provider-kind').selectOption('openai_compatible');
    await dialog.getByLabel('Name').fill(label);
    await dialog.getByLabel('API key').fill('e2e-placeholder-key-000000wxyz');
    await dialog.getByLabel('Base URL').fill(FAKE_LLM_URL);
    await dialog.getByLabel('Spending cap (USD)').fill('2');
    await dialog.getByRole('button', { name: 'Add provider' }).click();
    const row = page.getByRole('row', { name: new RegExp(label) });
    await expect(row.getByText('••••wxyz')).toBeVisible();
    await expect(row.getByText('of $2.00 per month')).toBeVisible();

    try {
      await page.getByRole('tab', { name: 'Models & roles' }).click();
      await page.getByRole('button', { name: 'Add model' }).click();
      const form = page.getByRole('dialog');
      await form.locator('#model-provider').selectOption({ label });
      // A model can be tried with the provider's key before it is added: one the
      // provider refuses says why, one it serves answers.
      await form.getByLabel('Model name').fill('always-fails');
      await form.getByRole('button', { name: 'Test model' }).click();
      await expect(form.getByRole('status')).toContainText(
        'The provider did not accept always-fails:',
      );
      await form.getByLabel('Model name').fill('scripted-cheap');
      await form.getByRole('button', { name: 'Test model' }).click();
      await expect(form.getByRole('status')).toContainText('scripted-cheap answered in');
      await form.getByLabel('Display name (optional)').fill(`${label} model`);
      await form.getByLabel('Tool calling and JSON').selectOption('yes');
      // Cheaper than the demo models, so cheapest-first routing picks it.
      await form.getByLabel('Input price per 1M tokens (USD)').fill('0.01');
      await form.getByLabel('Output price per 1M tokens (USD)').fill('0.02');
      await form.getByRole('button', { name: 'Add model' }).click();
      await expect(page.getByRole('row', { name: new RegExp(`${label} model`) })).toBeVisible();

      const role = page.getByRole('region', { name: 'AI agent (chat and email)' });
      const order = role.getByRole('list', { name: /routing order/ });
      await expect(order.getByRole('listitem').first()).toContainText(`${label} model`);
      await role.getByRole('button', { name: 'Try it' }).click();
      await expect(role.getByRole('status')).toContainText('answered');
      await expect(role.getByRole('status')).toContainText('OK');
    } finally {
      const providers = await call<Array<{ id: string; label: string }>>(
        admin,
        'GET',
        '/settings/llm/providers',
      );
      for (const p of providers.filter((x) => x.label === label)) {
        await call(admin, 'DELETE', `/settings/llm/providers/${p.id}`);
      }
    }
  });

  test('chooses a model from the provider’s own list instead of typing its name', async ({
    page,
  }) => {
    const admin = (await login()).accessToken;
    const label = `E2E catalogue ${Date.now().toString(36)}`;
    // A placeholder key: listing and registering a model never calls the provider.
    const provider = await call<{ id: string }>(admin, 'POST', '/settings/llm/providers', {
      provider: 'anthropic',
      label,
      apiKey: 'e2e-placeholder-key-000000abcd',
    });
    try {
      await signInOrbit(page);
      await openSettings(page);
      await page.getByRole('tab', { name: 'Models & roles' }).click();
      await page.getByRole('button', { name: 'Add model' }).click();
      const form = page.getByRole('dialog');
      await form.locator('#model-provider').selectOption({ label });

      // The list is the provider's chat models, each with its price; no name field yet.
      const choice = form.locator('#model-choice');
      await expect(choice).toBeEnabled();
      const options = choice.locator('option');
      await expect(options.filter({ hasText: /^claude-.* in \/ .* out$/ }).first()).toBeAttached();
      await expect(form.getByLabel('Model name')).toHaveCount(0);
      await expect(form.getByRole('button', { name: 'Add model' })).toBeDisabled();

      const picked = (await options
        .filter({ hasText: /^claude-.* in \/ / })
        .first()
        .getAttribute('value'))!;
      await choice.selectOption(picked);
      await expect(form.getByTestId('model-facts')).toContainText('Can use tools');
      // The long names in the list do not push the form wider than a phone.
      await page.setViewportSize({ width: 390, height: 844 });
      const box = (await form.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(await form.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
      await page.setViewportSize({ width: 1440, height: 1000 });
      await form.getByLabel('Display name (optional)').fill(`${label} model`);
      await form.getByRole('button', { name: 'Add model' }).click();

      const row = page.getByRole('row', { name: new RegExp(`${label} model`) });
      await expect(row).toContainText(`anthropic/${picked}`);
      await expect(row).toContainText('from LiteLLM');

      // Asked again, the list says it is there already; a name it lacks can still be typed.
      await page.getByRole('button', { name: 'Add model' }).click();
      await form.locator('#model-provider').selectOption({ label });
      await expect(choice).toBeEnabled();
      await choice.selectOption(picked);
      await expect(form.getByTestId('model-facts')).toContainText('already added');
      await expect(form.getByRole('button', { name: 'Add model' })).toBeDisabled();
      await choice.selectOption({ label: 'Another model: type its name' });
      await expect(form.getByLabel('Model name')).toBeVisible();
      await form.getByLabel('Kind').selectOption('embedding');
      // Anthropic has no embedding models in the list: the name is typed.
      await expect(form.getByLabel('Model name')).toBeVisible();
      await expect(choice).toHaveCount(0);
    } finally {
      await call(admin, 'DELETE', `/settings/llm/providers/${provider.id}`);
    }
  });

  test('stores a channel secret write-only', async ({ page }) => {
    const admin = (await login()).accessToken;
    await signInOrbit(page);
    await openSettings(page);
    await page.getByRole('tab', { name: 'Channels' }).click();
    const card = page.getByRole('region', { name: 'Sarvam voice' });
    try {
      await card.getByLabel('API subscription key').fill('sarvam-e2e-placeholder-9876');
      await card.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(card.getByText('Stored: ••••9876')).toBeVisible();
      await expect(card.getByLabel('API subscription key')).toHaveValue('');
      await expect(page.locator('body')).not.toContainText('sarvam-e2e-placeholder');
    } finally {
      // The voice and channel status specs count on no key being saved.
      await call(admin, 'DELETE', '/settings/secrets/sarvam.api_key');
    }
  });

  test('offers agents and team leads only their own settings, and the API refuses them', async ({
    page,
  }) => {
    for (const who of [AGENTS.jonah, AGENTS.maya]) {
      const token = (await login(who.email, SAMPLE_PASSWORD)).accessToken;
      expect((await raw(token, 'GET', '/settings/llm/providers')).status).toBe(403);
      expect((await raw(token, 'GET', '/settings/secrets')).status).toBe(403);
    }
    await signInOrbit(page, AGENTS.maya.email);
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByRole('tab')).toHaveText(['My settings', 'Teams']);
  });

  test('fits a phone screen without horizontal scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/models`);
    await expect(page.getByRole('heading', { level: 1, name: 'Workspace settings' })).toBeVisible();
    for (const tab of ['Models & roles', 'Channels', 'Usage', 'AI providers']) {
      await page.getByRole('tab', { name: tab }).click();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `horizontal overflow on ${tab}`).toBeLessThanOrEqual(0);
    }
  });
});
