import { apiKeys, type Database } from '@tms/db';
import type { ApiKeyView, CreatedApiKey, IntegrationIdentity, IntegrationView } from '@tms/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infra/tokens';
import { hashApiKey } from '../src/integrations/api-key.util';
import { makeUser, startApp, type TestClient, uniq } from './helpers';

/**
 * Integrations and their API keys (ADR 0022): who may manage them, that a key
 * is shown once and stored as a hash, and what a key can and cannot reach.
 */
let t: TestClient;
let db: Database;
let admin: string;
let supervisor: Awaited<ReturnType<typeof makeUser>>;

beforeAll(async () => {
  t = await startApp();
  db = t.app.get(DB);
  admin = await t.adminToken();
  supervisor = await makeUser(t, admin, 'supervisor');
});

afterAll(async () => {
  await t?.close();
});

async function makeIntegration(name = 'Ethnic Threads') {
  const res = await t.call<IntegrationView>('POST', '/integrations', {
    token: admin,
    body: { slug: uniq('shop-'), name },
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function makeKey(integrationId: string, body: Record<string, unknown> = {}) {
  const res = await t.call<CreatedApiKey>('POST', `/integrations/${integrationId}/keys`, {
    token: admin,
    body: { name: 'Storefront', scopes: ['integration:ticket'], ...body },
  });
  expect(res.status).toBe(201);
  return res.body;
}

const whoAmI = (token?: string) =>
  t.call<IntegrationIdentity & { message?: string }>('GET', '/integration', { token });

describe('managing integrations', () => {
  it('creates, lists, renames and switches off an integration', async () => {
    const made = await makeIntegration();
    expect(made).toMatchObject({ name: 'Ethnic Threads', isActive: true, activeKeys: 0 });

    const list = await t.call<IntegrationView[]>('GET', '/integrations', { token: admin });
    expect(list.body.some((i) => i.id === made.id)).toBe(true);

    const renamed = await t.call<IntegrationView>('PATCH', `/integrations/${made.id}`, {
      token: admin,
      body: { name: 'Ethnic Threads storefront', isActive: false },
    });
    expect(renamed.body).toMatchObject({ name: 'Ethnic Threads storefront', isActive: false });
    // The slug names its secrets and cannot change.
    expect(renamed.body.slug).toBe(made.slug);
  });

  it('refuses a slug that is taken or malformed', async () => {
    const made = await makeIntegration();
    const again = await t.call('POST', '/integrations', {
      token: admin,
      body: { slug: made.slug, name: 'Another' },
    });
    expect(again.status).toBe(409);
    const bad = await t.call('POST', '/integrations', {
      token: admin,
      body: { slug: 'Not A Slug', name: 'Another' },
    });
    expect(bad.status).toBe(400);
  });

  it('is for administrators only', async () => {
    const made = await makeIntegration();
    for (const [method, url, body] of [
      ['GET', '/integrations', undefined],
      ['POST', '/integrations', { slug: uniq('s-'), name: 'Nope' }],
      ['PATCH', `/integrations/${made.id}`, { name: 'Nope' }],
      ['GET', `/integrations/${made.id}/keys`, undefined],
      ['POST', `/integrations/${made.id}/keys`, { name: 'Nope', scopes: ['kb:read'] }],
    ] as const) {
      const res = await t.call(method, url, { token: supervisor.token, body });
      expect(res.status, `${method} ${url}`).toBe(403);
    }
    expect((await t.call('GET', '/integrations')).status).toBe(401);
  });

  it('records changes in the audit trail without the key', async () => {
    const made = await makeIntegration();
    const key = await makeKey(made.id);
    await t.call('POST', `/integrations/keys/${key.id}/revoke`, { token: admin });

    const audit = await t.call<Array<{ action: string; data: Record<string, unknown> }>>(
      'GET',
      '/audit',
      { token: admin, query: { targetType: 'integration', targetId: made.id, limit: '10' } },
    );
    expect(audit.body.map((a) => a.action).sort()).toEqual([
      'integration.created',
      'integration.key_created',
      'integration.key_revoked',
    ]);
    expect(JSON.stringify(audit.body)).not.toContain(key.key);
  });
});

describe('API keys', () => {
  it('returns the key once and stores only its hash', async () => {
    const made = await makeIntegration();
    const key = await makeKey(made.id, { scopes: ['integration:ticket', 'kb:read'] });
    expect(key.key).toMatch(/^tms_sk_[A-Za-z0-9_-]{43}$/);
    expect(key.key.startsWith(key.prefix)).toBe(true);
    expect(key).toMatchObject({
      status: 'active',
      scopes: ['integration:ticket', 'kb:read'],
      rateLimitPerMinute: 120,
      lastUsedAt: null,
    });

    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, key.id));
    expect(row!.keyHash).toBe(hashApiKey(key.key));
    expect(JSON.stringify(row)).not.toContain(key.key);

    const list = await t.call<ApiKeyView[]>('GET', `/integrations/${made.id}/keys`, {
      token: admin,
    });
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain(key.key);
    expect((list.body[0] as unknown as Record<string, unknown>).key).toBeUndefined();

    const all = await t.call<IntegrationView[]>('GET', '/integrations', { token: admin });
    expect(all.body.find((i) => i.id === made.id)!.activeKeys).toBe(1);
  });

  it('accepts only scopes a key may have', async () => {
    const made = await makeIntegration();
    for (const scopes of [[], ['ticket:read'], ['settings:secrets']]) {
      const res = await t.call('POST', `/integrations/${made.id}/keys`, {
        token: admin,
        body: { name: 'Too much', scopes },
      });
      expect(res.status, JSON.stringify(scopes)).toBe(400);
    }
  });

  it('identifies its integration and notes that it was used', async () => {
    const made = await makeIntegration('Catalogue worker');
    const key = await makeKey(made.id, { name: 'Worker', scopes: ['integration:event'] });

    const me = await whoAmI(key.key);
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      integration: { slug: made.slug, name: 'Catalogue worker' },
      key: {
        name: 'Worker',
        prefix: key.prefix,
        scopes: ['integration:event'],
        rateLimitPerMinute: 120,
      },
    });

    const list = await t.call<ApiKeyView[]>('GET', `/integrations/${made.id}/keys`, {
      token: admin,
    });
    expect(list.body[0]!.lastUsedAt).not.toBeNull();
  });

  it('reaches integration routes only, and staff tokens do not reach those', async () => {
    const made = await makeIntegration();
    const key = await makeKey(made.id, { scopes: ['integration:ticket', 'kb:read'] });

    // A key never works on a route written for a signed-in person, whatever its scopes.
    for (const url of ['/tickets', '/customers', '/integrations', '/auth/me', '/kb/documents']) {
      const res = await t.call('GET', url, { token: key.key });
      expect(res.status, url).toBe(403);
      expect(res.body.message).toBe('API keys cannot call this route');
    }

    const staff = await whoAmI(admin);
    expect(staff.status).toBe(401);
    expect(staff.body.message).toBe('This route needs an API key');
    expect((await whoAmI()).status).toBe(401);
  });

  it('refuses a wrong, revoked or expired key, and a switched-off integration', async () => {
    const made = await makeIntegration();
    const key = await makeKey(made.id);
    expect((await whoAmI(key.key)).status).toBe(200);

    const wrong = await whoAmI(`${key.key.slice(0, -4)}AAAA`);
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe('Invalid API key');

    // Switching the integration off stops its keys; switching it on brings them back.
    await t.call('PATCH', `/integrations/${made.id}`, { token: admin, body: { isActive: false } });
    expect((await whoAmI(key.key)).status).toBe(403);
    await t.call('PATCH', `/integrations/${made.id}`, { token: admin, body: { isActive: true } });
    expect((await whoAmI(key.key)).status).toBe(200);

    // Revoking works on the very next request, and cannot be undone.
    const revoked = await t.call<ApiKeyView>('POST', `/integrations/keys/${key.id}/revoke`, {
      token: admin,
    });
    expect(revoked.body.status).toBe('revoked');
    const after = await whoAmI(key.key);
    expect(after.status).toBe(401);
    expect(after.body.message).toBe('This API key was revoked');
    const twice = await t.call<ApiKeyView>('POST', `/integrations/keys/${key.id}/revoke`, {
      token: admin,
    });
    expect(twice.body.revokedAt).toBe(revoked.body.revokedAt);

    const expired = await makeKey(made.id, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(expired.status).toBe('expired');
    const old = await whoAmI(expired.key);
    expect(old.status).toBe(401);
    expect(old.body.message).toBe('This API key has expired');
  });
});

