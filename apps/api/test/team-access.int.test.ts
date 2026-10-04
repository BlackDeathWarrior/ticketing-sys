import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTeam, makeUser, startApp, type TestClient, uniq } from './helpers';

/**
 * Teams own their tickets (ADR 0031), on the real routes: the rule itself is
 * unit-tested in packages/shared (`canActOnTeam`); this checks that the routes
 * that change a ticket ask it, and that reading and notes stay open.
 */
let t: TestClient;
let admin: string;
let orders: string;
let payments: string;
let ordersAgent: Awaited<ReturnType<typeof makeUser>>;
let paymentsAgent: Awaited<ReturnType<typeof makeUser>>;

async function ticketOf(teamId?: string) {
  const customer = await t.call('POST', '/customers', {
    token: admin,
    body: { displayName: 'Tara Team', email: `${uniq('tara')}@example.com` },
  });
  const made = await t.call('POST', '/tickets', {
    token: admin,
    body: { customerId: customer.body.id, subject: `Whose ticket ${uniq()}` },
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  if (teamId) {
    const given = await t.call('POST', `/tickets/${made.body.id}/assign`, {
      token: admin,
      body: { teamId },
    });
    expect(given.status, JSON.stringify(given.body)).toBe(201);
  }
  return made.body.id as string;
}
const start = (id: string, token: string) =>
  t.call('POST', `/tickets/${id}/transition`, { token, body: { status: 'in_progress' } });

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  orders = await makeTeam(t, admin, uniq('Orders'));
  payments = await makeTeam(t, admin, uniq('Payments'));
  ordersAgent = await makeUser(t, admin, 'agent', { name: 'Ola Orders', teamIds: [orders] });
  paymentsAgent = await makeUser(t, admin, 'agent', { name: 'Pat Payments', teamIds: [payments] });
}, 60_000);

afterAll(async () => {
  await t?.close();
});

describe('a ticket that belongs to a team', () => {
  it('is acted on by its team, and only read and noted by everyone else', async () => {
    const id = await ticketOf(payments);

    const refused = await start(id, ordersAgent.token);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'other_team', team: { id: payments } });
    const edit = await t.call('PATCH', `/tickets/${id}`, {
      token: ordersAgent.token,
      body: { priority: 'urgent' },
    });
    expect(edit.status).toBe(403);

    // Reading and internal notes stay open: a colleague can still help.
    expect((await t.call('GET', `/tickets/${id}`, { token: ordersAgent.token })).status).toBe(200);
    const note = await t.call('POST', `/tickets/${id}/notes`, {
      token: ordersAgent.token,
      body: { body: 'The customer also wrote to Orders about this.' },
    });
    expect(note.status).toBe(201);

    expect((await start(id, paymentsAgent.token)).status).toBe(201);
  });

  it('is open to a super admin whatever the team', async () => {
    const id = await ticketOf(orders);
    expect((await start(id, admin)).status).toBe(201);
  });
});

describe('a ticket with no team yet', () => {
  it('can be worked by anyone', async () => {
    const id = await ticketOf();
    expect((await start(id, ordersAgent.token)).status).toBe(201);
  });
});
