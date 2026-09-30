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
  conversations,
  customers,
  type Database,
  type DbOrTx,
  internalNotes,
  messages,
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

type Ticket = typeof tickets.$inferSelect;

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

  async create(ctx: RequestCtx, input: CreateTicketInput, tx?: DbOrTx) {
    const run = async (t: DbOrTx) => {
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
    };
    const ticket = tx ? await run(tx) : await this.db.transaction(run);
    return tx ? ticket : this.get(ticket.id);
  }

  async update(ctx: RequestCtx, id: string, input: UpdateTicketInput) {
    await this.db.transaction(async (tx) => {
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
    });
    return this.get(id);
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
    await this.db.transaction(async (tx) => {
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
    });
    return this.get(id);
  }

  async addNote(ctx: RequestCtx, id: string, body: string) {
    const ticket = await this.get(id);
    return this.db.transaction(async (tx) => {
      const [note] = await tx
        .insert(internalNotes)
        .values({ ticketId: ticket.id, authorId: ctx.user?.id, body })
        .returning();
      await this.audit.record(tx, ctx, {
        action: 'ticket.note_added',
        targetType: 'ticket',
        targetId: ticket.id,
        data: { noteId: note!.id },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'ticket.note_added',
        aggregateType: 'ticket',
        aggregateId: ticket.id,
        payload: { noteId: note!.id },
      });
      return note!;
    });
  }

  async notes(id: string) {
    const ticket = await this.get(id);
    return this.db
      .select({
        id: internalNotes.id,
        body: internalNotes.body,
        createdAt: internalNotes.createdAt,
        author: { id: users.id, name: users.name },
      })
      .from(internalNotes)
      .leftJoin(users, eq(users.id, internalNotes.authorId))
      .where(eq(internalNotes.ticketId, ticket.id))
      .orderBy(asc(internalNotes.createdAt));
  }

  async history(id: string) {
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
      .where(and(eq(auditLog.targetType, 'ticket'), eq(auditLog.targetId, ticket.id)))
      .orderBy(asc(auditLog.id));
  }

  /** Conversations with their messages, oldest first. Populated by channels from Phase 2. */
  async conversations(id: string) {
    const ticket = await this.get(id);
    const convs = await this.db
      .select()
      .from(conversations)
      .where(eq(conversations.ticketId, ticket.id))
      .orderBy(asc(conversations.createdAt));
    if (!convs.length) return [];
    const msgs = await this.db
      .select()
      .from(messages)
      .where(
        inArray(
          messages.conversationId,
          convs.map((c) => c.id),
        ),
      )
      .orderBy(asc(messages.createdAt));
    return convs.map((c) => ({ ...c, messages: msgs.filter((m) => m.conversationId === c.id) }));
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
        customer: { id: customers.id, displayName: customers.displayName },
        assignee: { id: users.id, name: users.name },
        team: { id: teams.id, name: teams.name },
        category: { id: categories.id, name: categories.name },
        subcategory: { id: subcategories.id, name: subcategories.name },
      })
      .from(tickets)
      .innerJoin(customers, eq(customers.id, tickets.customerId))
      .leftJoin(users, eq(users.id, tickets.assigneeId))
      .leftJoin(teams, eq(teams.id, tickets.teamId))
      .leftJoin(categories, eq(categories.id, tickets.categoryId))
      .leftJoin(subcategories, eq(subcategories.id, tickets.subcategoryId));
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
