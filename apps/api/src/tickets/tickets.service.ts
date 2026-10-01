import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  auditLog,
  categories,
  customers,
  type Database,
  type DbOrTx,
  integrations,
  internalNotes,
  teams,
  tickets,
  users,
} from '@tms/db';
import {
  type AssignTicketInput,
  type CreateTicketInput,
  formatTicketNumber,
  type ListTicketsQuery,
  parseTicketNumber,
  type TicketHandling,
  type TransitionTicketInput,
  UNASSIGNED_STATUSES,
  type UpdateTicketInput,
} from '@tms/shared';
import {
  aliasedTable,
  and,
  arrayContains,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { WorkflowService } from '../workflow/workflow.service';
import { lifecycleTimestamps } from '../workflow/workflow.rules';

export type Ticket = typeof tickets.$inferSelect;

const TRANSITION_ERRORS = {
  same_status: 'The ticket is already in that status',
  unknown_status: 'Unknown status',
  inactive_status: 'That status is disabled',
  not_allowed: 'The workflow does not allow this status change',
} as const;

const subcategories = aliasedTable(categories, 'subcategories');

@Injectable()
export class TicketsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly workflow: WorkflowService,
    private readonly customers: CustomersService,
  ) {}

  async list(q: ListTicketsQuery, ctx: RequestCtx) {
    const where: SQL[] = [];
    if (q.status)
      where.push(inArray(tickets.status, Array.isArray(q.status) ? q.status : q.status.split(',')));
    if (q.priority) where.push(eq(tickets.priority, q.priority));
    if (q.channel) where.push(eq(tickets.channel, q.channel));
    if (q.teamId) where.push(eq(tickets.teamId, q.teamId));
    if (q.customerId) where.push(eq(tickets.customerId, q.customerId));
    if (q.categoryId)
      where.push(
        or(eq(tickets.categoryId, q.categoryId), eq(tickets.subcategoryId, q.categoryId))!,
      );
    if (q.tag) where.push(arrayContains(tickets.tags, [q.tag]));
    if (q.handling) where.push(inArray(tickets.handling, q.handling.split(',')));
    if (q.sla === 'breached') where.push(eq(tickets.slaState, 'breached'));
    else if (q.sla === 'at_risk') where.push(inArray(tickets.slaState, ['at_risk', 'breached']));
    if (q.assigneeId === 'none') where.push(isNull(tickets.assigneeId));
    else if (q.assigneeId === 'me') where.push(eq(tickets.assigneeId, ctx.user!.id));
    else if (q.assigneeId) where.push(eq(tickets.assigneeId, q.assigneeId));
    if (q.q) {
      const num = parseTicketNumber(q.q);
      const term = `%${q.q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      where.push(or(ilike(tickets.subject, term), ...(num ? [eq(tickets.number, num)] : []))!);
    }
    const cond = where.length ? and(...where) : undefined;

    const [items, total] = await Promise.all([
      this.baseSelect()
        .where(cond)
        .orderBy(desc(tickets.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      this.db.$count(tickets, cond),
    ]);
    return { items: items.map(present), total };
  }

  /** Tickets an integration raised, newest first. It never sees any others (ADR 0023). */
  async forIntegration(
    integrationId: string,
    q: { externalRef?: string; statuses?: string[]; limit: number; offset: number },
  ) {
    const cond = and(
      eq(tickets.integrationId, integrationId),
      q.externalRef ? eq(tickets.externalRef, q.externalRef) : undefined,
      q.statuses ? inArray(tickets.status, q.statuses) : undefined,
    );
    const [items, total] = await Promise.all([
      this.baseSelect()
        .where(cond)
        .orderBy(desc(tickets.createdAt))
        .limit(q.limit)
        .offset(q.offset),
      this.db.$count(tickets, cond),
    ]);
    return { items: items.map(present), total };
  }

  /** Ticket numbers by id, for modules that show a reference next to their own records. */
  async numbersFor(db: DbOrTx, ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await db
      .select({ id: tickets.id, number: tickets.number })
      .from(tickets)
      .where(inArray(tickets.id, ids));
    return new Map(rows.map((r) => [r.id, r.number]));
  }

  /** One customer's tickets, most recently updated first (the customer portal). */
  async forCustomer(customerId: string, limit = 100) {
    const rows = await this.baseSelect()
      .where(eq(tickets.customerId, customerId))
      .orderBy(desc(tickets.updatedAt))
      .limit(limit);
    return rows.map(present);
  }

  /** Open and pending tickets of a team (before a team is deleted). */
  async openForTeam(teamId: string): Promise<number> {
    const { statuses } = await this.workflow.load();
    const open = statuses
      .filter((s) => s.category === 'open' || s.category === 'pending')
      .map((s) => s.key);
    if (!open.length) return 0;
    return this.db.$count(tickets, and(eq(tickets.teamId, teamId), inArray(tickets.status, open)));
  }

  /** Tickets the AI is answering that are waiting for the customer, oldest update first. */
  async awaitingCustomerWithAi(limit: number): Promise<string[]> {
    const { statuses } = await this.workflow.load();
    const pending = statuses.filter((s) => s.category === 'pending').map((s) => s.key);
    if (!pending.length) return [];
    const rows = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(and(eq(tickets.handling, 'ai'), inArray(tickets.status, pending)))
      .orderBy(asc(tickets.updatedAt))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  /**
   * Moves a ticket to a resolved status the workflow allows from where it is.
   * False when there is none, or it is no longer waiting with the AI.
   */
  async resolveInTx(tx: DbOrTx, ctx: RequestCtx, ticketId: string, resolution: string) {
    const current = await this.lock(tx, ticketId);
    if (current.handling !== 'ai') return false;
    if ((await this.workflow.status(current.status)).category !== 'pending') return false;
    const { statuses } = await this.workflow.load();
    for (const s of statuses.filter((x) => x.category === 'resolved' && x.isActive)) {
      if ((await this.workflow.check(current.status, s.key)).ok) {
        await this.applyTransition(tx, ctx, current, s.key, resolution);
        return true;
      }
    }
    return false;
  }

  /**
   * Moves an open or pending ticket to the first resolved status the workflow
   * allows from where it is. False when it is already resolved or closed, or
   * the workflow has no such move.
   */
  async resolveOpenInTx(tx: DbOrTx, ctx: RequestCtx, ticketId: string, resolution: string) {
    const current = await this.lock(tx, ticketId);
    const { category } = await this.workflow.status(current.status);
    if (category === 'resolved' || category === 'closed') return false;
    const { statuses } = await this.workflow.load();
    for (const s of statuses.filter((x) => x.category === 'resolved' && x.isActive)) {
      if ((await this.workflow.check(current.status, s.key)).ok) {
        await this.applyTransition(tx, ctx, current, s.key, resolution);
        return true;
      }
    }
    return false;
  }

  /** Accepts a UUID or a ticket reference such as "TMS-1042". */
  async get(ref: string) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref);
    const num = isUuid ? null : parseTicketNumber(ref);
    if (!isUuid && !num) throw new NotFoundException('Ticket not found');
    const cond = num ? eq(tickets.number, num) : eq(tickets.id, ref);
    const [row] = await this.baseSelect().where(cond);
    if (!row) throw new NotFoundException('Ticket not found');
    return present(row);
  }

  async create(ctx: RequestCtx, input: CreateTicketInput) {
    const ticket = await this.db.transaction((tx) => this.createInTx(tx, ctx, input));
    return this.get(ticket.id);
  }

  /**
   * Creates a ticket inside the caller's transaction (used by channel intake).
   * `integrationId` is set only by the integration API, never from a request body.
   */
  async createInTx(
    tx: DbOrTx,
    ctx: RequestCtx,
    input: CreateTicketInput & { integrationId?: string },
  ): Promise<Ticket> {
    const t = tx;
    const customer = await this.customers.findActive(t, input.customerId);
    await this.assertCategories(t, input.categoryId, input.subcategoryId);
    const initial = await this.workflow.initialStatus();
    const [ticket] = await t
      .insert(tickets)
      .values({
        customerId: customer.id,
        channel: input.channel,
        subject: input.subject,
        description: input.description,
        categoryId: input.categoryId,
        subcategoryId: input.subcategoryId,
        priority: input.priority,
        teamId: input.teamId,
        tags: [...new Set(input.tags)],
        status: initial.key,
        integrationId: input.integrationId,
        externalRef: input.externalRef,
        metadata: input.metadata ?? {},
      })
      .returning();
    const data = {
      number: formatTicketNumber(ticket!.number),
      customerId: customer.id,
      channel: ticket!.channel,
      priority: ticket!.priority,
      status: ticket!.status,
    };
    await this.audit.record(t, ctx, {
      action: 'ticket.created',
      targetType: 'ticket',
      targetId: ticket!.id,
      data,
    });
    await this.outbox.publish(t, ctx, {
      type: 'ticket.created',
      aggregateType: 'ticket',
      aggregateId: ticket!.id,
      payload: data,
    });
    return ticket!;
  }

  async update(ctx: RequestCtx, id: string, input: UpdateTicketInput) {
    await this.db.transaction((tx) => this.updateInTx(tx, ctx, id, input));
    return this.get(id);
  }

  /** Changes ticket fields inside the caller's transaction. Nothing is written when nothing changes. */
  async updateInTx(tx: DbOrTx, ctx: RequestCtx, id: string, input: UpdateTicketInput) {
    const current = await this.lock(tx, id);
    await this.assertCategories(
      tx,
      input.categoryId === undefined ? current.categoryId : input.categoryId,
      input.subcategoryId === undefined ? current.subcategoryId : input.subcategoryId,
    );
    const patch = { ...input, ...(input.tags ? { tags: [...new Set(input.tags)] } : {}) };
    const changes = diff(current, patch);
    if (!Object.keys(changes).length) return;
    await tx.update(tickets).set(patch).where(eq(tickets.id, id));
    await this.audit.record(tx, ctx, {
      action: 'ticket.updated',
      targetType: 'ticket',
      targetId: id,
      data: { changes },
    });
    await this.outbox.publish(tx, ctx, {
      type: 'ticket.updated',
      aggregateType: 'ticket',
      aggregateId: id,
      payload: { changes },
    });
  }

  async transition(ctx: RequestCtx, id: string, input: TransitionTicketInput, tx?: DbOrTx) {
    const run = async (t: DbOrTx) => {
      const current = await this.lock(t, id);
      await this.applyTransition(t, ctx, current, input.status, input.resolution);
    };
    if (tx) await run(tx);
    else await this.db.transaction(run);
    return tx ? undefined : this.get(id);
  }

  /**
   * Sets assignee and/or team. Assigning a person to a ticket that is still
   * New or with the AI moves it to Human Assigned when the workflow allows.
   */
  async assign(ctx: RequestCtx, id: string, input: AssignTicketInput) {
    await this.db.transaction((tx) => this.assignInTx(tx, ctx, id, input));
    return this.get(id);
  }

  /** `assign` inside the caller's transaction (take-over, handover). */
  async assignInTx(tx: DbOrTx, ctx: RequestCtx, id: string, input: AssignTicketInput) {
    {
      const current = await this.lock(tx, id);
      if (input.assigneeId) {
        const [u] = await tx.select().from(users).where(eq(users.id, input.assigneeId));
        if (!u || !u.isActive) throw new BadRequestException('Assignee not found or inactive');
      }
      if (input.teamId) {
        const [team] = await tx.select().from(teams).where(eq(teams.id, input.teamId));
        if (!team) throw new BadRequestException('Team not found');
      }
      const patch: Partial<Ticket> = {};
      if (input.assigneeId !== undefined) patch.assigneeId = input.assigneeId;
      if (input.teamId !== undefined) patch.teamId = input.teamId;
      const changes = diff(current, patch);
      if (!Object.keys(changes).length) return;

      await tx.update(tickets).set(patch).where(eq(tickets.id, id));
      const data = { assigneeId: patch.assigneeId, teamId: patch.teamId, changes };
      await this.audit.record(tx, ctx, {
        action: 'ticket.assigned',
        targetType: 'ticket',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'ticket.assigned',
        aggregateType: 'ticket',
        aggregateId: id,
        payload: data,
      });

      if (patch.assigneeId && (UNASSIGNED_STATUSES as readonly string[]).includes(current.status)) {
        const check = await this.workflow.check(current.status, 'human_assigned');
        if (check.ok)
          await this.applyTransition(tx, ctx, { ...current, ...patch }, 'human_assigned');
      }
    }
  }

  /**
   * A team lead escalates: priority goes up one step (to urgent at most) and
   * the team's leads are told (`ticket.escalated`).
   */
  async escalate(ctx: RequestCtx, id: string, reason: string) {
    await this.db.transaction(async (tx) => {
      const current = await this.lock(tx, id);
      const order = ['low', 'normal', 'high', 'urgent'];
      const next = order[Math.min(order.indexOf(current.priority) + 1, order.length - 1)]!;
      if (next !== current.priority) {
        await tx.update(tickets).set({ priority: next }).where(eq(tickets.id, id));
      }
      const data = { reason, from: current.priority, to: next };
      await this.audit.record(tx, ctx, {
        action: 'ticket.escalated',
        targetType: 'ticket',
        targetId: id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'ticket.escalated',
        aggregateType: 'ticket',
        aggregateId: id,
        payload: data,
      });
    });
    return this.get(id);
  }

  async addNote(ctx: RequestCtx, id: string, body: string) {
    const ticket = await this.get(id);
    return this.db.transaction((tx) => this.addNoteInTx(tx, ctx, ticket.id, body));
  }

  /** Adds an internal note inside the caller's transaction (AI handover notes use this). */
  async addNoteInTx(tx: DbOrTx, ctx: RequestCtx, ticketId: string, body: string) {
    const [note] = await tx
      .insert(internalNotes)
      .values({
        ticketId,
        authorId: ctx.user?.id,
        authorType: ctx.actor.type === 'ai' ? 'ai' : ctx.user ? 'user' : 'system',
        body,
      })
      .returning();
    await this.audit.record(tx, ctx, {
      action: 'ticket.note_added',
      targetType: 'ticket',
      targetId: ticketId,
      data: { noteId: note!.id },
    });
    await this.outbox.publish(tx, ctx, {
      type: 'ticket.note_added',
      aggregateType: 'ticket',
      aggregateId: ticketId,
      payload: { noteId: note!.id },
    });
    return note!;
  }

  async notes(id: string) {
    const ticket = await this.get(id);
    return this.db
      .select({
        id: internalNotes.id,
        body: internalNotes.body,
        authorType: internalNotes.authorType,
        createdAt: internalNotes.createdAt,
        author: { id: users.id, name: users.name },
      })
      .from(internalNotes)
      .leftJoin(users, eq(users.id, internalNotes.authorId))
      .where(eq(internalNotes.ticketId, ticket.id))
      .orderBy(asc(internalNotes.createdAt));
  }

  async history(id: string, actorType?: string) {
    const ticket = await this.get(id);
    return this.db
      .select({
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        actorName: users.name,
        data: auditLog.data,
      })
      .from(auditLog)
      .leftJoin(users, sql`${users.id}::text = ${auditLog.actorId}`)
      .where(
        and(
          eq(auditLog.targetType, 'ticket'),
          eq(auditLog.targetId, ticket.id),
          actorType ? eq(auditLog.actorType, actorType) : undefined,
        ),
      )
      .orderBy(asc(auditLog.id));
  }

  /**
   * A customer wrote again. Resolved or pending tickets go back to In Progress
   * when the workflow allows it; otherwise the status is left alone.
   */
  async reopenOnCustomerReply(
    tx: DbOrTx,
    ctx: RequestCtx,
    ticket: Ticket,
    opts: { aiControlled?: boolean } = {},
  ) {
    const { category } = await this.workflow.status(ticket.status);
    if (category !== 'resolved' && category !== 'pending') return;
    // The AI still owns the conversation: hand the reply back to it when the workflow allows.
    if (opts.aiControlled && (await this.workflow.check(ticket.status, 'ai_handling')).ok) {
      await this.applyTransition(tx, ctx, ticket, 'ai_handling');
      return;
    }
    if ((await this.workflow.check(ticket.status, 'in_progress')).ok) {
      await this.applyTransition(tx, ctx, ticket, 'in_progress');
    }
  }

  /**
   * Moves the ticket to `to` if the workflow allows it from the current
   * status; otherwise leaves it. Returns whether it moved.
   */
  async moveIfAllowed(
    tx: DbOrTx,
    ctx: RequestCtx,
    ticketId: string,
    to: string,
    resolution?: string,
  ) {
    const current = await this.lock(tx, ticketId);
    if (current.status === to || !(await this.workflow.check(current.status, to)).ok) return false;
    await this.applyTransition(tx, ctx, current, to, resolution);
    return true;
  }

  /**
   * Moves to `to`, stepping through `via` when the workflow has no direct
   * transition (e.g. AI Handling → Human Assigned → In Progress on take-over).
   */
  async moveVia(tx: DbOrTx, ctx: RequestCtx, ticketId: string, to: string, via: string) {
    const current = await this.lock(tx, ticketId);
    if (current.status === to) return true;
    if (await this.moveIfAllowed(tx, ctx, ticketId, to)) return true;
    if (!(await this.workflow.check(current.status, via)).ok) return false;
    if (!(await this.workflow.check(via, to)).ok) return false;
    await this.moveIfAllowed(tx, ctx, ticketId, via);
    return this.moveIfAllowed(tx, ctx, ticketId, to);
  }

  /** Stores what the classifier found and applies the parts it may change. */
  async applyClassification(
    tx: DbOrTx,
    ctx: RequestCtx,
    ticketId: string,
    classification: Record<string, unknown>,
    patch: { categoryId?: string; subcategoryId?: string; priority?: string },
  ) {
    const current = await this.lock(tx, ticketId);
    const changes = diff(current, patch);
    await tx
      .update(tickets)
      .set({ aiClassification: classification, ...patch })
      .where(eq(tickets.id, ticketId));
    const data = { classification, changes };
    await this.audit.record(tx, ctx, {
      action: 'ticket.classified',
      targetType: 'ticket',
      targetId: ticketId,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'ticket.classified',
      aggregateType: 'ticket',
      aggregateId: ticketId,
      payload: data,
    });
  }

  /**
   * Someone answered the customer: stamp the first response. A human reply
   * also moves New/Human Assigned to In Progress; an AI reply leaves the
   * status alone (the ticket stays with the AI).
   */
  async recordAgentReply(
    tx: DbOrTx,
    ctx: RequestCtx,
    ticket: Ticket,
    opts: { byAi?: boolean } = {},
  ) {
    if (!ticket.firstResponseAt) {
      await tx
        .update(tickets)
        .set({ firstResponseAt: new Date() })
        .where(eq(tickets.id, ticket.id));
    }
    if (opts.byAi) return;
    if (ticket.status === 'new' || ticket.status === 'human_assigned') {
      if ((await this.workflow.check(ticket.status, 'in_progress')).ok) {
        await this.applyTransition(tx, ctx, ticket, 'in_progress');
      }
    }
  }

  /**
   * Who is answering (ADR 0014). Derived state, written in the same
   * transaction as the controller change that caused it (which is audited).
   */
  async setHandling(tx: DbOrTx, id: string, handling: TicketHandling) {
    await tx.update(tickets).set({ handling }).where(eq(tickets.id, id));
  }

  /** The SLA summary the queue shows; written by the SLA service with the timers. */
  async setSlaSummary(
    tx: DbOrTx,
    id: string,
    s: { slaPolicyId: string | null; slaState: string | null; slaDueAt: Date | null },
  ) {
    await tx.update(tickets).set(s).where(eq(tickets.id, id));
  }

  /** Locks and returns the ticket row, for callers composing their own transaction. */
  lockRow(tx: DbOrTx, id: string): Promise<Ticket> {
    return this.lock(tx, id);
  }

  private async applyTransition(
    tx: DbOrTx,
    ctx: RequestCtx,
    current: Ticket,
    to: string,
    resolution?: string,
  ) {
    const check = await this.workflow.check(current.status, to);
    if (!check.ok) {
      throw new ConflictException({
        message: TRANSITION_ERRORS[check.reason],
        reason: check.reason,
        from: current.status,
        to,
      });
    }
    const target = await this.workflow.status(to);
    const patch = {
      status: to,
      ...lifecycleTimestamps(target.category, new Date()),
      ...(resolution !== undefined ? { resolution } : {}),
    };
    await tx.update(tickets).set(patch).where(eq(tickets.id, current.id));
    const data = { from: current.status, to, category: target.category };
    await this.audit.record(tx, ctx, {
      action: 'ticket.status_changed',
      targetType: 'ticket',
      targetId: current.id,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'ticket.status_changed',
      aggregateType: 'ticket',
      aggregateId: current.id,
      payload: data,
    });
  }

  private async lock(tx: DbOrTx, id: string): Promise<Ticket> {
    const [row] = await tx.select().from(tickets).where(eq(tickets.id, id)).for('update');
    if (!row) throw new NotFoundException('Ticket not found');
    return row;
  }

  private async assertCategories(
    tx: DbOrTx,
    categoryId?: string | null,
    subcategoryId?: string | null,
  ) {
    if (subcategoryId && !categoryId)
      throw new BadRequestException('A sub-category needs a category');
    if (!categoryId) return;
    const [cat] = await tx.select().from(categories).where(eq(categories.id, categoryId));
    if (!cat || cat.parentId) throw new BadRequestException('Category not found');
    if (subcategoryId) {
      const [sub] = await tx.select().from(categories).where(eq(categories.id, subcategoryId));
      if (!sub || sub.parentId !== categoryId) {
        throw new BadRequestException('Sub-category does not belong to the category');
      }
    }
  }

  private baseSelect() {
    return this.db
      .select({
        ticket: tickets,
        customer: {
          id: customers.id,
          displayName: customers.displayName,
          primaryEmail: customers.primaryEmail,
          primaryPhone: customers.primaryPhone,
          customerType: customers.customerType,
          attributes: customers.attributes,
        },
        assignee: { id: users.id, name: users.name },
        team: { id: teams.id, name: teams.name },
        category: { id: categories.id, name: categories.name },
        subcategory: { id: subcategories.id, name: subcategories.name },
        integration: { id: integrations.id, slug: integrations.slug, name: integrations.name },
      })
      .from(tickets)
      .innerJoin(customers, eq(customers.id, tickets.customerId))
      .leftJoin(users, eq(users.id, tickets.assigneeId))
      .leftJoin(teams, eq(teams.id, tickets.teamId))
      .leftJoin(categories, eq(categories.id, tickets.categoryId))
      .leftJoin(subcategories, eq(subcategories.id, tickets.subcategoryId))
      .leftJoin(integrations, eq(integrations.id, tickets.integrationId));
  }
}

type Row = Awaited<ReturnType<TicketsService['baseSelect']>>[number];

function present(row: Row) {
  return {
    ...row.ticket,
    reference: formatTicketNumber(row.ticket.number),
    customer: row.customer,
    assignee: row.assignee,
    team: row.team,
    category: row.category,
    subcategory: row.subcategory,
    integration: row.integration,
  };
}

/** Field-level before/after for audit, ignoring values that didn't change. */
function diff(current: Record<string, unknown>, patch: Record<string, unknown>) {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [k, to] of Object.entries(patch)) {
    if (to === undefined) continue;
    const from = current[k] ?? null;
    if (JSON.stringify(from) !== JSON.stringify(to ?? null)) changes[k] = { from, to };
  }
  return changes;
}
