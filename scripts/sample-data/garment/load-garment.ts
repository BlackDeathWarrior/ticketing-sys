/**
 * Sets up a running TMS as the support desk of Ethnic Threads (the shop in
 * the garment-web-scraper repository), and writes the shop's side of the
 * connection to its .env (ADR 0027, ADR 0028).
 *
 * Everything goes through the API, as an administrator would do it in Orbit
 * Desk: branding, teams, staff, categories, SLA, routing, AI modes, the
 * knowledge base, the integration with its keys, webhook and chat identity
 * secret, and the tools the AI may call on the shop's server.
 *
 *   pnpm garment:load
 *   GARMENT_LLM=scripted pnpm garment:load   # the scripted model, for tests
 *   GARMENT_REKEY=1 pnpm garment:load        # new keys and secrets for an existing setup
 *
 * (`scripts/demo/garment-demo.ps1 load` sets these.) The same choices can be
 * passed as `--llm scripted`, `--rekey` and `--env-out <absolute path>`.
 *
 * It can be run again: what exists is left alone, what is missing is added.
 * Keys and secrets are created once (they cannot be read back), or again with
 * `--rekey`. Nothing secret is printed: it goes to the env file only
 * (GARMENT_ENV; by default `.env` in a garment-web-scraper clone next to this
 * repository).
 *
 * `--llm none` (the default) leaves the models to you: add a provider with a
 * chat and an embedding model under Settings → Providers and Models, then run this again to
 * load the knowledge base, which needs the embedding model.
 *
 * Env: API_URL (http://localhost:3200), WIDGET_URL (http://localhost:8090,
 * where the browser loads the chat widget), GARMENT_WORKER_URL
 * (http://host.docker.internal:8765, the shop's server as the TMS containers
 * reach it), ADMIN_EMAIL / ADMIN_PASSWORD, FAKE_LLM_URL.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EXAMPLE_PRIORITY_RULES } from '@tms/shared';
import { llm } from '../data';
import {
  aiChannels,
  branding,
  categories,
  INTEGRATION,
  kb,
  routing,
  sla,
  STAFF_PASSWORD,
  teams,
  tools,
  users,
  webhookEvents,
} from './data';

const { values: args } = parseArgs({
  // pnpm hands a script the `--` that separates its own options.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    'env-out': { type: 'string' },
    llm: { type: 'string', default: process.env.GARMENT_LLM || 'none' },
    rekey: { type: 'boolean', default: /^(1|true)$/.test(process.env.GARMENT_REKEY ?? '') },
  },
});
if (args.llm !== 'none' && args.llm !== 'scripted') {
  throw new Error('--llm must be "none" or "scripted"');
}

const API_URL = (process.env.API_URL ?? 'http://localhost:3200').replace(/\/$/, '');
const WIDGET_URL = (process.env.WIDGET_URL ?? 'http://localhost:8090').replace(/\/$/, '');
const GARMENT_WORKER_URL = (
  process.env.GARMENT_WORKER_URL ?? 'http://host.docker.internal:8765'
).replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
const FAKE_LLM_URL = process.env.FAKE_LLM_URL ?? 'http://fake-providers:4010/v1';
/** The garment repo's .env; the default assumes it is cloned next to this repo. */
const ENV_OUT = resolve(
  args['env-out'] ?? process.env.GARMENT_ENV ?? '../../../garment-web-scraper/.env',
);

interface Ref {
  id: string;
  name: string;
}

