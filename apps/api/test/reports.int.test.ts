import type { OverviewReport } from '@tms/shared';
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

async function userWithRole(role: string) {
  const email = `${uniq(role)}@test.local`;
  const password = 'Report-Passw0rd!';
  const res = await t.call('POST', '/users', {
    token: admin,
    body: { email, name: `Report ${role}`, password, roles: [role] },
  });
  expect(res.status).toBe(201);
  return { id: res.body.id as string, token: (await t.login(email, password)).accessToken };
}

async function overview(token = admin): Promise<OverviewReport> {
  const res = await t.call<OverviewReport>('GET', '/reports/overview', { token });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
}

const channelCount = (r: OverviewReport, channel: string) =>
  r.byChannel.find((c) => c.channel === channel)?.count ?? 0;
const priorityCount = (r: OverviewReport, priority: string) =>
  r.byPriority.find((p) => p.priority === priority)?.count ?? 0;
const statusCount = (r: OverviewReport, status: string) =>
  r.byStatus.find((s) => s.status === status)?.count ?? 0;

describe('GET /reports/overview', () => {
  it('requires report:read', async () => {
    expect((await t.call('GET', '/reports/overview')).status).toBe(401);
    const agent = await userWithRole('agent');
    expect((await t.call('GET', '/reports/overview', { token: agent.token })).status).toBe(403);
    const lead = await userWithRole('team_lead');
    await overview(lead.token);
  });

  it('reflects ticket creation, assignment and resolution', async () => {
    const before = await overview();
    expect(before.volume).toHaveLength(14);
    expect(before.volume.at(-1)!.date).toBe(new Date().toISOString().slice(0, 10));

    const customer = await t.call('POST', '/customers', {
      token: admin,
      body: { displayName: 'Report Customer', email: `${uniq('rep')}@example.com` },
    });
    const make = async (body: Record<string, unknown>) => {
      const res = await t.call('POST', '/tickets', {
        token: admin,
        body: { customerId: customer.body.id, subject: `Report ${uniq()}`, ...body },
      });
      expect(res.status).toBe(201);
      return res.body as { id: string; reference: string };
    };
    const a = await make({ priority: 'urgent', channel: 'webchat' });
    const b = await make({ priority: 'low', channel: 'email' });
    await make({ priority: 'urgent', channel: 'email' });

    const agent = await userWithRole('agent');
    expect(
      (
        await t.call('POST', `/tickets/${a.id}/assign`, {
          token: admin,
          body: { assigneeId: agent.id },
        })
      ).status,
    ).toBe(201);
    const resolved = await t.call('POST', `/tickets/${b.id}/transition`, {
      token: admin,
      body: { status: 'resolved', resolution: 'Answered' },
    });
    expect(resolved.status).toBe(201);

    const after = await overview();
    expect(after.open - before.open).toBe(2);
    expect(after.unassigned - before.unassigned).toBe(1);
    expect(after.resolvedToday - before.resolvedToday).toBe(1);
    expect(after.resolvedLast7Days - before.resolvedLast7Days).toBe(1);
    expect(priorityCount(after, 'urgent') - priorityCount(before, 'urgent')).toBe(2);
    expect(priorityCount(after, 'low') - priorityCount(before, 'low')).toBe(0);
    expect(channelCount(after, 'webchat') - channelCount(before, 'webchat')).toBe(1);
    expect(channelCount(after, 'email') - channelCount(before, 'email')).toBe(1);
    expect(statusCount(after, 'resolved') - statusCount(before, 'resolved')).toBe(1);
    expect(statusCount(after, 'human_assigned') - statusCount(before, 'human_assigned')).toBe(1);

    const todayBefore = before.volume.at(-1)!;
    const todayAfter = after.volume.at(-1)!;
    expect(todayAfter.created - todayBefore.created).toBe(3);
    expect(todayAfter.resolved - todayBefore.resolved).toBe(1);
    expect(after.medianResolutionMinutes).not.toBeNull();

    expect(after.byAssignee).toContainEqual({ id: agent.id, name: 'Report agent', open: 1 });

    const latest = after.activity[0]!;
    expect(latest.action).toBe('ticket.status_changed');
    expect(latest.ticket).toMatchObject({ id: b.id, reference: b.reference });
    expect(latest.actor.name).toBe('Administrator');
    expect(after.activity.length).toBeLessThanOrEqual(15);
  });

  it('includes customer details on ticket list rows', async () => {
    const res = await t.call('GET', '/tickets', { token: admin, query: { limit: '1' } });
    expect(res.status).toBe(200);
    expect(res.body.items[0].customer).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        displayName: expect.any(String),
        customerType: expect.any(String),
        attributes: expect.any(Object),
      }),
    );
  });
});
