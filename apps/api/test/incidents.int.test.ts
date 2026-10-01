import type {
  CreatedApiKey,
  IncidentView,
  IntegrationTicketList,
  IntegrationView,
  ReportEventResult,
} from '@tms/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeUser, startApp, type TestClient, uniq } from './helpers';

/**
 * Incidents an app reports about itself (ADR 0024): the first report opens a
 * ticket, repeats are counted on it, and a recovery resolves it.
 */
let t: TestClient;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;
let worker: Awaited<ReturnType<typeof connect>>;
let other: Awaited<ReturnType<typeof connect>>;

interface StaffTicket {
  id: string;
  reference: string;
  channel: string;
  status: string;
  priority: string;
  tags: string[];
  resolution: string | null;
  externalRef: string | null;
  metadata: Record<string, unknown>;
  integration: { name: string } | null;
  customer: { displayName: string };
  handling: string;
}

async function connect(name: string, scopes = ['integration:event', 'integration:ticket']) {
  const integration = await t.call<IntegrationView>('POST', '/integrations', {
    token: admin,
    body: { slug: uniq('app-'), name },
  });
  const key = await t.call<CreatedApiKey>('POST', `/integrations/${integration.body.id}/keys`, {
    token: admin,
    body: { name: 'Worker', scopes, rateLimitPerMinute: 6000 },
  });
  expect(key.status).toBe(201);
  return { ...integration.body, key: key.body.key };
}

const fingerprint = (what = 'scraper.source_failed') => `${what}:${uniq()}`;

/** Reports an event the way the app's worker would. */
async function report(body: Record<string, unknown>, key = worker.key) {
  const res = await t.call<ReportEventResult & { message?: string }>(
    'POST',
    '/integration/events',
    {
      token: key,
      body,
    },
  );
  return res;
}
const firing = (fp: string, extra: Record<string, unknown> = {}, key = worker.key) =>
  report(
    {
      fingerprint: fp,
      title: 'Myntra scrape failed',
      severity: 'error',
      source: 'scraper/myntra',
      message: 'Fatal error during scrape: page timed out after 150s',
      ...extra,
    },
    key,
  );
const recovered = (fp: string, extra: Record<string, unknown> = {}, key = worker.key) =>
  report({ fingerprint: fp, status: 'resolved', ...extra }, key);

const staffTicket = async (reference: string) =>
  (await t.call<StaffTicket>('GET', `/tickets/${reference}`, { token: admin })).body;
const notes = async (ticketId: string) =>
  (
    await t.call<Array<{ body: string; authorType: string }>>('GET', `/tickets/${ticketId}/notes`, {
      token: admin,
    })
  ).body;
const ticketsFor = async (fp: string, key = worker.key) =>
  (
    await t.call<IntegrationTicketList>('GET', '/integration/tickets', {
      token: key,
      query: { externalRef: fp },
    })
  ).body;
const transition = (ticketId: string, status: string) =>
  t.call('POST', `/tickets/${ticketId}/transition`, { token: admin, body: { status } });

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent');
  worker = await connect('Ethnic Threads');
  other = await connect('Another app');
});

afterAll(async () => {
  await t?.close();
});

