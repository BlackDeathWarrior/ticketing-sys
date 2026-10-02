import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  agentPresence,
  conversations,
  type Database,
  type DbOrTx,
  routingRules,
  teamMembers,
  teams,
  tickets,
  userSkills,
  users,
} from '@tms/db';
import {
  type AgentAvailability,
  type PresenceStatus,
  type RoutingDecision,
  type RoutingRuleInput,
  routingRuleSchema,
  type RoutingRuleView,
  type RoutingStrategy,
  ruleMatches,
  type SetPresenceInput,
} from '@tms/shared';
import { and, asc, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';

export interface Candidate {
  id: string;
  name: string;
  status: PresenceStatus;
  capacity: number;
  open: number;
  lastRoutedAt: Date | null;
  skills: string[];
}

/**
 * Picks the agent for a ticket among a team's candidates: online, with the
 * skill, below capacity; least loaded (ties: longest since last routed) or
 * round robin (longest since last routed). Pure, for unit tests.
 */
export function chooseAgent(
  candidates: Candidate[],
  strategy: RoutingStrategy,
  skill: string | null,
  exclude: string[] = [],
): Candidate | null {
  const eligible = candidates.filter(
    (c) =>
      c.status === 'online' &&
      c.open < c.capacity &&
      !exclude.includes(c.id) &&
      (!skill || c.skills.includes(skill)),
  );
  if (strategy === 'team_queue' || !eligible.length) return null;
  const since = (c: Candidate) => c.lastRoutedAt?.getTime() ?? 0;
  const sorted = [...eligible].sort((a, b) =>
    strategy === 'least_loaded'
      ? a.open - b.open || since(a) - since(b) || a.name.localeCompare(b.name)
      : since(a) - since(b) || a.name.localeCompare(b.name),
  );
  return sorted[0] ?? null;
}

/** Routing rules, skills, presence, and routing itself (ADR 0014). */
@Injectable()
export class RoutingService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly workflow: WorkflowService,
  ) {}

  // ---- rules ----

  async listRules(): Promise<RoutingRuleView[]> {
    const rows = await this.db
      .select({ r: routingRules, team: teams })
      .from(routingRules)
      .innerJoin(teams, eq(teams.id, routingRules.teamId))
      .orderBy(asc(routingRules.position), asc(routingRules.createdAt));
    return rows.map(({ r, team }) => ({
      id: r.id,
      name: r.name,
      position: r.position,
      enabled: r.enabled,
      conditions: r.conditions,
      team: { id: team.id, name: team.name },
      strategy: r.strategy as RoutingStrategy,
      requiredSkill: r.requiredSkill,
    }));
  }

  async saveRule(ctx: RequestCtx, input: RoutingRuleInput, id?: string) {
    const v = routingRuleSchema.parse(input);
    const [team] = await this.db.select().from(teams).where(eq(teams.id, v.teamId));
    if (!team) throw new BadRequestException('Team not found');
    const ruleId = await this.db.transaction(async (tx) => {
      let rid = id;
      if (id) {
        const [row] = await tx
          .update(routingRules)
          .set({ ...v, updatedAt: new Date() })
          .where(eq(routingRules.id, id))
          .returning();
        if (!row) throw new NotFoundException('Routing rule not found');
      } else {
        const [{ max } = { max: -1 }] = await tx
          .select({ max: sql<number>`coalesce(max(${routingRules.position}), -1)::int` })
          .from(routingRules);
        const [row] = await tx
          .insert(routingRules)
          .values({ ...v, position: max + 1 })
          .returning();
        rid = row!.id;
      }
      await this.changed(tx, ctx, id ? 'routing.rule_updated' : 'routing.rule_created', rid!, v);
      return rid!;
    });
    return (await this.listRules()).find((r) => r.id === ruleId)!;
  }

  async deleteRule(ctx: RequestCtx, id: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.delete(routingRules).where(eq(routingRules.id, id)).returning();
      if (!row) throw new NotFoundException('Routing rule not found');
      await this.changed(tx, ctx, 'routing.rule_deleted', id, { name: row.name });
    });
  }

  async reorder(ctx: RequestCtx, ids: string[]) {
    await this.db.transaction(async (tx) => {
      for (const [i, id] of ids.entries()) {
        await tx.update(routingRules).set({ position: i }).where(eq(routingRules.id, id));
      }
      await this.changed(tx, ctx, 'routing.rules_reordered', 'rules', { ids });
    });
    return this.listRules();
  }

  // ---- agents ----

  async setSkills(ctx: RequestCtx, userId: string, skills: string[]) {
    const [u] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!u) throw new NotFoundException('User not found');
    await this.db.transaction(async (tx) => {
      await tx.delete(userSkills).where(eq(userSkills.userId, userId));
      const unique = [...new Set(skills)];
      if (unique.length) {
        await tx.insert(userSkills).values(unique.map((skill) => ({ userId, skill })));
      }
      await this.changed(tx, ctx, 'routing.skills_set', userId, { skills: unique }, 'user');
    });
  }

  async setPresence(ctx: RequestCtx, userId: string, input: SetPresenceInput) {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(agentPresence)
        .values({ userId, status: input.status, capacity: input.capacity ?? 5 })
        .onConflictDoUpdate({
          target: agentPresence.userId,
          set: {
            status: input.status,
            ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
            updatedAt: new Date(),
          },
        });
      const data = { status: input.status, capacity: input.capacity };
      await this.audit.record(tx, ctx, {
        action: 'presence.changed',
        targetType: 'user',
        targetId: userId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'presence.changed',
        aggregateType: 'user_presence',
        aggregateId: userId,
        payload: data,
      });
    });
    return this.presenceOf(userId);
  }

  async presenceOf(userId: string) {
    const [p] = await this.db.select().from(agentPresence).where(eq(agentPresence.userId, userId));
    return { status: (p?.status ?? 'offline') as PresenceStatus, capacity: p?.capacity ?? 5 };
  }

  /** Everyone who can take tickets, with presence, load, skills and teams. */
  async agents(): Promise<AgentAvailability[]> {
    const rows = await this.candidates(null);
    const memberships = await this.db
      .select({ userId: teamMembers.userId, team: teams.name })
      .from(teamMembers)
      .innerJoin(teams, eq(teams.id, teamMembers.teamId));
    return rows.map((c) => ({
      user: { id: c.id, name: c.name },
      status: c.status,
      capacity: c.capacity,
      openTickets: c.open,
      skills: c.skills,
      teams: memberships.filter((m) => m.userId === c.id).map((m) => m.team),
    }));
  }

  // ---- routing ----

  /**
   * Routes a ticket that needs a person: keeps a still-available assignee,
   * otherwise applies the first matching rule and its strategy. Records the
   * decision (audit + `ticket.routed`) and returns it.
   */
  async route(
    ticketId: string,
    opts: { teamId?: string | null; reason: string },
  ): Promise<RoutingDecision> {
    const t = await this.tickets.get(ticketId);
    const customer = await this.customers.get(t.customerId).catch(() => null);
    const [conv] = await this.db
      .select({ language: conversations.language })
      .from(conversations)
      .where(and(eq(conversations.ticketId, t.id), isNotNull(conversations.language)))
      .orderBy(desc(conversations.createdAt))
      .limit(1);
    const language =
      conv?.language ?? (t.aiClassification as { language?: string } | null)?.language ?? null;

    let decision: RoutingDecision;
    if (t.assignee) {
      decision = {
        ruleId: null,
        ruleName: null,
        teamId: t.team?.id ?? null,
        assigneeId: t.assignee.id,
        reason: `Already assigned to ${t.assignee.name}`,
      };
    } else {
      const rules = (await this.listRules()).filter((r) => r.enabled);
      const rule = opts.teamId
        ? null
        : rules.find((r) =>
            ruleMatches(r.conditions, {
              channel: t.channel,
              priority: t.priority,
              categoryId: t.categoryId,
              subcategoryId: t.subcategoryId,
              language,
              customerType: customer?.customerType ?? null,
              tags: t.tags,
            }),
          );
      const teamId = opts.teamId ?? rule?.team.id ?? t.team?.id ?? null;
      const strategy: RoutingStrategy = rule?.strategy ?? 'least_loaded';
      const pick = teamId
        ? chooseAgent(await this.candidates(teamId), strategy, rule?.requiredSkill ?? null)
        : null;
      decision = {
        ruleId: rule?.id ?? null,
        ruleName: rule?.name ?? null,
        teamId,
        assigneeId: pick?.id ?? null,
        reason: pick
          ? `${rule ? `Rule "${rule.name}"` : 'Team'}: ${pick.name} (${ROUTE_WHY[strategy]})`
          : !teamId
            ? 'No rule matched; left in the queue'
            : strategy === 'team_queue'
              ? `Rule "${rule?.name}": team queue`
              : 'Nobody on the team is online with room; waiting in the team queue',
      };
    }

    if (
      decision.teamId !== (t.team?.id ?? null) ||
      decision.assigneeId !== (t.assignee?.id ?? null)
    ) {
      await this.tickets.assign(SYSTEM_CTX, t.id, {
        teamId: decision.teamId ?? undefined,
        assigneeId: decision.assigneeId ?? undefined,
      });
    }
    if (decision.assigneeId && !t.assignee) {
      await this.db
        .update(agentPresence)
        .set({ lastRoutedAt: new Date() })
        .where(eq(agentPresence.userId, decision.assigneeId));
    }
    await this.db.transaction(async (tx) => {
      const data = { ...decision, why: opts.reason };
      await this.audit.record(tx, SYSTEM_CTX, {
        action: 'ticket.routed',
        targetType: 'ticket',
        targetId: t.id,
        data,
      });
      await this.outbox.publish(tx, SYSTEM_CTX, {
        type: 'ticket.routed',
        aggregateType: 'ticket',
        aggregateId: t.id,
        payload: data,
      });
    });
    return decision;
  }

  /** People who can be routed to (agents and up), with presence and open tickets. */
  private async candidates(teamId: string | null): Promise<Candidate[]> {
    const open = (await this.workflow.load()).statuses
      .filter((s) => s.category === 'open' || s.category === 'pending')
      .map((s) => s.key);
    const members = teamId
      ? this.db
          .select({ id: teamMembers.userId })
          .from(teamMembers)
          .where(eq(teamMembers.teamId, teamId))
      : undefined;
    const rows = await this.db
      .select({
        id: users.id,
        name: users.name,
        status: agentPresence.status,
        capacity: agentPresence.capacity,
        lastRoutedAt: agentPresence.lastRoutedAt,
      })
      .from(users)
      .leftJoin(agentPresence, eq(agentPresence.userId, users.id))
      .where(and(eq(users.isActive, true), members ? inArray(users.id, members) : undefined))
      .orderBy(asc(users.name));
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const load = open.length
      ? await this.db
          .select({ id: tickets.assigneeId, n: sql<number>`count(*)::int` })
          .from(tickets)
          .where(and(inArray(tickets.assigneeId, ids), inArray(tickets.status, open)))
          .groupBy(tickets.assigneeId)
      : [];
    const skills = await this.db.select().from(userSkills).where(inArray(userSkills.userId, ids));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      status: (r.status ?? 'offline') as PresenceStatus,
      capacity: r.capacity ?? 5,
      open: load.find((l) => l.id === r.id)?.n ?? 0,
      lastRoutedAt: r.lastRoutedAt,
      skills: skills.filter((s) => s.userId === r.id).map((s) => s.skill),
    }));
  }

  private async changed(
    tx: DbOrTx,
    ctx: RequestCtx,
    action: string,
    id: string,
    data: Record<string, unknown>,
    targetType = 'routing',
  ) {
    await this.audit.record(tx, ctx, { action, targetType, targetId: id, data });
    await this.outbox.publish(tx, ctx, {
      type: 'routing.config_changed',
      aggregateType: 'routing',
      aggregateId: id,
      payload: { action, ...data },
    });
  }
}

const ROUTE_WHY: Record<RoutingStrategy, string> = {
  least_loaded: 'least busy',
  round_robin: 'next in turn',
  team_queue: 'team queue',
};
