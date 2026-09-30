import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startApp, type TestClient, uniq } from './helpers';

let t: TestClient;
let admin: string;

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
});

afterAll(async () => {
  await t?.close();
});

async function createAgent(roles = ['agent']) {
  const email = `${uniq('agent')}@test.local`;
  const password = 'Agent-Passw0rd!';
  const res = await t.call('POST', '/users', {
    token: admin,
    body: { email, name: 'Test Agent', password, roles },
  });
  expect(res.status).toBe(201);
  const tokens = await t.login(email, password);
  return { id: res.body.id as string, email, password, token: tokens.accessToken, tokens };
}

async function createCustomer(token = admin) {
  const res = await t.call('POST', '/customers', {
    token,
    body: { displayName: 'Arjun Mehta', email: `${uniq('c')}@example.com` },
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; identities: Array<{ type: string; value: string }> };
}

async function createTicket(customerId: string, extra: Record<string, unknown> = {}) {
  const res = await t.call('POST', '/tickets', {
    token: admin,
    body: { customerId, subject: 'Order not delivered', ...extra },
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; number: number; reference: string; status: string };
}

describe('health', () => {
  it('is ready when Postgres and Redis are up, reporting optional deps', async () => {
    const res = await t.call('GET', '/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.database.status).toBe('up');
    expect(res.body.checks.redis.status).toBe('up');
    expect(res.body.checks.litellm.status).toBe('down');
  });
});

describe('auth', () => {
  it('rejects requests without a token', async () => {
    expect((await t.call('GET', '/tickets')).status).toBe(401);
  });

  it('rejects a wrong password and audits the attempt', async () => {
    const res = await t.call('POST', '/auth/login', {
      body: { email: 'admin@test.local', password: 'wrong-password' },
    });
    expect(res.status).toBe(401);
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'auth.login_failed' },
    });
    expect(audit.body.length).toBeGreaterThan(0);
  });

  it('returns the current user with permissions', async () => {
    const res = await t.call('GET', '/auth/me', { token: admin });
    expect(res.status).toBe(200);
    expect(res.body.roles).toContain('admin');
    expect(res.body.permissions).toContain('settings:llm');
  });

  it('rotates refresh tokens and revokes everything on reuse', async () => {
    const agent = await createAgent();
    const first = agent.tokens.refreshToken;
    const r1 = await t.call('POST', '/auth/refresh', { body: { refreshToken: first } });
    expect(r1.status).toBe(200);
    const second = r1.body.refreshToken as string;
    expect(second).not.toBe(first);

    // Replaying the rotated token is treated as theft...
    expect((await t.call('POST', '/auth/refresh', { body: { refreshToken: first } })).status).toBe(
      401,
    );
    // ...so the newer token is revoked too.
    expect((await t.call('POST', '/auth/refresh', { body: { refreshToken: second } })).status).toBe(
      401,
    );
  });

  it('blocks deactivated users', async () => {
    const agent = await createAgent();
    const res = await t.call('PATCH', `/users/${agent.id}`, {
      token: admin,
      body: { isActive: false },
    });
    expect(res.status).toBe(200);
    const login = await t.call('POST', '/auth/login', {
      body: { email: agent.email, password: agent.password },
    });
    expect(login.status).toBe(401);
  });
});

describe('RBAC', () => {
  it('lets agents work tickets but not manage users or assign', async () => {
    const agent = await createAgent();
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);

    expect((await t.call('GET', '/tickets', { token: agent.token })).status).toBe(200);
    const users = await t.call('POST', '/users', {
      token: agent.token,
      body: { email: `${uniq()}@x.io`, name: 'x', password: 'Xyzxyzxyz1!' },
    });
    expect(users.status).toBe(403);
    const assign = await t.call('POST', `/tickets/${ticket.id}/assign`, {
      token: agent.token,
      body: { assigneeId: agent.id },
    });
    expect(assign.status).toBe(403);
    expect((await t.call('GET', '/audit', { token: agent.token })).status).toBe(403);
  });

  it('lets team leads assign', async () => {
    const lead = await createAgent(['team_lead']);
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);
    const res = await t.call('POST', `/tickets/${ticket.id}/assign`, {
      token: lead.token,
      body: { assigneeId: lead.id },
    });
    expect(res.status).toBe(201);
  });
});

