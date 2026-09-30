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
  /** Search the knowledge base and read documents. */
  'kb:read',
  /** Add, edit, approve, archive and delete knowledge base documents. */
  'kb:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

const AGENT: Permission[] = [
  'kb:read',
  'ticket:read',
  'ticket:create',
  'ticket:update',
  'ticket:transition',
  'ticket:note',
  'message:send',
  'customer:read',
  'customer:write',
];

const TEAM_LEAD: Permission[] = [...AGENT, 'ticket:assign', 'user:read', 'report:read'];

const SUPERVISOR: Permission[] = [
  ...TEAM_LEAD,
  'customer:merge',
  'approval:approve',
  'audit:read',
  'kb:manage',
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
    name: 'Administrator',
    description: 'Full access including settings',
    permissions: [...PERMISSIONS],
  },
} as const satisfies Record<
  string,
  { name: string; description: string; permissions: readonly Permission[] }
>;

export type SystemRoleKey = keyof typeof SYSTEM_ROLES;
