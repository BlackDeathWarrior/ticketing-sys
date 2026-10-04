import { createHash, createSign } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join, relative, resolve, sep } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { type KbConnectorType, kbConnectorConfigSchemas } from '@tms/shared';
import { createConnection } from 'mysql2/promise';
import { Client } from 'pg';
import type { z } from 'zod';
import {
  assertPublicUrl,
  fetchPublicUrl,
  isPrivateAddress,
  UnsafeUrlError,
} from '../../common/url-fetch';
import { detectKind, extractText, htmlTitle, htmlToText } from '../extract';

/**
 * The outside sources a knowledge-base connector reads (ADR 0033). Each one
 * lists what is there (with a version that changes when the item does) and
 * fetches an item's text. They talk to the real service; there are no
 * stand-ins. Every address is checked before it is used: public addresses
 * only, unless an admin allowed a private host (`KB_CONNECTOR_PRIVATE_HOSTS`),
 * and folders only inside `KB_CONNECTOR_PATHS`.
 */
export interface SourceItem {
  /** Stable id in the source: a URL, a path, a page id. */
  externalId: string;
  title: string;
  /** Changes when the item changes: an etag, a modified time, a hash. */
  version: string;
  url?: string | null;
}

export interface FetchedItem {
  title: string;
  text: string;
  url?: string | null;
}

export interface ConnectorSource {
  list(): Promise<SourceItem[]>;
  fetch(item: SourceItem): Promise<FetchedItem | null>;
}

export interface SourceContext {
  config: Record<string, unknown>;
  secret(field: string): Promise<string | null>;
  /** Private hosts an admin allowed. */
  privateHosts: string[];
  /** Folders a folder connector may read. */
  folderRoots: string[];
}

/** At most this many items per source and run; the rest wait for the next run. */
export const MAX_ITEMS = 500;
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex').slice(0, 32);

/** The first "# heading" of a text, or the fallback. */
const titleOf = (text: string, fallback: string) =>
  /^#{1,3}\s+(.+)$/m.exec(text)?.[1]?.trim().slice(0, 200) || fallback;

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

/** A JSON or text API call to a public host: no redirects, a time limit, a size limit. */
async function call(
  url: string,
  init: RequestInit,
  privateHosts: string[],
): Promise<{ status: number; body: Buffer; type: string | null }> {
  const host = new URL(url).hostname;
  await assertPublicUrl(url, privateHosts.includes(host));
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of (res.body ?? []) as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new SourceError('The source returned more than 10 MB');
    chunks.push(Buffer.from(chunk));
  }
  return { status: res.status, body: Buffer.concat(chunks), type: res.headers.get('content-type') };
}

async function json<T>(
  url: string,
  init: RequestInit,
  privateHosts: string[],
  what: string,
): Promise<T> {
  const r = await call(url, init, privateHosts);
  if (r.status === 401 || r.status === 403)
    throw new SourceError(`${what} refused the credentials`);
  if (r.status === 404) throw new SourceError(`${what} found nothing at that address`);
  if (r.status < 200 || r.status >= 300) throw new SourceError(`${what} answered HTTP ${r.status}`);
  try {
    return JSON.parse(r.body.toString('utf8')) as T;
  } catch {
    throw new SourceError(`${what} did not answer with JSON`);
  }
}

/** Text from a file's bytes, by its name or type; null for kinds the knowledge base cannot read. */
async function textOf(body: Buffer, name: string, type?: string | null): Promise<string | null> {
  const kind = detectKind(name, type);
  return kind ? extractText(body, kind) : null;
}

// ---- Website or sitemap ----

