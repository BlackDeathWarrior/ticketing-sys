/**
 * Loads the fictional sample data in ./data.ts into a running TMS.
 *
 * Everything goes through the public API (and the chat widget socket and the
 * support mailbox), so audit rows, outbox events, realtime updates and email
 * delivery all happen exactly as they would for real traffic. The one
 * exception is the optional backdating step, which rewrites ticket timestamps
 * directly in Postgres so charts have two weeks of history.
 *
 *   pnpm sample:load                 # load, then backdate
 *   pnpm sample:load -- --no-backdate
 *   pnpm sample:load -- --skip-inbound   # no chat/email traffic
 *
 * Env: API_URL (http://localhost:3000), ADMIN_EMAIL / ADMIN_PASSWORD
 * (admin@example.com / ChangeMe123!), DATABASE_URL for backdating,
 * SMTP_HOST / SMTP_PORT for the support mailbox (localhost:3025).
 */
import { parseArgs } from 'node:util';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { io } from 'socket.io-client';
import {
  chats,
  customers,
  emails,
  type FinalStatus,
  llm,
  MARKER_EMAIL,
  SAMPLE_PASSWORD,
  type SampleTicket,
  teams,
  tickets,
  users,
} from './data';

const { values: args } = parseArgs({
  options: {
    'no-backdate': { type: 'boolean', default: false },
    'skip-inbound': { type: 'boolean', default: false },
  },
});

const API_URL = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';
const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? 'ChangeMe123!';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://tms:tms@localhost:5432/tms';
const SMTP_HOST = process.env.SMTP_HOST ?? 'localhost';
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 3025);
const FAKE_LLM_URL = process.env.FAKE_LLM_URL ?? 'http://fake-providers:4010/v1';

interface Ref {
  id: string;
  name: string;
}
interface Ticket {
  id: string;
  reference: string;
  status: string;
}
interface Category extends Ref {
  children: Ref[];
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
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  return data as T;
}

async function login(email: string, password: string): Promise<string> {
  const res = await call<{ accessToken: string }>(null, 'POST', '/auth/login', { email, password });
  return res.accessToken;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs = 90_000) {
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
  const admin = await login(ADMIN_EMAIL, ADMIN_PASSWORD);

  const existing = await call<{ total: number }>(
    admin,
    'GET',
    `/customers?q=${encodeURIComponent(MARKER_EMAIL)}&limit=1`,
  );
  if (existing.total > 0) {
    console.log(
      'Sample data is already loaded (marker customer exists). Reset the database to load it again.',
    );
    return;
  }

  // ---- teams ----
  const teamIds = new Map<string, string>();
  for (const t of await call<Ref[]>(admin, 'GET', '/teams')) teamIds.set(t.name, t.id);
  for (const t of teams) {
    if (!teamIds.has(t.name)) {
      const created = await call<Ref>(admin, 'POST', '/teams', t);
      teamIds.set(t.name, created.id);
    }
  }
  log(`${teams.length} teams`);

  await loadLlm(admin);

  // ---- users ----
  const userIds = new Map<string, string>();
  const tokens = new Map<string, string>();
  const known = await call<Array<Ref & { email: string }>>(admin, 'GET', '/users');
  for (const u of users) {
    let id = known.find((k) => k.email === u.email)?.id;
    if (!id) {
      const created = await call<Ref>(admin, 'POST', '/users', {
        email: u.email,
        name: u.name,
        password: SAMPLE_PASSWORD,
        roles: u.roles,
        teamIds: u.teams.map((t) => teamIds.get(t)!),
      });
      id = created.id;
    }
    userIds.set(u.key, id);
    tokens.set(u.key, await login(u.email, SAMPLE_PASSWORD));
  }
  log(`${users.length} agents and leads (password ${SAMPLE_PASSWORD})`);
  const tokenOf = (key?: string) => (key ? tokens.get(key)! : admin);
  const lead = tokens.get('maya')!;

  // ---- customers ----
  const customerIds = new Map<string, string>();
  for (const c of customers) {
    const created = await call<Ref>(admin, 'POST', '/customers', {
      displayName: c.name,
      email: c.email,
      ...(c.phone ? { phone: c.phone } : {}),
      ...(c.language ? { language: c.language } : {}),
      customerType: c.type,
      attributes: { company: c.company },
    });
    customerIds.set(c.key, created.id);
    if (c.whatsapp) {
      await call(admin, 'POST', `/customers/${created.id}/identities`, {
        type: 'whatsapp',
        value: c.whatsapp,
        verified: true,
      });
    }
  }
  log(`${customers.length} customers`);

  // ---- categories ----
  const categories = await call<Category[]>(admin, 'GET', '/categories');
  const categoryIds = (path?: string) => {
    if (!path) return {};
    const [parentName, childName] = path.split('/');
    const parent = categories.find((c) => c.name === parentName);
    const child = parent?.children.find((c) => c.name === childName);
    if (!parent) throw new Error(`Unknown category ${path}`);
    return { categoryId: parent.id, ...(child ? { subcategoryId: child.id } : {}) };
  };

  // ---- tickets ----
  const created: Array<{ spec: SampleTicket; ticket: Ticket }> = [];
  for (const spec of tickets) {
    const ticket = await call<Ticket>(admin, 'POST', '/tickets', {
      customerId: customerIds.get(spec.customer)!,
      subject: spec.subject,
      description: spec.description,
      priority: spec.priority,
      channel: spec.channel,
      tags: spec.tags ?? [],
      ...categoryIds(spec.category),
    });
    await playOut(spec, ticket, { lead, tokenOf, teamIds, userIds });
    created.push({ spec, ticket });
  }
  log(`${tickets.length} tickets with assignments, notes, replies and status changes`);

  // ---- inbound traffic: web chat and email ----
  if (!args['skip-inbound']) {
    const chatRefs = await sendChats(admin);
    log(`${chatRefs.length} web chat conversations (${chatRefs.join(', ')})`);
    const emailRefs = await sendEmails(admin);
    log(`${emailRefs.length} customer emails (${emailRefs.join(', ')})`);

    // An agent picks up the first chat and the first email and answers them.
    const [chatTicket] = chatRefs;
    const [emailTicket] = emailRefs;
    await answer(
      chatTicket!,
      'jonah',
      'Hi Bea, thanks for flagging this. SPRING10 is valid until Sunday; I have re-enabled it on your account.',
      { lead, tokenOf, userIds, teamIds, team: 'Orders', admin },
    );
    await answer(
      emailTicket!,
      'sam',
      'Hello Chidi, sorry about the screen. Please reply with the photos and we will send a replacement right away.',
      { lead, tokenOf, userIds, teamIds, team: 'Returns', admin },
    );
    log(`agents replied on ${chatTicket} (chat) and ${emailTicket} (email)`);
  }

  if (!args['no-backdate']) {
    await backdate(created);
    log('ticket timestamps spread over the last 14 days');
  }

  console.log(`\nDone. Sign in as ${ADMIN_EMAIL}, or as any agent above with ${SAMPLE_PASSWORD}.`);
}