async function call<T>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_URL}/api/v1${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await check();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const log = (msg: string) => console.log(`• ${msg}`);

async function main() {
  const admin = (
    await call<{ accessToken: string }>(null, 'POST', '/auth/login', {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
    })
  ).accessToken;

  await call(admin, 'PUT', '/settings/branding', branding);
  log(`branding: ${branding.companyName}`);

  const teamIds = await loadTeams(admin);
  await loadUsers(admin, teamIds);
  await loadTeamAdmins(admin, teamIds);
  const categoryIds = await loadCategories(admin);
  await loadSla(admin);
  await loadRouting(admin, teamIds, categoryIds);
  await loadAi(admin);

  if (args.llm === 'scripted') await loadScriptedLlm(admin);
  const kbLoaded = await loadKb(admin);

  const connection = await loadIntegration(admin);
  await loadTools(admin, connection?.toolToken ?? null, teamIds);
  await loadPriorityRules(admin);
  if (connection) writeEnv(connection);

  console.log('');
  if (!kbLoaded) {
    console.log(
      'No embedding model is set up, so the knowledge base was left as it is: documents already there are searched by keywords only, and new ones cannot be added. For search by meaning, add an embedding model under Settings → Models & roles, choose it for "Knowledge base embeddings", then run this again.',
    );
  }
  console.log(
    `Done. Staff sign in to Orbit Desk as ${ADMIN_EMAIL}, or as ${users.map((u) => u.email).join(', ')} (the password is STAFF_PASSWORD in scripts/sample-data/garment/data.ts).`,
  );
}

async function loadTeams(admin: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  for (const t of await call<Ref[]>(admin, 'GET', '/teams')) ids.set(t.name, t.id);
  for (const t of teams) {
    if (!ids.has(t.name)) ids.set(t.name, (await call<Ref>(admin, 'POST', '/teams', t)).id);
  }
  log(`${teams.length} teams`);
  return ids;
}

async function loadUsers(admin: string, teamIds: Map<string, string>) {
  const known = await call<Array<Ref & { email: string }>>(admin, 'GET', '/users');
  for (const u of users) {
    let id = known.find((k) => k.email === u.email)?.id;
    if (!id) {
      id = (
        await call<Ref>(admin, 'POST', '/users', {
          email: u.email,
          name: u.name,
          password: STAFF_PASSWORD,
          roles: u.roles,
          teamIds: u.teams.map((t) => teamIds.get(t)!),
        })
      ).id;
    }
    // Online, so routing has someone to hand a ticket to straight away.
    await call(admin, 'PUT', `/routing/agents/${id}/presence`, {
      status: u.online ? 'online' : 'away',
      capacity: 8,
    });
  }
  log(`${users.length} staff accounts`);
}

/** Each team's admins, who manage its members (ADR 0031). Members who stay keep their place. */
async function loadTeamAdmins(admin: string, teamIds: Map<string, string>) {
  const known = await call<Array<Ref & { email: string }>>(admin, 'GET', '/users');
  const current = await call<Array<Ref & { members: Ref[] }>>(admin, 'GET', '/teams');
  for (const [name, id] of teamIds) {
    const adminIds = users
      .filter((u) => u.admins?.includes(name))
      .map((u) => known.find((k) => k.email === u.email)?.id)
      .filter((x): x is string => !!x);
    if (!adminIds.length) continue;
    const members = current.find((t) => t.id === id)?.members.map((m) => m.id) ?? [];
    await call(admin, 'PATCH', `/teams/${id}`, {
      memberIds: [...new Set([...members, ...adminIds])],
      adminIds,
    });
  }
  log('team admins: one per team');
}

/** Priority rules a shop starts from (ADR 0032): payment problems first, price questions last. */
async function loadPriorityRules(admin: string) {
  const current = await call<{ rules: unknown[] }>(admin, 'GET', '/settings/priority-rules');
  if (current.rules.length) return log('priority rules already set');
  await call(admin, 'PUT', '/settings/priority-rules', {
    rules: EXAMPLE_PRIORITY_RULES.map((r) => ({ ...r, id: 'new' })),
  });
  log(
    `${EXAMPLE_PRIORITY_RULES.length} priority rules (payment problems are high, price questions low)`,
  );
}

interface Category extends Ref {
  children: Ref[];
}

async function loadCategories(admin: string): Promise<Map<string, string>> {
  const existing = await call<Category[]>(admin, 'GET', '/categories');
  const ids = new Map<string, string>();
  for (const c of categories) {
    const found = existing.find((e) => e.name === c.name);
    const parent = found ?? (await call<Ref>(admin, 'POST', '/categories', { name: c.name }));
    ids.set(c.name, parent.id);
    for (const child of c.children) {
      if (!found?.children.some((x) => x.name === child)) {
        await call(admin, 'POST', '/categories', { name: child, parentId: parent.id });
      }
    }
  }
  log(`${categories.length} categories`);
  return ids;
}

async function loadSla(admin: string) {
  const hours =
    (await call<Ref[]>(admin, 'GET', '/sla/business-hours')).find(
      (h) => h.name === sla.hours.name,
    ) ?? (await call<Ref>(admin, 'POST', '/sla/business-hours', sla.hours));
  const existing = await call<Ref[]>(admin, 'GET', '/sla/policies');
  for (const { supportHours, ...p } of sla.policies) {
    if (existing.some((e) => e.name === p.name)) continue;
    await call(admin, 'POST', '/sla/policies', {
      ...p,
      ...(supportHours ? { businessHoursId: hours.id } : {}),
    });
  }
  log(`${sla.policies.length} SLA policies (urgent: first answer within 2 minutes)`);
}

async function loadRouting(
  admin: string,
  teamIds: Map<string, string>,
  categoryIds: Map<string, string>,
) {
  const existing = await call<Ref[]>(admin, 'GET', '/routing/rules');
  for (const { team, category, conditions, ...rule } of routing) {
    if (existing.some((e) => e.name === rule.name)) continue;
    await call(admin, 'POST', '/routing/rules', {
      ...rule,
      teamId: teamIds.get(team),
      conditions: {
        ...conditions,
        ...(category ? { categoryId: categoryIds.get(category) } : {}),
      },
    });
  }
  log(`${routing.length} routing rules (incidents go to Operations)`);
}

async function loadAi(admin: string) {
  // On a setup that exists, how the AI answers each channel is the owner's choice by now.
  const set = await call<Array<{ slug: string }>>(admin, 'GET', '/integrations');
  if (set.some((i) => i.slug === INTEGRATION.slug))
    return log('AI: channel modes left as they are');
  const current = await call<{ channels: Record<string, string> }>(admin, 'GET', '/settings/ai');
  await call(admin, 'PUT', '/settings/ai', {
    ...current,
    channels: { ...current.channels, ...aiChannels },
  });
  log('AI: answers the chat by itself, drafts replies to form requests for an agent');
}

/** The scripted model of apps/fake-providers, as the general sample data uses it. */
async function loadScriptedLlm(admin: string) {
  const providers = await call<Array<{ id: string; label: string }>>(
    admin,
    'GET',
    '/settings/llm/providers',
  );
  if (providers.some((p) => p.label === llm.provider.label)) return;
  await waitFor(
    'LiteLLM to be up',
    async () => {
      const res = await fetch(`${API_URL}/api/v1/health/ready`).catch(() => null);
      const body = (await res?.json().catch(() => null)) as {
        checks?: { litellm?: { status?: string } };
      } | null;
      return body?.checks?.litellm?.status === 'up' || undefined;
    },
    240_000,
  );
  const provider = await call<{ id: string }>(admin, 'POST', '/settings/llm/providers', {
    ...llm.provider,
    baseUrl: FAKE_LLM_URL,
  });
  const ids: Record<string, string> = {};
  for (const m of llm.models) {
    ids[m.model] = (
      await call<{ id: string }>(admin, 'POST', '/settings/llm/models', {
        providerId: provider.id,
        ...m,
      })
    ).id;
  }
  await call(admin, 'PUT', '/settings/llm/roles/embedding', {
    mode: 'ordered',
    modelIds: [ids['scripted-embed']],
  });
  log('scripted demo model (no real key)');
}

/** False when there is no embedding model yet: documents cannot be indexed without one. */
async function loadKb(admin: string): Promise<boolean> {
  const roles = await call<Array<{ role: string; candidates: unknown[] }>>(
    admin,
    'GET',
    '/settings/llm/roles',
  );
  if (!roles.find((r) => r.role === 'embedding')?.candidates.length) return false;

  const listed = await call<Array<{ title: string }> | { items: Array<{ title: string }> }>(
    admin,
    'GET',
    '/kb/documents?limit=200',
  );
  const titles = new Set((Array.isArray(listed) ? listed : listed.items).map((d) => d.title));
  const dir = new URL('./kb/', import.meta.url);
  const ids: string[] = [];
  for (const file of kb.files) {
    const content = readFileSync(new URL(file, dir), 'utf8');
    const title = /^# (.+)$/m.exec(content)?.[1] ?? file;
    if (titles.has(title) || titles.has(file)) continue;
    const form = new FormData();
    form.append('visibility', 'public');
    form.append('file', new Blob([content], { type: 'text/markdown' }), file);
    const res = await fetch(`${API_URL}/api/v1/kb/documents/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}` },
      body: form,
    });
    if (!res.ok) throw new Error(`upload ${file} → ${res.status}: ${await res.text()}`);
    ids.push(((await res.json()) as { id: string }).id);
  }
  for (const faq of kb.faqs) {
    if (titles.has(faq.question)) continue;
    ids.push(
      (
        await call<{ id: string }>(admin, 'POST', '/kb/documents', {
          source: 'faq',
          visibility: 'public',
          title: faq.question,
          content: faq.answer,
        })
      ).id,
    );
  }
  if (!titles.has(kb.internal.title)) {
    ids.push(
      (
        await call<{ id: string }>(admin, 'POST', '/kb/documents', {
          source: 'text',
          visibility: 'internal',
          ...kb.internal,
        })
      ).id,
    );
  }
  for (const id of ids) {
    await waitFor(`knowledge base document ${id} to be indexed`, async () => {
      const d = await call<{ indexState: string }>(admin, 'GET', `/kb/documents/${id}`);
      if (d.indexState === 'failed') throw new Error(`indexing ${id} failed`);
      return d.indexState === 'indexed' || undefined;
    });
    await call(admin, 'POST', `/kb/documents/${id}/status`, { status: 'approved' });
  }
  log(
    ids.length
      ? `${ids.length} knowledge base documents, approved`
      : 'knowledge base already loaded',
  );
  return true;
}

