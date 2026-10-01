import { call, login } from './api';
import { env } from './env';
import { expect, signInOrbit, test } from './fixtures';

test.describe('branding', () => {
  test.afterAll(async () => {
    // Back to the sample shop, which the other specs expect.
    await call((await login()).accessToken, 'PUT', '/settings/branding', {});
  });

  test('an admin names the company; the help center and its form follow', async ({
    browser,
    page,
  }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/customers`);
    const form = page.getByRole('form', { name: 'Branding' });
    await expect(form.getByLabel('Company name')).toHaveValue('Demo Store');
    await form.getByLabel('Company name').fill('Ethnic Threads');
    await form.getByLabel('Replies are signed by').fill('Ethnic Threads Care');
    await form.getByLabel('Reference field on the request form').fill('Listing');
    await form.getByLabel('Line at the bottom of the help center').fill('');
    await form.getByRole('button', { name: 'Save branding' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');

    const visitor = await browser.newPage();
    await visitor.goto(env.helpCenter);
    await expect(visitor.locator('.brand')).toContainText('Ethnic Threads');
    await expect(visitor.locator('.brand__mark')).toHaveText('ET');
    await expect(visitor).toHaveTitle('Ethnic Threads Help');
    await expect(visitor.getByLabel('Listing')).toBeVisible();
    await expect(visitor.getByLabel('Order number')).toHaveCount(0);
    await expect(
      visitor.getByText('Include your listing if the request is about one.'),
    ).toBeVisible();
    await expect(visitor.locator('.site-footer')).toHaveCount(0);

    // No reference field at all when it has no label.
    await form.getByLabel('Reference field on the request form').fill('');
    await form.getByRole('button', { name: 'Save branding' }).click();
    await expect(form.getByRole('status')).toHaveText('Saved.');
    await visitor.reload();
    await expect(visitor.locator('.brand')).toContainText('Ethnic Threads');
    await expect(visitor.getByLabel('Listing')).toHaveCount(0);
    await visitor.close();
  });
});