interface Ctx {
  lead: string;
  tokenOf: (key?: string) => string;
  teamIds: Map<string, string>;
  userIds: Map<string, string>;
}

/** Assigns, annotates, replies and walks the workflow to the ticket's final status. */
async function playOut(spec: SampleTicket, ticket: Ticket, ctx: Ctx) {
  const id = ticket.id;
  const teamId = spec.team ? ctx.teamIds.get(spec.team) : undefined;
  const assigneeId = spec.assignee ? ctx.userIds.get(spec.assignee) : undefined;
  if (teamId || assigneeId) {
    await call(ctx.lead, 'POST', `/tickets/${id}/assign`, {
      ...(assigneeId ? { assigneeId } : {}),
      ...(teamId ? { teamId } : {}),
    });
  }
  for (const n of spec.notes ?? []) {
    await call(ctx.tokenOf(n.by), 'POST', `/tickets/${id}/notes`, { body: n.body });
  }
  if (spec.reply) {
    await call(ctx.tokenOf(spec.reply.by), 'POST', `/tickets/${id}/conversations`, {
      channel: 'email',
      body: spec.reply.body,
    });
  }

  const actor = ctx.tokenOf(spec.assignee);
  const current = (await call<Ticket>(actor, 'GET', `/tickets/${id}`)).status;
  for (const step of stepsTo(current, spec.status)) {
    await call(actor, 'POST', `/tickets/${id}/transition`, {
      status: step,
      ...(step === 'resolved' && spec.resolution ? { resolution: spec.resolution } : {}),
    });
  }
}

/** Transitions from `current` to `target` that the default workflow allows. */
export function stepsTo(current: string, target: FinalStatus): string[] {
  if (current === target) return [];
  switch (target) {
    case 'new':
    case 'human_assigned':
      return [];
    case 'ai_handling':
    case 'in_progress':
      return [target];
    case 'pending_customer':
      return current === 'new' ? ['in_progress', 'pending_customer'] : ['pending_customer'];
    case 'resolved':
      return ['resolved'];
    case 'closed':
      return current === 'resolved' ? ['closed'] : ['resolved', 'closed'];
  }
}

