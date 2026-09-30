import { expect, openTicket, signInOrbit, test } from './fixtures';

test.describe('Orbit Desk at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('no horizontal scroll; the menu opens as a drawer; tickets open', async ({ page }) => {
    await signInOrbit(page);
    const overflow = () =>
      page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
    // Right after first paint (the chart used to render 640px wide until measured) and once loaded.
    expect(await overflow()).toBeLessThanOrEqual(0);
    await expect(page.locator('tr[data-ticket]').first()).toBeVisible();
    expect(await overflow()).toBeLessThanOrEqual(0);

    const nav = page.getByRole('complementary', { name: 'Primary' });
    await expect(nav).not.toBeInViewport();
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect(nav).toBeInViewport();
    await nav.getByRole('link', { name: /^Urgent/ }).click();
    await expect(
      page.getByRole('heading', { name: 'Urgent', level: 2, exact: true }),
    ).toBeVisible();

    const first = page.locator('tr[data-ticket]').first();
    const ref = (await first.getAttribute('data-ticket'))!;
    const drawer = await openTicket(page, ref);
    const box = await drawer.boundingBox();
    expect(Math.round(box!.width)).toBeLessThanOrEqual(390);
  });
});
