/**
 * Loads the fictional sample data in ./data.ts into a running TMS.
 *
 * Everything goes through the public API (and the chat widget socket and the
 * support mailbox), so audit rows, outbox events, realtime updates and email
 * delivery all happen exactly as they would for real traffic. Customers rate
 * their tickets the real way too: in the chat, and in the portal after opening
 * the sign-in link emailed to them. The one exception is the optional
 * backdating step, which rewrites timestamps directly in Postgres so charts
 * have two weeks of history and the AI's "quiet for 72 hours" rule applies.
 *
 *   pnpm sample:load                 # load, then backdate
 *   pnpm sample:load -- --no-backdate
 *   pnpm sample:load -- --skip-inbound   # no chat/email traffic
 *
 * Env: API_URL (http://localhost:3000), ADMIN_EMAIL / ADMIN_PASSWORD
 * (admin@example.com / ChangeMe123!), DATABASE_URL for backdating,
 * SMTP_HOST / SMTP_PORT for the support mailbox (localhost:3025), MAILPIT_URL
 * for the inbox outgoing mail lands in (http://localhost:8025).
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { io } from 'socket.io-client';
import {
  chats,
  customers,
  emails,
  type FinalStatus,
  kb,
  llm,
  answeredByPerson,
  lessons,
  MARKER_EMAIL,
  quietChats,
  ratings,
  SAMPLE_PASSWORD,
  type SampleTicket,
  teams,
  tickets,
  users,
  operations,
  tools,
  webForms,
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
/** Where the stack's outgoing mail lands; the loader reads customers' sign-in links from it. */
const MAILPIT_URL = (process.env.MAILPIT_URL ?? 'http://localhost:8025').replace(/\/$/, '');
const FAKE_LLM_URL = process.env.FAKE_LLM_URL ?? 'http://fake-providers:4010/v1';
/** The sample MCP server as the API container reaches it, and as this script does. */
const FAKE_MCP_URL = process.env.FAKE_MCP_URL ?? 'http://fake-providers:4010/mcp';
const FAKE_PROVIDERS_HOST_URL = process.env.FAKE_PROVIDERS_HOST_URL ?? 'http://localhost:4010';

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
  await loadKb(admin);
  await loadTools(admin);

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
  await loadOperations(admin, teamIds, userIds);
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
    const { refs: chatRefs, sessions } = await sendChats(admin);
    log(`${chatRefs.length} web chat conversations (${chatRefs.join(', ')})`);
    const emailRefs = await sendEmails(admin);
    log(`${emailRefs.length} customer emails (${emailRefs.join(', ')})`);
    const formRefs = await sendWebForms();
    log(`${formRefs.length} help-center requests (${formRefs.join(', ')})`);

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

    if (!args['no-backdate']) {
      const done = await resolveQuietChats(admin, sessions);
      log(`${done} chats resolved by the AI after the customer went quiet, and rated in the chat`);
    }

    // The chat an agent took over is solved, and the visitor rates it.
    const solved = await call<Ticket>(admin, 'GET', `/tickets/${chatTicket!}`);
    await call(tokenOf(answeredByPerson.agent), 'POST', `/tickets/${solved.id}/transition`, {
      status: 'resolved',
    });
    await rateInChat(
      sessions.get(answeredByPerson.name)!,
      answeredByPerson.name,
      answeredByPerson.rating,
      answeredByPerson.comment,
    );
    log(`${chatTicket} solved by an agent and rated ${answeredByPerson.rating} in the chat`);
  }

  for (const l of lessons) {
    await call(tokenOf(l.by), 'POST', '/learning/lessons', { body: l.body });
  }
  log(`${lessons.length} lesson for the AI, written after a rating`);

  const rated = await rateInPortal();
  log(
    rated === null
      ? 'no portal ratings: the mail inbox (Mailpit) could not be reached'
      : `${rated} tickets rated by customers in the portal`,
  );

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

/** SLA hours and policies, routing rules, skills and presence (Phase 7). */
async function loadOperations(
  admin: string,
  teamIds: Map<string, string>,
  userIds: Map<string, string>,
) {
  const hours = await call<Ref>(admin, 'POST', '/sla/business-hours', operations.hours);
  for (const { supportHours, ...p } of operations.policies as Array<
    Record<string, unknown> & { supportHours?: boolean }
  >) {
    await call(admin, 'POST', '/sla/policies', {
      ...p,
      ...(supportHours ? { businessHoursId: hours.id } : {}),
    });
  }
  for (const r of operations.rules) {
    const { team, ...rule } = r;
    await call(admin, 'POST', '/routing/rules', { ...rule, teamId: teamIds.get(team) });
  }
  for (const [key, skills] of Object.entries(operations.skills)) {
    await call(admin, 'PUT', `/routing/agents/${userIds.get(key)}/skills`, { skills });
  }
  for (const [key, p] of Object.entries(operations.presence)) {
    await call(admin, 'PUT', `/routing/agents/${userIds.get(key)}/presence`, p);
  }
  log(
    `${operations.policies.length} SLA policies, ${operations.rules.length} routing rules, ` +
      `${Object.values(operations.presence).filter((p) => p.status === 'online').length} agents online`,
  );
}