/** Registers the scripted demo LLM so AI features run without real keys. */
async function loadLlm(admin: string) {
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
    const created = await call<{ id: string }>(admin, 'POST', '/settings/llm/models', {
      providerId: provider.id,
      ...m,
    });
    ids[m.model] = created.id;
  }
  await call(admin, 'PUT', '/settings/llm/roles/embedding', {
    mode: 'ordered',
    modelIds: [ids['scripted-embed']],
  });
  const test = await call<{ ok: boolean; error?: string }>(
    admin,
    'POST',
    `/settings/llm/providers/${provider.id}/test`,
  );
  if (!test.ok) console.warn(`  (the demo LLM did not answer: ${test.error})`);
  for (let i = 0; i < llm.warmUpCalls; i++) {
    await call(admin, 'POST', '/settings/llm/roles/chat_agent/try', {});
  }
  log(`demo LLM provider with ${llm.models.length} models`);
}

async function sendChats(admin: string): Promise<string[]> {
  const refs: string[] = [];
  for (const c of chats) {
    const socket = io(`${API_URL}/chat`, {
      transports: ['websocket'],
      auth: { name: c.name, email: c.email },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('session', () => resolve());
      socket.once('connect_error', reject);
    });
    const ack = (await socket.timeout(10_000).emitWithAck('message', {
      text: c.text,
      clientMessageId: `sample-${c.email}`,
    })) as { ok: boolean; error?: string };
    socket.disconnect();
    if (!ack.ok) throw new Error(`chat message failed: ${ack.error}`);
    const ref = await waitFor(`chat ticket for ${c.name}`, async () => {
      const page = await call<{ items: Array<Ticket & { customer: { displayName: string } }> }>(
        admin,
        'GET',
        '/tickets?channel=webchat&limit=50',
      );
      return page.items.find((t) => t.customer.displayName === c.name)?.reference;
    });
    refs.push(ref);
  }
  return refs;
}

async function sendEmails(admin: string): Promise<string[]> {
  const transport = nodemailer.createTransport({ host: SMTP_HOST, port: SMTP_PORT, secure: false });
  for (const e of emails) {
    await transport.sendMail({
      from: { name: e.fromName, address: e.from },
      to: 'support@tms.local',
      subject: e.subject,
      text: e.text,
    });
  }
  transport.close();
  const refs: string[] = [];
  for (const e of emails) {
    refs.push(
      await waitFor(`email ticket "${e.subject}"`, async () => {
        const page = await call<{ items: Ticket[] }>(
          admin,
          'GET',
          `/tickets?channel=email&q=${encodeURIComponent(e.subject)}&limit=5`,
        );
        return page.items[0]?.reference;
      }),
    );
  }
  return refs;
}

async function answer(
  reference: string,
  agent: string,
  body: string,
  ctx: Ctx & { team: string; admin: string },
) {
  const ticket = await call<Ticket>(ctx.admin, 'GET', `/tickets/${reference}`);
  await call(ctx.lead, 'POST', `/tickets/${ticket.id}/assign`, {
    assigneeId: ctx.userIds.get(agent),
    teamId: ctx.teamIds.get(ctx.team),
  });
  const [conversation] = await call<Array<{ id: string }>>(
    ctx.admin,
    'GET',
    `/tickets/${ticket.id}/conversations`,
  );
  await call(ctx.tokenOf(agent), 'POST', `/conversations/${conversation!.id}/messages`, { body });
}

/**
 * Dev-only: spreads ticket timestamps over the last two weeks so the volume
 * chart, resolution medians and "opened 3d ago" labels look like real history.
 */
async function backdate(items: Array<{ spec: SampleTicket; ticket: Ticket }>) {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const [i, { spec, ticket }] of items.entries()) {
      const firstResponseMinutes = 10 + ((i * 37) % 170);
      await client.query(
        `UPDATE tickets SET
           created_at = now() - make_interval(hours => $2::int),
           first_response_at = CASE WHEN first_response_at IS NULL AND $3::boolean THEN NULL
             ELSE now() - make_interval(hours => $2::int) + make_interval(mins => LEAST($4::int, $2::int * 60 - 5)) END,
           resolved_at = CASE WHEN $5::int IS NULL THEN resolved_at
             ELSE now() - make_interval(hours => $2::int) + make_interval(hours => $5::int) END,
           closed_at = CASE WHEN closed_at IS NULL OR $5::int IS NULL THEN closed_at
             ELSE now() - make_interval(hours => $2::int) + make_interval(hours => $5::int + 1) END,
           updated_at = CASE WHEN $5::int IS NULL THEN updated_at
             ELSE now() - make_interval(hours => $2::int) + make_interval(hours => $5::int) END
         WHERE id = $1`,
        [
          ticket.id,
          spec.ageHours,
          !spec.reply && !spec.resolveAfterHours,
          firstResponseMinutes,
          spec.resolveAfterHours ?? null,
        ],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