describe('customers', () => {
  it('resolves an existing identity instead of creating a duplicate', async () => {
    const c = await createCustomer();
    const email = c.identities.find((i) => i.type === 'email')!.value;
    const res = await t.call('POST', '/customers/resolve', {
      token: admin,
      body: { type: 'email', value: email.toUpperCase() },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(false);
    expect(res.body.customer.id).toBe(c.id);
  });

  it('creates a customer for an unknown WhatsApp number', async () => {
    const number = `+91 98${Math.floor(Math.random() * 1e8)
      .toString()
      .padStart(8, '0')}`;
    const res = await t.call('POST', '/customers/resolve', {
      token: admin,
      body: { type: 'whatsapp', value: number, displayName: 'Rahul' },
    });
    expect(res.body.created).toBe(true);
    const again = await t.call('POST', '/customers/resolve', {
      token: admin,
      body: { type: 'whatsapp', value: number.replace(/\s/g, '') },
    });
    expect(again.body.created).toBe(false);
    expect(again.body.customer.id).toBe(res.body.customer.id);
  });

  it('refuses to attach an identity owned by someone else', async () => {
    const a = await createCustomer();
    const b = await createCustomer();
    const email = a.identities.find((i) => i.type === 'email')!.value;
    const res = await t.call('POST', `/customers/${b.id}/identities`, {
      token: admin,
      body: { type: 'email', value: email },
    });
    expect(res.status).toBe(409);
    expect(res.body.customerId).toBe(a.id);
  });

  it('merges customers, moving identities and tickets', async () => {
    const source = await createCustomer();
    const target = await createCustomer();
    const ticket = await createTicket(source.id);
    const res = await t.call('POST', '/customers/merge', {
      token: admin,
      body: { sourceId: source.id, targetId: target.id },
    });
    expect(res.status).toBe(201);
    expect(res.body.identities).toHaveLength(2);
    const moved = await t.call('GET', `/tickets/${ticket.id}`, { token: admin });
    expect(moved.body.customerId).toBe(target.id);
    // The old id keeps resolving to the surviving record.
    const old = await t.call('GET', `/customers/${source.id}`, { token: admin });
    expect(old.body.id).toBe(target.id);
  });
});

describe('tickets', () => {
  it('creates tickets in the initial status with a TMS reference', async () => {
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id, { priority: 'high', tags: ['vip', 'vip'] });
    expect(ticket.status).toBe('new');
    expect(ticket.reference).toBe(`TMS-${ticket.number}`);
    const byRef = await t.call('GET', `/tickets/${ticket.reference}`, { token: admin });
    expect(byRef.body.id).toBe(ticket.id);
    expect(byRef.body.tags).toEqual(['vip']);
  });

  it('validates input', async () => {
    const res = await t.call('POST', '/tickets', { token: admin, body: { subject: '' } });
    expect(res.status).toBe(400);
    expect(res.body.issues.map((i: { path: string }) => i.path)).toEqual(
      expect.arrayContaining(['customerId', 'subject']),
    );
  });

  it('enforces the workflow', async () => {
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);
    const close = await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'closed' },
    });
    expect(close.status).toBe(201);
    expect(close.body.closedAt).not.toBeNull();

    const reopen = await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'in_progress' },
    });
    expect(reopen.status).toBe(409);
    expect(reopen.body.reason).toBe('not_allowed');
  });

  it('stamps and clears resolution timestamps', async () => {
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);
    const resolved = await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'resolved', resolution: 'Shared tracking link' },
    });
    expect(resolved.body.resolvedAt).not.toBeNull();
    expect(resolved.body.resolution).toBe('Shared tracking link');
    const reopened = await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'in_progress' },
    });
    expect(reopened.body.resolvedAt).toBeNull();
  });

  it('moves a new ticket to Human Assigned when a person is assigned, with history and events', async () => {
    const agent = await createAgent();
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);

    const res = await t.call('POST', `/tickets/${ticket.id}/assign`, {
      token: admin,
      body: { assigneeId: agent.id },
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('human_assigned');
    expect(res.body.assignee).toEqual({ id: agent.id, name: 'Test Agent' });

    const history = await t.call('GET', `/tickets/${ticket.id}/history`, { token: admin });
    expect(history.body.map((h: { action: string }) => h.action)).toEqual([
      'ticket.created',
      'ticket.assigned',
      'ticket.status_changed',
    ]);

    const { createDb, outboxEvents } = await import('@tms/db');
    const { eq } = await import('drizzle-orm');
    const h = createDb(process.env.DATABASE_URL!, { max: 1 });
    const events = await h.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, ticket.id));
    await h.close();
    expect(events.map((e) => e.type)).toEqual([
      'ticket.created',
      'ticket.assigned',
      'ticket.status_changed',
    ]);
  });

  it('records field-level changes and notes', async () => {
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);
    const upd = await t.call('PATCH', `/tickets/${ticket.id}`, {
      token: admin,
      body: { priority: 'urgent', subject: 'Order not delivered (urgent)' },
    });
    expect(upd.status).toBe(200);
    expect(upd.body.priority).toBe('urgent');

    const note = await t.call('POST', `/tickets/${ticket.id}/notes`, {
      token: admin,
      body: { body: 'Called courier; parcel stuck at hub.' },
    });
    expect(note.status).toBe(201);
    const notes = await t.call('GET', `/tickets/${ticket.id}/notes`, { token: admin });
    expect(notes.body[0].body).toContain('courier');

    const history = await t.call('GET', `/tickets/${ticket.id}/history`, { token: admin });
    const updated = history.body.find((h: { action: string }) => h.action === 'ticket.updated');
    expect(updated.data.changes.priority).toEqual({ from: 'normal', to: 'urgent' });
  });

  it('filters and searches', async () => {
    const customer = await createCustomer();
    const ticket = await createTicket(customer.id, { priority: 'low' });
    const byCustomer = await t.call('GET', '/tickets', {
      token: admin,
      query: { customerId: customer.id, priority: 'low' },
    });
    expect(byCustomer.body.total).toBe(1);
    const byRef = await t.call('GET', '/tickets', { token: admin, query: { q: ticket.reference } });
    expect(byRef.body.items.map((i: { id: string }) => i.id)).toContain(ticket.id);
    const unassigned = await t.call('GET', '/tickets', {
      token: admin,
      query: { assigneeId: 'none', status: 'new' },
    });
    expect(
      unassigned.body.items.every((i: { assigneeId: string | null }) => i.assigneeId === null),
    ).toBe(true);
  });

  it('returns 404 for unknown references', async () => {
    expect((await t.call('GET', '/tickets/TMS-99999999', { token: admin })).status).toBe(404);
    expect((await t.call('GET', '/tickets/not-a-ticket', { token: admin })).status).toBe(404);
  });
});