function website(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.website.parse(ctx.config);
  const start = new URL(c.url);
  const allow = ctx.privateHosts.includes(start.hostname);
  const pages = new Map<string, { html: string }>();
  const inScope = (u: URL) =>
    u.origin === start.origin && (!c.pathPrefix || u.pathname.startsWith(c.pathPrefix));

  return {
    async list() {
      const found: string[] = [];
      if (/\.xml($|\?)/i.test(start.pathname)) {
        // A sitemap: every <loc> on the same site.
        const { body } = await fetchPublicUrl(start.toString(), allow);
        for (const m of body.toString('utf8').matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
          try {
            const u = new URL(m[1]!);
            if (inScope(u)) found.push(u.toString());
          } catch {
            // Not a URL: skipped.
          }
          if (found.length >= c.maxPages) break;
        }
      } else {
        // A page: follow links on the same site, breadth first, up to the page limit.
        const queue = [start.toString()];
        const seen = new Set(queue);
        while (queue.length && found.length < c.maxPages) {
          const url = queue.shift()!;
          let html: string;
          try {
            const r = await fetchPublicUrl(url, allow);
            if (r.contentType && !/html|text/i.test(r.contentType)) continue;
            html = r.body.toString('utf8');
          } catch {
            continue;
          }
          pages.set(url, { html });
          found.push(url);
          for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
            try {
              const next = new URL(m[1]!, url);
              next.hash = '';
              if (!inScope(next) || seen.has(next.toString())) continue;
              if (/\.(png|jpe?g|gif|svg|webp|css|js|zip|ico|woff2?)$/i.test(next.pathname))
                continue;
              seen.add(next.toString());
              queue.push(next.toString());
            } catch {
              // Not a URL: skipped.
            }
          }
        }
      }
      // The version is decided when the page is fetched (by its content hash).
      return found.map((url) => ({ externalId: url, title: url, version: '', url }));
    },
    async fetch(item) {
      const html =
        pages.get(item.externalId)?.html ??
        (await fetchPublicUrl(item.externalId, allow)).body.toString('utf8');
      const text = htmlToText(html);
      return {
        title: htmlTitle(html) ?? titleOf(text, item.externalId),
        text,
        url: item.externalId,
      };
    },
  };
}

// ---- GitHub repository ----

