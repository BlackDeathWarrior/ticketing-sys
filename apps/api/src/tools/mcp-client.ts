import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertPublicUrl } from '../common/url-fetch';

export interface McpTarget {
  url: string;
  /** Header name and value carrying the token, if the server needs one. */
  auth: { header: string; value: string } | null;
  /** Host names allowed to resolve to private addresses (compose services). */
  privateHosts: string[];
}

export interface ListedTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
}

export class McpCallError extends Error {
  constructor(
    message: string,
    /** The server answered, but reported the call as failed (isError). */
    readonly fromTool = false,
  ) {
    super(message);
    this.name = 'McpCallError';
  }
}

const CONNECT_TIMEOUT_MS = 8_000;
/** What the model sees of a result; the full result is stored on the tool call. */
export const RESULT_PREVIEW_CHARS = 6_000;

/**
 * One short-lived MCP session per operation over streamable HTTP. The URL is
 * checked against private addresses on every call (not only when saved), so
 * a DNS change can't point a registered server at internal services, and
 * redirects are refused outright.
 */
async function withClient<T>(target: McpTarget, fn: (c: Client) => Promise<T>): Promise<T> {
  const url = new URL(target.url);
  await assertPublicUrl(target.url, target.privateHosts.includes(url.hostname.toLowerCase()));
  const headers: Record<string, string> = {};
  if (target.auth) {
    headers[target.auth.header] =
      target.auth.header.toLowerCase() === 'authorization'
        ? `Bearer ${target.auth.value}`
        : target.auth.value;
  }
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
    fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }),
  });
  const client = new Client({ name: 'tms', version: '0.1.0' });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listTools(target: McpTarget): Promise<ListedTool[]> {
  return withClient(target, async (c) => {
    const out: ListedTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await c.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        out.push({
          name: t.name,
          title: t.title ?? t.annotations?.title ?? null,
          description: t.description ?? '',
          inputSchema: t.inputSchema as Record<string, unknown>,
          annotations: (t.annotations ?? {}) as Record<string, unknown>,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && out.length < 500);
    return out;
  });
}

/** Calls a tool; returns its structured result, or its text content parsed as JSON when possible. */
export async function callTool(
  target: McpTarget,
  name: string,
  args: Record<string, unknown>,
  timeoutMs: number,
): Promise<unknown> {
  return withClient(target, async (c) => {
    const r = await c.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
    const text = (Array.isArray(r.content) ? r.content : [])
      .map((p) => (p && typeof p === 'object' && 'text' in p ? String(p.text) : ''))
      .join('\n')
      .trim();
    if (r.isError) throw new McpCallError(text.slice(0, 500) || 'The tool reported an error', true);
    if (r.structuredContent) return r.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  });
}
