import { randomUUID } from 'node:crypto';
import { type Database, llmCalls, notifications, outboxEvents, portalLogins } from '@tms/db';
import type { QueueView, RetentionView } from '@tms/shared';
import { Queue, Worker } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import Redis from 'ioredis';
import { io, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiterService } from '../src/common/rate-limit';
import { DB } from '../src/infra/tokens';
import { makeUser, startApp, type TestClient, uniq, waitFor } from './helpers';
import { testRedisUrl } from './test-env';

// Every other test file runs with rate limits off; this one is about them.
process.env.RATE_LIMITS = 'on';

/**
 * Hardening (ADR 0021): sign-in lockout, rate limits on public routes,
 * security headers, data retention and the failed-jobs view.
 */
let t: TestClient;
let db: Database;
let admin: string;
let agent: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  // Listening, for the chat sockets.
  t = await startApp({ listen: true });
  db = t.app.get(DB);
  admin = await t.adminToken();
  agent = await makeUser(t, admin, 'agent');
});

afterAll(async () => {
  await t?.call('PUT', '/settings/retention', { token: admin, body: {} });
  await t?.close();
});

const login = (email: string, password: string) =>
  t.call('POST', '/auth/login', { body: { email, password } });

describe('sign-in lockout', () => {
  const password = 'Lockout-Passw0rd!';

  async function account() {
    const email = `${uniq('lock')}@test.local`;
    const res = await t.call('POST', '/users', {
      token: admin,
      body: { email, name: 'Lena Lockout', password, roles: ['agent'] },
    });
    expect(res.status).toBe(201);
    return email;
  }

  it('pauses an account after ten wrong passwords from one address', async () => {
    const email = await account();
    for (let i = 0; i < 10; i++) expect((await login(email, 'wrong')).status).toBe(401);
    const locked = await login(email, 'wrong');
    expect(locked.status).toBe(429);
    expect(locked.body.message).toBe('Too many failed sign-in attempts. Try again in 15 minutes.');
    const again = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'wrong' },
    });
    expect(again.headers['retry-after']).toBe('900');
    // The right password doesn't get through either while it is paused.
    expect((await login(email, password)).status).toBe(429);

    // Other accounts are not affected, and the attempt is on record.
    const other = await account();
    expect((await login(other, password)).status).toBe(200);
    const audit = await t.call('GET', '/audit', {
      token: admin,
      query: { action: 'auth.login_locked', limit: '5' },
    });
    expect(audit.body.some((a: { data: { email: string } }) => a.data.email === email)).toBe(true);
  });

  it('forgets earlier mistakes after a successful sign-in', async () => {
    const email = await account();
    for (let i = 0; i < 9; i++) expect((await login(email, 'wrong')).status).toBe(401);
    expect((await login(email, password)).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await login(email, 'wrong')).status).toBe(401);
    expect((await login(email, password)).status).toBe(200);
  });

  it('gives no hint whether an address has an account', async () => {
    const ghost = `${uniq('ghost')}@test.local`;
    const unknown = await login(ghost, 'wrong');
    const known = await login(await account(), 'wrong');
    expect(unknown.status).toBe(401);
    expect(unknown.body.message).toBe(known.body.message);
    for (let i = 0; i < 9; i++) await login(ghost, 'wrong');
    expect((await login(ghost, 'wrong')).status).toBe(429);
  });
});

describe('rate limits on public routes', () => {
  it('lets a person through and stops a flood, saying when to come back', async () => {
    // 60 a minute for the rating page.
    for (let i = 0; i < 60; i++) {
      expect((await t.call('GET', '/public/csat/not-a-token')).status).toBe(404);
    }
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/public/csat/not-a-token' });
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.json().message).toMatch(/^Too many requests\. Try again in \d+ seconds\.$/);
  });

  it('counts the real caller, whatever X-Forwarded-For claims', async () => {
    const rate = (remoteAddress: string, forwardedFor: string) =>
      t.app.inject({
        method: 'GET',
        url: '/api/v1/public/csat/not-a-token',
        remoteAddress,
        headers: { 'x-forwarded-for': forwardedFor },
      });
    // Straight from the internet: a new made-up address on every request changes nothing.
    for (let i = 0; i < 60; i++) {
      expect((await rate('203.0.113.50', `198.51.100.${i}`)).statusCode).toBe(404);
    }
    expect((await rate('203.0.113.50', '198.51.100.200')).statusCode).toBe(429);

    // Through our own proxy (a private address) each customer has their own count,
    // and what the customer wrote in front of the proxy's entry is ignored.
    for (let i = 0; i < 60; i++) {
      expect((await rate('172.18.0.9', `198.51.100.${i}, 203.0.113.60`)).statusCode).toBe(404);
    }
    expect((await rate('172.18.0.9', '198.51.100.201, 203.0.113.60')).statusCode).toBe(429);
    expect((await rate('172.18.0.9', '203.0.113.61')).statusCode).toBe(404);
  });

  it('limits the request form and portal sign-in, each on its own count', async () => {
    const form = () => t.call('POST', '/public/requests', { body: { submissionId: 'not-a-uuid' } });
    for (let i = 0; i < 20; i++) expect((await form()).status).toBe(400);
    expect((await form()).status).toBe(429);

    // A different route has its own allowance.
    const signIn = () => t.call('POST', '/public/portal/sign-in', { body: { email: 'nope' } });
    expect((await signIn()).status).toBe(400);
  });

  it('does not limit signed-in work', async () => {
    for (let i = 0; i < 40; i++) {
      expect((await t.call('GET', '/tickets?limit=1', { token: admin })).status).toBe(200);
    }
  });
});

