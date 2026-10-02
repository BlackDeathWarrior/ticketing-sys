import { readFileSync } from 'node:fs';
import type { Browser, Page } from '@playwright/test';
import { env } from '../env';
import { expect } from '../fixtures';

/**
 * The Ethnic Threads demo (ADR 0027, 0028): a shop with TMS as its support
 * desk. These specs drive the shop's real storefront and Orbit Desk together,
 * so they need the demo stack, the loader and the shop running
 * (docs/runbooks/phase-14b-shop-demo.md). Without GARMENT_URL they are skipped.
 *
 *   GARMENT_URL          the storefront, e.g. http://localhost:5173
 *   GARMENT_SHOP_URL     the shop's server (http://localhost:8765)
 *   GARMENT_ENV          the shop's .env, written by the loader: the admin
 *                        sign-in and the keys the specs use are read from it
 *
 * Start the shop with a short step (`garment-demo.ps1 shop -StepSeconds 5`),
 * so an order is delivered while a spec watches.
 */
export const garment = {
  site: (process.env.GARMENT_URL ?? '').replace(/\/$/, ''),
  shop: (process.env.GARMENT_SHOP_URL ?? 'http://localhost:8765').replace(/\/$/, ''),
  envFile: process.env.GARMENT_ENV ?? '',
};

export const SKIP_REASON = 'Set GARMENT_URL to run the Ethnic Threads demo specs';

/** Product images come from other sites' CDNs; one that is gone is not this demo's business. */
export const STORE_IMAGE_ERRORS = [/Failed to load resource/, /net::ERR_/];

export const stamp = () => Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

/** The shop's settings, as the loader wrote them. */
export function appEnv(): Record<string, string> {
  if (!garment.envFile) throw new Error('Set GARMENT_ENV to the shop’s .env');
  const values: Record<string, string> = {};
  for (const line of readFileSync(garment.envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.trim();
  }
  return values;
}

export const ADDRESS = {
  name: 'Asha Verma',
  phone: '98300 55555',
  line1: '12 MG Road',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
};

export interface Shopper {
  id: string;
  name: string;
  email: string;
  token: string;
}

export interface Order {
  id: string;
  status: string;
  statusLabel: string;
  total: number;
  delayed: boolean;
  payment: { status: string };
  refund: { id: string; amount: number } | null;
  delivery: { carrier: string | null; trackingNumber: string | null };
}

/** Calls the shop's API the way its storefront does. */
export async function shopApi<T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${garment.shop}/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as T };
}

/** A new shopper account, made through the shop's own registration. */
export async function newShopper(name = 'Asha Verma'): Promise<Shopper> {
  const id = stamp();
  const email = `asha.${id}@shopper.example`;
  const made = await shopApi<{ token: string; user: { id: string } }>('POST', '/auth/register', {
    name,
    email,
    password: `Shopper-${id}-pass`,
  });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return { id: made.body.user.id, name, email, token: made.body.token };
}

/** A storefront page already signed in as this shopper (the session the shop issued). */
export async function signedIn(browser: Browser, shopper: Shopper): Promise<Page> {
  const page = await browser.newPage();
  await page.addInitScript(
    ({ token, user }) => {
      localStorage.setItem('ethnic-threads-session-v1', JSON.stringify({ token, user }));
    },
    {
      token: shopper.token,
      user: { id: shopper.id, role: 'shopper', name: shopper.name, email: shopper.email },
    },
  );
  return page;
}

let cachedAdmin: string | null = null;

/** The shop admin's session, from the sign-in the loader wrote to the shop's .env. */
export async function adminToken(): Promise<string> {
  if (cachedAdmin) return cachedAdmin;
  const settings = appEnv();
  const res = await shopApi<{ token: string }>('POST', '/auth/login', {
    username: settings.ADMIN_USERNAME,
    password: settings.ADMIN_PASSWORD,
  });
  expect(res.status, 'the shop admin sign-in from the .env').toBe(200);
  cachedAdmin = res.body.token;
  return cachedAdmin;
}

/** A storefront page signed in as the shop's admin, through the sign-in form. */
export async function signInAdmin(page: Page) {
  const settings = appEnv();
  await page.goto(`${garment.site}/login`);
  // By id: the chat widget has its own (hidden) email field on every page.
  await page.locator('#login-email').fill(settings.ADMIN_USERNAME ?? 'shop_admin');
  await page.locator('#login-password').fill(settings.ADMIN_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Operations' })).toBeVisible();
}

/** Turns the shop's simulated problems on or off. */
export async function setSwitches(changes: Record<string, unknown>) {
  const res = await shopApi('PUT', '/admin/simulation', changes, await adminToken());
  expect(res.status).toBe(200);
}

/** The id of a product that is on sale, from the catalogue the storefront shows. */
export async function someProductId(): Promise<string> {
  const res = await fetch(`${garment.site}/products.json`);
  const products = (await res.json()) as Array<{ id: string; in_stock?: boolean }>;
  return products.find((p) => p.in_stock !== false)!.id;
}

/** Places an order for the shopper through the shop's API. */
export async function placeOrder(shopper: Shopper, payment = 'cod'): Promise<Order> {
  const res = await shopApi<{ order: Order; message?: string }>(
    'POST',
    '/orders',
    {
      items: [{ productId: await someProductId(), quantity: 1, size: 'M' }],
      address: ADDRESS,
      payment,
    },
    shopper.token,
  );
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.order;
}

export async function orderOf(shopper: Shopper, orderId: string): Promise<Order> {
  return (await shopApi<{ order: Order }>('GET', `/orders/${orderId}`, undefined, shopper.token))
    .body.order;
}

/** Moves an order along as the admin would, without waiting for the clock. */
export async function advanceTo(orderId: string, status: string) {
  const token = await adminToken();
  for (let i = 0; i < 5; i++) {
    const res = await shopApi<{ orders: Order[] }>('GET', '/admin/orders', undefined, token);
    const order = res.body.orders.find((o) => o.id === orderId);
    if (!order) throw new Error(`No order ${orderId}`);
    if (order.status === status) return;
    await shopApi('POST', `/admin/orders/${orderId}/advance`, {}, token);
  }
  throw new Error(`${orderId} did not reach ${status}`);
}

/** The chat widget's panel on the storefront, opened. */
export async function openChat(page: Page) {
  await page.getByRole('button', { name: 'Chat with us' }).click();
  const panel = page.getByRole('dialog', { name: 'Ethnic Threads support' });
  await expect(panel).toBeVisible();
  return panel;
}

/** Says something in the chat and returns the panel. */
export async function say(panel: ReturnType<Page['getByRole']>, text: string) {
  await panel.getByLabel('Message').fill(text);
  await panel.getByRole('button', { name: 'Send' }).click();
}

/** Polls until `check` returns something, or fails. */
export async function waitFor<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await check();
    if (found) return found;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

export interface Incident {
  fingerprint: string;
  title: string;
  status: 'open' | 'resolved';
  severity: string;
  occurrences: number;
  ticket: string | null;
}

/** The shop's incidents, read with the key it reports them with. Newest first. */
export async function incidents(): Promise<Incident[]> {
  const res = await fetch(`${env.api}/api/v1/integration/incidents?limit=50`, {
    headers: { authorization: `Bearer ${appEnv().SUPPORT_API_KEY_EVENTS}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Incident[];
}

export const openIncident = async (fingerprint: string) =>
  (await incidents()).find((i) => i.fingerprint === fingerprint && i.status === 'open');
