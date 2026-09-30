import { call, login, type TicketRow } from './api';
import { expect, signInOrbit, test } from './fixtures';

test.describe('Orbit Desk new ticket dialog', () => {
  test('creates a ticket for an existing customer found by search', async ({ page }) => {
    await signInOrbit(page);
    await page.getByRole('button', { name: 'New ticket' }).click();
    const dialog = page.getByRole('dialog', { name: 'New ticket' });

    const create = dialog.getByRole('button', { name: 'Create ticket' });
    await expect(create).toBeDisabled();

    const subject = `Bulk discount for 20 cargo bikes ${Date.now().toString(36)}`;
    await dialog.getByLabel('Subject').fill(subject);
    await expect(create).toBeDisabled(); // still needs a customer
    await dialog.getByLabel('Customer', { exact: true }).fill('Riverbend');
    await dialog.getByRole('button', { name: /Ravi Menon/ }).click();
    await expect(dialog.getByText('ravi.menon@riverbend.example.com')).toBeVisible();
    await dialog.getByLabel('Priority').selectOption('high');
    await dialog.getByLabel('Channel').selectOption('voice');
    await dialog.getByLabel('Tags').fill('pricing, vip');
    await dialog
      .getByLabel('Description')
      .fill('Asked on the phone for a quote on 20 cargo bikes.');
    await create.click();

    const drawer = page.getByRole('dialog', { name: subject });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByText('Riverbend Cycles')).toBeVisible();
    await expect(drawer.getByText('#vip')).toBeVisible();

    const admin = (await login()).accessToken;
    const page1 = await call<{ items: TicketRow[] }>(
      admin,
      'GET',
      `/tickets?q=${encodeURIComponent(subject)}`,
    );
    expect(page1.items[0]).toMatchObject({
      subject,
      priority: 'high',
      channel: 'voice',
      status: 'new',
    });
  });

  test('creates a new customer inline', async ({ page }) => {
    await signInOrbit(page);
    await page.getByRole('button', { name: 'New ticket' }).click();
    const dialog = page.getByRole('dialog', { name: 'New ticket' });
    const stamp = Date.now().toString(36);
    const subject = `Set up an invoicing account ${stamp}`;

    await dialog.getByLabel('Subject').fill(subject);
    await dialog.getByLabel('Customer', { exact: true }).fill('Ines Calloway');
    await dialog.getByRole('button', { name: 'New customer' }).click();
    await expect(dialog.getByLabel('Customer name')).toHaveValue('Ines Calloway');
    await dialog.getByLabel('Company').fill('Calloway Ceramics');
    await dialog.getByLabel('Email', { exact: true }).fill(`ines.${stamp}@calloway.example.com`);
    await dialog.getByRole('button', { name: 'Create ticket' }).click();

    const drawer = page.getByRole('dialog', { name: subject });
    await expect(drawer.getByText('Calloway Ceramics')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('tr[data-ticket]', { hasText: subject })).toContainText(
      'Ines Calloway',
    );
  });
});

test.describe('Orbit Desk new ticket validation', () => {
  // The rejected request is logged by the browser; that one error is expected.
  test.use({ allowedConsoleErrors: [/400 \(Bad Request\)/] });

  test('shows the API validation error for a bad email', async ({ page }) => {
    await signInOrbit(page);
    await page.getByRole('button', { name: 'New ticket' }).click();
    const dialog = page.getByRole('dialog', { name: 'New ticket' });
    await dialog.getByLabel('Subject').fill('Validation check');
    await dialog.getByRole('button', { name: 'New customer' }).click();
    await dialog.getByLabel('Customer name').fill('Bad Email');
    // Browser validation is bypassed so the API's own validation is exercised.
    await dialog.locator('form').evaluate((f) => ((f as HTMLFormElement).noValidate = true));
    await dialog.getByLabel('Email', { exact: true }).fill('not-an-email');
    await dialog.getByRole('button', { name: 'Create ticket' }).click();
    await expect(dialog.getByRole('alert')).toContainText(/email/i);
  });
});