function github(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.github.parse(ctx.config);
  const headers = async (): Promise<Record<string, string>> => {
    const token = await ctx.secret('token');
    return {
      accept: 'application/vnd.github+json',
      'user-agent': 'TMS-knowledge-base',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  };
  const prefix = c.path.replace(/^\/+|\/+$/g, '');
  return {
    async list() {
      const tree = await json<{
        tree: Array<{ path: string; type: string; sha: string }>;
        truncated?: boolean;
      }>(
        `https://api.github.com/repos/${c.repo}/git/trees/${encodeURIComponent(c.branch)}?recursive=1`,
        { headers: await headers() },
        ctx.privateHosts,
        'GitHub',
      );
      return tree.tree
        .filter((t) => t.type === 'blob')
        .filter((t) => !prefix || t.path === prefix || t.path.startsWith(`${prefix}/`))
        .filter((t) => detectKind(t.path) !== null)
        .slice(0, MAX_ITEMS)
        .map((t) => ({
          externalId: t.path,
          title: t.path.split('/').pop()!,
          version: t.sha,
          url: `https://github.com/${c.repo}/blob/${c.branch}/${t.path}`,
        }));
    },
    async fetch(item) {
      const r = await call(
        `https://api.github.com/repos/${c.repo}/contents/${item.externalId
          .split('/')
          .map(encodeURIComponent)
          .join('/')}?ref=${encodeURIComponent(c.branch)}`,
        { headers: { ...(await headers()), accept: 'application/vnd.github.raw' } },
        ctx.privateHosts,
      );
      if (r.status !== 200)
        throw new SourceError(`GitHub answered HTTP ${r.status} for ${item.externalId}`);
      const text = await textOf(r.body, item.externalId);
      return text === null ? null : { title: titleOf(text, item.title), text, url: item.url };
    },
  };
}

// ---- Notion ----

type NotionText = { plain_text?: string };
type NotionBlock = { id: string; type: string; has_children?: boolean } & Record<string, unknown>;

const NOTION_PREFIX: Record<string, string> = {
  heading_1: '# ',
  heading_2: '## ',
  heading_3: '### ',
  bulleted_list_item: '- ',
  numbered_list_item: '- ',
  to_do: '- ',
  quote: '> ',
};

function notion(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.notion.parse(ctx.config);
  const headers = async () => {
    const token = await ctx.secret('token');
    if (!token) throw new SourceError('Add the Notion integration token first');
    return {
      authorization: `Bearer ${token}`,
      'notion-version': '2022-06-28',
      'content-type': 'application/json',
    };
  };
  const children = async (id: string, depth: number, out: string[]) => {
    let cursor: string | undefined;
    do {
      const page = await json<{
        results: NotionBlock[];
        has_more: boolean;
        next_cursor: string | null;
      }>(
        `https://api.notion.com/v1/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`,
        { headers: await headers() },
        ctx.privateHosts,
        'Notion',
      );
      for (const b of page.results) {
        const body = b[b.type] as { rich_text?: NotionText[] } | undefined;
        const line = (body?.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
        if (line.trim()) out.push(`${NOTION_PREFIX[b.type] ?? ''}${line}`);
        if (b.has_children && depth < 2) await children(b.id, depth + 1, out);
      }
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
    } while (cursor && out.length < 5000);
  };
  return {
    async list() {
      const items: SourceItem[] = [];
      let cursor: string | undefined;
      do {
        const page = await json<{
          results: Array<{
            id: string;
            url?: string;
            last_edited_time: string;
            properties?: Record<string, { type: string; title?: NotionText[] }>;
          }>;
          has_more: boolean;
          next_cursor: string | null;
        }>(
          'https://api.notion.com/v1/search',
          {
            method: 'POST',
            headers: await headers(),
            body: JSON.stringify({
              query: c.query,
              filter: { property: 'object', value: 'page' },
              page_size: 100,
              ...(cursor ? { start_cursor: cursor } : {}),
            }),
          },
          ctx.privateHosts,
          'Notion',
        );
        for (const p of page.results) {
          const titleProp = Object.values(p.properties ?? {}).find((x) => x.type === 'title');
          const title =
            (titleProp?.title ?? []).map((t) => t.plain_text ?? '').join('') || 'Untitled';
          items.push({ externalId: p.id, title, version: p.last_edited_time, url: p.url ?? null });
        }
        cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined;
      } while (cursor && items.length < MAX_ITEMS);
      return items.slice(0, MAX_ITEMS);
    },
    async fetch(item) {
      const out: string[] = [`# ${item.title}`];
      await children(item.externalId, 0, out);
      return { title: item.title, text: out.join('\n\n'), url: item.url };
    },
  };
}

// ---- Google Drive ----

const b64url = (s: string | Buffer) => Buffer.from(s).toString('base64url');

function googleDrive(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.google_drive.parse(ctx.config);
  let token: { value: string; until: number } | null = null;
  const access = async () => {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const raw = await ctx.secret('service_account');
    if (!raw) throw new SourceError('Add the service account key first');
    let key: { client_email?: string; private_key?: string; token_uri?: string };
    try {
      key = JSON.parse(raw);
    } catch {
      throw new SourceError('The service account key is not valid JSON');
    }
    if (!key.client_email || !key.private_key) {
      throw new SourceError('The service account key has no client_email or private_key');
    }
    const aud = key.token_uri ?? 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(
      JSON.stringify({
        iss: key.client_email,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        aud,
        iat: now,
        exp: now + 3600,
      }),
    )}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
    const r = await json<{ access_token?: string; expires_in?: number }>(
      aud,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: `${unsigned}.${b64url(signature)}`,
        }).toString(),
      },
      ctx.privateHosts,
      'Google',
    );
    if (!r.access_token) throw new SourceError('Google gave no access token');
    token = { value: r.access_token, until: Date.now() + (r.expires_in ?? 3600) * 1000 };
    return token.value;
  };
  const api = 'https://www.googleapis.com/drive/v3/files';
  return {
    async list() {
      const items: SourceItem[] = [];
      let pageToken: string | undefined;
      do {
        const q = encodeURIComponent(
          `'${c.folderId.replace(/'/g, "\\'")}' in parents and trashed = false`,
        );
        const page = await json<{
          files: Array<{
            id: string;
            name: string;
            mimeType: string;
            modifiedTime: string;
            webViewLink?: string;
          }>;
          nextPageToken?: string;
        }>(
          `${api}?q=${q}&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=nextPageToken,files(id,name,mimeType,modifiedTime,webViewLink)${pageToken ? `&pageToken=${pageToken}` : ''}`,
          { headers: { authorization: `Bearer ${await access()}` } },
          ctx.privateHosts,
          'Google Drive',
        );
        for (const f of page.files) {
          const doc = f.mimeType === 'application/vnd.google-apps.document';
          if (!doc && !detectKind(f.name, f.mimeType)) continue;
          items.push({
            externalId: `${f.id}|${f.mimeType}`,
            title: f.name,
            version: f.modifiedTime,
            url: f.webViewLink ?? null,
          });
        }
        pageToken = page.nextPageToken;
      } while (pageToken && items.length < MAX_ITEMS);
      return items.slice(0, MAX_ITEMS);
    },
    async fetch(item) {
      const [id, mime] = item.externalId.split('|') as [string, string];
      const doc = mime === 'application/vnd.google-apps.document';
      const r = await call(
        doc
          ? `${api}/${id}/export?mimeType=text/plain`
          : `${api}/${id}?alt=media&supportsAllDrives=true`,
        { headers: { authorization: `Bearer ${await access()}` } },
        ctx.privateHosts,
      );
      if (r.status !== 200)
        throw new SourceError(`Google Drive answered HTTP ${r.status} for ${item.title}`);
      const text = doc ? r.body.toString('utf8') : await textOf(r.body, item.title, mime);
      return text === null ? null : { title: item.title, text, url: item.url };
    },
  };
}

