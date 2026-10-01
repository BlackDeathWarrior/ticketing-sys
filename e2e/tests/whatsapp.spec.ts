import { createHmac, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { call, eventually, login, raw, type TicketRow } from './api';
import { env } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

/**
 * WhatsApp in the console. The stack has no Meta account, so these tests post
 * signed webhooks the way Meta does and check what agents see. Sending needs
 * a real access token, so here every reply must fail with a clear reason.
 * Delivery to Meta itself is covered by apps/api/test/whatsapp.int.test.ts.
 */
const PHONE_NUMBER_ID = '1055598765';
const WABA_ID = '2055598765';
const APP_SECRET = randomBytes(24).toString('hex');
const VERIFY_TOKEN = randomBytes(16).toString('hex');
const HOOK = `${env.api}/api/v1/channels/whatsapp/webhook`;

let admin: string;
let before: { config: Record<string, unknown> | null } | undefined;

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
const newPhone = () => `1555${String(Date.now()).slice(-6)}${Math.floor(Math.random() * 9)}`;

/** With SCREENSHOTS=1, saves an image for docs/testing/TEST_REPORT.md. */
async function shot(page: Page, name: string) {
  if (!process.env.SCREENSHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({
    path: fileURLToPath(new URL(`../../docs/testing/screenshots/${name}.png`, import.meta.url)),
  });
}

async function webhook(payload: unknown, signature?: string) {
  const body = JSON.stringify(payload);
  const res = await fetch(HOOK, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256':
        signature ?? `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`,
    },
    body,
  });
  return res.status;
}

