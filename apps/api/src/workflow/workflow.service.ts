import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Database, ticketStatuses, workflowTransitions } from '@tms/db';
import { asc, eq } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { checkTransition, type TransitionCheck } from './workflow.rules';

type Status = typeof ticketStatuses.$inferSelect;
type Transition = typeof workflowTransitions.$inferSelect;

@Injectable()
export class WorkflowService {
  /**
   * In-process cache. Cleared on local edits; the TTL bounds staleness when
   * another API instance changes the workflow.
   */
  private cache: { statuses: Status[]; transitions: Transition[]; at: number } | null = null;
  private static readonly TTL_MS = 30_000;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  async load() {
    if (!this.cache || Date.now() - this.cache.at > WorkflowService.TTL_MS) {
      const [statuses, transitions] = await Promise.all([
        this.db.select().from(ticketStatuses).orderBy(asc(ticketStatuses.sortOrder)),
        this.db.select().from(workflowTransitions),
      ]);
      this.cache = { statuses, transitions, at: Date.now() };
    }
    const { statuses, transitions } = this.cache;
    return { statuses, transitions };
  }

  async initialStatus(): Promise<Status> {
    const { statuses } = await this.load();
    const s = statuses.find((x) => x.isInitial && x.isActive);
    if (!s) throw new Error('No initial ticket status configured');
    return s;
  }

  async status(key: string): Promise<Status> {
    const { statuses } = await this.load();
    const s = statuses.find((x) => x.key === key);
    if (!s) throw new NotFoundException(`Unknown status "${key}"`);
    return s;
  }

  async check(from: string, to: string): Promise<TransitionCheck> {
    const { statuses, transitions } = await this.load();
    return checkTransition(statuses, transitions, from, to);
  }

  async upsertStatus(ctx: RequestCtx, input: Omit<Status, 'isInitial'>) {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(ticketStatuses)
        .values(input)
        .onConflictDoUpdate({
          target: ticketStatuses.key,
          set: {
            name: input.name,
            category: input.category,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
          },
        });
      await this.audit.record(tx, ctx, {
        action: 'workflow.status_upserted',
        targetType: 'ticket_status',
        targetId: input.key,
        data: input,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'workflow.status_upserted',
        aggregateType: 'workflow',
        aggregateId: input.key,
        payload: input,
      });
    });
    this.cache = null;
    return this.load();
  }

  /** Replaces the full transition graph in one step. */
  async setTransitions(ctx: RequestCtx, transitions: Array<{ from: string; to: string }>) {
    const { statuses } = await this.load();
    const keys = new Set(statuses.map((s) => s.key));
    const unknown = transitions.flatMap((t) => [t.from, t.to]).filter((k) => !keys.has(k));
    if (unknown.length) {
      throw new BadRequestException(`Unknown status(es): ${[...new Set(unknown)].join(', ')}`);
    }
    await this.db.transaction(async (tx) => {
      await tx.delete(workflowTransitions);
      await tx
        .insert(workflowTransitions)
        .values(transitions.map((t) => ({ fromStatus: t.from, toStatus: t.to })))
        .onConflictDoNothing();
      await this.audit.record(tx, ctx, {
        action: 'workflow.transitions_replaced',
        targetType: 'workflow',
        data: { count: transitions.length, transitions },
      });
      await this.outbox.publish(tx, ctx, {
        type: 'workflow.transitions_replaced',
        aggregateType: 'workflow',
        aggregateId: 'default',
        payload: { count: transitions.length },
      });
    });
    this.cache = null;
    return this.load();
  }

  async deactivateStatus(ctx: RequestCtx, key: string) {
    const s = await this.status(key);
    if (s.isInitial) throw new BadRequestException('The initial status cannot be deactivated');
    await this.db.transaction(async (tx) => {
      await tx.update(ticketStatuses).set({ isActive: false }).where(eq(ticketStatuses.key, key));
      await this.audit.record(tx, ctx, {
        action: 'workflow.status_deactivated',
        targetType: 'ticket_status',
        targetId: key,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'workflow.status_deactivated',
        aggregateType: 'workflow',
        aggregateId: key,
        payload: { key },
      });
    });
    this.cache = null;
    return this.load();
  }
}
