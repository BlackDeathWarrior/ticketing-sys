import { ADMIN, env } from './env';
import { expect, test } from './fixtures';

test.describe('Orbit Desk sign-in', () => {
  test.use({ allowedConsoleErrors: [/401 \(Unauthorized\)/] });

  test('rejects a wrong password', async ({ page }) => {
    await page.goto(env.orbit);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');
    await expect(page.getByRole('heading', { name: 'Sign in to your queue' })).toBeVisible();
  });

  test('signs in, keeps the session on reload and signs out', async ({ page }) => {
    await page.goto(env.orbit);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Administrator');

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Administrator');

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to your queue' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Sign in to your queue' })).toBeVisible();
  });
});

test.describe('basic console sign-in', () => {
  test.use({ allowedConsoleErrors: [/401 \(Unauthorized\)/] });

  test('rejects a wrong password, then signs in and out', async ({ page }) => {
    await page.goto(env.console);
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Email or password is incorrect');

    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Tickets' })).toBeVisible();
    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to TMS' })).toBeVisible();
  });
});