// ---- S3-compatible bucket ----

function s3(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.s3.parse(ctx.config);
  let client: S3Client | null = null;
  const connect = async () => {
    if (client) return client;
    if (c.endpoint) {
      const host = new URL(c.endpoint).hostname;
      await assertPublicUrl(c.endpoint, ctx.privateHosts.includes(host));
    }
    const accessKeyId = await ctx.secret('access_key_id');
    const secretAccessKey = await ctx.secret('secret_access_key');
    if (!accessKeyId || !secretAccessKey) throw new SourceError('Add the access key first');
    client = new S3Client({
      region: c.region,
      ...(c.endpoint ? { endpoint: c.endpoint, forcePathStyle: true } : {}),
      credentials: { accessKeyId, secretAccessKey },
    });
    return client;
  };
  return {
    async list() {
      const s = await connect();
      const items: SourceItem[] = [];
      let token: string | undefined;
      do {
        const page = await s.send(
          new ListObjectsV2Command({
            Bucket: c.bucket,
            Prefix: c.prefix || undefined,
            ContinuationToken: token,
          }),
        );
        for (const o of page.Contents ?? []) {
          if (!o.Key || o.Key.endsWith('/') || !detectKind(o.Key)) continue;
          if ((o.Size ?? 0) > MAX_BYTES) continue;
          items.push({
            externalId: o.Key,
            title: o.Key.split('/').pop()!,
            version: o.ETag ?? String(o.LastModified?.getTime() ?? ''),
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token && items.length < MAX_ITEMS);
      return items.slice(0, MAX_ITEMS);
    },
    async fetch(item) {
      const s = await connect();
      const o = await s.send(new GetObjectCommand({ Bucket: c.bucket, Key: item.externalId }));
      const bytes = Buffer.from((await o.Body?.transformToByteArray()) ?? []);
      const text = await textOf(bytes, item.externalId, o.ContentType);
      return text === null ? null : { title: titleOf(text, item.title), text };
    },
  };
}

// ---- Shared folder (a NAS share mounted into the worker) ----

function folder(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.folder.parse(ctx.config);
  const inside = (root: string, p: string) => {
    const rel = relative(root, p);
    return (
      rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !rel.includes(`..${sep}`))
    );
  };
  const rootOf = async () => {
    const wanted = await realpath(resolve(c.path)).catch(() => {
      throw new SourceError('That folder does not exist, or the worker cannot read it');
    });
    for (const r of ctx.folderRoots) {
      const root = await realpath(resolve(r)).catch(() => null);
      if (root && inside(root, wanted)) return wanted;
    }
    throw new SourceError(
      'That folder is not one TMS may read. An administrator lists the allowed folders in KB_CONNECTOR_PATHS.',
    );
  };
  return {
    async list() {
      const root = await rootOf();
      const items: SourceItem[] = [];
      const walk = async (dir: string, depth: number) => {
        if (depth > 8 || items.length >= MAX_ITEMS) return;
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (items.length >= MAX_ITEMS) return;
          if (e.name.startsWith('.')) continue;
          const p = join(dir, e.name);
          // A link that points outside the folder is not followed.
          const real = await realpath(p).catch(() => null);
          if (!real || !inside(root, real)) continue;
          if (e.isDirectory()) await walk(real, depth + 1);
          else if (detectKind(e.name)) {
            const st = await stat(real);
            if (st.size > MAX_BYTES) continue;
            items.push({
              externalId: relative(root, real).split(sep).join('/'),
              title: e.name,
              version: `${Math.round(st.mtimeMs)}:${st.size}`,
            });
          }
        }
      };
      await walk(root, 0);
      return items;
    },
    async fetch(item) {
      const root = await rootOf();
      const real = await realpath(join(root, item.externalId));
      if (!inside(root, real)) throw new SourceError('That file is outside the folder');
      const text = await textOf(await readFile(real), item.externalId);
      return text === null ? null : { title: titleOf(text, item.title), text };
    },
  };
}

// ---- Databases (PostgreSQL, MySQL) ----

/** One SELECT, nothing else: no second statement, no writing. */
export function readOnlyQuery(query: string): string {
  const q = query.trim().replace(/;\s*$/, '');
  if (!/^(select|with)\b/i.test(q) || q.includes(';')) {
    throw new SourceError('The query must be a single SELECT');
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do)\b/i.test(q)) {
    throw new SourceError('The query may only read');
  }
  return q;
}