interface Connection {
  webKey: string;
  eventsKey: string;
  limitedKey: string;
  webhookSecret: string;
  chatIdentitySecret: string;
  toolToken: string;
}

/**
 * The integration, its keys, its webhook and its chat identity secret. Null
 * when it exists already and `--rekey` was not given: its secrets cannot be
 * read back, and the app's .env still holds them.
 */
async function loadIntegration(admin: string): Promise<Connection | null> {
  const all = await call<Array<{ id: string; slug: string }>>(admin, 'GET', '/integrations');
  let integration = all.find((i) => i.slug === INTEGRATION.slug);
  if (integration && !args.rekey) {
    log(
      `integration "${INTEGRATION.slug}" exists: keys and secrets kept (use --rekey for new ones)`,
    );
    return null;
  }
  const fresh = !integration;
  integration ??= await call<{ id: string; slug: string }>(
    admin,
    'POST',
    '/integrations',
    INTEGRATION,
  );
  const id = integration.id;

  if (!fresh) {
    const keys = await call<Array<{ id: string; status: string }>>(
      admin,
      'GET',
      `/integrations/${id}/keys`,
    );
    for (const k of keys.filter((x) => x.status === 'active')) {
      await call(admin, 'POST', `/integrations/keys/${k.id}/revoke`);
    }
  }
  const key = async (name: string, scopes: string[], rateLimitPerMinute?: number) =>
    (
      await call<{ key: string }>(admin, 'POST', `/integrations/${id}/keys`, {
        name,
        scopes,
        ...(rateLimitPerMinute ? { rateLimitPerMinute } : {}),
      })
    ).key;
  const webKey = await key('Shop server: shopper requests', [
    'integration:ticket',
    'integration:customer',
  ]);
  const eventsKey = await key('Shop server: incidents', ['integration:event']);
  // For showing the per-key limit: five calls a minute, then 429.
  const limitedKey = await key('Demo: five calls a minute', ['integration:ticket'], 5);

  const url = `${GARMENT_WORKER_URL}/api/support/webhook`;
  const hooks = await call<Array<{ id: string; url: string }>>(
    admin,
    'GET',
    `/integrations/${id}/webhooks`,
  );
  const existing = hooks.find((h) => h.url === url);
  // An existing webhook keeps its address; the list of events is brought up to date.
  if (existing) await call(admin, 'PATCH', `/webhooks/${existing.id}`, { events: webhookEvents });
  const webhookSecret = existing
    ? (await call<{ secret: string }>(admin, 'POST', `/webhooks/${existing.id}/rotate-secret`))
        .secret
    : (
        await call<{ secret: string }>(admin, 'POST', `/integrations/${id}/webhooks`, {
          url,
          events: webhookEvents,
          scope: 'own',
          description: "The Ethnic Threads shop's /api/support/webhook",
        })
      ).secret;

  const chatIdentitySecret = (
    await call<{ secret: string }>(admin, 'POST', `/integrations/${id}/chat-identity-secret`)
  ).secret;

  log(`integration "${INTEGRATION.slug}": 3 API keys, a webhook and a chat identity secret`);
  return {
    webKey,
    eventsKey,
    limitedKey,
    webhookSecret,
    chatIdentitySecret,
    toolToken: randomBytes(24).toString('base64url'),
  };
}

