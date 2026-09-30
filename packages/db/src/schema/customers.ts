import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { timestamps } from './auth';

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    displayName: text('display_name').notNull(),
    primaryEmail: text('primary_email'),
    primaryPhone: text('primary_phone'),
    language: text('language'),
    customerType: text('customer_type').notNull().default('standard'),
    externalRef: text('external_ref'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    /** Set when this record was merged into another; merged records are hidden from lists. */
    mergedIntoId: uuid('merged_into_id').references((): AnyPgColumn => customers.id),
    ...timestamps,
  },
  (t) => [
    index('customers_display_name_trgm').using('gin', sql`${t.displayName} gin_trgm_ops`),
    index('customers_primary_email_idx').on(t.primaryEmail),
  ],
);

export const customerIdentities = pgTable(
  'customer_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    /** Normalized with normalizeIdentity() from @tms/shared. */
    value: text('value').notNull(),
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('customer_identities_type_value_uq').on(t.type, t.value),
    index('customer_identities_customer_idx').on(t.customerId),
  ],
);
