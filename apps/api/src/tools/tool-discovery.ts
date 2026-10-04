import type { ToolView } from '@tms/shared';

/**
 * What the desk can work out about a company system by itself, so that a
 * person setting up a tool does not have to know an address, a header or a
 * parameter name (ADR 0036). Pure: no network, no database.
 *
 * A "known system" is a host the custom tools already call. What they share
 * is that system's convention: where its requests live, which header carries
 * the key, which parameter carries the customer's email. A system can also say
 * what it offers in an OpenAPI document; `operationsFromOpenApi` reads one.
 */
export interface KnownSystem {
  /** `https://shop.example.com` */
  origin: string;
  /** The address the tools' requests share: `https://shop.example.com/api/support/tools`. */
  base: string;
  /** The header its tools send the key in, or null when they send none. */
  keyHeader: string | null;
  /** The parameter its tools put the customer's email in, or null. */
  customerParameter: string | null;
  tools: Array<{ name: string; title: string; method: string; url: string }>;
  /** A tool of this system whose key is saved: a new tool for the same host can use that key. */
  keyed: { id: string; title: string } | null;
}

export interface CatalogueOperation {
  method: string;
  url: string;
  summary: string;
  /** Whether a call changes anything, when the system says so; a GET is taken as a lookup. */
  changesData: boolean;
  parameters: Array<{ name: string; type: string; required: boolean; description: string }>;
}

const MAX_OPERATIONS = 60;
const MAX_PARAMETERS = 12;
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const PARAM_TYPES = ['string', 'number', 'integer', 'boolean'];

const oneLine = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** The commonest value, ignoring empty ones. */
function commonest(values: Array<string | null>): string | null {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

/** The path segments every address shares, stopping at the first value placeholder. */
function sharedSegments(paths: string[][]): string[] {
  const shared: string[] = [];
  for (let i = 0; ; i++) {
    const segment = paths[0]?.[i];
    if (segment === undefined || segment.includes('{')) return shared;
    if (paths.some((p) => p[i] !== segment)) return shared;
    // A single tool's last segment is its own request, not the folder its siblings would share.
    if (paths.every((p) => p.length === i + 1)) return shared;
    shared.push(segment);
  }
}

/** The systems the custom tools already call, each with what its tools have in common. */
export function knownSystems(tools: ToolView[]): KnownSystem[] {
  const byOrigin = new Map<string, ToolView[]>();
  for (const tool of tools) {
    if (!tool.custom) continue;
    let origin: string;
    try {
      origin = new URL(tool.custom.url.replace(/\{[^{}]*\}/g, 'x')).origin;
    } catch {
      continue;
    }
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), tool]);
  }
  return [...byOrigin].map(([origin, group]) => {
    const paths = group.map((t) =>
      t.custom!.url.slice(origin.length).split('?')[0]!.split('/').filter(Boolean),
    );
    const keyed = group.find((t) => t.custom!.authHeader && t.custom!.token.set);
    return {
      origin,
      base: [origin, ...sharedSegments(paths)].join('/'),
      keyHeader: commonest(group.map((t) => t.custom!.authHeader)),
      customerParameter: commonest(group.map((t) => t.customerArg)),
      tools: group.map((t) => ({
        name: t.name,
        title: t.title ?? t.name,
        method: t.custom!.method,
        url: t.custom!.url,
      })),
      keyed: keyed ? { id: keyed.id, title: keyed.title ?? keyed.name } : null,
    };
  });
}

/** Where a system's OpenAPI document may be, most specific first. */
export function catalogueAddresses(system: KnownSystem): string[] {
  return [...new Set([`${system.base}/openapi.json`, `${system.origin}/openapi.json`])];
}

/**
 * The requests an OpenAPI 3 document describes, with full addresses. `from`
 * is the address the document was read from: its paths are taken as relative
 * to that folder unless the document names an absolute server. Anything that
 * is not shaped as expected is skipped: the document comes from outside.
 */
export function operationsFromOpenApi(doc: unknown, from: string): CatalogueOperation[] {
  const d = doc as { paths?: unknown; servers?: Array<{ url?: unknown }> } | null;
  if (!d || typeof d.paths !== 'object' || d.paths === null) return [];
  const server = d.servers?.[0]?.url;
  const base = (
    typeof server === 'string' && /^https?:\/\//.test(server)
      ? server
      : from.slice(0, from.lastIndexOf('/'))
  ).replace(/\/+$/, '');

  const operations: CatalogueOperation[] = [];
  for (const [path, item] of Object.entries(d.paths as Record<string, unknown>)) {
    if (!path.startsWith('/') || typeof item !== 'object' || item === null) continue;
    for (const method of METHODS) {
      const op = (item as Record<string, unknown>)[method] as Record<string, unknown> | undefined;
      if (!op || typeof op !== 'object') continue;
      const parameters: CatalogueOperation['parameters'] = [];
      const add = (name: unknown, schema: unknown, required: boolean, description: unknown) => {
        const n = oneLine(name, 40);
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(n) || parameters.some((p) => p.name === n)) return;
        const type = (schema as { type?: unknown } | null)?.type;
        parameters.push({
          name: n,
          type: PARAM_TYPES.includes(type as string) ? (type as string) : 'string',
          required,
          description: oneLine(description, 200),
        });
      };
      for (const p of Array.isArray(op.parameters) ? op.parameters : []) {
        const param = p as Record<string, unknown> | null;
        if (param?.in !== 'path' && param?.in !== 'query') continue;
        add(
          param.name,
          param.schema,
          param.in === 'path' || param.required === true,
          param.description,
        );
      }
      const body = (
        op.requestBody as
          { content?: Record<string, { schema?: Record<string, unknown> }> } | undefined
      )?.content?.['application/json']?.schema;
      const required = Array.isArray(body?.required) ? body.required : [];
      for (const [name, schema] of Object.entries((body?.properties as object | undefined) ?? {})) {
        add(
          name,
          schema,
          required.includes(name),
          (schema as { description?: unknown })?.description,
        );
      }
      const changes = op['x-changes-data'];
      operations.push({
        method: method.toUpperCase(),
        url: `${base}${path}`,
        summary: [oneLine(op.summary, 80), oneLine(op.description, 240)].filter(Boolean).join(': '),
        changesData: typeof changes === 'boolean' ? changes : method !== 'get',
        parameters: parameters.slice(0, MAX_PARAMETERS),
      });
      if (operations.length >= MAX_OPERATIONS) return operations;
    }
  }
  return operations;
}
