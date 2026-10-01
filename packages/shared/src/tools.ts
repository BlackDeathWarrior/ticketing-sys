import { z } from 'zod';
import type { CustomToolDetails } from './custom-tools';

/**
 * Company-system tools for the AI agent (ADR 0013). Tools come from MCP
 * servers an admin registers; each tool has a risk tier:
 *
 * - `read`: looks data up; runs straight away.
 * - `write`: changes something reversible (an address, a note); runs straight away.
 * - `transactional`: moves money or makes a commitment (a refund, a credit);
 *   waits for a supervisor's approval.
 */
export const TOOL_TIERS = ['read', 'write', 'transactional'] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];

export const TOOL_TIER_LABELS: Record<ToolTier, string> = {
  read: 'Read only',
  write: 'Changes data',
  transactional: 'Needs approval',
};

/**
 * `ok`/`error`: ran. `awaiting_approval` → `approved` (queued to run) →
 * `running` → `ok`/`error`, or → `rejected`/`expired`. `denied`: refused
 * before running (bad arguments, unknown customer). A call left `running`
 * after a crash is never retried automatically: a person checks it.
 */
export const TOOL_CALL_STATUSES = [
  'ok',
  'error',
  'denied',
  'awaiting_approval',
  'approved',
  'running',
  'rejected',
  'expired',
] as const;
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** A name for the model: `<server slug>__<tool>`, within OpenAI's 64-character limit. */
export const qualifiedToolName = (serverSlug: string, tool: string) =>
  `${serverSlug}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

export const slugify = (name: string) =>
  name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'server';

// ---- API contracts ----

const headerName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(/^[A-Za-z0-9-]+$/, 'Letters, digits and dashes only');

export const createMcpServerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  url: z.string().trim().url().max(500),
  /** Header that carries the token, e.g. `Authorization` (sent as `Bearer <token>`) or `X-Api-Key`. */
  authHeader: headerName.nullable().default(null),
});
export type CreateMcpServerInput = z.input<typeof createMcpServerSchema>;

export const updateMcpServerSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    url: z.string().trim().url().max(500),
    authHeader: headerName.nullable(),
    enabled: z.boolean(),
  })
  .partial();
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

export const updateToolSchema = z
  .object({
    enabled: z.boolean(),
    tier: z.enum(TOOL_TIERS),
    timeoutMs: z.number().int().min(1000).max(60_000),
    /** Argument filled with the ticket customer's email; hidden from the model. */
    customerArg: z.string().trim().min(1).max(60).nullable(),
  })
  .partial();
export type UpdateToolInput = z.infer<typeof updateToolSchema>;

export const testToolSchema = z.object({
  args: z.record(z.unknown()).default({}),
  /** Fills the tool's customer argument, as a ticket's customer would. */
  customerEmail: z.string().email().optional(),
});
export type TestToolInput = z.input<typeof testToolSchema>;

export const decideApprovalSchema = z.object({
  decision: z.enum(['approve', 'reject']),
  note: z.string().trim().max(1000).optional(),
});
export type DecideApprovalInput = z.infer<typeof decideApprovalSchema>;

export const listApprovalsQuerySchema = z.object({
  status: z.enum(APPROVAL_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---- views ----

export interface McpServerView {
  id: string;
  name: string;
  slug: string;
  url: string;
  enabled: boolean;
  authHeader: string | null;
  /** The token is stored as secret `tool.<slug>.token`; only whether it is set and its last 4. */
  token: { key: string; set: boolean; last4: string | null };
  lastSyncedAt: string | null;
  lastError: string | null;
  toolCount: number;
}

export interface ToolView {
  id: string;
  serverId: string;
  serverName: string;
  name: string;
  qualifiedName: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  tier: ToolTier;
  timeoutMs: number;
  customerArg: string | null;
  /** The tool disappeared from the server at the last sync. */
  missing: boolean;
  /** Set for custom (HTTP) tools; null for tools listed by an MCP server. */
  custom: CustomToolDetails | null;
}

export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  ticket: { id: string; reference: string; subject: string };
  customer: { id: string; name: string };
  tool: {
    id: string;
    name: string;
    title: string | null;
    qualifiedName: string;
    serverName: string;
    tier: ToolTier;
    /** The argument TMS filled with the customer's email (hide it; show the customer instead). */
    customerArg: string | null;
  };
  args: Record<string, unknown>;
  /** One line for the inbox, e.g. "issue_refund: order DS-10388, 59.90". */
  summary: string;
  /** What the AI said about why it asked. */
  reasoning: string | null;
  /** The customer's words that led to it. */
  evidence: string | null;
  requestedAt: string;
  expiresAt: string;
  decidedBy: { id: string; name: string } | null;
  decidedAt: string | null;
  note: string | null;
  /** The action's result once it ran. */
  result: unknown;
  error: string | null;
}

export interface ToolCallView {
  id: string;
  tool: {
    name: string;
    title: string | null;
    qualifiedName: string;
    serverName: string;
    tier: ToolTier;
    customerArg: string | null;
  };
  status: ToolCallStatus;
  actor: 'ai' | 'user';
  args: Record<string, unknown>;
  result: unknown;
  error: string | null;
  latencyMs: number | null;
  createdAt: string;
  approval: { id: string; status: ApprovalStatus; expiresAt: string } | null;
}

/** One line describing a call's arguments, for inboxes and activity lists. */
export function describeArgs(args: Record<string, unknown>, hide: string[] = []): string {
  return Object.entries(args)
    .filter(([k, v]) => !hide.includes(k) && v !== undefined && v !== null && v !== '')
    .map(
      ([k, v]) =>
        `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`,
    )
    .join(', ');
}
