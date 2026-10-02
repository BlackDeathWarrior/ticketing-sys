import { expect, test } from '../fixtures';
import {
  ADDRESS,
  garment,
  newShopper,
  placeOrder,
  signedIn,
  signInAdmin,
  SKIP_REASON,
  stamp,
  STORE_IMAGE_ERRORS,
} from './garment';

test.use({ allowedConsoleErrors: STORE_IMAGE_ERRORS });

test.describe('Ethnic Threads: shopping', () => {
  test.skip(!garment.site, SKIP_REASON);

  test('a visitor fills a cart, registers at checkout, and watches the order arrive; then returns it', async ({
    browser,
    page,
  }) => {
    test.setTimeout(150_000);
    // Anyone can browse and fill a cart.
    await page.goto(garment.site);
    const card = page.locator('article').first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    await card.click();
    const product = page.getByRole('dialog').first();
    const title = (await product.locator('h2').textContent())!.trim();
    await product.getByRole('radio', { name: 'L', exact: true }).click();
    await product.getByRole('button', { name: 'Add to cart' }).click();
    await expect(page.getByTestId('cart-count')).toHaveText('1');
    await product.getByRole('button', { name: 'Close' }).click();

    await page.getByRole('link', { name: /^Cart/ }).click();
    await expect(page.getByRole('list', { name: 'Cart items' })).toContainText(title);
    await expect(page.getByRole('list', { name: 'Cart items' })).toContainText('Size: L');

    // Checkout asks for an account; registering comes straight back to it.
    await page.getByRole('button', { name: 'Proceed to checkout' }).click();
    await expect(page).toHaveURL(/\/login\?next=\/checkout$/);
    await page.getByRole('link', { name: 'Create an account' }).click();
    const id = stamp();
    // By id: the chat widget has its own (hidden) name and email fields on every page.
    await page.locator('#register-name').fill('Asha Verma');
    await page.locator('#register-email').fill(`asha.${id}@shopper.example`);
    await page.locator('#register-password').fill(`Shopper-${id}-pass`);
    await page.locator('#register-confirm').fill(`Shopper-${id}-pass`);
    await page.getByRole('button', { name: /Create account/ }).click();
    await expect(page).toHaveURL(/\/checkout$/);

    await expect(page.getByLabel('Full name')).toHaveValue('Asha Verma');
    await page.getByLabel('Phone number').fill(ADDRESS.phone);
    await page.getByLabel('Address line 1').fill(ADDRESS.line1);
    await page.getByLabel('City').fill(ADDRESS.city);
    await page.getByLabel('State').fill(ADDRESS.state);
    await page.getByLabel('PIN code').fill(ADDRESS.pincode);
    await page.getByLabel('Cash on delivery').check();
    // No card number, expiry or UPI id is asked for anywhere.
    await expect(page.locator('input[autocomplete^="cc-"], input[name*="card" i]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Place order' }).click();

    // The order page, and the order moving by itself.
    await expect(page).toHaveURL(/\/orders\/ET-\d+\?placed=1$/);
    await expect(page.getByText('Thank you, your order is placed.')).toBeVisible();
    const orderId = /ET-\d+/.exec(page.url())![0];
    await expect(page.getByRole('heading', { name: `Order ${orderId}` })).toBeVisible();
    await expect(page.getByTestId('payment-status')).toHaveText('Pay on delivery');
    await expect(page.getByRole('button', { name: 'Cancel order' })).toBeVisible();

    const status = page.getByTestId('order-status');
    await expect(status).toHaveText('Delivered', { timeout: 90_000 });
    await expect(page.locator('li[data-step][data-done="yes"]')).toHaveCount(5);
    await expect(page.getByRole('region', { name: 'Order tracking' })).toContainText(
      /SwiftShip · SW\d+/,
    );
    // Cash was collected at the door.
    await expect(page.getByTestId('payment-status')).toHaveText('Paid');
    await expect(page.getByRole('button', { name: 'Cancel order' })).toHaveCount(0);

    // "Your Orders" lists it.
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    await expect(page.getByRole('link', { name: new RegExp(orderId) })).toContainText('Delivered');
    await page.getByRole('link', { name: new RegExp(orderId) }).click();

    // A return: asked for by the shopper, approved in the shop's back room, refunded.
    await page.getByRole('button', { name: 'Return items' }).click();
    const form = page.getByRole('form', { name: 'Return this order' });
    await form.getByLabel('What is wrong with it?').fill('It is too small.');
    await form.getByRole('button', { name: 'Request a return' }).click();
    await expect(status).toHaveText('Return requested');

    const backRoom = await browser.newPage();
    await signInAdmin(backRoom);
    const row = backRoom.locator(`tr[data-order="${orderId}"]`);
    await expect(row).toContainText('Asha Verma');
    await row.getByRole('button', { name: 'Approve return and refund' }).click();
    await expect(row.getByTestId('order-status')).toHaveText('Refunded');
    await backRoom.close();

    await expect(status).toHaveText('Refunded', { timeout: 20_000 });
    await expect(page.getByTestId('refund')).toContainText(/refunded \(RF-\d+\)/);
  });

  test('an order is cancelled before it ships, and what was paid comes back', async ({
    browser,
  }) => {
    const shopper = await newShopper();
    const order = await placeOrder(shopper, 'upi');
    const page = await signedIn(browser, shopper);
    await page.goto(`${garment.site}/orders/${order.id}`);
    await expect(page.getByTestId('payment-status')).toHaveText('Paid');
    await page.getByRole('button', { name: 'Cancel order' }).click();
    const form = page.getByRole('form', { name: 'Cancel this order?' });
    await expect(form).toContainText('refunded at once');
    await form.getByRole('button', { name: 'Yes, cancel it' }).click();
    await expect(page.getByTestId('order-status')).toHaveText('Cancelled');
    await expect(page.getByTestId('refund')).toContainText(/RF-\d+/);
    await expect(page.getByTestId('payment-status')).toHaveText('Refunded');
    await page.close();
  });

  test("one shopper cannot open another's order", async ({ browser }) => {
    const asha = await newShopper('Asha Verma');
    const ravi = await newShopper('Ravi Menon');
    const order = await placeOrder(asha);
    const page = await signedIn(browser, ravi);
    await page.goto(`${garment.site}/orders/${order.id}`);
    await expect(page.getByRole('alert')).toContainText('could not find that order');
    await expect(page.getByTestId('order-status')).toHaveCount(0);
    await page.close();
  });
});
