import type { AuthTokens, CurrentUser } from '@tms/shared';

const BASE = '/api/v1';
const STORAGE_KEY = 'tms.tokens';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: { message?: string | string[]; issues?: Array<{ path: string; message: string }> },
  ) {
    const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
    const issues = body?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ');
    super([msg ?? `Request failed (${status})`, issues].filter(Boolean).join(' — '));
  }
}

let tokens: AuthTokens | null = readTokens();

function readTokens(): AuthTokens | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as AuthTokens) : null;
  } catch {
    return null;
  }
}

function saveTokens(t: AuthTokens | null) {
  tokens = t;
  try {
    if (t) localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable: session lasts until reload.
  }
}

export const hasSession = () => tokens !== null;

async function raw(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let refreshing: Promise<boolean> | null = null;

async function refresh(): Promise<boolean> {
  if (!tokens) return false;
  refreshing ??= (async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens!.refreshToken }),
    });
    if (!res.ok) {
      saveTokens(null);
      return false;
    }
    saveTokens((await res.json()) as AuthTokens);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  if (res.status === 401 && (await refresh())) res = await raw(method, path, body);
  if (res.status === 401) window.dispatchEvent(new Event('tms:logout'));
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

export async function login(email: string, password: string): Promise<CurrentUser> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  saveTokens(data as AuthTokens);
  return api<CurrentUser>('GET', '/auth/me');
}

export async function logout(): Promise<void> {
  if (tokens)
    await raw('POST', '/auth/logout', { refreshToken: tokens.refreshToken }).catch(() => undefined);
  saveTokens(null);
}

export function qs(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [
    string,
    string,
  ][];
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
}
