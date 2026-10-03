import { boolean, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { timestamps, users } from './auth';

/**
 * An outside app connected to TMS (ADR 0022). Its API keys hang off it, and so
 * do the secrets named `integration.<slug>.<field>`.
 */
export const integrations = pgTable('integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** Used in secret names and by the widget; never changes. */
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /** Off: every key of the integration is refused. */
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  ...timestamps,
});

/**
 * A key an integration calls the API with. Only the SHA-256 of the key is
 * stored; the key itself is shown once, when it is created.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** The start of the key, shown in Settings to tell keys apart. */
    prefix: text('prefix').notNull(),
    keyHash: text('key_hash').notNull().unique(),
    /** Permission strings from API_KEY_SCOPES. */
    scopes: text('scopes').array().notNull(),
    rateLimitPerMinute: integer('rate_limit_per_minute').notNull().default(120),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: uuid('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    /** Written at most once a minute; a usage hint, not an audit record. */
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('api_keys_integration_idx').on(t.integrationId)],
);

/**
 * A code sent to prove a customer owns a phone number. Only a keyed hash of
 * the code is stored, never the code. Rows are purged after a day.
 */
export const phoneVerifications = pgTable(
  'phone_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    integrationId: uuid('integration_id')
      .notNull()
      .references(() => integrations.id, { onDelete: 'cascade' }),
    /** The app's own id for the person, as in the request. */
    externalId: text('external_id').notNull(),
    /** Digits only, country code included. */
    phone: text('phone').notNull(),
    codeHash: text('code_hash').notNull(),
    /** `template` or `text`: how the code reached the customer. */
    sentVia: text('sent_via').notNull(),
    /** Wrong tries so far; the code is spent at PHONE_CODE_MAX_ATTEMPTS. */
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    /** Set when the right code was given; a code works once. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('phone_verifications_lookup_idx').on(t.integrationId, t.externalId, t.phone)],
);