describe('workflow settings', () => {
  it('adds a status and wires it into the workflow', async () => {
    const add = await t.call('PUT', '/workflow/statuses', {
      token: admin,
      body: { key: 'on_hold', name: 'On Hold', category: 'pending', sortOrder: 55 },
    });
    expect(add.status).toBe(200);
    const wf = await t.call('GET', '/workflow', { token: admin });
    const transitions = wf.body.transitions.map((x: { fromStatus: string; toStatus: string }) => ({
      from: x.fromStatus,
      to: x.toStatus,
    }));
    const set = await t.call('PUT', '/workflow/transitions', {
      token: admin,
      body: { transitions: [...transitions, { from: 'in_progress', to: 'on_hold' }] },
    });
    expect(set.status).toBe(200);

    const customer = await createCustomer();
    const ticket = await createTicket(customer.id);
    await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'in_progress' },
    });
    const hold = await t.call('POST', `/tickets/${ticket.id}/transition`, {
      token: admin,
      body: { status: 'on_hold' },
    });
    expect(hold.status).toBe(201);
    expect(hold.body.status).toBe('on_hold');
  });

  it('rejects transitions to unknown statuses', async () => {
    const res = await t.call('PUT', '/workflow/transitions', {
      token: admin,
      body: { transitions: [{ from: 'new', to: 'nowhere' }] },
    });
    expect(res.status).toBe(400);
  });
});

describe('audit trail', () => {
  it('is append-only at the database level', async () => {
    const { createDb } = await import('@tms/db');
    const h = createDb(process.env.DATABASE_URL!, { max: 1 });
    await expect(h.pool.query('UPDATE audit_log SET action = action')).rejects.toThrow(
      /append-only/,
    );
    await expect(h.pool.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
    await h.close();
  });
});
