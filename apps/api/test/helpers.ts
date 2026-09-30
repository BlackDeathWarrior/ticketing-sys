import type { NestFastifyApplication } from '@nestjs/platform-fastify';
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
  close(): Promise<void>;
}

export async function startApp(): Promise<TestClient> {
  // Imported lazily so the test env is in place before config is read.
  const { createApp } = await import('../src/bootstrap');
  const app = await createApp();
  let admin: string | undefined;

  const client: TestClient = {
    app,
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
