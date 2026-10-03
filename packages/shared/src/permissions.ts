/**
 * Permission strings checked by the API. Roles are stored in the database and
 * map to these; SYSTEM_ROLES is the default set written by the seed script.
 */
export const PERMISSIONS = [
  'ticket:read',
  'ticket:create',
  'ticket:update',
  'ticket:assign',
  'ticket:transition',
  'ticket:note',
  'message:send',
  'customer:read',
  'customer:write',
  'customer:merge',
  'user:read',
  'user:manage',
  'team:manage',
  'settings:workflow',
  'settings:categories',
  'settings:llm',
  /** Create, rotate or delete API keys and credentials (LLM, channels, tools). Admin only. */
  'settings:secrets',
  'settings:channels',
  'audit:read',
  'approval:approve',
  'report:read',
  /** Download report data as CSV. */
  'report:export',
  /** Review rated tickets and write the lessons the AI follows. */
  'learning:manage',
  /** Failed background jobs and data retention. Admin only. */
  'system:manage',
  /** Search the knowledge base and read documents. */
  'kb:read',
  /** Add, edit, approve, archive and delete knowledge base documents. */
  'kb:manage',
  /** Approve, edit or discard AI-drafted replies. */
  'message:approve_draft',
  /** AI behaviour: autonomy per channel, thresholds. */
  'settings:ai',
  /** Register MCP servers, enable tools, set risk tiers, run test calls. Admin only. */
  'tool:manage',
  /**
   * Create, edit, test and switch on custom (HTTP) tools. Admins have it; an
   * admin can grant it to other roles. Keys still need `settings:secrets`.
   */
  'tool:create',
  /** Join a live voice call and speak with the caller. */
  'voice:answer',
  /** Listen to call recordings. */
  'voice:recording_read',
  /** Take a conversation over from the AI or the queue, and hand it back. */
  'conversation:takeover',
  /** Routing rules, agent skills and capacities. */
  'settings:routing',
  /** SLA policies, business hours and holidays. */
  'settings:sla',
  /** Raise a ticket's priority and send it to a team lead. */
  'ticket:escalate',
  /** Connect outside apps: integrations and their API keys. Admin only. */
  'integration:manage',
  /**
   * Scopes of an integration's API key (ADR 0022). The routes that need them
   * accept keys only, so holding one as a person opens nothing.
   */
  'integration:ticket',
  'integration:event',
  'integration:customer',
  /**
   * Act on any team's tickets (ADR 0031). Without it a ticket that belongs to
   * a team can be read and noted by anyone, but only its team acts on it.
   */
  'ticket:any_team',
  /** Priority rules: what makes a ticket urgent, high, normal or low (ADR 0032). */
  'settings:priority',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

const AGENT: Permission[] = [
  'voice:answer',
  'conversation:takeover',
  'kb:read',
  'message:approve_draft',
  'ticket:read',
  'ticket:create',
  'ticket:update',
  'ticket:transition',
  'ticket:note',
  'message:send',
  'customer:read',
  'customer:write',
];

const TEAM_LEAD: Permission[] = [
  ...AGENT,
  'ticket:assign',
  'ticket:escalate',
  'user:read',
  'report:read',
  'report:export',
];

const SUPERVISOR: Permission[] = [
  ...TEAM_LEAD,
  'customer:merge',
  'approval:approve',
  'audit:read',
  'kb:manage',
  'voice:recording_read',
  'learning:manage',
];

export const SYSTEM_ROLES = {
  agent: {
    name: 'Agent',
    description: 'Handles assigned tickets and live conversations',
    permissions: AGENT,
  },
  team_lead: {
    name: 'Team lead',
    description: 'Assigns work and monitors queues',
    permissions: TEAM_LEAD,
  },
  supervisor: {
    name: 'Supervisor',
    description: 'Approves high-risk actions, merges customers, reads the audit trail',
    permissions: SUPERVISOR,
  },
  admin: {
    name: 'Super admin',
    description: 'Every permission, on every team’s tickets, including settings',
    permissions: [...PERMISSIONS],
  },
} as const satisfies Record<
  string,
  { name: string; description: string; permissions: readonly Permission[] }
>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
