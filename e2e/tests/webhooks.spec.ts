import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { call, login } from './api';
import { env } from './env';
import { expect, signInOrbit, test } from './fixtures';

const stamp = () => Date.now().toString(36);

interface Received {
  headers: IncomingHttpHeaders;
  raw: string;
  body: { id: string; type: string; data: { ticket?: { reference: string } } };
}

/** Checks a delivery the way a receiver should: HMAC-SHA256 over "<t>.<raw body>". */
function signedWith(secret: string, r: Received): boolean {
  const header = String(r.headers['x-tms-signature']);
  const t = /t=(\d+)/.exec(header)?.[1];
  const v1 = /v1=([0-9a-f]+)/.exec(header)?.[1];
  return !!t && v1 === createHmac('sha256', secret).update(`${t}.${r.raw}`).digest('hex');
}

test.describe('webhooks', () => {
  // The app's own server, played by this test: it records what arrives and answers `status`.
  let receiver: Server;
  let status = 200;
  const received: Received[] = [];

  test.beforeAll(async () => {
    receiver = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        received.push({ headers: req.headers, raw, body: JSON.parse(raw) });
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, '0.0.0.0', resolve));
  });

  test.afterAll(async () => {
    await new Promise((resolve) => receiver.close(resolve));
  });

  test('an admin adds a webhook, tests it, and sees a failed delivery get through', async ({
    page,
  }) => {
    // Retries wait a few seconds between attempts.
    test.setTimeout(120_000);
    const admin = (await login()).accessToken;
    const name = `Acme Store ${stamp()}`;
    const integration = await call<{ id: string }>(admin, 'POST', '/integrations', {
      slug: `hooks-${stamp()}`,
      name,
    });
    const { key } = await call<{ key: string }>(
      admin,
      'POST',
      `/integrations/${integration.id}/keys`,
      { name: 'Backend', scopes: ['integration:ticket'] },
    );
    const address = `http://${env.hostFromStack}:${(receiver.address() as AddressInfo).port}/support/webhook`;

    await signInOrbit(page);
    await page.goto(`${env.orbit}/#/settings/integrations`);
    await page
      .getByRole('row', { name: new RegExp(name) })
      .getByRole('button', { name: 'Keys and webhooks' })
      .click();
    const card = page.getByRole('region', { name: `Webhooks of ${name}` });
    await expect(card).toContainText('No webhooks yet.');

    // Add it: the signing secret is shown once.
    await card.getByRole('button', { name: 'Add webhook' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Address').fill(address);
    await dialog.getByLabel(/A ticket was created/).check();
    await dialog.getByRole('button', { name: 'Add webhook' }).click();
    const shown = card.getByTestId('new-webhook-secret');
    await expect(shown).toHaveText(/^whsec_[A-Za-z0-9_-]{43}$/);
    const secret = (await shown.textContent())!;
    await card.getByRole('button', { name: 'Done' }).click();
    await expect(card).not.toContainText(secret);
    await expect(card).toContainText(`secret ••••${secret.slice(-4)}`);

    // A test goes out signed, and the admin is told how it went.
    await card.getByRole('button', { name: 'Send a test' }).click();
    await expect(card.getByRole('status')).toContainText('The test was delivered');
    expect(received.at(-1)!.body.type).toBe('ping');
    expect(signedWith(secret, received.at(-1)!)).toBe(true);

    // The app's server goes down; a ticket is raised meanwhile.
    status = 500;
    const ticket = await call<{ reference: string }>(key, 'POST', '/integration/tickets', {
      customer: { externalId: `shopper-${stamp()}` },
      subject: 'Broken buy link',
      body: 'The buy button opens a missing page.',
      ai: 'off',
    });
    await card.getByRole('button', { name: 'Deliveries' }).click();
    const log = card.getByRole('region', { name: 'Deliveries' });
    const row = log.getByRole('row', { name: /ticket\.created/ }).first();
    await expect(async () => {
      await log.getByRole('button', { name: 'Refresh' }).click();
      await expect(row).toContainText(/Trying again|Failed after/, { timeout: 1000 });
    }).toPass({ timeout: 20_000 });
    await expect(row).toContainText('HTTP 500');

    // It comes back; the delivery gets through on a later attempt, or is sent again by hand.
    status = 200;
    await expect(async () => {
      await log.getByRole('button', { name: 'Refresh' }).click();
      const again = log.getByRole('button', { name: 'Send again' }).first();
      if (await row.getByText(/Failed after/).isVisible()) await again.click();
      // The newest ticket.created row, not the test delivery above it, which was delivered long ago.
      await expect(row).toContainText('Delivered', { timeout: 1000 });
    }).toPass({ timeout: 90_000 });
    const delivered = received.filter(
      (r) => r.body.type === 'ticket.created' && r.body.data.ticket?.reference === ticket.reference,
    );
    expect(delivered.length).toBeGreaterThan(1);
    expect(delivered.every((r) => signedWith(secret, r))).toBe(true);
  });
});
