import { z } from 'zod';
import type { Permission } from './permissions';

/**
 * Integrations (ADR 0022): an outside app that connects to TMS. Its API keys,
 * and later its webhooks and chat settings, belong to the integration.
 */

/** What a key may be allowed to do. Each one is a permission, checked like a staff permission. */
export const API_KEY_SCOPES = [
  'integration:ticket',
  'integration:event',
  'kb:read',
] as const satisfies readonly Permission[];
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'integration:ticket': 'Create and read its own tickets and messages',
  'integration:event': 'Report incidents and recoveries',
  'kb:read': 'Search the knowledge base',
};

/** Every key starts with this, so a leaked one is easy to recognise. */
export const API_KEY_PREFIX = 'tms_sk_';

export const DEFAULT_KEY_RATE_LIMIT = 120;

export const integrationSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'Lowercase letters, digits and dashes, starting with a letter');

export const createIntegrationSchema = z.object({
  /** Names the integration in keys, secrets and the widget; it cannot change later. */
  slug: integrationSlugSchema,
  name: z.string().trim().min(2).max(80),
});
export type CreateIntegrationInput = z.output<typeof createIntegrationSchema>;

export const updateIntegrationSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    /** Off: every key of the integration is refused. */
    isActive: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
export type UpdateIntegrationInput = z.output<typeof updateIntegrationSchema>;

export const createApiKeySchema = z.object({
  name: z.string().trim().min(2).max(80),
  scopes: z
    .array(z.enum(API_KEY_SCOPES))
    .min(1, 'Choose at least one scope')
    .transform((s) => [...new Set(s)]),
  /** Requests per minute across the whole key. */
  rateLimitPerMinute: z.number().int().min(1).max(6000).default(DEFAULT_KEY_RATE_LIMIT),
  expiresAt: z.string().datetime().nullable().default(null),
});
export type CreateApiKeyInput = z.output<typeof createApiKeySchema>;

export interface IntegrationView {
  id: string;
  slug: string;
  name: string;
  isActive: boolean;
  /** Keys that still work. */
  activeKeys: number;
  createdAt: string;
  updatedAt: string;
}

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

export interface ApiKeyView {
  id: string;
  integrationId: string;
  name: string;
  /** The start of the key, enough to tell two keys apart. Never the whole key. */
  prefix: string;
  scopes: ApiKeyScope[];
  rateLimitPerMinute: number;
  status: ApiKeyStatus;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Accurate to about a minute. */
  lastUsedAt: string | null;
  createdAt: string;
  createdBy: { id: string; name: string } | null;
}

/** The answer to creating a key: the only time the key itself is returned. */
export interface CreatedApiKey extends ApiKeyView {
  key: string;
}

/** What `GET /integration` tells a key about itself. */
export interface IntegrationIdentity {
  integration: { slug: string; name: string };
  key: { name: string; prefix: string; scopes: ApiKeyScope[]; rateLimitPerMinute: number };
}