/** Registers the Demo Store MCP server, stores its placeholder token and turns its tools on. */
async function loadTools(admin: string) {
  await fetch(`${FAKE_PROVIDERS_HOST_URL}/demo-store/reset`, { method: 'POST' }).catch(() => {
    console.warn('  (could not reset the Demo Store sample server)');
  });
  const existing = await call<Array<{ id: string; name: string; slug: string }>>(
    admin,
    'GET',
    '/tools/servers',
  );
  const server =
    existing.find((s) => s.name === tools.server.name) ??
    (await call<{ id: string; slug: string }>(admin, 'POST', '/tools/servers', {
      ...tools.server,
      url: FAKE_MCP_URL,
    }));
  await call(admin, 'PUT', `/settings/secrets/tool.${server.slug}.token`, { value: tools.token });
  const listed = await call<Array<{ id: string; name: string; tier: string }>>(
    admin,
    'POST',
    `/tools/servers/${server.id}/sync`,
  );
  for (const t of listed.filter((x) => tools.enable.includes(x.name))) {
    await call(admin, 'PATCH', `/tools/${t.id}`, { enabled: true });
  }
  const custom = await call<Array<{ name: string }>>(admin, 'GET', '/tools/custom');
  if (!custom.some((t) => t.name === tools.custom.name)) {
    const { path, ...definition } = tools.custom;
    await call(admin, 'POST', '/tools/custom', {
      ...definition,
      url: new URL(path, FAKE_MCP_URL).toString(),
    });
  }
  log(
    `Demo Store MCP server with ${listed.length} tools (${listed
      .filter((t) => t.tier === 'transactional')
      .map((t) => t.name)
      .join(', ')} needs approval), and 1 custom tool`,
  );
}

/** Uploads the fictional knowledge base, waits for indexing and approves it. */
async function loadKb(admin: string) {
  const dir = new URL('./kb/', import.meta.url);
  const ids: string[] = [];
  for (const f of kb.files) {
    const form = new FormData();
    form.append('visibility', f.visibility);
    form.append(
      'file',
      new Blob([readFileSync(new URL(f.file, dir))], { type: f.contentType }),
      f.file,
    );
    const res = await fetch(`${API_URL}/api/v1/kb/documents/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${admin}` },
      body: form,
    });
    if (!res.ok) throw new Error(`upload ${f.file} → ${res.status}: ${await res.text()}`);
    ids.push(((await res.json()) as { id: string }).id);
  }
  const faqs = JSON.parse(readFileSync(new URL(kb.faqFile, dir), 'utf8')) as Array<{
    question: string;
    answer: string;
  }>;
  for (const f of faqs) {
    const doc = await call<{ id: string }>(admin, 'POST', '/kb/documents', {
      source: 'faq',
      title: f.question,
      content: f.answer,
      visibility: 'public',
      language: 'hi',
    });
    ids.push(doc.id);
  }
  const internal = await call<{ id: string }>(admin, 'POST', '/kb/documents', {
    source: 'text',
    visibility: 'internal',
    ...kb.internal,
  });
  ids.push(internal.id);
  await call(admin, 'POST', '/kb/documents', { source: 'text', visibility: 'public', ...kb.draft });

  for (const id of ids) {
    await waitFor(`KB document ${id} to be indexed`, async () => {
      const d = await call<{ indexState: string }>(admin, 'GET', `/kb/documents/${id}`);
      if (d.indexState === 'failed') throw new Error(`indexing ${id} failed`);
      return d.indexState === 'indexed' || undefined;
    });
    await call(admin, 'POST', `/kb/documents/${id}/status`, { status: 'approved' });
  }
  log(`${ids.length} knowledge base documents (+1 draft)`);
}