/** The tool token the shop's .env already holds, for a tool added to an existing setup. Never printed. */
function keptToolToken(): string | null {
  if (!existsSync(ENV_OUT)) return null;
  const line = readFileSync(ENV_OUT, 'utf8')
    .split(/\r?\n/)
    .find((l) => /^\s*SUPPORT_TOOL_TOKEN\s*=/.test(l));
  const value = line
    ?.slice(line.indexOf('=') + 1)
    .trim()
    .replace(/^["']|["']$/g, '');
  return value || null;
}

/**
 * The AI's tools on the shop's server. `token` is new on first load and on
 * `--rekey`, and is given to every tool. Otherwise the existing tools keep
 * theirs, and a tool that is new gets the token the shop already checks:
 * without it the shop would answer every call with 401.
 */
async function loadTools(admin: string, token: string | null, teamIds: Map<string, string>) {
  const existing = await call<Array<{ name: string }>>(admin, 'GET', '/tools/custom');
  const kept = token ? null : keptToolToken();
  for (const { path, approverTeam: _approverTeam, ...definition } of tools) {
    const added = !existing.some((t) => t.name === definition.name);
    if (added) {
      await call(admin, 'POST', '/tools/custom', {
        ...definition,
        url: `${GARMENT_WORKER_URL}/api/support/tools${path}`,
        authHeader: 'Authorization',
        enabled: true,
      });
    }
    const value = token ?? (added ? kept : null);
    if (value) {
      await call(admin, 'PUT', `/settings/secrets/tool.custom_${definition.name}.token`, {
        value,
      });
    } else if (added) {
      log(
        `tool "${definition.name}" was added without a token (none in ${ENV_OUT}): set it in Orbit Desk, or load again with --rekey`,
      );
    }
  }
  // Who decides each tool's requests (refunds: Payments).
  const loaded = await call<Array<Ref & { name: string }>>(admin, 'GET', '/tools/custom');
  for (const t of tools.filter((x) => x.approverTeam)) {
    const id = loaded.find((l) => l.name === t.name)?.id;
    const teamId = teamIds.get(t.approverTeam!);
    if (id && teamId) await call(admin, 'PATCH', `/tools/${id}`, { approverTeamId: teamId });
  }
  const gated = tools.filter((t) => t.tier === 'transactional').map((t) => t.name);
  log(`${tools.length} tools for the AI on the shop's server (${gated.join(', ')} needs approval)`);
}

/**
 * Writes the SUPPORT_* settings into the app's .env, keeping every other
 * line. An admin sign-in is added when the file has none, so the storefront's
 * admin pages work on a fresh clone.
 */
function writeEnv(c: Connection) {
  const old = existsSync(ENV_OUT) ? readFileSync(ENV_OUT, 'utf8').split(/\r?\n/) : [];
  const kept = old.filter(
    (line) => !/^\s*SUPPORT_[A-Z_]+\s*=/.test(line) && !line.startsWith('# Support desk'),
  );
  while (kept.length && !kept.at(-1)!.trim()) kept.pop();
  const has = (name: string) =>
    kept.some((line) => new RegExp(`^\\s*${name}\\s*=\\s*\\S`).test(line));

  const lines = [...kept];
  if (!has('ADMIN_PASSWORD')) {
    if (lines.length) lines.push('');
    lines.push('# Shop admin sign-in (generated for the local demo)');
    if (!has('ADMIN_USERNAME')) lines.push('ADMIN_USERNAME=shop_admin');
    lines.push(`ADMIN_PASSWORD=${randomBytes(12).toString('base64url')}`);
  }
  if (lines.length) lines.push('');
  lines.push(
    `# Support desk (written by the TMS garment loader on ${new Date().toISOString().slice(0, 10)})`,
    `SUPPORT_API_URL=${API_URL}`,
    `SUPPORT_WIDGET_URL=${WIDGET_URL}`,
    `SUPPORT_INTEGRATION=${INTEGRATION.slug}`,
    `SUPPORT_API_KEY_WEB=${c.webKey}`,
    `SUPPORT_API_KEY_EVENTS=${c.eventsKey}`,
    `SUPPORT_WEBHOOK_SECRET=${c.webhookSecret}`,
    `SUPPORT_CHAT_IDENTITY_SECRET=${c.chatIdentitySecret}`,
    `SUPPORT_TOOL_TOKEN=${c.toolToken}`,
    `SUPPORT_DEMO_KEY_LIMITED=${c.limitedKey}`,
    '',
  );
  writeFileSync(ENV_OUT, lines.join('\n'), { mode: 0o600 });
  log(`the app's settings are in ${ENV_OUT} (keys and secrets are not shown here)`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