describe('rate limits on API keys', () => {
  async function integrationWithKey(rateLimitPerMinute: number) {
    const integration = await t.call<{ id: string }>('POST', '/integrations', {
      token: admin,
      body: { slug: uniq('limit-'), name: 'Limited app' },
    });
    const key = await t.call<{ key: string }>('POST', `/integrations/${integration.body.id}/keys`, {
      token: admin,
      body: { name: 'Small allowance', scopes: ['integration:event'], rateLimitPerMinute },
    });
    expect(key.status).toBe(201);
    return key.body.key;
  }
  const whoAmI = (key: string, remoteAddress = '203.0.113.90') =>
    t.app.inject({
      method: 'GET',
      url: '/api/v1/integration',
      remoteAddress,
      headers: { authorization: `Bearer ${key}` },
    });

  it('stops a key at its own allowance, wherever its requests come from', async () => {
    const small = await integrationWithKey(5);
    const other = await integrationWithKey(5);
    for (let i = 0; i < 5; i++) {
      expect((await whoAmI(small, `203.0.113.${100 + i}`)).statusCode).toBe(200);
    }
    const res = await whoAmI(small, '203.0.113.120');
    expect(res.statusCode).toBe(429);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    // Another key has its own count.
    expect((await whoAmI(other)).statusCode).toBe(200);
  });

  it('slows down guessing at keys from one address', async () => {
    const guess = (i: number, remoteAddress: string) =>
      whoAmI(`tms_sk_${String(i).padStart(43, 'x')}`, remoteAddress);
    for (let i = 0; i < 20; i++) expect((await guess(i, '203.0.113.130')).statusCode).toBe(401);
    expect((await guess(99, '203.0.113.130')).statusCode).toBe(429);
    expect((await guess(99, '203.0.113.131')).statusCode).toBe(401);
  });
});

describe('rate limits on the public chat', () => {
  const sockets: Socket[] = [];
  afterAll(() => sockets.forEach((s) => s.disconnect()));

  /** Opens a chat as our proxy would pass it on: the visitor's address in X-Forwarded-For. */
  function open(address: string): Promise<{ chat: Socket; refused?: string }> {
    const chat = io(`${t.baseUrl}/chat`, {
      auth: {},
      transports: ['websocket'],
      forceNew: true,
      extraHeaders: { 'x-forwarded-for': address },
    });
    sockets.push(chat);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer from /chat')), 10_000);
      const done = (refused?: string) => {
        clearTimeout(timer);
        resolve({ chat, refused });
      };
      chat.once('session', () => done());
      chat.once('error', (e: { message: string }) => done(e.message));
    });
  }

  it('counts new chats per address, so reconnecting is no way around a limit', async () => {
    for (let i = 0; i < 60; i++) {
      const { chat, refused } = await open('203.0.113.80');
      expect(refused).toBeUndefined();
      chat.disconnect();
    }
    expect((await open('203.0.113.80')).refused).toMatch(/^Too many chats were opened/);
    // Someone else is not affected.
    expect((await open('203.0.113.81')).refused).toBeUndefined();
  });

  it('counts messages per address across all its chats', async () => {
    const limiter = t.app.get(RateLimiterService);
    // As if this address had already sent its 120 messages this minute, over many chats.
    for (let i = 0; i < 120; i++) await limiter.hit('chat-message', '203.0.113.82', 120, 60);
    const send = async (address: string) => {
      const { chat } = await open(address);
      return (await chat
        .timeout(10_000)
        .emitWithAck('message', { text: 'Hello there', clientMessageId: randomUUID() })) as {
        ok: boolean;
        error?: string;
      };
    };
    expect(await send('203.0.113.82')).toEqual({
      ok: false,
      error: 'You are sending messages too quickly',
    });
    expect((await send('203.0.113.83')).ok).toBe(true);
  });
});