type DatabaseQuery = z.infer<(typeof kbConnectorConfigSchemas)['postgres']>;
type Rows = Array<Record<string, unknown>>;

/**
 * The connection string of a database source, once its host passed the same
 * check as every other address: public, unless an admin allowed the host.
 */
async function databaseConnection(ctx: SourceContext, scheme: RegExp, shape: string) {
  const connection = await ctx.secret('connection');
  if (!connection) throw new SourceError('Add the connection string first');
  let url: URL;
  try {
    url = new URL(connection);
  } catch {
    throw new SourceError(`The connection string is not a ${shape} address`);
  }
  if (!scheme.test(url.protocol)) {
    throw new SourceError(`The connection string is not a ${shape} address`);
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!ctx.privateHosts.includes(host)) {
    const addresses = isIP(host)
      ? [host]
      : (await lookup(host, { all: true })).map((a) => a.address);
    if (!addresses.length || addresses.some(isPrivateAddress)) {
      throw new UnsafeUrlError(
        'That database is on a private network. An administrator can allow its host in KB_CONNECTOR_PRIVATE_HOSTS.',
      );
    }
  }
  return connection;
}

/** A source whose documents are the rows of one query: listed and fetched from a single read. */
function databaseSource(c: DatabaseQuery, read: (query: string) => Promise<Rows>): ConnectorSource {
  let rows: Map<string, { title: string; body: string }> | null = null;
  const load = async () => {
    if (rows) return rows;
    const found = await read(readOnlyQuery(c.query));
    rows = new Map();
    for (const row of found) {
      const id = row[c.idColumn];
      const body = row[c.bodyColumn];
      if (id === undefined || id === null || body === undefined || body === null) continue;
      rows.set(String(id), {
        title: String(row[c.titleColumn] ?? id).slice(0, 200),
        body: String(body),
      });
    }
    return rows;
  };
  return {
    async list() {
      const all = await load();
      return [...all].map(([id, r]) => ({
        externalId: id,
        title: r.title,
        version: hash(r.title + r.body),
      }));
    },
    async fetch(item) {
      const r = (await load()).get(item.externalId);
      return r ? { title: r.title, text: `# ${r.title}\n\n${r.body}` } : null;
    },
  };
}

function postgres(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.postgres.parse(ctx.config);
  return databaseSource(c, async (query) => {
    const connection = await databaseConnection(ctx, /^postgres(ql)?:$/, 'postgres://');
    const client = new Client({ connectionString: connection, connectionTimeoutMillis: 10_000 });
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await client.query("SET LOCAL statement_timeout = '15s'");
      const r = await client.query(`SELECT * FROM (${query}) AS kb_source LIMIT ${MAX_ITEMS}`);
      await client.query('COMMIT');
      return r.rows as Rows;
    } finally {
      await client.end().catch(() => undefined);
    }
  });
}

function mysql(ctx: SourceContext): ConnectorSource {
  const c = kbConnectorConfigSchemas.mysql.parse(ctx.config);
  return databaseSource(c, async (query) => {
    const connection = await databaseConnection(ctx, /^mysql:$/, 'mysql://');
    // One statement per call is the driver's default; it is never switched on here.
    const client = await createConnection({ uri: connection, connectTimeout: 10_000 });
    try {
      // The time limit for a statement: MySQL names it in milliseconds, MariaDB in seconds.
      await client
        .query('SET SESSION max_execution_time = 15000')
        .catch(() => client.query('SET SESSION max_statement_time = 15'));
      await client.query('START TRANSACTION READ ONLY');
      const [found] = await client.query(
        `SELECT * FROM (${query}) AS kb_source LIMIT ${MAX_ITEMS}`,
      );
      await client.query('COMMIT');
      return found as Rows;
    } finally {
      await client.end().catch(() => undefined);
    }
  });
}

const SOURCES: Record<KbConnectorType, (ctx: SourceContext) => ConnectorSource> = {
  website,
  github,
  notion,
  google_drive: googleDrive,
  s3,
  folder,
  postgres,
  mysql,
};

export function sourceFor(type: KbConnectorType, ctx: SourceContext): ConnectorSource {
  return SOURCES[type](ctx);
}

/** The content hash used to tell whether an item's text changed. */
export const textHash = hash;