describe('reporting a problem', () => {
  it('opens an incident with a ticket for people, not for the AI', async () => {
    const fp = fingerprint();
    const res = await firing(fp, { details: { exit_code: 1, run: 'manual-scrape-0412' } });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body.action).toBe('opened');
    expect(res.body.incident).toMatchObject({
      fingerprint: fp,
      status: 'open',
      severity: 'error',
      title: 'Myntra scrape failed',
      source: 'scraper/myntra',
      occurrences: 1,
      resolvedAt: null,
      ticket: expect.stringMatching(/^TMS-\d+$/),
    });

    const ticket = await staffTicket(res.body.incident!.ticket!);
    expect(ticket).toMatchObject({
      channel: 'api',
      status: 'new',
      priority: 'high',
      tags: ['incident'],
      externalRef: fp,
      handling: 'none',
      integration: { name: 'Ethnic Threads' },
      customer: { displayName: 'Ethnic Threads (automatic reports)' },
      metadata: {
        kind: 'incident',
        severity: 'error',
        source: 'scraper/myntra',
        exit_code: 1,
        run: 'manual-scrape-0412',
      },
    });
    const conversations = await t.call('GET', `/tickets/${ticket.id}/conversations`, {
      token: admin,
    });
    expect(conversations.body).toHaveLength(1);
    expect(conversations.body[0]).toMatchObject({ channel: 'api', controller: 'none' });
    expect(conversations.body[0].messages[0].body).toBe(
      [
        'Fatal error during scrape: page timed out after 150s',
        '',
        'Severity: error',
        'Source: scraper/myntra',
        `Fingerprint: ${fp}`,
      ].join('\n'),
    );
  });

  it('counts repeats on the one ticket and notes them now and then', async () => {
    const fp = fingerprint();
    const first = await firing(fp);
    for (let i = 2; i <= 10; i++) {
      const res = await firing(fp, { message: `Attempt ${i} failed` });
      expect(res.body.action).toBe('updated');
      expect(res.body.incident).toMatchObject({
        occurrences: i,
        ticket: first.body.incident!.ticket,
      });
    }
    expect((await ticketsFor(fp)).total).toBe(1);

    const ticket = await staffTicket(first.body.incident!.ticket!);
    const seen = await notes(ticket.id);
    expect(seen.map((n) => n.body.split('\n')[0]!.replace(/ since .*$/, ''))).toEqual([
      'Reported again: 2 times',
      'Reported again: 10 times',
    ]);
    expect(seen[1]!.body).toContain('Latest report: Attempt 10 failed');
    expect(seen.every((n) => n.authorType === 'system')).toBe(true);

    // Counting is not audited; opening and the noted moments are.
    const audit = await t.call<Array<{ action: string; actorType: string }>>('GET', '/audit', {
      token: admin,
      query: { targetType: 'incident', targetId: first.body.incident!.id, limit: '50' },
    });
    expect(audit.body.map((a) => a.action).sort()).toEqual([
      'incident.opened',
      'incident.updated',
      'incident.updated',
    ]);
    expect(audit.body.every((a) => a.actorType === 'integration')).toBe(true);
  });

  it('opens one incident when many reports arrive at once', async () => {
    const fp = fingerprint('scraper.s3_sync_failed');
    const results = await Promise.all(Array.from({ length: 8 }, () => firing(fp)));
    expect(results.every((r) => r.status === 202)).toBe(true);
    expect(results.filter((r) => r.body.action === 'opened')).toHaveLength(1);
    expect((await ticketsFor(fp)).total).toBe(1);
    const incidents = await t.call<IncidentView[]>('GET', '/integration/incidents', {
      token: worker.key,
      query: { status: 'open', limit: '100' },
    });
    expect(incidents.body.filter((i) => i.fingerprint === fp)).toEqual([
      expect.objectContaining({ occurrences: 8 }),
    ]);
  });

  it('raises the priority when it gets worse, and never lowers it', async () => {
    const fp = fingerprint('catalog.stale');
    const first = await firing(fp, { severity: 'warning', title: 'Catalogue is 3 days old' });
    const reference = first.body.incident!.ticket!;
    expect((await staffTicket(reference)).priority).toBe('normal');

    const worse = await firing(fp, { severity: 'critical', message: 'Now 30 days old' });
    expect(worse.body.incident).toMatchObject({ severity: 'critical', occurrences: 2 });
    const ticket = await staffTicket(reference);
    expect(ticket.priority).toBe('urgent');
    expect((await notes(ticket.id)).at(-1)!.body).toContain(
      'Severity is now critical (was warning).',
    );

    const milder = await firing(fp, { severity: 'info' });
    expect(milder.body.incident!.severity).toBe('critical');
    expect((await staffTicket(reference)).priority).toBe('urgent');
  });

  it('says what is wrong with a bad report', async () => {
    const untitled = await report({ fingerprint: fingerprint() });
    expect(untitled.status).toBe(400);
    expect(JSON.stringify(untitled.body)).toContain('A firing event needs a title');
    const spaced = await report({ fingerprint: 'has spaces', title: 'x' });
    expect(spaced.status).toBe(400);
    const severity = await report({ fingerprint: fingerprint(), title: 'x', severity: 'fatal' });
    expect(severity.status).toBe(400);
  });
});