describe('security headers', () => {
  it('are set on API responses', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/health/ready' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('retention', () => {
  const view = async (token = admin) =>
    t.call<RetentionView>('GET', '/settings/retention', { token });

  it('is for admins, with sensible defaults and limits', async () => {
    expect((await view(agent.token)).status).toBe(403);
    const res = await view();
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      llmCallsDays: 90,
      notificationsDays: 90,
      eventsDays: 30,
      signInLinksDays: 7,
      webhookDeliveriesDays: 30,
    });
    expect(res.body.recordingsDays).toBe(30);
    const bad = await t.call('PUT', '/settings/retention', {
      token: admin,
      body: { llmCallsDays: 1 },
    });
    expect(bad.status).toBe(400);
    const saved = await t.call<RetentionView>('PUT', '/settings/retention', {
      token: admin,
      body: { llmCallsDays: 30 },
    });
    expect(saved.body.settings.llmCallsDays).toBe(30);
  });

  it('deletes what is past its time, keeps the rest, and records what it did', async () => {
    // Model calls are kept 30 days here, so the 40-day-old one below is due.
    await t.call('PUT', '/settings/retention', { token: admin, body: { llmCallsDays: 30 } });
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    const customerId = (
      await t.call('POST', '/customers', {
        token: admin,
        body: { displayName: 'Rae Retention', email: `${uniq('rae')}@example.com` },
      })
    ).body.id;

    const call = (createdAt: Date) =>
      db
        .insert(llmCalls)
        .values({ role: 'chat_agent', model: 'old-model', status: 'ok', createdAt })
        .returning({ id: llmCalls.id });
    const [oldCall] = await call(daysAgo(40));
    const [newCall] = await call(daysAgo(5));

    const note = (createdAt: Date) =>
      db
        .insert(notifications)
        .values({ userId: agent.id, kind: 'ticket.assigned', title: 'Old news', createdAt })
        .returning({ id: notifications.id });
    const [oldNote] = await note(daysAgo(120));
    const [newNote] = await note(daysAgo(10));

    const event = (publishedAt: Date | null) =>
      db
        .insert(outboxEvents)
        .values({
          type: 'ticket.updated',
          aggregateType: 'ticket',
          aggregateId: randomUUID(),
          payload: {},
          actorType: 'system',
          createdAt: daysAgo(60),
          publishedAt,
        })
        .returning({ id: outboxEvents.id });
    const [oldEvent] = await event(daysAgo(60));
    // Never delivered: it must survive, however old.
    const [stuckEvent] = await event(null);
    await db.update(outboxEvents).set({ attempts: 99 }).where(eq(outboxEvents.id, stuckEvent!.id));

    const link = (expiresAt: Date) =>
      db
        .insert(portalLogins)
        .values({ customerId, email: 'rae@example.com', expiresAt })
        .returning({ id: portalLogins.id });
    const [oldLink] = await link(daysAgo(20));
    const [newLink] = await link(daysAgo(1));

    expect((await t.call('POST', '/system/retention/run', { token: agent.token })).status).toBe(
      403,
    );
    const run = await t.call('POST', '/system/retention/run', { token: admin });
    expect(run.status, JSON.stringify(run.body)).toBe(200);
    expect(run.body.deleted.llmCalls).toBeGreaterThanOrEqual(1);
    expect(run.body.deleted.notifications).toBeGreaterThanOrEqual(1);
    expect(run.body.deleted.events).toBeGreaterThanOrEqual(1);
    expect(run.body.deleted.signInLinks).toBeGreaterThanOrEqual(1);

    const left = async <T extends { id: unknown }>(rows: Promise<T[]>) =>
      (await rows).map((r) => r.id);
    expect(
      await left(
        db
          .select({ id: llmCalls.id })
          .from(llmCalls)
          .where(inArray(llmCalls.id, [oldCall!.id, newCall!.id])),
      ),
    ).toEqual([newCall!.id]);
    expect(
      await left(
        db
          .select({ id: notifications.id })
          .from(notifications)
          .where(inArray(notifications.id, [oldNote!.id, newNote!.id])),
      ),
    ).toEqual([newNote!.id]);
    expect(
      await left(
        db
          .select({ id: outboxEvents.id })
          .from(outboxEvents)
          .where(inArray(outboxEvents.id, [oldEvent!.id, stuckEvent!.id])),
      ),
    ).toEqual([stuckEvent!.id]);
    expect(
      await left(
        db
          .select({ id: portalLogins.id })
          .from(portalLogins)
          .where(inArray(portalLogins.id, [oldLink!.id, newLink!.id])),
      ),
    ).toEqual([newLink!.id]);
    await db.delete(outboxEvents).where(eq(outboxEvents.id, stuckEvent!.id));

    // The run is on record, and the settings page shows it.
    const last = (await view()).body.lastRun!;
    expect(last.deleted).toEqual(run.body.deleted);
    expect(Date.now() - new Date(last.at).getTime()).toBeLessThan(60_000);
    // A second run finds nothing more of ours to delete.
    const again = await t.call('POST', '/system/retention/run', { token: admin });
    expect(again.body.deleted.signInLinks).toBe(0);
  });
});

