import { z } from 'zod';

/**
 * Knowledge-base connectors (ADR 0033): outside sources whose pages and files
 * are kept in the knowledge base and re-synced on a schedule. Each is a real
 * integration with the source's own API; nothing is simulated.
 */
export const KB_CONNECTOR_TYPES = [
  'website',
  'github',
  'notion',
  'google_drive',
  's3',
  'folder',
  'postgres',
  'mysql',
] as const;
export type KbConnectorType = (typeof KB_CONNECTOR_TYPES)[number];

export const KB_CONNECTOR_LABELS: Record<KbConnectorType, string> = {
  website: 'Website or sitemap',
  github: 'GitHub repository',
  notion: 'Notion',
  google_drive: 'Google Drive folder',
  s3: 'S3-compatible bucket',
  folder: 'Shared folder (NAS)',
  postgres: 'PostgreSQL database',
  mysql: 'MySQL database',
};

/** The credentials each type needs, stored as secrets `kb.connector-<id>.<field>`; never returned. */
export const KB_CONNECTOR_SECRETS: Record<
  KbConnectorType,
  Array<{ field: string; label: string; optional?: boolean }>
> = {
  website: [],
  github: [
    { field: 'token', label: 'Access token (only for a private repository)', optional: true },
  ],
  notion: [{ field: 'token', label: 'Integration token (secret_… or ntn_…)' }],
  google_drive: [
    { field: 'service_account', label: 'Service account key (the JSON file’s contents)' },
  ],
  s3: [
    { field: 'access_key_id', label: 'Access key id' },
    { field: 'secret_access_key', label: 'Secret access key' },
  ],
  folder: [],
  postgres: [
    { field: 'connection', label: 'Connection string (postgres://user:password@host:5432/db)' },
  ],
  mysql: [{ field: 'connection', label: 'Connection string (mysql://user:password@host:3306/db)' }],
};

const text = (max: number) => z.string().trim().min(1).max(max);

/** A database source: one query, a row per document. The same for every database type. */
const databaseQuery = z.object({
  /** One SELECT; it runs read-only, with a time limit and at most 500 rows. */
  query: text(4000),
  idColumn: text(100),
  titleColumn: text(100),
  bodyColumn: text(100),
});

/** What each type needs to know, besides its credentials. */
export const kbConnectorConfigSchemas = {
  website: z.object({
    /** A page to start from (links on the same site are followed), or a sitemap.xml. */
    url: z.string().trim().url().max(500),
    maxPages: z.number().int().min(1).max(300).default(50),
    /** Only pages whose path starts with this, e.g. /help/. */
    pathPrefix: z.string().trim().max(200).optional(),
  }),
  github: z.object({
    /** owner/name */
    repo: z
      .string()
      .trim()
      .regex(/^[\w.-]+\/[\w.-]+$/, 'Write it as owner/name'),
    branch: z.string().trim().max(100).default('main'),
    /** Only files under this folder. */
    path: z.string().trim().max(200).default(''),
  }),
  notion: z.object({
    /** Only pages whose title contains this; empty: every page shared with the integration. */
    query: z.string().trim().max(200).default(''),
  }),
  google_drive: z.object({ folderId: text(200) }),
  s3: z.object({
    bucket: text(200),
    region: z.string().trim().max(50).default('us-east-1'),
    /** Leave empty for AWS; any S3-compatible service otherwise (e.g. http://objectstore:8333). */
    endpoint: z.string().trim().max(300).optional(),
    prefix: z.string().trim().max(300).default(''),
  }),
  folder: z.object({
    /** A folder the worker can read, inside one of KB_CONNECTOR_PATHS (where a NAS share is mounted). */
    path: text(500),
  }),
  postgres: databaseQuery,
  mysql: databaseQuery,
} as const satisfies Record<KbConnectorType, z.ZodTypeAny>;

const base = {
  name: text(100),
  /** Who may see what it brings in. Imported documents are drafts unless `autoApprove`. */
  visibility: z.enum(['public', 'internal', 'team']).default('internal'),
  teamId: z.string().uuid().nullable().optional(),
  autoApprove: z.boolean().default(false),
  /** How often to sync, in minutes; 0 = only when someone asks. */
  scheduleMinutes: z.number().int().min(0).max(10_080).default(1440),
  /** Credentials, by field name. Written once, never read back. */
  secrets: z.record(z.string().max(20_000)).optional(),
};

export const createKbConnectorSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('website'), config: kbConnectorConfigSchemas.website, ...base }),
  z.object({ type: z.literal('github'), config: kbConnectorConfigSchemas.github, ...base }),
  z.object({ type: z.literal('notion'), config: kbConnectorConfigSchemas.notion, ...base }),
  z.object({
    type: z.literal('google_drive'),
    config: kbConnectorConfigSchemas.google_drive,
    ...base,
  }),
  z.object({ type: z.literal('s3'), config: kbConnectorConfigSchemas.s3, ...base }),
  z.object({ type: z.literal('folder'), config: kbConnectorConfigSchemas.folder, ...base }),
  z.object({ type: z.literal('postgres'), config: kbConnectorConfigSchemas.postgres, ...base }),
  z.object({ type: z.literal('mysql'), config: kbConnectorConfigSchemas.mysql, ...base }),
]);
export type CreateKbConnectorInput = z.infer<typeof createKbConnectorSchema>;

export const updateKbConnectorSchema = z
  .object({
    name: base.name,
    visibility: base.visibility,
    teamId: base.teamId,
    autoApprove: z.boolean(),
    scheduleMinutes: base.scheduleMinutes,
    enabled: z.boolean(),
    /** Replaced as a whole and checked against the connector's type. */
    config: z.record(z.unknown()),
    secrets: base.secrets,
  })
  .partial();
export type UpdateKbConnectorInput = z.infer<typeof updateKbConnectorSchema>;

export const KB_CONNECTOR_STATUSES = ['idle', 'syncing', 'ok', 'failed'] as const;
export type KbConnectorStatus = (typeof KB_CONNECTOR_STATUSES)[number];

export interface KbConnectorView {
  id: string;
  name: string;
  type: KbConnectorType;
  config: Record<string, unknown>;
  visibility: 'public' | 'internal' | 'team';
  teamId: string | null;
  autoApprove: boolean;
  scheduleMinutes: number;
  enabled: boolean;
  status: KbConnectorStatus;
  lastSyncAt: string | null;
  lastError: string | null;
  /** From the last sync: what was found, added, changed, archived, skipped. */
  stats: {
    found: number;
    added: number;
    updated: number;
    archived: number;
    skipped: number;
  } | null;
  /** Which credential fields are set; never their values. */
  secrets: Array<{ field: string; set: boolean }>;
  documents: number;
}

/** The secret key a connector's credential is stored under. */
export const kbConnectorSecretKey = (connectorId: string, field: string) =>
  `kb.connector-${connectorId.slice(0, 36)}.${field}`;
