import { call, login } from './api';
import { env } from './env';
import { expect, openTicket, signInOrbit, test } from './fixtures';

const stamp = () => Date.now().toString(36);

/** Calls the integration API with an app's key. */
async function app<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${env.api}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

test.describe('tickets an integration raises', () => {
  test('an agent sees what the app sent and answers; the app reads the answer', async ({
    page,
  }) => {
    const admin = (await login()).accessToken;
    const name = `Ethnic Threads ${stamp()}`;
    const integration = await call<{ id: string }>(admin, 'POST', '/integrations', {
      slug: `shop-${stamp()}`,
      name,
    });
    const { key } = await call<{ key: string }>(
      admin,
      'POST',
      `/integrations/${integration.id}/keys`,
      { name: 'Backend', scopes: ['integration:ticket'] },
    );

    // The app raises a ticket about one of its listings. People only, so the test owns the thread.
    const ticket = await app<{ reference: string }>(key, 'POST', '/integration/tickets', {
      customer: { externalId: `shopper-${stamp()}`, name: 'Asha Verma' },
      subject: 'The price on this listing looks wrong',
      body: 'The site shows 1,499 but the store charges 1,799.',
      externalRef: 'MYN-48213',
      metadata: { title: 'Cotton straight kurta', source: 'Myntra', price_current: 1499 },
      ai: 'off',
    });

    await signInOrbit(page);
    const drawer = await openTicket(page, ticket.reference);
    const context = drawer.getByRole('region', { name: 'Context from the app' });
    await expect(context).toContainText(`Context from ${name}`);
    await expect(context).toContainText('MYN-48213');
    await expect(context).toContainText('Cotton straight kurta');
    await expect(context).toContainText('Price current');
    await expect(context).toContainText('1499');
    await expect(drawer).toContainText('The site shows 1,499 but the store charges 1,799.');

    // The agent's answer is what the app reads back.
    const reply = `Thanks, we have corrected the price. (${stamp()})`;
    await drawer.getByLabel(/^Reply/).fill(reply);
    await drawer.getByRole('button', { name: 'Send reply' }).click();
    await expect(drawer.getByRole('region', { name: 'Conversation' })).toContainText(reply);

    await expect
      .poll(async () =>
        (
          await app<Array<{ from: string; body: string }>>(
            key,
            'GET',
            `/integration/tickets/${ticket.reference}/messages`,
          )
        ).map((m) => `${m.from}: ${m.body}`),
      )
      .toEqual([
        'customer: The site shows 1,499 but the store charges 1,799.',
        `support: ${reply}`,
      ]);
  });
});
