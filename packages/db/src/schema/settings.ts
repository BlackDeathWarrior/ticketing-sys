import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps, users } from './auth';

/**
 * Credentials TMS stores itself: channel passwords and tokens, tool and
 * integration keys. `ciphertext` is AES-256-GCM (see SecretsService);
 * plaintext never leaves the server.
 */
export const secrets = pgTable('secrets', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** channel | tool | integration */
  scope: text('scope').notNull(),
  key: text('key').notNull().unique(),
  ciphertext: text('ciphertext').notNull(),
  /** Which master key encrypted it, so the master key can be rotated later. */
  keyVersion: integer('key_version').notNull().default(1),
  last4: text('last4'),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

/** Typed key/value settings (channel hosts, AI behaviour). Values are validated by zod per key. */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** A provider credential. The key itself is stored in LiteLLM under `litellmCredential`. */
export const llmProviders = pgTable('llm_providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** anthropic | openai | gemini | … (LLM_PROVIDERS) */
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  baseUrl: text('base_url'),
  keyLast4: text('key_last4'),
  litellmCredential: text('litellm_credential').notNull().unique(),
  enabled: boolean('enabled').notNull().default(true),
  budgetUsd: doublePrecision('budget_usd'),
  /** day | week | month */
  budgetPeriod: text('budget_period').notNull().default('month'),
  lastTest: jsonb('last_test').$type<{ ok: boolean; at: string; error?: string }>(),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

/** A model deployment registered in LiteLLM under the alias `tms-<id>`. */
export const llmModels = pgTable(
  'llm_models',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => llmProviders.id, { onDelete: 'cascade' }),
    /** Full LiteLLM model string, e.g. `anthropic/claude-haiku-4-5`. */
    model: text('model').notNull(),
    label: text('label').notNull(),
    /** chat | embedding */
    mode: text('mode').notNull().default('chat'),
    supportsTools: boolean('supports_tools').notNull().default(false),
    supportsJson: boolean('supports_json').notNull().default(false),
    supportsVision: boolean('supports_vision').notNull().default(false),
    contextWindow: integer('context_window'),
    /** USD per token, as LiteLLM reports it. */
    inputCostPerToken: doublePrecision('input_cost_per_token'),
    outputCostPerToken: doublePrecision('output_cost_per_token'),
    /** litellm | manual | unknown */
    costSource: text('cost_source').notNull().default('unknown'),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('llm_models_provider_idx').on(t.providerId)],
);

/** Which models serve each app role, and how they are ordered. */
export const llmRoles = pgTable('llm_roles', {
  role: text('role').primaryKey(),
  /** cheapest | ordered */
  mode: text('mode').notNull().default('cheapest'),
  modelIds: uuid('model_ids').array().notNull().default([]),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/**
 * One row per LLM call: the basis for per-provider caps and usage reports.
 * A metrics log, like refresh tokens: not audited per row (ADR 0008).
 */
export const llmCalls = pgTable(
  'llm_calls',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    role: text('role').notNull(),
    modelId: uuid('model_id').references(() => llmModels.id, { onDelete: 'set null' }),
    providerId: uuid('provider_id').references(() => llmProviders.id, { onDelete: 'set null' }),
    model: text('model').notNull(),
    /** ok | error */
    status: text('status').notNull(),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    costUsd: doublePrecision('cost_usd').notNull().default(0),
    latencyMs: integer('latency_ms').notNull().default(0),
    fallbacksAttempted: integer('fallbacks_attempted').notNull().default(0),
    error: text('error'),
    ticketId: uuid('ticket_id'),
    conversationId: uuid('conversation_id'),
    traceId: text('trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('llm_calls_provider_created_idx').on(t.providerId, t.createdAt),
    index('llm_calls_created_idx').on(t.createdAt),
  ],
);
