import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Database } from '@tms/db';
import { applyTestEnv, TEST_ADMIN } from './test-env';

applyTestEnv();

export interface TestClient {
  app: NestFastifyApplication;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test responses are loosely typed
  call<T = any>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    opts?: { token?: string; body?: unknown; query?: Record<string, string> },
  ): Promise<{ status: number; body: T }>;
  login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }>;
  adminToken(): Promise<string>;
  /** Base URL when started with { listen: true } (needed for sockets). */
  baseUrl?: string;
  close(): Promise<void>;
}

export async function startApp(opts: { listen?: boolean } = {}): Promise<TestClient> {
  // Imported lazily so the test env is in place before config is read.
  const { createApp } = await import('../src/bootstrap');
  const app = await createApp();
  let admin: string | undefined;
  let baseUrl: string | undefined;
  if (opts.listen) {
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = await app.getUrl();
  }

  const client: TestClient = {
    app,
    baseUrl,
    async call<T>(
      method: Parameters<TestClient['call']>[0],
      url: string,
      opts: Parameters<TestClient['call']>[2] = {},
    ) {
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        query: opts.query,
        headers: {
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        payload: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: res.statusCode, body: (res.body ? res.json() : undefined) as T };
    },
    async login(email, password) {
      const res = await client.call('POST', '/auth/login', { body: { email, password } });
      if (res.status !== 200)
        throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
      return res.body;
    },
    async adminToken() {
      admin ??= (await client.login(TEST_ADMIN.adminEmail, TEST_ADMIN.adminPassword)).accessToken;
      return admin;
    },
    close: () => app.close(),
  };
  return client;
}

let seq = 0;
/** Unique suffix so tests don't collide on unique columns. */
export const uniq = (prefix = 'x') => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Starts the background worker (outbox relay, delivery, mailbox) in-process. */
export async function startWorker() {
  const { createWorker } = await import('../src/worker/bootstrap');
  return createWorker();
}

/** Polls until the check returns a truthy value, or fails after the timeout. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null | false,
  what: string,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await check();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

/**
 * Waits until everything written so far has had its consequences: every event
 * relayed from the outbox, and nothing waiting or running on the event queue
 * (and on `queues`, for work the handlers pass on). A check that something did
 * NOT happen waits for this instead of sleeping and hoping.
 */
export async function eventsHandled(t: TestClient, queues: string[] = []): Promise<void> {
  const [{ Queue }, { default: Redis }, { outboxEvents }, { count, isNull }, shared, { DB }] =
    await Promise.all([
      import('bullmq'),
      import('ioredis'),
      import('@tms/db'),
      import('drizzle-orm'),
      import('@tms/shared'),
      import('../src/infra/tokens'),
    ]);
  const db = t.app.get<Database>(DB);
  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
  const watched = [shared.DOMAIN_EVENTS_QUEUE, ...queues].map(
    (name) => new Queue(name, { connection }),
  );
  const quiet = async () => {
    const [pending] = await db
      .select({ n: count() })
      .from(outboxEvents)
      .where(isNull(outboxEvents.publishedAt));
    if (pending!.n > 0) return false;
    for (const queue of watched) {
      const jobs = await queue.getJobCounts('waiting', 'active', 'prioritized');
      if (Object.values(jobs).some((n) => n > 0)) return false;
    }
    return true;
  };
  try {
    // Twice in a row: a handler may write the next event as it finishes.
    await waitFor(async () => (await quiet()) && (await quiet()), 'every event to be handled');
  } finally {
    await Promise.all(watched.map((queue) => queue.close()));
    await connection.quit().catch(() => undefined);
  }
}

/** Creates a team; returns its id. */
export async function makeTeam(t: TestClient, admin: string, name = uniq('Team')) {
  const res = await t.call<{ id: string }>('POST', '/teams', { token: admin, body: { name } });
  if (res.status !== 201) throw new Error(`team: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.id;
}

/** Creates a user with a role (and teams) and signs them in. */
export async function makeUser(
  t: TestClient,
  admin: string,
  role: string,
  opts: { name?: string; teamIds?: string[] } = {},
) {
  const email = `${uniq(role)}@test.local`;
  const password = 'Phase7-Passw0rd!';
  const res = await t.call<{ id: string }>('POST', '/users', {
    token: admin,
    body: {
      email,
      name: opts.name ?? `User ${uniq()}`,
      password,
      roles: [role],
      teamIds: opts.teamIds ?? [],
    },
  });
  if (res.status !== 201) throw new Error(`user: ${res.status} ${JSON.stringify(res.body)}`);
  const token = (await t.login(email, password)).accessToken;
  return { id: res.body.id, email, token, name: opts.name };
}

/**
 * Empties the knowledge base. Test files share one database, and what the AI
 * answers depends on which documents exist: a file that relies on its own
 * documents starts from none.
 */
export async function clearKnowledgeBase(t: TestClient, admin: string): Promise<void> {
  const res = await t.call('GET', '/kb/documents', { token: admin, query: { limit: '200' } });
  const docs = (Array.isArray(res.body) ? res.body : (res.body?.items ?? [])) as Array<{
    id: string;
  }>;
  for (const d of docs) await t.call('DELETE', `/kb/documents/${d.id}`, { token: admin });
}
