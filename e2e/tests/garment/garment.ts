import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect } from '../fixtures';

/**
 * The Ethnic Threads demo (ADR 0027): the garment-web-scraper app with TMS as
 * its support desk. These specs drive the app's real storefront and Orbit
 * Desk together, so they need the demo stack, the loader and the app running
 * (docs/runbooks/phase-14-garment-demo.md). Without GARMENT_URL they are skipped.
 *
 *   GARMENT_URL          the storefront, e.g. http://localhost:5173
 *   GARMENT_WORKER_URL   the app's worker (http://localhost:8765)
 *   GARMENT_ENV          the app's .env, written by the loader: the admin
 *                        sign-in and the keys the specs use are read from it
 */
export const garment = {
  site: (process.env.GARMENT_URL ?? '').replace(/\/$/, ''),
  worker: (process.env.GARMENT_WORKER_URL ?? 'http://localhost:8765').replace(/\/$/, ''),
  envFile: process.env.GARMENT_ENV ?? '',
};

export const SKIP_REASON = 'Set GARMENT_URL to run the Ethnic Threads demo specs';

/** Product images come from the stores' CDNs; one that is gone is not this demo's business. */
export const STORE_IMAGE_ERRORS = [/Failed to load resource/, /net::ERR_/];

export const stamp = () => Date.now().toString(36);

/** The app's settings, as the loader wrote them. */
export function appEnv(): Record<string, string> {
  if (!garment.envFile) throw new Error('Set GARMENT_ENV to the garment app’s .env');
  const values: Record<string, string> = {};
  for (const line of readFileSync(garment.envFile, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) values[match[1]!] = match[2]!.trim();
  }
  return values;
}

export interface Shopper {
  name: string;
  email: string;
}

export function newShopper(): Shopper {
  const id = stamp();
  return { name: `asha_${id}`, email: `asha.${id}@shopper.example` };
}

/** Registers on the storefront the way a shopper does. The account lives in that browser only. */
export async function registerShopper(page: Page, shopper: Shopper) {
  const password = `Shopper-${stamp()}!1`;
  await page.goto(`${garment.site}/register`);
  await page.getByPlaceholder('Pick a username').fill(shopper.name);
  await page.getByPlaceholder('you@example.com').fill(shopper.email);
  const passwords = page.getByPlaceholder('••••••••');
  await passwords.nth(0).fill(password);
  await passwords.nth(1).fill(password);
  await page.getByRole('button', { name: 'Register Now' }).click();
  await expect(page.getByText('Mode: Registered User')).toBeVisible();
}

/** Signs in as the storefront's admin, with the sign-in the loader wrote to the app's .env. */
export async function signInAdmin(page: Page) {
  const settings = appEnv();
  await page.goto(`${garment.site}/login`);
  await page.getByPlaceholder('Enter username').fill(settings.ADMIN_USERNAME ?? 'scraper_admin');
  await page.locator('input[type="password"]').fill(settings.ADMIN_PASSWORD ?? '');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText('Mode: Scraper Admin')).toBeVisible();
}

/** Opens the first listing on the home page; returns its title. */
export async function openFirstListing(page: Page): Promise<string> {
  const card = page.locator('article').first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.click();
  // The product window is the page's only full-screen overlay.
  const title = page.locator('div.fixed.inset-0 h2').first();
  await expect(title).toBeVisible();
  return (await title.textContent())!.trim();
}

/** The chat widget's panel on the storefront, opened. */
export async function openChat(page: Page) {
  await page.getByRole('button', { name: 'Chat with us' }).click();
  const panel = page.getByRole('dialog', { name: 'Ethnic Threads support' });
  await expect(panel).toBeVisible();
  return panel;
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
