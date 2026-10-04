import { secrets } from '@tms/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DB } from '../src/infra/tokens';
import { startApp, type TestClient, uniq } from './helpers';
import { FAKE_LLM_BASE_URL } from './test-env';

let t: TestClient;
let admin: string;
const tokens: Record<string, string> = {};
const createdProviders: string[] = [];

beforeAll(async () => {
  t = await startApp();
  admin = await t.adminToken();
  for (const role of ['agent', 'supervisor']) {
    const email = `${uniq(role)}@test.local`;
    const res = await t.call('POST', '/users', {
      token: admin,
      body: { email, name: `Settings ${role}`, password: 'Settings-Passw0rd!', roles: [role] },
    });
    expect(res.status).toBe(201);
    tokens[role] = (await t.login(email, 'Settings-Passw0rd!')).accessToken;
  }
});

afterAll(async () => {
  // Providers own LiteLLM credentials and models; remove them so LiteLLM stays clean.
  for (const id of createdProviders) {
    await t.call('DELETE', `/settings/llm/providers/${id}`, { token: admin });
  }
  await t?.close();
});

async function audit(action: string, targetId?: string) {
  const res = await t.call('GET', '/audit', {
    token: admin,
    query: { action, ...(targetId ? { targetId } : {}) },
  });
  return res.body as Array<{ data: Record<string, unknown>; actorType: string }>;
}

describe('settings permissions', () => {
  it('needs a token, and settings:secrets for keys (admins only)', async () => {
    expect((await t.call('GET', '/settings/secrets')).status).toBe(401);
    expect((await t.call('GET', '/settings/secrets', { token: tokens.agent })).status).toBe(403);
    expect((await t.call('GET', '/settings/secrets', { token: tokens.supervisor })).status).toBe(
      403,
    );
    expect((await t.call('GET', '/settings/secrets', { token: admin })).status).toBe(200);
  });

  it('keeps agents and supervisors out of LLM and channel settings', async () => {
    for (const role of ['agent', 'supervisor']) {
      expect((await t.call('GET', '/settings/llm/providers', { token: tokens[role] })).status).toBe(
        403,
      );
      expect((await t.call('GET', '/settings/channels', { token: tokens[role] })).status).toBe(403);
      const create = await t.call('POST', '/settings/llm/providers', {
        token: tokens[role],
        body: { provider: 'openai', label: 'x', apiKey: 'sk-should-not-work-123' },
      });
      expect(create.status).toBe(403);
    }
  });
});

describe('secrets', () => {
  const value = 'sarvam-test-key-0123456789abcd';
  // Other test files save this key too, so count the entries each step adds.
  const entriesFor = async (action: string) => (await audit(action, 'sarvam.api_key')).length;

  it('stores a secret encrypted and only ever shows the last four characters', async () => {
    const createdBefore = await entriesFor('settings.secret_created');
    const res = await t.call('PUT', '/settings/secrets/sarvam.api_key', {
      token: admin,
      body: { value },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: 'sarvam.api_key', scope: 'channel', last4: 'abcd' });
    expect(JSON.stringify(res.body)).not.toContain(value);

    const list = await t.call('GET', '/settings/secrets', { token: admin });
    expect(JSON.stringify(list.body)).not.toContain(value);

    const db = t.app.get(DB);
    const [row] = await db.select().from(secrets).where(eq(secrets.key, 'sarvam.api_key'));
    expect(row!.ciphertext).not.toContain(value);
    expect(row!.ciphertext.startsWith('v1:')).toBe(true);

    const entries = await audit('settings.secret_created', 'sarvam.api_key');
    expect(entries).toHaveLength(createdBefore + 1);
    expect(JSON.stringify(entries)).not.toContain(value);
  });

  it('rotates and deletes, auditing each step', async () => {
    const rotatedBefore = await entriesFor('settings.secret_rotated');
    const deletedBefore = await entriesFor('settings.secret_deleted');
    const rotated = await t.call('PUT', '/settings/secrets/sarvam.api_key', {
      token: admin,
      body: { value: 'sarvam-rotated-key-000000wxyz' },
    });
    expect(rotated.body.last4).toBe('wxyz');
    expect(await entriesFor('settings.secret_rotated')).toBe(rotatedBefore + 1);

    expect(
      (await t.call('DELETE', '/settings/secrets/sarvam.api_key', { token: admin })).status,
    ).toBe(204);
    expect(await entriesFor('settings.secret_deleted')).toBe(deletedBefore + 1);
    expect(
      (await t.call('DELETE', '/settings/secrets/sarvam.api_key', { token: admin })).status,
    ).toBe(404);
  });

  it('rejects unknown keys', async () => {
    const res = await t.call('PUT', '/settings/secrets/not.a.key', {
      token: admin,
      body: { value: 'x' },
    });
    expect(res.status).toBe(400);
  });
});

