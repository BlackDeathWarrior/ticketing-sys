import type { AuthTokens, CurrentUser } from '@tms/shared';

const BASE = '/api/v1';
const STORAGE_KEY = 'orbit.tokens';

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

/** The reply's JSON. A proxy's error page (the API is restarting) becomes a plain message. */
async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { message: `The service isn't answering right now (${res.status}). Try again shortly.` };
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
    // Storage unavailable: the session lasts until reload.
  }
}

export const hasSession = () => tokens !== null;

/** Current access token, for the realtime socket handshake. */
export const accessToken = () => tokens?.accessToken;

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
      // Only a refused token ends the session; a busy or restarting API doesn't.
      if (res.status === 401 || res.status === 403) saveTokens(null);
      return false;
    }
    saveTokens((await res.json()) as AuthTokens);
    return true;
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** A fresh access token for something that is not an API call (the live socket). False when signed out. */
export function refreshSession(): Promise<boolean> {
  return refresh();
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await raw(method, path, body);
  if (res.status === 401 && (await refresh())) res = await raw(method, path, body);
  if (res.status === 401 && !tokens) window.dispatchEvent(new Event('orbit:logout'));
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data as ApiError['body']);
  return data as T;
}

/** POSTs multipart form data (file uploads) with the session's token. */
export async function apiForm<T = unknown>(path: string, form: FormData): Promise<T> {
  const send = () =>
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: tokens ? { authorization: `Bearer ${tokens.accessToken}` } : {},
      body: form,
    });
  let res = await send();
  if (res.status === 401 && (await refresh())) res = await send();
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data as ApiError['body']);
  return data as T;
}

/** Opens an authenticated file (e.g. a KB document) in a new tab via a blob URL. */
export async function openFile(apiPath: string): Promise<void> {
  const path = apiPath.startsWith(BASE) ? apiPath.slice(BASE.length) : apiPath;
  let res = await raw('GET', path);
  if (res.status === 401 && (await refresh())) res = await raw('GET', path);
  if (!res.ok)
    throw new ApiError(res.status, { message: `Could not open the file (${res.status})` });
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Downloads an authenticated file (e.g. a message attachment) under its own name. */
/** A file behind the API, fetched with the agent's token (for players and downloads). */
export async function fetchBlob(apiPath: string): Promise<Blob> {
  let res = await raw('GET', apiPath);
  if (res.status === 401 && (await refresh())) res = await raw('GET', apiPath);
  if (!res.ok)
    throw new ApiError(res.status, { message: `Could not download the file (${res.status})` });
  return res.blob();
}

export async function downloadFile(apiPath: string, filename: string): Promise<void> {
  const url = URL.createObjectURL(await fetchBlob(apiPath));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function login(email: string, password: string): Promise<CurrentUser> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const data = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, data as ApiError['body']);
  saveTokens(data as AuthTokens);
  return api<CurrentUser>('GET', '/auth/me');
}

export async function logout(): Promise<void> {
  if (tokens)
    await raw('POST', '/auth/logout', { refreshToken: tokens.refreshToken }).catch(() => undefined);
  saveTokens(null);
}

export function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => [k, String(v)] as [string, string]);
  return entries.length ? `?${new URLSearchParams(entries)}` : '';
}
