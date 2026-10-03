import { z } from 'zod';
import type { Permission } from './permissions';
import { TOOL_TIERS } from './tools';

/**
 * Custom tools (ADR 0017): an HTTP request to a company system, described in
 * Settings instead of being listed by an MCP server. They run through the
 * same gateway as MCP tools: validation, customer binding, risk tiers,
 * approvals and the audit trail all apply.
 */
export const CUSTOM_TOOL_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type CustomToolMethod = (typeof CUSTOM_TOOL_METHODS)[number];

export const CUSTOM_TOOL_PARAM_TYPES = ['string', 'number', 'integer', 'boolean'] as const;
export type CustomToolParamType = (typeof CUSTOM_TOOL_PARAM_TYPES)[number];

/** The slug of the built-in "server" that custom tools live under. */
export const CUSTOM_TOOLS_SLUG = 'custom';
/** The secret that holds a custom tool's token. */
export const customToolTokenKey = (name: string) => `tool.custom_${name}.token`;

const identifier = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{1,39}$/,
    'Lowercase letters, digits and underscores, starting with a letter',
  );

export const customToolParamSchema = z.object({
  name: identifier,
  type: z.enum(CUSTOM_TOOL_PARAM_TYPES).default('string'),
  description: z.string().trim().max(200).default(''),
  required: z.boolean().default(true),
});
export type CustomToolParam = z.output<typeof customToolParamSchema>;

/** `{name}` placeholders in a URL, in order of appearance, without repeats. */
export function urlPlaceholders(url: string): string[] {
  return [...new Set([...url.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1]!))];
}

const fields = {
  /** What the model calls: `custom__<name>`. */
  name: identifier,
  title: z.string().trim().min(2).max(80),
  /** The AI decides when to use the tool from this, so it must say what the tool does. */
  description: z.string().trim().min(10).max(500),
  method: z.enum(CUSTOM_TOOL_METHODS),
  /** `https://api.example.com/orders/{order_id}`: placeholders are filled from the arguments. */
  url: z.string().trim().min(8).max(500),
  /** Header that carries the token (`Authorization` sends `Bearer <token>`); null for none. */
  authHeader: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{1,60}$/, 'Letters, digits and dashes only')
    .nullable()
    .default(null),
  parameters: z.array(customToolParamSchema).max(12).default([]),
  tier: z.enum(TOOL_TIERS).default('read'),
  /** A parameter filled with the ticket customer's email and hidden from the model. */
  customerArg: identifier.nullable().default(null),
  timeoutMs: z.number().int().min(1000).max(60_000).default(8000),
  enabled: z.boolean().default(false),
};

type Checked = {
  url?: string;
  parameters?: Array<{ name: string; required: boolean }>;
  customerArg?: string | null;
};

/** Rules that span fields: the URL, its placeholders and the customer argument. */
function check(v: Checked, ctx: z.RefinementCtx) {
  const names = (v.parameters ?? []).map((p) => p.name);
  if (new Set(names).size !== names.length) {
    ctx.addIssue({ code: 'custom', path: ['parameters'], message: 'Parameter names must differ' });
  }
  if (v.url !== undefined) {
    // Placeholders are swapped for a letter so the rest of the URL can be checked.
    let parsed: URL | null = null;
    try {
      parsed = new URL(v.url.replace(/\{[^{}]*\}/g, 'x'));
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: 'Enter an http or https address' });
    } else if (/\{[^{}]*\}/.test(v.url.split('/').slice(0, 3).join('/'))) {
      // The host decides where customer data goes: it can't come from an argument.
      ctx.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Placeholders can only be used after the host name',
      });
    }
    for (const p of urlPlaceholders(v.url)) {
      const param = (v.parameters ?? []).find((x) => x.name === p);
      if (!param) {
        ctx.addIssue({
          code: 'custom',
          path: ['url'],
          message: `{${p}} is in the URL but is not a parameter`,
        });
      } else if (!param.required) {
        ctx.addIssue({
          code: 'custom',
          path: ['parameters'],
          message: `${p} is part of the URL, so it must be required`,
        });
      }
    }
  }
  if (v.customerArg && !names.includes(v.customerArg)) {
    ctx.addIssue({
      code: 'custom',
      path: ['customerArg'],
      message: 'The customer email must go into one of the parameters',
    });
  }
}

