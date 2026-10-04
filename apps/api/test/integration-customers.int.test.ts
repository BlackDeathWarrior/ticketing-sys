import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestClient, uniq } from './helpers';

/**
 * A customer's phone number between an app and the desk, without a WhatsApp
 * code: the app tells the desk a number it linked, and asks which number the
 * desk holds for an email address. Codes are tested in whatsapp.int.test.ts.
 */
let t: TestClient;
let admin: string;
let slug: string;
let key: string;
let ticketsOnly: string;

const phoneOf = () => `9198${String(Date.now()).slice(-7)}${Math.floor(Math.random() * 9)}`;
const link = (body: unknown, token = key) =>
  t.call('POST', '/integration/customers/phones', { token, body });
const lookup = (email: string, token = key) =>
  t.call('POST', '/integration/customers/phone-lookup', { token, body: { email } });

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  const app = await t.call('POST', '/integrations', {
    token: admin,
    body: { slug: uniq('link-app-'), name: 'Linking app' },
  });
  slug = app.body.slug;
  const make = async (scopes: string[]) =>
    (
      await t.call('POST', `/integrations/${app.body.id}/keys`, {
        token: admin,
        body: { name: scopes.join(' '), scopes },
      })
    ).body.key as string;
  key = await make(['integration:customer']);
  ticketsOnly = await make(['integration:ticket']);
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('linking a phone number an app has taken from its customer', () => {
  it('needs the customer scope, on both routes', async () => {
    const who = { externalId: uniq('user-'), email: `${uniq('lia')}@example.com` };
    expect((await link({ customer: who, phone: phoneOf() }, ticketsOnly)).status).toBe(403);
    expect((await lookup(who.email, ticketsOnly)).status).toBe(403);
    // A staff token is not an app's key.
    expect((await link({ customer: who, phone: phoneOf() }, admin)).status).toBe(401);
  });

  it('gives the customer the number and the email, and the lookup finds it by email', async () => {
    const who = {
      externalId: uniq('user-'),
      name: 'Lia Link',
      email: `${uniq('lia')}@example.com`,
    };
    const phone = phoneOf();
    expect((await lookup(who.email)).body).toEqual({ phone: null });

    const linked = await link({ customer: who, phone: `+${phone.slice(0, 2)} ${phone.slice(2)}` });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    // Stored as digits, however it was typed.
    expect(linked.body).toEqual({ linked: true, phone });
    expect((await lookup(who.email.toUpperCase())).body).toEqual({ phone });

    const found = (await t.call('GET', '/customers', { token: admin, query: { q: who.email } }))
      .body.items as Array<{ id: string }>;
    const customer = (await t.call('GET', `/customers/${found[0]!.id}`, { token: admin })).body;
    expect(customer.identities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'phone', value: phone, verified: true }),
        expect.objectContaining({ type: 'email', value: who.email, verified: true }),
        expect.objectContaining({ type: 'external_id', value: `${slug}:${who.externalId}` }),
      ]),
    );
  });

  it('moves a number to the customer it was linked to last', async () => {
    const first = { externalId: uniq('user-'), email: `${uniq('first')}@example.com` };
    const second = { externalId: uniq('user-'), email: `${uniq('second')}@example.com` };
    const phone = phoneOf();
    await link({ customer: first, phone });
    await link({ customer: second, phone });
    expect((await lookup(second.email)).body).toEqual({ phone });
    expect((await lookup(first.email)).body).toEqual({ phone: null });
  });

  it('refuses a number that is not a full international one', async () => {
    const who = { externalId: uniq('user-') };
    expect((await link({ customer: who, phone: '12345' })).status).toBe(400);
  });
});
