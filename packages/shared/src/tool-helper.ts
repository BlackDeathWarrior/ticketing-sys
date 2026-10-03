import { z } from 'zod';
import { CUSTOM_TOOL_METHODS, customToolParamSchema } from './custom-tools';
import { TOOL_TIERS } from './tools';

/**
 * The AI helper in Settings → Tools (ADR 0036): a person describes the tool or
 * MCP server they want, in their own words, and the helper fills in the form.
 * It saves nothing: the person checks the form and saves it, through the same
 * routes and checks as a form filled in by hand.
 */

/** A field of a form still being written: missing is fine, and a value that does not fit is left out. */
const maybe = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

const identifier = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/);
const headerName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{1,60}$/);

/** A custom tool as far as the helper could fill it in. `enabled` is not here: a new tool starts switched off. */
export const customToolDraftSchema = z.object({
  name: maybe(identifier),
  title: maybe(z.string().trim().min(2).max(80)),
  description: maybe(z.string().trim().min(10).max(500)),
  method: maybe(z.enum(CUSTOM_TOOL_METHODS)),
  url: maybe(z.string().trim().min(8).max(500)),
  authHeader: maybe(headerName.nullable()),
  parameters: maybe(z.array(customToolParamSchema).max(12)),
  tier: maybe(z.enum(TOOL_TIERS)),
  customerArg: maybe(identifier.nullable()),
});
export type CustomToolDraft = z.output<typeof customToolDraftSchema>;

/** An MCP server as far as the helper could fill it in. */
export const mcpServerDraftSchema = z.object({
  name: maybe(z.string().trim().min(2).max(80)),
  url: maybe(z.string().trim().url().max(500)),
  authHeader: maybe(headerName.nullable()),
});
export type McpServerDraft = z.output<typeof mcpServerDraftSchema>;

/** What was said so far, oldest first: the person's descriptions and the helper's answers. */
const turns = z
  .array(
    z.object({
      from: z.enum(['you', 'helper']),
      text: z.string().trim().min(1).max(4000),
    }),
  )
  .min(1)
  .max(12);
export type ToolHelperTurn = z.infer<typeof turns>[number];

export const customToolHelperSchema = z.object({
  messages: turns,
  /** The form as it stands, so a follow-up changes it instead of starting again. */
  draft: customToolDraftSchema.optional(),
});
export type CustomToolHelperInput = z.output<typeof customToolHelperSchema>;

export const mcpServerHelperSchema = z.object({
  messages: turns,
  draft: mcpServerDraftSchema.optional(),
});
export type McpServerHelperInput = z.output<typeof mcpServerHelperSchema>;

/**
 * A connection check of a form as it stands, saved or not. It never changes
 * anything in the other system: see `ToolsService.checkCustom`.
 */
export const checkCustomToolSchema = z.object({
  method: z.enum(CUSTOM_TOOL_METHODS),
  url: z.string().trim().min(8).max(500),
  authHeader: headerName.nullable().default(null),
  /** The saved tool being edited: its stored key is used, when the address is still on the same host. */
  toolId: z.string().uuid().optional(),
});
export type CheckCustomToolInput = z.output<typeof checkCustomToolSchema>;

export const checkMcpServerSchema = z.object({
  url: z.string().trim().url().max(500),
  authHeader: headerName.nullable().default(null),
  serverId: z.string().uuid().optional(),
});
export type CheckMcpServerInput = z.output<typeof checkMcpServerSchema>;

export interface ConnectionCheck {
  ok: boolean;
  /** What happened, in plain words. */
  summary: string;
  /** The other system's answer code, when it answered. */
  status: number | null;
  /** For whoever fixes it: the error or the start of the answer. Never a key. */
  detail: string | null;
  ms: number;
  /** An MCP server that answered: how many tools it lists. */
  tools?: number;
}

/** A failed check to explain. `name` tells one bug from another in the ticket list. */
export const diagnoseConnectionSchema = z.object({
  name: z.string().trim().max(80).default(''),
  method: z.enum(CUSTOM_TOOL_METHODS).optional(),
  url: z.string().trim().min(1).max(500),
  check: z.object({
    ok: z.boolean(),
    summary: z.string().max(500),
    status: z.number().int().nullable(),
    detail: z.string().max(600).nullable(),
    ms: z.number(),
  }),
});
export type DiagnoseConnectionInput = z.output<typeof diagnoseConnectionSchema>;

export interface ConnectionDiagnosis {
  /** The likely cause, in plain words. */
  cause: string;
  /** What to try, in order. */
  steps: string[];
  /** The ticket the failure was saved in, so someone can follow it up. */
  bug: { reference: string; created: boolean } | null;
  model: string | null;
}

/** `metadata.kind` and the tag of a ticket that records a tool or server that does not connect. */
export const TOOL_PROBLEM_TICKET_KIND = 'tool_problem';
export const TOOL_PROBLEM_TAG = 'tool-bug';

export interface ToolHelperAnswer<Draft> {
  /** What the helper says back: what it filled in and what to check. */
  message: string;
  /** The fields it could fill in. Not saved: the person checks the form and saves it. */
  draft: Draft;
  /** What it still needs before the form can be saved, as questions in plain words. */
  missing: string[];
  /**
   * Custom tools only: a tool of the same system whose saved key the new tool
   * can use, so nobody has to find or type a key. Chosen by the desk from the
   * address, never by the model.
   */
  keyFrom?: { toolId: string; title: string } | null;
  model: string;
}
