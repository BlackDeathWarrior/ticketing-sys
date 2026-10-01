import type { CustomToolHttp } from '@tms/shared';
import { urlPlaceholders } from '@tms/shared';
import { assertPublicUrl } from '../common/url-fetch';

/** A custom tool's request, ready to send. */
export interface HttpToolRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export class HttpToolError extends Error {
  constructor(
    message: string,
    /**
     * The system answered and said no (4xx, e.g. "order not found"): a real
     * answer, not an outage, so it doesn't count against the circuit breaker.
     */
    readonly fromTool = false,
  ) {
    super(message);
    this.name = 'HttpToolError';
  }
}

/** The most we read of an answer; tool results are small JSON documents. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Turns a tool definition and its arguments into a request: `{placeholders}`
 * in the URL are filled (and escaped) from the arguments; the rest go in the
 * query string for GET and DELETE, or in a JSON body otherwise.
 */
export function buildRequest(
  http: CustomToolHttp,
  args: Record<string, unknown>,
  token: string | null,
): HttpToolRequest {
  const inPath = urlPlaceholders(http.url);
  let url = http.url;
  for (const name of inPath) {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      throw new HttpToolError(`Missing a value for ${name}`, true);
    }
    url = url.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
  }
  const rest = Object.entries(args).filter(
    ([k, v]) => !inPath.includes(k) && v !== undefined && v !== null,
  );

  const headers: Record<string, string> = { accept: 'application/json' };
  if (http.authHeader && token) {
    headers[http.authHeader] =
      http.authHeader.toLowerCase() === 'authorization' ? `Bearer ${token}` : token;
  }

  if (http.method === 'GET' || http.method === 'DELETE') {
    const target = new URL(url);
    for (const [k, v] of rest) target.searchParams.set(k, String(v));
    return { url: target.toString(), method: http.method, headers };
  }
  return {
    url,
    method: http.method,
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(Object.fromEntries(rest)),
  };
}

/**
 * Calls a custom tool. The address is checked against private networks on
 * every call (a DNS change must not turn a saved tool into a way in), and
 * redirects are refused: they could lead anywhere, with the token attached.
 */
export async function callHttpTool(
  http: CustomToolHttp,
  args: Record<string, unknown>,
  opts: { token: string | null; timeoutMs: number; privateHosts: string[] },
): Promise<unknown> {
  const request = buildRequest(http, args, opts.token);
  const host = new URL(request.url).hostname.toLowerCase();
  await assertPublicUrl(request.url, opts.privateHosts.includes(host));

  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'error',
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const text = await readCapped(response);
  if (!response.ok) {
    const detail = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    throw new HttpToolError(
      `The system answered ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status >= 400 && response.status < 500 && response.status !== 429,
    );
  }
  if (!text.trim()) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { text: text.slice(0, 20_000) };
  }
}

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new HttpToolError('The answer is too large to use');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new HttpToolError('The answer is too large to use');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
