import { z } from 'zod';
import { prioritySchema } from './tickets';

/**
 * Routing (ADR 0014): ordered rules pick a team (and optionally a skill) for
 * tickets that need a person; a strategy picks the agent among the team's
 * online members with room under their capacity.
 */
export const ROUTING_STRATEGIES = ['least_loaded', 'round_robin', 'team_queue'] as const;
export type RoutingStrategy = (typeof ROUTING_STRATEGIES)[number];

export const ROUTING_STRATEGY_LABELS: Record<RoutingStrategy, string> = {
  least_loaded: 'Least busy agent',
  round_robin: 'Take turns',
  team_queue: 'Team queue only',
};

export const PRESENCE_STATUSES = ['online', 'away', 'offline'] as const;
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number];

const skill = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(40)
  .regex(/^[\p{L}\p{N}_ -]+$/u, 'Letters, digits, spaces, dashes');

export const routingConditionsSchema = z
  .object({
    channel: z.string().max(40).optional(),
    priority: prioritySchema.optional(),
    categoryId: z.string().uuid().optional(),
    /** ISO 639-1, as detected on the conversation or classified on the ticket. */
    language: z.string().min(2).max(8).optional(),
    customerType: z.string().max(40).optional(),
  })
  .strict();
export type RoutingConditions = z.infer<typeof routingConditionsSchema>;

export const routingRuleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  enabled: z.boolean().default(true),
  conditions: routingConditionsSchema.default({}),
  teamId: z.string().uuid(),
  strategy: z.enum(ROUTING_STRATEGIES).default('least_loaded'),
  /** Only agents with this skill (e.g. "hindi", "billing") are picked. */
  requiredSkill: skill.nullable().default(null),
});
export type RoutingRuleInput = z.input<typeof routingRuleSchema>;

export const reorderRulesSchema = z.object({ ids: z.array(z.string().uuid()).max(200) });

export const setSkillsSchema = z.object({ skills: z.array(skill).max(30) });

export const setPresenceSchema = z.object({
  status: z.enum(PRESENCE_STATUSES),
  /** Open tickets they can hold before routing skips them. */
  capacity: z.number().int().min(0).max(100).optional(),
});
export type SetPresenceInput = z.infer<typeof setPresenceSchema>;

export interface RoutingRuleView {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  conditions: RoutingConditions;
  team: { id: string; name: string };
  strategy: RoutingStrategy;
  requiredSkill: string | null;
}

export interface AgentAvailability {
  user: { id: string; name: string };
  status: PresenceStatus;
  capacity: number;
  openTickets: number;
  skills: string[];
  teams: string[];
}

/** Why a ticket went where it went, for the audit trail and the drawer. */
export interface RoutingDecision {
  ruleId: string | null;
  ruleName: string | null;
  teamId: string | null;
  assigneeId: string | null;
  reason: string;
}

/** Does a rule's conditions match a ticket's facts? Empty conditions match everything. */
export function ruleMatches(
  c: RoutingConditions,
  t: {
    channel: string;
    priority: string;
    categoryId: string | null;
    subcategoryId: string | null;
    language: string | null;
    customerType: string | null;
  },
): boolean {
  if (c.channel && c.channel !== t.channel) return false;
  if (c.priority && c.priority !== t.priority) return false;
  if (c.categoryId && c.categoryId !== t.categoryId && c.categoryId !== t.subcategoryId) {
    return false;
  }
  if (c.language && c.language !== t.language) return false;
  if (c.customerType && c.customerType !== t.customerType) return false;
  return true;
}
