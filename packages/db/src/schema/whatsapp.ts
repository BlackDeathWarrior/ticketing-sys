import type { WaTemplateButton } from '@tms/shared';
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * WhatsApp message templates as last synced from Meta. Meta owns them: TMS
 * only reads the list and sends approved ones outside the 24-hour window.
 */
export const waTemplates = pgTable(
  'wa_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Meta's template id. */
    metaId: text('meta_id'),
    name: text('name').notNull(),
    language: text('language').notNull(),
    /** Meta's status as sent: APPROVED, PENDING, REJECTED, PAUSED, DISABLED, … */
    status: text('status').notNull(),
    category: text('category').notNull(),
    /** text | image | video | document */
    headerType: text('header_type'),
    headerText: text('header_text'),
    bodyText: text('body_text').notNull().default(''),
    footerText: text('footer_text'),
    buttons: jsonb('buttons').$type<WaTemplateButton[]>().notNull().default([]),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('wa_templates_name_language_uq').on(t.name, t.language)],
);
