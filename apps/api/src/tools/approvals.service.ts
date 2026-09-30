import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { approvals, type Database, type DbOrTx, mcpServers, toolCalls, tools } from '@tms/db';
import {
  type ApprovalStatus,
  type ApprovalView,
  type DecideApprovalInput,
  qualifiedToolName,
  type ToolTier,
} from '@tms/shared';
import { and, desc, eq, lte } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { DB } from '../infra/tokens';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';

type Row = {
  approval: typeof approvals.$inferSelect;
  call: typeof toolCalls.$inferSelect;
  tool: typeof tools.$inferSelect;
  server: typeof mcpServers.$inferSelect;
};

/**
 * Supervisor approvals for transactional tool calls (ADR 0013). Deciding only
 * records the decision; the worker runs an approved call and the AI tells the
 * customer, so no company system is called inside the request.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly tickets: TicketsService,
    private readonly users: UsersService,
  ) {}

  async list(q: { status?: ApprovalStatus; limit: number }): Promise<ApprovalView[]> {
    const rows = await this.query()
      .where(q.status ? eq(approvals.status, q.status) : undefined)
      .orderBy(desc(approvals.createdAt))
      .limit(q.limit);
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string): Promise<ApprovalView> {
    return this.view(await this.row(id));
  }

  async forTicket(ticketId: string): Promise<ApprovalView[]> {
    const rows = await this.query()
      .where(eq(approvals.ticketId, ticketId))
      .orderBy(desc(approvals.createdAt));
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async pendingCount(): Promise<number> {
    const rows = await this.db
      .select({ id: approvals.id })
      .from(approvals)
      .where(eq(approvals.status, 'pending'));
    return rows.length;
  }

  async decide(ctx: RequestCtx, id: string, input: DecideApprovalInput): Promise<ApprovalView> {
    const expired = await this.db.transaction(async (tx) => {
      const [a] = await tx.select().from(approvals).where(eq(approvals.id, id)).for('update');
      if (!a) throw new NotFoundException('Approval not found');
      if (a.status !== 'pending') {
        throw new ConflictException(`This request was already ${a.status}`);
      }
      if (a.expiresAt.getTime() <= Date.now()) {
        await this.markExpired(tx, a);
        return true;
      }
      const status = input.decision === 'approve' ? 'approved' : 'rejected';
      await tx
        .update(approvals)
        .set({
          status,
          decidedBy: ctx.user?.id ?? null,
          decidedAt: new Date(),
          note: input.note ?? null,
        })
        .where(eq(approvals.id, id));
      await tx
        .update(toolCalls)
        .set({
          status,
          ...(status === 'rejected' ? { completedAt: new Date() } : {}),
        })
        .where(eq(toolCalls.id, a.toolCallId));
      const data = {
        approvalId: id,
        toolCallId: a.toolCallId,
        decision: status,
        note: input.note ?? null,
      };
      await this.audit.record(tx, ctx, {
        action: `approval.${status}`,
        targetType: 'ticket',
        targetId: a.ticketId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'approval.decided',
        aggregateType: 'approval',
        aggregateId: id,
        payload: { ...data, ticketId: a.ticketId, conversationId: a.conversationId },
      });
      return false;
    });
    if (expired) throw new ConflictException('This request expired before it was decided');
    return this.get(id);
  }

  /** Expires a request nobody decided in time. Safe to call early or twice. */
  async expire(id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [a] = await tx
        .select()
        .from(approvals)
        .where(
          and(
            eq(approvals.id, id),
            eq(approvals.status, 'pending'),
            lte(approvals.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!a) return false;
      await this.markExpired(tx, a);
      return true;
    });
  }

  private async markExpired(tx: DbOrTx, a: typeof approvals.$inferSelect) {
    await tx.update(approvals).set({ status: 'expired' }).where(eq(approvals.id, a.id));
    await tx
      .update(toolCalls)
      .set({ status: 'expired', completedAt: new Date() })
      .where(eq(toolCalls.id, a.toolCallId));
    const data = { approvalId: a.id, toolCallId: a.toolCallId };
    await this.audit.record(tx, SYSTEM_CTX, {
      action: 'approval.expired',
      targetType: 'ticket',
      targetId: a.ticketId,
      data,
    });
    await this.outbox.publish(tx, SYSTEM_CTX, {
      type: 'approval.expired',
      aggregateType: 'approval',
      aggregateId: a.id,
      payload: { ...data, ticketId: a.ticketId, conversationId: a.conversationId },
    });
  }

  /** The approval with its call, for the follow-up after a decision. */
  async withCall(id: string) {
    return this.row(id);
  }

  private query() {
    return this.db
      .select({ approval: approvals, call: toolCalls, tool: tools, server: mcpServers })
      .from(approvals)
      .innerJoin(toolCalls, eq(toolCalls.id, approvals.toolCallId))
      .innerJoin(tools, eq(tools.id, toolCalls.toolId))
      .innerJoin(mcpServers, eq(mcpServers.id, tools.serverId))
      .$dynamic();
  }

  private async row(id: string): Promise<Row> {
    const [r] = await this.query().where(eq(approvals.id, id));
    if (!r) throw new NotFoundException('Approval not found');
    return r;
  }

  private async view(r: Row): Promise<ApprovalView> {
    const ticket = await this.tickets.get(r.approval.ticketId);
    const decider = r.approval.decidedBy
      ? await this.users.get(r.approval.decidedBy).catch(() => null)
      : null;
    return {
      id: r.approval.id,
      status: r.approval.status as ApprovalStatus,
      ticket: { id: ticket.id, reference: ticket.reference, subject: ticket.subject },
      customer: { id: ticket.customer.id, name: ticket.customer.displayName },
      tool: {
        id: r.tool.id,
        name: r.tool.name,
        title: r.tool.title,
        qualifiedName: qualifiedToolName(r.server.slug, r.tool.name),
        serverName: r.server.name,
        tier: r.tool.tier as ToolTier,
        customerArg: r.tool.customerArg,
      },
      args: r.call.args,
      summary: r.approval.summary,
      reasoning: r.approval.reasoning,
      evidence: r.approval.evidence,
      requestedAt: r.approval.createdAt.toISOString(),
      expiresAt: r.approval.expiresAt.toISOString(),
      decidedBy: decider ? { id: decider.id, name: decider.name } : null,
      decidedAt: r.approval.decidedAt?.toISOString() ?? null,
      note: r.approval.note,
      result: r.call.result,
      error: r.call.error,
    };
  }
}