async function sendChats(admin: string) {
  const refs: string[] = [];
  /** The session token of each visitor, to come back as the same person later. */
  const sessions = new Map<string, string>();
  for (const c of chats) {
    const socket = io(`${API_URL}/chat`, {
      transports: ['websocket'],
      auth: { name: c.name, email: c.email },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('session', (s: { token: string }) => {
        sessions.set(c.name, s.token);
        resolve();
      });
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
  return { refs, sessions };
}

/**
 * The chats the AI answered and the customer left alone. Dev-only, like
 * `backdate`: their history is moved back in time, so the AI's rule "resolve
 * after 72 quiet hours" applies today. The AI then resolves them through the
 * API, and each visitor comes back to answer the rating question in the chat.
 */
async function resolveQuietChats(admin: string, sessions: Map<string, string>): Promise<number> {
  type Row = Ticket & { handling: string; customer: { displayName: string } };
  const find = async (name: string) =>
    (await call<{ items: Row[] }>(admin, 'GET', '/tickets?channel=webchat&limit=50')).items.find(
      (t) => t.customer.displayName === name,
    );

  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    for (const q of quietChats) {
      // The AI's answer has gone out and the ticket waits for the customer.
      const ticket = await waitFor(`the AI's answer to ${q.name}`, async () => {
        const t = await find(q.name);
        return t?.status === 'pending_customer' && t.handling === 'ai' ? t : undefined;
      });
      await client.query('BEGIN');
      const shift = [ticket.id, q.quietHours];
      await client.query(
        `UPDATE tickets SET created_at = created_at - make_interval(hours => $2::int),
           first_response_at = first_response_at - make_interval(hours => $2::int),
           updated_at = updated_at - make_interval(hours => $2::int)
         WHERE id = $1`,
        shift,
      );
      await client.query(
        `UPDATE messages m SET created_at = m.created_at - make_interval(hours => $2::int),
           sent_at = m.sent_at - make_interval(hours => $2::int)
         FROM conversations c WHERE c.id = m.conversation_id AND c.ticket_id = $1`,
        shift,
      );
      await client.query(
        `UPDATE sla_timers SET started_at = started_at - make_interval(hours => $2::int),
           due_at = due_at - make_interval(hours => $2::int),
           at_risk_at = at_risk_at - make_interval(hours => $2::int),
           resumed_at = resumed_at - make_interval(hours => $2::int),
           met_at = met_at - make_interval(hours => $2::int)
         WHERE ticket_id = $1`,
        shift,
      );
      await client.query('COMMIT');
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }

  await call(admin, 'POST', '/ai/auto-resolve');

  let rated = 0;
  for (const q of quietChats) {
    await waitFor(`${q.name}'s chat to be resolved`, async () =>
      (await find(q.name))?.status === 'resolved' ? true : undefined,
    );
    if (await rateInChat(sessions.get(q.name)!, q.name, q.rating, q.comment)) rated++;
  }
  return rated;
}

/** The visitor comes back to the chat and answers the "How did we do?" question waiting there. */
async function rateInChat(
  sessionToken: string,
  name: string,
  rating: number,
  comment?: string,
): Promise<boolean> {
  const socket = io(`${API_URL}/chat`, {
    transports: ['websocket'],
    auth: { token: sessionToken },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('session', () => resolve());
      socket.once('connect_error', reject);
    });
    const prompt = await waitFor(`the rating question for ${name}`, async () => {
      const h = (await socket.timeout(10_000).emitWithAck('history')) as {
        rate?: { token: string } | null;
      };
      return h.rate ?? undefined;
    });
    const ack = (await socket.timeout(10_000).emitWithAck('rate', {
      token: prompt.token,
      rating,
      ...(comment ? { comment } : {}),
    })) as { ok: boolean };
    return ack.ok;
  } finally {
    socket.disconnect();
  }
}

/**
 * Customers rate their resolved tickets in the portal. Each one signs in the
 * real way: asks for a link, and opens the one that arrives by email (read
 * here from Mailpit, where the stack's outgoing mail lands).
 */
async function rateInPortal(): Promise<number | null> {
  const mail = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${MAILPIT_URL}/api/v1${path}`);
    if (!res.ok) throw new Error(`Mailpit ${path} → ${res.status}`);
    return (await res.json()) as T;
  };
  try {
    await mail('/info');
  } catch {
    return null;
  }

  let rated = 0;
  for (const key of [...new Set(ratings.map((r) => r.customer))]) {
    const email = customers.find((c) => c.key === key)!.email;
    await call(null, 'POST', '/public/portal/sign-in', { email });
    const token = await waitFor(`the sign-in link for ${email}`, async () => {
      const query = encodeURIComponent(`to:"${email}" subject:"sign-in link"`);
      const found = await mail<{ messages: Array<{ ID: string }> }>(`/search?query=${query}`);
      const id = found.messages[0]?.ID;
      if (!id) return undefined;
      const { Text } = await mail<{ Text: string }>(`/message/${id}`);
      return /#\/portal\/verify\/(\S+)/.exec(Text)?.[1];
    });
    const session = await call<{ token: string }>(null, 'POST', '/public/portal/session', {
      token,
    });
    const mine = await call<Array<{ reference: string; subject: string }>>(
      session.token,
      'GET',
      '/portal/tickets',
    );
    for (const r of ratings.filter((x) => x.customer === key)) {
      const ticket = mine.find((t) => t.subject === r.subject);
      if (!ticket) throw new Error(`No ticket "${r.subject}" for ${email}`);
      await call(session.token, 'POST', `/portal/tickets/${ticket.reference}/rating`, {
        rating: r.rating,
        ...(r.comment ? { comment: r.comment } : {}),
      });
      rated++;
    }
  }
  return rated;
}

/** Submits the help-center form as a customer would (no token). */
async function sendWebForms(): Promise<string[]> {
  const form = await call<{ categories: Ref[] }>(null, 'GET', '/public/request-form');
  const refs: string[] = [];
  for (const { topic, ...f } of webForms) {
    const categoryId = form.categories.find((c) => c.name === topic)?.id;
    const receipt = await call<{ reference: string }>(null, 'POST', '/public/requests', {
      ...f,
      ...(categoryId ? { categoryId } : {}),
    });
    refs.push(receipt.reference);
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
  // Routing may already have given the ticket to another team than the lead's (ADR 0031).
  await call(ctx.admin, 'POST', `/tickets/${ticket.id}/assign`, {
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
  const ids = items.map((x) => x.ticket.id);
  // The worker starts SLA timers from ticket events; wait for them before shifting time.
  await waitFor('SLA timers on the sample tickets', async () => {
    const r = await client.query<{ n: string }>(
      'SELECT count(DISTINCT ticket_id) AS n FROM sla_timers WHERE ticket_id = ANY($1)',
      [ids],
    );
    return Number(r.rows[0]?.n) >= ids.length || undefined;
  });
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
    // Timers move with their tickets: same start, deadlines shifted by the same amount.
    await client.query(
      `UPDATE sla_timers s SET
         due_at = s.due_at - (s.started_at - t.created_at),
         at_risk_at = s.at_risk_at - (s.started_at - t.created_at),
         resumed_at = s.resumed_at - (s.started_at - t.created_at),
         met_at = CASE
           WHEN s.kind = 'first_response' AND t.first_response_at IS NOT NULL THEN t.first_response_at
           WHEN s.kind = 'resolution' AND t.resolved_at IS NOT NULL THEN t.resolved_at
           ELSE s.met_at END,
         started_at = t.created_at
       FROM tickets t WHERE s.ticket_id = t.id AND t.id = ANY($1)`,
      [ids],
    );
    // Answered and resolved tickets settle their timers: met, or breached when late.
    await client.query(
      `UPDATE sla_timers s SET
         state = CASE WHEN x.done_at > s.due_at THEN 'breached' ELSE 'met' END,
         breached_at = CASE WHEN x.done_at > s.due_at THEN s.due_at ELSE NULL END,
         met_at = x.done_at,
         at_risk_notified = true
       FROM (
         SELECT s2.id, CASE WHEN s2.kind = 'first_response' THEN t.first_response_at ELSE t.resolved_at END AS done_at
         FROM sla_timers s2 JOIN tickets t ON t.id = s2.ticket_id
         WHERE t.id = ANY($1)
       ) x
       WHERE s.id = x.id AND x.done_at IS NOT NULL AND s.state IN ('running', 'met')`,
      [ids],
    );
    await client.query(
      `UPDATE tickets t SET sla_state = CASE
         WHEN EXISTS (SELECT 1 FROM sla_timers s WHERE s.ticket_id = t.id AND s.state = 'breached' AND s.met_at IS NULL) THEN 'breached'
         WHEN NOT EXISTS (SELECT 1 FROM sla_timers s WHERE s.ticket_id = t.id AND s.state IN ('running', 'paused')) THEN 'met'
         ELSE t.sla_state END
       WHERE t.id = ANY($1)`,
      [ids],
    );
    await client.query(
      `UPDATE tickets t SET sla_due_at = (
         SELECT min(due_at) FROM sla_timers s WHERE s.ticket_id = t.id AND s.state = 'running')
       WHERE t.id = ANY($1)`,
      [ids],
    );
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