describe('failed background jobs', () => {
  const jobs = async (token = admin) => t.call<QueueView[]>('GET', '/system/jobs', { token });
  const retention = (list: QueueView[]) => list.find((q) => q.name === 'retention')!;

  it('are listed without their content, and can be retried or removed', async () => {
    expect((await jobs(agent.token)).status).toBe(403);
    const before = await jobs();
    expect(before.status).toBe(200);
    expect(before.body.map((q) => q.name)).toContain('domain-events');
    expect(before.body.every((q) => q.label.length > 0)).toBe(true);

    // A job that fails for good. This file runs no real worker for the queue,
    // so a worker of our own plays the part: it fails until told otherwise.
    const connection = new Redis(testRedisUrl(), { maxRetriesPerRequest: null });
    const queue = new Queue('retention', { connection });
    let healthy = false;
    const worker = new Worker(
      'retention',
      async () => {
        if (!healthy) throw new Error('The storage service said no');
      },
      { connection: connection.duplicate() },
    );
    try {
      const secret = 'customer wrote: my card number is 4111 1111 1111 1111';
      const a = await queue.add('run', { note: secret, documentId: 'doc-1' }, { attempts: 1 });
      const b = await queue.add('run', { note: secret }, { attempts: 1 });
      const failed = await waitFor(async () => {
        const q = retention((await jobs()).body);
        return q.failed >= 2 ? q : undefined;
      }, 'both jobs to fail');
      const mine = failed.jobs.find((j) => j.id === a.id)!;
      expect(mine).toMatchObject({
        name: 'run',
        reason: 'The storage service said no',
        attempts: 1,
        about: 'document doc-1',
      });
      // What the job carried is never shown.
      expect(JSON.stringify(failed)).not.toContain('4111');

      // Retry: it runs again and, this time, succeeds.
      healthy = true;
      expect(
        (await t.call('POST', `/system/jobs/retention/${a.id}/retry`, { token: agent.token }))
          .status,
      ).toBe(403);
      expect(
        (await t.call('POST', `/system/jobs/retention/${a.id}/retry`, { token: admin })).status,
      ).toBe(204);
      await waitFor(
        async () => !retention((await jobs()).body).jobs.some((j) => j.id === a.id),
        'the retried job to leave the failed list',
      );

      // Remove: gone for good.
      expect(
        (await t.call('DELETE', `/system/jobs/retention/${b.id}`, { token: admin })).status,
      ).toBe(204);
      expect(retention((await jobs()).body).jobs.some((j) => j.id === b.id)).toBe(false);
      expect(
        (await t.call('DELETE', `/system/jobs/retention/${b.id}`, { token: admin })).status,
      ).toBe(404);
      expect(
        (await t.call('POST', '/system/jobs/no-such-queue/1/retry', { token: admin })).status,
      ).toBe(404);

      // Both actions are on record, again without what the job carried.
      const audit = async (action: string) =>
        (await t.call('GET', '/audit', { token: admin, query: { action, limit: '5' } }))
          .body as Array<{ data: { queue: string; id: string } }>;
      const retried = (await audit('system.job_retried')).find((r) => r.data.id === a.id);
      expect(retried?.data).toMatchObject({ queue: 'retention', about: 'document doc-1' });
      expect((await audit('system.job_removed')).some((r) => r.data.id === b.id)).toBe(true);
      expect(JSON.stringify(retried)).not.toContain('4111');
    } finally {
      await worker.close();
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
      await connection.quit();
    }
  });
});