function textMessage(phone: string, name: string, text: string, at = new Date()) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: WABA_ID,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100199', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name }, wa_id: phone }],
              messages: [
                {
                  from: phone,
                  id: `wamid.e2e.${stamp()}`,
                  timestamp: String(Math.floor(at.getTime() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

async function ticketFor(text: string): Promise<TicketRow> {
  return eventually(`WhatsApp ticket for "${text}"`, async () => {
    const page = await call<{ items: TicketRow[] }>(
      admin,
      'GET',
      `/tickets?channel=whatsapp&q=${encodeURIComponent(text)}&limit=5`,
    );
    return page.items[0];
  });
}

test.describe('WhatsApp', () => {
  // Without an access token the API refuses to send or sync (400) and says why.
  test.use({ allowedConsoleErrors: [/400 \(Bad Request\)/] });

  test.beforeAll(async () => {
    admin = (await login()).accessToken;
    before = await call(admin, 'GET', '/settings/channels/whatsapp');
    await call(admin, 'PUT', '/settings/channels/whatsapp', {
      enabled: true,
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      graphVersion: 'v23.0',
    });
    await call(admin, 'PUT', '/settings/secrets/whatsapp.app_secret', { value: APP_SECRET });
    await call(admin, 'PUT', '/settings/secrets/whatsapp.verify_token', { value: VERIFY_TOKEN });
  });

  test.afterAll(async () => {
    // Leave the stack as it was: WhatsApp off and without test secrets.
    for (const key of ['whatsapp.app_secret', 'whatsapp.verify_token']) {
      await raw(admin, 'DELETE', `/settings/secrets/${key}`);
    }
    await call(admin, 'PUT', '/settings/channels/whatsapp', {
      phoneNumberId: PHONE_NUMBER_ID,
      wabaId: WABA_ID,
      graphVersion: 'v23.0',
      ...(before?.config ?? {}),
      enabled: false,
    });
  });

  test('the webhook answers Meta’s handshake and refuses unsigned calls', async () => {
    const query = (token: string) =>
      `${HOOK}?hub.mode=subscribe&hub.challenge=7781&hub.verify_token=${token}`;
    const ok = await fetch(query(VERIFY_TOKEN));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('7781');
    expect((await fetch(query('guess'))).status).toBe(403);

    const forged = textMessage(newPhone(), 'Forger', `Forged ${stamp()}`);
    expect(await webhook(forged, 'sha256=00')).toBe(401);
  });

  test('settings show a red light, what is missing, the webhook address and the templates', async ({
    page,
  }) => {
    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/channels`);
    // Switched on without an access token: the light is red and says why.
    const overview = page.getByRole('region', { name: 'Channel status' });
    await expect(overview.getByRole('button', { name: /^WhatsApp/ })).toHaveAttribute(
      'data-state',
      'down',
    );
    const card = page.getByRole('region', { name: 'WhatsApp', exact: true });
    await expect(card.getByRole('status').first()).toContainText(
      'Not working' + 'Not saved. Messages cannot be sent.',
    );
    const checks = card.getByRole('list', { name: 'WhatsApp checks' });
    await expect(
      checks.locator('li', { has: page.getByText('Access token', { exact: true }) }),
    ).toHaveAttribute('data-state', 'down');
    await expect(
      checks.locator('li', { has: page.getByText('Webhook security', { exact: true }) }),
    ).toHaveAttribute('data-state', 'ok');

    const setup = page.getByRole('region', { name: 'WhatsApp setup' });
    await expect(setup.getByLabel('Webhook address for Meta')).toHaveValue(
      /\/api\/v1\/channels\/whatsapp\/webhook$/,
    );
    await expect(setup.getByText('No templates synced yet.')).toBeVisible();
    await setup.getByRole('button', { name: 'Sync templates' }).click();
    await expect(setup.getByRole('status')).toContainText('Set the WhatsApp access token first');
    await card.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await shot(page, 'orbit-settings-whatsapp-red');
  });

  test.describe('conversations', () => {
    test('a customer message opens a ticket; a reply that cannot be sent says why', async ({
      page,
    }) => {
      const name = `Farah Idris ${stamp()}`;
      const text = `How long does standard delivery take? (${stamp()})`;
      expect(await webhook(textMessage(newPhone(), name, text))).toBe(200);
      const ticket = await ticketFor(text);
      expect(ticket.subject).toBe(`WhatsApp: ${text}`);

      await signInOrbit(page);
      await page.getByLabel('Channel').selectOption({ label: 'WhatsApp' });
      const drawer = await openTicket(page, ticket.reference);
      await expect(drawer.locator('li[data-kind="customer"]', { hasText: text })).toBeVisible();
      await expect(drawer.getByText(/WhatsApp: free replies for another 23h/)).toBeVisible();

      // The AI answered, but WhatsApp has no access token: the reply shows as not delivered.
      const failed = drawer.locator('li[data-ai]', { hasText: 'Not delivered' }).first();
      await expect(failed).toBeVisible({ timeout: 30_000 });
      await expect(failed.getByRole('note')).toContainText(
        'WhatsApp is not connected. Add the access token in Settings → Channels.',
      );
      await failed.scrollIntoViewIfNeeded();
      await shot(page, 'orbit-whatsapp-conversation');

      await drawer.getByLabel(`Reply to ${name}`).fill('We deliver in 3 to 5 working days.');
      await drawer.getByRole('button', { name: 'Send reply' }).click();
      await expect(drawer.getByRole('alert')).toContainText('WhatsApp is not connected');
    });

    test('after 24 hours the reply box offers templates only', async ({ page }) => {
      const name = `Kofi Mensah ${stamp()}`;
      const text = `Is my warranty claim approved? (${stamp()})`;
      const yesterday = new Date(Date.now() - 26 * 3_600_000);
      expect(await webhook(textMessage(newPhone(), name, text, yesterday))).toBe(200);
      const ticket = await ticketFor(text);

      await page.setViewportSize({ width: 390, height: 844 });
      await signInOrbit(page);
      const drawer = await openTicket(page, ticket.reference);
      const picker = drawer.getByRole('group', { name: 'WhatsApp template' });
      await expect(picker).toContainText(/More than 24 hours since the customer.s last message/);
      await expect(picker).toContainText('No approved templates yet');
      await expect(picker.getByRole('button', { name: 'Send template' })).toBeDisabled();
      await expect(drawer.getByLabel(`Reply to ${name}`)).toHaveCount(0);
      await shot(page, 'orbit-whatsapp-template-phone');

      // Notes are still possible, and nothing spills sideways on a phone.
      await drawer.getByRole('tab', { name: 'Internal note' }).click();
      await expect(drawer.getByLabel('Internal note', { exact: true })).toBeVisible();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    });
  });
});
