import { findTicket, login } from './api';
import { env } from './env';
import { expect, signInConsole, test } from './fixtures';

test.describe('basic console (apps/web) on sample data', () => {
  test('lists tickets, filters and opens one', async ({ page }) => {
    await signInConsole(page);
    await page.goto(`${env.console}/tickets`);
    await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
    await expect(page.getByText(/\d+ ticket\(s\)/)).toBeVisible();

    await page.getByLabel('Search').fill('Juniper Health');
    await page.getByRole('button', { name: 'Apply' }).click();
    const row = page.getByRole('row', { name: /Nobody at Juniper Health can log in/ });
    await expect(row).toContainText('Jamal Carter');
    await row.getByRole('link').first().click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Nobody at Juniper Health');
    await expect(page.getByText('Escalated to Platform on-call')).toBeVisible();
  });

  test('replies to an email conversation', async ({ page }) => {
    const admin = (await login()).accessToken;
    const t = await findTicket(admin, 'Exchange hiking boots for a larger size');
    await signInConsole(page);
    await page.goto(`${env.console}/tickets/${t.reference}`);
    await expect(page.getByText('exchange label EX-2231')).toBeVisible();
    const reply = `The replacement pair ships today (${Date.now().toString(36)}).`;
    await page.getByLabel('Reply by email').fill(reply);
    await page.getByRole('button', { name: 'Send reply' }).click();
    await expect(page.getByText(reply)).toBeVisible();
  });

  test('searches customers', async ({ page }) => {
    await signInConsole(page);
    await page.goto(`${env.console}/customers`);
    await page.getByLabel('Search').fill('Riverbend');
    await expect(page.getByRole('link', { name: 'Ravi Menon' })).toBeVisible();
    await page.getByRole('link', { name: 'Ravi Menon' }).click();
    await expect(page.getByRole('heading', { name: 'Ravi Menon' })).toBeVisible();
    await expect(page.getByText('Bulk order of 60 bikes stuck')).toBeVisible();
  });
});