export const createCustomToolSchema = z.object(fields).superRefine(check);
export type CreateCustomToolInput = z.input<typeof createCustomToolSchema>;
export type ParsedCustomTool = z.output<typeof createCustomToolSchema>;

/** The whole definition again, except the name, which the model and the call history refer to. */
export const updateCustomToolSchema = z
  .object({
    title: fields.title,
    description: fields.description,
    method: fields.method,
    url: fields.url,
    authHeader: fields.authHeader,
    parameters: fields.parameters,
    tier: fields.tier,
    customerArg: fields.customerArg,
    timeoutMs: fields.timeoutMs,
    enabled: fields.enabled,
  })
  .superRefine(check);
export type UpdateCustomToolInput = z.input<typeof updateCustomToolSchema>;
export type ParsedCustomToolUpdate = z.output<typeof updateCustomToolSchema>;

/** The JSON Schema the model and the gateway's validator use, built from the parameter list. */
export function customToolInputSchema(parameters: CustomToolParam[]): Record<string, unknown> {
  const required = parameters.filter((p) => p.required).map((p) => p.name);
  return {
    type: 'object',
    properties: Object.fromEntries(
      parameters.map((p) => [
        p.name,
        { type: p.type, ...(p.description ? { description: p.description } : {}) },
      ]),
    ),
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

/** How a custom tool reaches its system; stored on the tool. */
export interface CustomToolHttp {
  method: CustomToolMethod;
  url: string;
  authHeader: string | null;
  parameters: CustomToolParam[];
}

export interface CustomToolDetails extends CustomToolHttp {
  token: { key: string; set: boolean; last4: string | null };
  createdBy: { id: string; name: string } | null;
}

// ---- Who may create custom tools ----

/**
 * Permissions an admin may hand to other roles (Settings → People → Roles).
 * A role keeps its built-in permissions; these can be added on top. Keys,
 * people, teams, integrations, models and the system stay admin-only.
 */
export const DELEGABLE_PERMISSIONS = [
  'tool:create',
  'approval:approve',
  'ticket:assign',
  'ticket:escalate',
  'ticket:any_team',
  'kb:manage',
  'report:read',
  'report:export',
  'learning:manage',
  'customer:merge',
  'audit:read',
  'voice:recording_read',
  'settings:priority',
  'settings:routing',
  'settings:sla',
  'settings:categories',
] as const satisfies readonly Permission[];

/** What each delegable permission lets someone do, for the roles table. */
export const DELEGABLE_LABELS: Record<DelegablePermission, string> = {
  'tool:create': 'Create custom tools',
  'approval:approve': 'Approve requests on any team',
  'ticket:assign': 'Assign tickets',
  'ticket:escalate': 'Escalate tickets',
  'ticket:any_team': "Act on other teams' tickets",
  'kb:manage': 'Manage the knowledge base',
  'report:read': 'See reports',
  'report:export': 'Export reports',
  'learning:manage': 'Review ratings and write lessons',
  'customer:merge': 'Merge customers',
  'audit:read': 'Read the audit trail',
  'voice:recording_read': 'Listen to call recordings',
  'settings:priority': 'Edit priority rules',
  'settings:routing': 'Edit routing',
  'settings:sla': 'Edit SLA policies',
  'settings:categories': 'Edit categories',
};
export type DelegablePermission = (typeof DELEGABLE_PERMISSIONS)[number];

export const isDelegable = (p: string): p is DelegablePermission =>
  (DELEGABLE_PERMISSIONS as readonly string[]).includes(p);

export interface RoleView {
  key: string;
  name: string;
  description: string | null;
  permissions: string[];
  /** The permissions an admin granted on top of the role's built-in ones. */
  grants?: string[];
  /** Roles whose permissions can't be changed (administrators always have everything). */
  locked: boolean;
}
