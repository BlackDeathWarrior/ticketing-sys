import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * What this desk created at a hosted voice agent provider so that its phone
 * agent can use the desk's tools (ADR 0040). One row per tool made there. The
 * desk changes and deletes at the provider only what is listed here.
 */
export const phoneAgentTools = pgTable(
  'phone_agent_tools',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** elevenlabs (Sarvam's tools are made by hand in its dashboard). */
    provider: text('provider').notNull(),
    /** A desk tool's id, or the name of one of the desk's own phone tools. */
    key: text('key').notNull(),
    /** The tool's id at the provider. */
    providerToolId: text('provider_tool_id').notNull(),
    /** The name the agent sees. */
    name: text('name').notNull(),
    /** A hash of what was last sent, so an unchanged tool is not sent again. */
    hash: text('hash').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('phone_agent_tools_key_idx').on(t.provider, t.key)],
);