describe('recovering', () => {
  it('resolves the ticket nobody had picked up', async () => {
    const fp = fingerprint();
    const first = await firing(fp);
    await firing(fp);
    const res = await recovered(fp, { message: 'Scrape finished with 412 products.' });
    expect(res.status).toBe(202);
    expect(res.body.action).toBe('resolved');
    expect(res.body.incident).toMatchObject({ status: 'resolved', occurrences: 2 });
    expect(res.body.incident!.resolvedAt).not.toBeNull();

    const ticket = await staffTicket(first.body.incident!.ticket!);
    expect(ticket.status).toBe('resolved');
    expect(ticket.resolution).toBe('Ethnic Threads reported that this has recovered (2 reports).');
    expect((await notes(ticket.id)).at(-1)!.body).toBe(
      'Ethnic Threads reported that this has recovered (2 reports).\nScrape finished with 412 products.',
    );

    // A recovery for something that is not open changes nothing.
    const again = await recovered(fp);
    expect(again.body).toEqual({ action: 'ignored', incident: null });
    expect((await recovered(fingerprint())).body.action).toBe('ignored');
  });

  it('leaves the ticket to the person who took it', async () => {
    const fp = fingerprint();
    const first = await firing(fp);
    const ticket = await staffTicket(first.body.incident!.ticket!);
    await t.call('POST', `/tickets/${ticket.id}/assign`, {
      token: admin,
      body: { assigneeId: agent.id },
    });

    const res = await recovered(fp);
    expect(res.body.incident!.status).toBe('resolved');
    const after = await staffTicket(ticket.reference);
    expect(after.status).not.toBe('resolved');
    expect((await notes(ticket.id)).at(-1)!.body).toBe(
      'Ethnic Threads reported that this has recovered (1 report).',
    );
  });

  it('returns to the same ticket when the problem comes back before it is closed', async () => {
    const fp = fingerprint();
    const first = await firing(fp, { severity: 'warning' });
    const reference = first.body.incident!.ticket!;
    await recovered(fp);
    expect((await staffTicket(reference)).status).toBe('resolved');

    const back = await firing(fp, { severity: 'critical', message: 'Failing again' });
    expect(back.body.action).toBe('opened');
    expect(back.body.incident).toMatchObject({ occurrences: 1, ticket: reference });
    expect(back.body.incident!.id).not.toBe(first.body.incident!.id);
    const ticket = await staffTicket(reference);
    expect(ticket.status).toBe('in_progress');
    expect(ticket.priority).toBe('urgent');
    expect((await ticketsFor(fp)).total).toBe(1);

    // Agents see both episodes on the ticket, newest first.
    const history = await t.call<IncidentView[]>('GET', `/tickets/${ticket.id}/incidents`, {
      token: agent.token,
    });
    expect(history.body.map((i) => [i.status, i.severity])).toEqual([
      ['open', 'critical'],
      ['resolved', 'warning'],
    ]);
  });

  it('opens a new ticket when the old one was closed by hand', async () => {
    const fp = fingerprint();
    const first = await firing(fp);
    const old = await staffTicket(first.body.incident!.ticket!);
    await transition(old.id, 'closed');

    const back = await firing(fp);
    expect(back.body.action).toBe('opened');
    expect(back.body.incident!.ticket).not.toBe(old.reference);
    expect((await staffTicket(old.reference)).status).toBe('closed');
    expect((await ticketsFor(fp)).total).toBe(2);
    const mine = await t.call<IncidentView[]>('GET', '/integration/incidents', {
      token: worker.key,
      query: { limit: '100' },
    });
    expect(mine.body.filter((i) => i.fingerprint === fp).map((i) => [i.status, i.ticket])).toEqual([
      ['open', back.body.incident!.ticket],
      ['resolved', old.reference],
    ]);
  });

  it('reopens a ticket someone solved by hand while the app still reports it', async () => {
    const fp = fingerprint();
    const first = await firing(fp);
    const ticket = await staffTicket(first.body.incident!.ticket!);
    await transition(ticket.id, 'resolved');

    const back = await firing(fp);
    expect(back.body.action).toBe('opened');
    expect(back.body.incident!.ticket).toBe(ticket.reference);
    expect((await staffTicket(ticket.reference)).status).toBe('in_progress');
  });
});

describe('what an integration cannot do', () => {
  it("keeps each integration's incidents apart", async () => {
    const fp = fingerprint();
    const mine = await firing(fp);
    const theirs = await firing(fp, {}, other.key);
    expect(theirs.body.action).toBe('opened');
    expect(theirs.body.incident!.ticket).not.toBe(mine.body.incident!.ticket);

    // Their recovery does not touch mine.
    await recovered(fp, {}, other.key);
    expect((await staffTicket(mine.body.incident!.ticket!)).status).toBe('new');
    const open = await t.call<IncidentView[]>('GET', '/integration/incidents', {
      token: other.key,
      query: { status: 'open' },
    });
    expect(open.body.some((i) => i.fingerprint === fp)).toBe(false);
  });

  it('needs the event scope, and an API key rather than a staff token', async () => {
    const storefront = await connect('Storefront only', ['integration:ticket']);
    const res = await firing(fingerprint(), {}, storefront.key);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('This API key lacks the scope: integration:event');
    expect((await t.call('GET', '/integration/incidents', { token: storefront.key })).status).toBe(
      403,
    );
    expect((await firing(fingerprint(), {}, admin)).status).toBe(401);
    // The agents' view of a ticket's incidents is not for keys.
    expect((await t.call('GET', '/tickets/TMS-1/incidents', { token: worker.key })).status).toBe(
      403,
    );
  });
});