describe('channel settings', () => {
  it('validates channel config per channel', async () => {
    const bad = await t.call('PUT', '/settings/channels/whatsapp', {
      token: admin,
      body: { enabled: true, phoneNumberId: 'not-digits' },
    });
    expect(bad.status).toBe(400);
  });

  it('reports a failed connection test with a reason, and records it', async () => {
    const res = await t.call('POST', '/settings/channels/sarvam/test', { token: admin });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not set/);
    const view = await t.call('GET', '/settings/channels/sarvam', { token: admin });
    expect(view.body.lastTest).toMatchObject({ ok: false });
    expect(view.body.secrets[0]).toMatchObject({ key: 'sarvam.api_key', set: false });
    const entries = await audit('settings.updated', 'channel.sarvam.last_test');
    expect(entries.at(-1)?.data).toMatchObject({ action: 'channel_tested', ok: false });
  });
});

describe('LLM providers, models and roles', () => {
  const fakeKey = 'fake-provider-key-000000009876';
  let cheap: { providerId: string; modelId: string };
  let premium: { providerId: string; modelId: string };

  async function addProvider(label: string, budgetUsd: number | null = null) {
    const res = await t.call('POST', '/settings/llm/providers', {
      token: admin,
      body: {
        provider: 'openai_compatible',
        label,
        apiKey: fakeKey,
        baseUrl: FAKE_LLM_BASE_URL,
        budgetUsd,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    createdProviders.push(res.body.id);
    return res.body as { id: string; keyLast4: string | null };
  }

  async function addModel(providerId: string, model: string, input: number, output: number) {
    const res = await t.call('POST', '/settings/llm/models', {
      token: admin,
      body: {
        providerId,
        model,
        label: `${model} ${uniq()}`,
        inputCostPerMTok: input,
        outputCostPerMTok: output,
        supportsTools: true,
        supportsJson: true,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; model: string; costSource: string };
  }

  async function tryRole(role = 'chat_agent') {
    const res = await t.call('POST', `/settings/llm/roles/${role}/try`, { token: admin, body: {} });
    expect(res.status).toBe(200);
    return res.body as {
      ok: boolean;
      modelId?: string;
      output?: string;
      costUsd?: number;
      reason?: string;
      fallbacksAttempted?: number;
    };
  }

  it('adds a provider without ever returning or auditing the key', async () => {
    const p = await addProvider('Fake cheap');
    expect(p.keyLast4).toBe('9876');
    expect(JSON.stringify(p)).not.toContain(fakeKey);
    const entries = await audit('llm.provider_created', p.id);
    expect(entries[0]!.data).toMatchObject({ provider: 'openai_compatible', keySet: true });
    expect(JSON.stringify(entries)).not.toContain(fakeKey);

    const m = await addModel(p.id, 'scripted-cheap', 0.1, 0.4);
    expect(m).toMatchObject({ model: 'openai/scripted-cheap', costSource: 'manual' });
    cheap = { providerId: p.id, modelId: m.id };

    const p2 = await addProvider('Fake premium');
    const m2 = await addModel(p2.id, 'scripted-premium', 3, 15);
    premium = { providerId: p2.id, modelId: m2.id };
  });

  it('tests a provider through LiteLLM with the stored key', async () => {
    const res = await t.call('POST', `/settings/llm/providers/${cheap.providerId}/test`, {
      token: admin,
    });
    expect(res.status).toBe(200);
    expect(res.body, JSON.stringify(res.body)).toMatchObject({
      ok: true,
      model: 'openai/scripted-cheap',
    });
    const list = await t.call('GET', '/settings/llm/providers', { token: admin });
    const view = list.body.find((p: { id: string }) => p.id === cheap.providerId);
    expect(view.lastTest).toMatchObject({ ok: true });
  });

  it('routes a role to the cheapest capable model and records the call', async () => {
    const roles = await t.call('GET', '/settings/llm/roles', { token: admin });
    const chat = roles.body.find((r: { role: string }) => r.role === 'chat_agent');
    const ids = chat.candidates.map((c: { modelId: string }) => c.modelId);
    expect(ids.indexOf(cheap.modelId)).toBeLessThan(ids.indexOf(premium.modelId));

    const r = await tryRole();
    expect(r).toMatchObject({ ok: true, modelId: cheap.modelId, output: 'OK' });
    expect(r.costUsd).toBeGreaterThan(0);

    const usage = await t.call('GET', '/settings/llm/usage', { token: admin });
    const row = usage.body.byProvider.find(
      (p: { providerId: string }) => p.providerId === cheap.providerId,
    );
    expect(row.calls).toBeGreaterThanOrEqual(1);
    expect(row.costUsd).toBeGreaterThan(0);
  });

  it('skips a provider at its cap, so traffic moves to the next cheapest', async () => {
    const res = await t.call('PATCH', `/settings/llm/providers/${cheap.providerId}`, {
      token: admin,
      body: { budgetUsd: 0 },
    });
    expect(res.status).toBe(200);
    expect(await tryRole()).toMatchObject({ ok: true, modelId: premium.modelId });

    const roles = await t.call('GET', '/settings/llm/roles', { token: admin });
    const chat = roles.body.find((r: { role: string }) => r.role === 'chat_agent');
    expect(
      chat.candidates.find((c: { modelId: string }) => c.modelId === cheap.modelId).skipped,
    ).toBe('over_budget');

    await t.call('PATCH', `/settings/llm/providers/${cheap.providerId}`, {
      token: admin,
      body: { budgetUsd: null },
    });
  });

  it('falls back when the first choice fails', async () => {
    const broken = await addProvider('Fake broken');
    const m = await addModel(broken.id, 'always-fails', 0.01, 0.01);
    const r = await tryRole();
    expect(r.ok).toBe(true);
    expect(r.modelId).not.toBe(m.id);
    expect(r.fallbacksAttempted).toBeGreaterThanOrEqual(1);
  });

  it('fails clearly when every provider is over budget', async () => {
    const all = await t.call('GET', '/settings/llm/providers', { token: admin });
    for (const p of all.body) {
      await t.call('PATCH', `/settings/llm/providers/${p.id}`, {
        token: admin,
        body: { budgetUsd: 0 },
      });
    }
    expect(await tryRole('summarizer')).toMatchObject({ ok: false, reason: 'over_budget' });
    for (const p of all.body) {
      await t.call('PATCH', `/settings/llm/providers/${p.id}`, {
        token: admin,
        body: { budgetUsd: null },
      });
    }
  });

  it('uses an ordered role exactly as configured', async () => {
    const res = await t.call('PUT', '/settings/llm/roles/copilot', {
      token: admin,
      body: { mode: 'ordered', modelIds: [premium.modelId, cheap.modelId] },
    });
    expect(res.status).toBe(200);
    expect(await tryRole('copilot')).toMatchObject({ ok: true, modelId: premium.modelId });
    expect(await audit('llm.role_updated', 'copilot')).toHaveLength(1);
  });

  it('rotates a key and deletes a provider with its models', async () => {
    const rotated = await t.call('PATCH', `/settings/llm/providers/${premium.providerId}`, {
      token: admin,
      body: { apiKey: 'fake-provider-rotated-key-4321' },
    });
    expect(rotated.body.keyLast4).toBe('4321');
    expect(await audit('llm.provider_key_rotated', premium.providerId)).toHaveLength(1);

    const del = await t.call('DELETE', `/settings/llm/providers/${premium.providerId}`, {
      token: admin,
    });
    expect(del.status).toBe(204);
    createdProviders.splice(createdProviders.indexOf(premium.providerId), 1);
    const models = await t.call('GET', '/settings/llm/models', { token: admin });
    expect(models.body.some((m: { id: string }) => m.id === premium.modelId)).toBe(false);
    const roles = await t.call('GET', '/settings/llm/roles', { token: admin });
    expect(roles.body.find((r: { role: string }) => r.role === 'copilot').modelIds).toEqual([
      cheap.modelId,
    ]);
  });

  it('tries a model before it is added, without touching the provider’s own test result', async () => {
    const before = (await t.call('GET', '/settings/llm/providers', { token: admin })).body.find(
      (p: { id: string }) => p.id === cheap.providerId,
    ).lastTest;
    const tryModel = (model: string, token = admin) =>
      t.call('POST', `/settings/llm/providers/${cheap.providerId}/test-model`, {
        token,
        body: { model },
      });

    const good = await tryModel('scripted-cheap');
    expect(good.status).toBe(200);
    expect(good.body).toMatchObject({ ok: true, model: 'openai/scripted-cheap' });

    const bad = await tryModel('always-fails');
    expect(bad.status).toBe(200);
    expect(bad.body).toMatchObject({ ok: false, model: 'openai/always-fails' });
    expect(bad.body.error).toEqual(expect.any(String));
    expect(bad.body.error.length).toBeGreaterThan(3);
    expect(JSON.stringify(bad.body)).not.toContain(fakeKey);

    const after = (await t.call('GET', '/settings/llm/providers', { token: admin })).body.find(
      (p: { id: string }) => p.id === cheap.providerId,
    ).lastTest;
    expect(after).toEqual(before);
    expect((await tryModel('has a space')).status).toBe(400);
    expect((await tryModel('scripted-cheap', tokens.agent)).status).toBe(403);
  });

  it("offers a provider's models to choose from, and none where only the owner knows them", async () => {
    type Offered = {
      model: string;
      mode: string;
      supportsTools: boolean;
      inputCostPerMTok: number | null;
      added: boolean;
    };
    const catalogue = (id: string, token = admin) =>
      t.call('GET', `/settings/llm/providers/${id}/catalogue`, { token });

    // A self-hosted endpoint: LiteLLM cannot know what it serves.
    const own = await catalogue(cheap.providerId);
    expect(own.status).toBe(200);
    expect(own.body).toEqual([]);

    const made = await t.call('POST', '/settings/llm/providers', {
      token: admin,
      body: { provider: 'anthropic', label: `Catalogue ${uniq()}`, apiKey: fakeKey },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = made.body.id as string;
    try {
      const listed = await catalogue(id);
      expect(listed.status).toBe(200);
      const models = listed.body as Offered[];
      expect(models.length).toBeGreaterThan(3);
      for (const m of models) {
        expect(['chat', 'embedding']).toContain(m.mode);
        // The provider's own name: the LiteLLM prefix is added when the model is registered.
        expect(m.model.startsWith('anthropic/')).toBe(false);
        expect(m.added).toBe(false);
      }
      const pick = models.find((m) => m.supportsTools && (m.inputCostPerMTok ?? 0) > 0)!;
      expect(pick, 'a chat model with tools and a price').toBeDefined();
      expect(pick.model).toMatch(/^claude-/);

      // Once registered it is marked, so the form does not add it twice.
      const added = await t.call('POST', '/settings/llm/models', {
        token: admin,
        body: { providerId: id, model: pick.model },
      });
      expect(added.status, JSON.stringify(added.body)).toBe(201);
      expect(added.body).toMatchObject({ model: `anthropic/${pick.model}`, supportsTools: true });
      const again = (await catalogue(id)).body as Offered[];
      expect(again.filter((m) => m.added).map((m) => m.model)).toEqual([pick.model]);

      expect((await catalogue(id, tokens.agent)).status).toBe(403);
      expect((await catalogue('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    } finally {
      await t.call('DELETE', `/settings/llm/providers/${id}`, { token: admin });
    }
  });
});
