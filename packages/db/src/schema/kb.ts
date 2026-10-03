import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import { teams, timestamps, users } from './auth';
import { llmModels } from './settings';

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' });

/**
 * A knowledge base document. `status` is the review state (draft | approved |
 * archived); `index_state` is background indexing (pending | indexing |
 * indexed | failed). Files live in object storage under `s3_key`; the text
 * indexing extracted is kept in `content` so a new version can be compared.
 */
export const kbDocuments = pgTable(
  'kb_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    title: text('title').notNull(),
    /** file | url | faq | text */
    source: text('source').notNull(),
    /** public | internal | team */
    visibility: text('visibility').notNull().default('internal'),
    teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
    language: text('language'),
    status: text('status').notNull().default('draft'),
    indexState: text('index_state').notNull().default('pending'),
    indexError: text('index_error'),
    /** hybrid | keyword (no embedding model was available) */
    indexMode: text('index_mode'),
    version: integer('version').notNull().default(1),
    /** The version whose chunks are in kb_chunks. */
    indexedVersion: integer('indexed_version'),
    content: text('content'),
    contentHash: text('content_hash'),
    url: text('url'),
    s3Key: text('s3_key'),
    filename: text('filename'),
    contentType: text('content_type'),
    sizeBytes: integer('size_bytes'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    /** Brought in by a connector (ADR 0033), as the source's item `external_id`. */
    connectorId: uuid('connector_id').references((): AnyPgColumn => kbConnectors.id, {
      onDelete: 'set null',
    }),
    externalId: text('external_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: uuid('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    index('kb_documents_status_idx').on(t.status, t.indexState),
    index('kb_documents_title_trgm').using('gin', sql`${t.title} gin_trgm_ops`),
    uniqueIndex('kb_documents_connector_item_uq').on(t.connectorId, t.externalId),
  ],
);

/**
 * An outside source the knowledge base keeps in sync (ADR 0033). Its
 * credentials are secrets `kb.connector-<id>.<field>`, never stored here.
 */
export const kbConnectors = pgTable('kb_connectors', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** website | github | notion | google_drive | s3 | folder | postgres */
  type: text('type').notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  visibility: text('visibility').notNull().default('internal'),
  teamId: uuid('team_id').references(() => teams.id, { onDelete: 'set null' }),
  autoApprove: boolean('auto_approve').notNull().default(false),
  scheduleMinutes: integer('schedule_minutes').notNull().default(1440),
  enabled: boolean('enabled').notNull().default(true),
  /** idle | syncing | ok | failed */
  status: text('status').notNull().default('idle'),
  lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
  lastError: text('last_error'),
  stats: jsonb('stats').$type<Record<string, number>>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

/** Searchable pieces of a document: a pgvector embedding plus a full-text vector. */
export const kbChunks = pgTable(
  'kb_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => kbDocuments.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    ordinal: integer('ordinal').notNull(),
    /** Heading trail, e.g. "Refunds › Card payments". */
    section: text('section'),
    content: text('content').notNull(),
    tokens: integer('tokens').notNull(),
    /** Null when indexed without an embedding model (keyword search only). */
    embedding: vector('embedding', { dimensions: 1024 }),
    embeddingModelId: uuid('embedding_model_id').references(() => llmModels.id, {
      onDelete: 'set null',
    }),
    /** `simple` config: no stemming, so it works the same for every language. */
    tsv: tsvector('tsv').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(section, '') || ' ' || content)`,
    ),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_chunks_document_idx').on(t.documentId, t.ordinal),
    index('kb_chunks_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('kb_chunks_tsv_gin').using('gin', t.tsv),
  ],
);
