import { ADMIN, env } from './env';

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface TicketRow {
  id: string;
  number: number;
  reference: string;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  assignee: { id: string; name: string } | null;
  customer: { id: string; displayName: string };
}

export async function login(email = ADMIN.email, password = ADMIN.password): Promise<Tokens> {
  const res = await fetch(`${env.api}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`);
  return (await res.json()) as Tokens;
}

/** Calls the API; returns status and parsed body without throwing on 4xx. */
export async function raw<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${env.api}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
}

export async function call<T = unknown>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await raw<T>(token, method, path, body);
  if (res.status >= 400) {
    throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

export async function findTicket(token: string, subject: string): Promise<TicketRow> {
  const page = await call<{ items: TicketRow[] }>(
    token,
    'GET',
    `/tickets?q=${encodeURIComponent(subject)}&limit=5`,
  );
  const hit = page.items.find((t) => t.subject === subject);
  if (!hit) throw new Error(`No ticket "${subject}". Did you run pnpm sample:load?`);
  return hit;
}

export async function customerByEmail(token: string, email: string) {
  const page = await call<{ items: Array<{ id: string; displayName: string }> }>(
    token,
    'GET',
    `/customers?q=${encodeURIComponent(email)}&limit=1`,
  );
  if (!page.items[0]) throw new Error(`No customer ${email}. Did you run pnpm sample:load?`);
  return page.items[0];
}

export async function userByEmail(token: string, email: string) {
  const users = await call<Array<{ id: string; email: string; name: string }>>(
    token,
    'GET',
    '/users',
  );
  const u = users.find((x) => x.email === email);
  if (!u) throw new Error(`No user ${email}`);
  return u;
}

/** Polls until `check` returns a truthy value. */
export async function eventually<T>(
  what: string,
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 60_000,
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
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}${last ? `: ${String(last)}` : ''}`);
}

export const unique = (label: string) => `${label} ${Date.now().toString(36)}`;

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
}

/** Messages in Mailpit (outgoing mail from TMS) matching a search. */
export async function mailpitSearch(query: string): Promise<MailpitMessage[]> {
  const res = await fetch(`${env.mailpit}/api/v1/search?query=${encodeURIComponent(query)}`);
  if (!res.ok) throw new Error(`Mailpit search failed: ${res.status}`);
  return ((await res.json()) as { messages: MailpitMessage[] }).messages;
}

export async function mailpitText(id: string): Promise<string> {
  const res = await fetch(`${env.mailpit}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}