describe('the API docs', () => {
  it('describe the integration routes from the contracts they validate', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/docs-json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.components.securitySchemes.apiKey).toMatchObject({ type: 'http', scheme: 'bearer' });

    const create = doc.paths['/api/v1/integration/tickets'].post;
    expect(create.summary).toBe('Raise a ticket for one of your users');
    expect(create.security).toEqual([{ apiKey: [] }]);
    const body = create.requestBody.content['application/json'].schema;
    expect(body.required).toEqual(expect.arrayContaining(['customer', 'subject', 'body']));
    expect(Object.keys(body.properties)).toEqual(
      expect.arrayContaining(['category', 'priority', 'tags', 'externalRef', 'metadata', 'ai']),
    );
    expect(body.properties.priority.enum).toEqual(['urgent', 'high', 'normal', 'low']);
    expect(create.parameters.map((p: { name: string }) => p.name)).toContain('Idempotency-Key');

    const list = doc.paths['/api/v1/integration/tickets'].get;
    expect(list.parameters.map((p: { name: string }) => p.name).sort()).toEqual([
      'externalRef',
      'limit',
      'offset',
      'state',
    ]);
    const event = doc.paths['/api/v1/integration/events'].post;
    expect(event.requestBody.content['application/json'].schema.properties.severity.enum).toEqual([
      'info',
      'warning',
      'error',
      'critical',
    ]);
    const hook = doc.paths['/api/v1/integrations/{id}/webhooks'].post;
    expect(
      hook.requestBody.content['application/json'].schema.properties.events.items.enum,
    ).toContain('message.created');
  });
});
