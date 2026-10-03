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

export interface ToolHelperAnswer<Draft> {
  /** What the helper says back: what it filled in and what to check. */
  message: string;
  /** The fields it could fill in. Not saved: the person checks the form and saves it. */
  draft: Draft;
  /** What it still needs before the form can be saved, as questions in plain words. */
  missing: string[];
  model: string;
}
