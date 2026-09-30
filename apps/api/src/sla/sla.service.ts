import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  businessHours,
  type Database,
  type DbOrTx,
  holidays,
  slaPolicies,
  slaTimers,
  tickets,
} from '@tms/db';
import {
  type BusinessHoursInput,
  businessHoursSchema,
  type BusinessHoursView,
  pickPolicy,
  SLA_AT_RISK_SHARE,
  SLA_KINDS,
  type SlaKind,
  type SlaPolicyInput,
  slaPolicySchema,
  type SlaPolicyView,
  type SlaState,
  type SlaTimerState,
  type TicketSlaView,
} from '@tms/shared';
import { and, asc, eq, inArray, lte, notInArray } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';
import {
  ALWAYS_OPEN,
  addBusinessMinutes,
  businessMinutesBetween,
  type Hours,
} from './business-time';

type Timer = typeof slaTimers.$inferSelect;
type Policy = typeof slaPolicies.$inferSelect;

/**
 * SLA timers (ADR 0014). `reconcile` brings a ticket's timers in line with
 * its current facts (policy, first response, status category) and is safe to
 * call any number of times; the worker calls it on ticket events. `sweep`
 * marks timers at risk (80%) and breached, and runs every few seconds.
 */
@Injectable()
export class SlaService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly workflow: WorkflowService,
  ) {}

  // ---- settings ----

  async listPolicies(): Promise<SlaPolicyView[]> {
    const rows = await this.db
      .select({ p: slaPolicies, h: businessHours })
      .from(slaPolicies)
      .leftJoin(businessHours, eq(businessHours.id, slaPolicies.businessHoursId))
      .orderBy(asc(slaPolicies.name));
    return rows.map(({ p, h }) => ({
      id: p.id,
      name: p.name,
      priority: p.priority,
      customerType: p.customerType,
      firstResponseMinutes: p.firstResponseMinutes,
      resolutionMinutes: p.resolutionMinutes,
      businessHours: h ? { id: h.id, name: h.name, timezone: h.timezone } : null,
      enabled: p.enabled,
    }));
  }

  async savePolicy(ctx: RequestCtx, input: SlaPolicyInput, id?: string) {
    const v = slaPolicySchema.parse(input);
    if (v.businessHoursId) await this.hoursRow(v.businessHoursId);
    const policyId = await this.db.transaction(async (tx) => {
      let pid = id;
      if (id) {
        const [row] = await tx
          .update(slaPolicies)
          .set({ ...v, updatedAt: new Date() })
          .where(eq(slaPolicies.id, id))
          .returning();
        if (!row) throw new NotFoundException('SLA policy not found');
      } else {
        const [row] = await tx.insert(slaPolicies).values(v).returning();
        pid = row!.id;
      }
      await this.configChanged(tx, ctx, id ? 'sla.policy_updated' : 'sla.policy_created', pid!, v);
      return pid!;
    });
    return (await this.listPolicies()).find((p) => p.id === policyId)!;
  }

  async deletePolicy(ctx: RequestCtx, id: string) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx.delete(slaPolicies).where(eq(slaPolicies.id, id)).returning();
      if (!row) throw new NotFoundException('SLA policy not found');
      await this.configChanged(tx, ctx, 'sla.policy_deleted', id, { name: row.name });
    });
  }

  async listHours(): Promise<BusinessHoursView[]> {
    const rows = await this.db.select().from(businessHours).orderBy(asc(businessHours.name));
    const days = await this.db.select().from(holidays).orderBy(asc(holidays.date));
    return rows.map((h) => ({
      id: h.id,
      name: h.name,
      timezone: h.timezone,
      schedule: h.schedule,
      holidays: days
        .filter((d) => d.businessHoursId === h.id)
        .map((d) => ({ date: d.date, name: d.name })),
    }));
  }

  async saveHours(ctx: RequestCtx, input: BusinessHoursInput, id?: string) {
    const v = businessHoursSchema.parse(input);
    const hoursId = await this.db.transaction(async (tx) => {
      let hid = id;
      const values = { name: v.name, timezone: v.timezone, schedule: v.schedule };
      if (id) {
        const [row] = await tx
          .update(businessHours)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(businessHours.id, id))
          .returning();
        if (!row) throw new NotFoundException('Business hours not found');
        await tx.delete(holidays).where(eq(holidays.businessHoursId, id));
      } else {
        const [row] = await tx.insert(businessHours).values(values).returning();
        hid = row!.id;
      }
      if (v.holidays.length) {
        await tx
          .insert(holidays)
          .values(v.holidays.map((d) => ({ businessHoursId: hid!, date: d.date, name: d.name })))
          .onConflictDoNothing();
      }
      await this.configChanged(tx, ctx, id ? 'sla.hours_updated' : 'sla.hours_created', hid!, {
        name: v.name,
        timezone: v.timezone,
      });
      return hid!;
    });
    return (await this.listHours()).find((h) => h.id === hoursId)!;
  }

  async deleteHours(ctx: RequestCtx, id: string) {
    const [used] = await this.db
      .select({ id: slaPolicies.id })
      .from(slaPolicies)
      .where(eq(slaPolicies.businessHoursId, id))
      .limit(1);
    if (used) throw new ConflictException('A policy uses these business hours');
    await this.db.transaction(async (tx) => {
      const [row] = await tx.delete(businessHours).where(eq(businessHours.id, id)).returning();
      if (!row) throw new NotFoundException('Business hours not found');
      await this.configChanged(tx, ctx, 'sla.hours_deleted', id, { name: row.name });
    });
  }

  // ---- timers ----

  /** Brings the ticket's timers in line with its policy, first response and status. Idempotent. */
  async reconcile(ticketId: string, now = new Date()): Promise<void> {
    const view = await this.tickets.get(ticketId).catch(() => null);
    if (!view) return;
    const category = (await this.workflow.status(view.status)).category;
    const customer = await this.customers.get(view.customerId).catch(() => null);
    const policies = await this.db.select().from(slaPolicies);
    const policy = pickPolicy(policies, {
      priority: view.priority,
      customerType: customer?.customerType ?? null,
    });

    await this.db.transaction(async (tx) => {
      const t = await this.tickets.lockRow(tx, ticketId);
      const timers = await tx
        .select()
        .from(slaTimers)
        .where(eq(slaTimers.ticketId, ticketId))
        .for('update');
      if (!policy && !timers.length) return;
      const hours = policy ? await this.hoursFor(policy) : ALWAYS_OPEN;
      const changes: string[] = [];

      for (const kind of SLA_KINDS) {
        const target = policy
          ? kind === 'first_response'
            ? policy.firstResponseMinutes
            : policy.resolutionMinutes
          : null;
        let timer = timers.find((x) => x.kind === kind);
        if (!timer) {
          if (!target) continue;
          const [created] = await tx
            .insert(slaTimers)
            .values({
              ticketId,
              policyId: policy!.id,
              kind,
              state: 'running',
              targetMinutes: target,
              startedAt: t.createdAt,
              resumedAt: t.createdAt,
              ...schedule(target, 0, t.createdAt, hours),
            })
            .returning();
          timer = created!;
          timers.push(timer);
          changes.push(`${kind} started`);
        }

        const desired: 'running' | 'paused' | 'met' =
          kind === 'first_response'
            ? t.firstResponseAt
              ? 'met'
              : 'running'
            : category === 'resolved' || category === 'closed'
              ? 'met'
              : category === 'pending'
                ? 'paused'
                : 'running';
        const next = step(timer, desired, {
          now,
          hours,
          target: target ?? timer.targetMinutes,
          policyId: policy?.id ?? timer.policyId,
          metAt: kind === 'first_response' ? t.firstResponseAt : (t.resolvedAt ?? now),
        });
        if (next) {
          await tx
            .update(slaTimers)
            .set({ ...next, updatedAt: now })
            .where(eq(slaTimers.id, timer.id));
          changes.push(
            next.state && next.state !== timer.state ? `${kind} ${next.state}` : `${kind} updated`,
          );
          Object.assign(timer, next);
        }
      }

      const summary = summarize(timers, category, now);
      if (
        changes.length ||
        t.slaState !== summary.state ||
        t.slaPolicyId !== (policy?.id ?? t.slaPolicyId) ||
        (t.slaDueAt?.getTime() ?? null) !== (summary.dueAt?.getTime() ?? null)
      ) {
        await this.tickets.setSlaSummary(tx, ticketId, {
          slaPolicyId: policy?.id ?? t.slaPolicyId,
          slaState: summary.state,
          slaDueAt: summary.dueAt,
        });
        const data = { changes, state: summary.state, dueAt: summary.dueAt?.toISOString() ?? null };
        await this.audit.record(tx, SYSTEM_CTX, {
          action: 'sla.updated',
          targetType: 'ticket',
          targetId: ticketId,
          data,
        });
        await this.outbox.publish(tx, SYSTEM_CTX, {
          type: 'sla.updated',
          aggregateType: 'ticket',
          aggregateId: ticketId,
          payload: data,
        });
      }
    });
  }

  /** Marks running timers at risk (80% used) and breached (due). Returns what it did. */
  async sweep(now = new Date()): Promise<{ atRisk: number; breached: number }> {
    let atRisk = 0;
    let breached = 0;
    const dueRows = await this.db
      .select({ id: slaTimers.id, ticketId: slaTimers.ticketId })
      .from(slaTimers)
      .where(and(eq(slaTimers.state, 'running'), lte(slaTimers.dueAt, now)))
      .limit(500);
    const riskRows = await this.db
      .select({ id: slaTimers.id, ticketId: slaTimers.ticketId })
      .from(slaTimers)
      .where(
        and(
          eq(slaTimers.state, 'running'),
          eq(slaTimers.atRiskNotified, false),
          lte(slaTimers.atRiskAt, now),
        ),
      )
      .limit(500);

    for (const r of [...dueRows, ...riskRows]) {
      const did = await this.db.transaction(async (tx) => {
        await this.tickets.lockRow(tx, r.ticketId);
        const [timer] = await tx
          .select()
          .from(slaTimers)
          .where(eq(slaTimers.id, r.id))
          .for('update');
        if (!timer || timer.state !== 'running') return null;
        const isDue = timer.dueAt && timer.dueAt <= now;
        const isRisk = !timer.atRiskNotified && timer.atRiskAt && timer.atRiskAt <= now;
        if (!isDue && !isRisk) return null;
        const patch = isDue
          ? { state: 'breached', breachedAt: timer.dueAt, atRiskNotified: true, updatedAt: now }
          : { atRiskNotified: true, updatedAt: now };
        await tx.update(slaTimers).set(patch).where(eq(slaTimers.id, timer.id));
        const all = await tx.select().from(slaTimers).where(eq(slaTimers.ticketId, r.ticketId));
        const [t] = await tx.select().from(tickets).where(eq(tickets.id, r.ticketId));
        const category = (await this.workflow.status(t!.status)).category;
        const summary = summarize(all, category, now);
        await this.tickets.setSlaSummary(tx, r.ticketId, {
          slaPolicyId: t!.slaPolicyId,
          slaState: summary.state,
          slaDueAt: summary.dueAt,
        });
        const type = isDue ? ('sla.breached' as const) : ('sla.at_risk' as const);
        const data = {
          timerId: timer.id,
          kind: timer.kind,
          dueAt: timer.dueAt?.toISOString() ?? null,
          assigneeId: t!.assigneeId,
          teamId: t!.teamId,
        };
        await this.audit.record(tx, SYSTEM_CTX, {
          action: type,
          targetType: 'ticket',
          targetId: r.ticketId,
          data,
        });
        await this.outbox.publish(tx, SYSTEM_CTX, {
          type,
          aggregateType: 'ticket',
          aggregateId: r.ticketId,
          payload: data,
        });
        return type;
      });
      if (did === 'sla.breached') breached++;
      else if (did === 'sla.at_risk') atRisk++;
    }
    return { atRisk, breached };
  }

  /** Re-checks recent open tickets after the SLA settings changed. */
  async reconcileOpen(limit = 500) {
    const closed = (await this.workflow.load()).statuses
      .filter((s) => s.category === 'closed' || s.category === 'resolved')
      .map((s) => s.key);
    const rows = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .where(closed.length ? notInArray(tickets.status, closed) : undefined)
      .limit(limit);
    for (const r of rows) await this.reconcile(r.id);
  }

  async forTicket(ticketId: string): Promise<TicketSlaView> {
    const t = await this.tickets.get(ticketId);
    const rows = await this.db
      .select()
      .from(slaTimers)
      .where(eq(slaTimers.ticketId, t.id))
      .orderBy(asc(slaTimers.kind));
    const [policy] = t.slaPolicyId
      ? await this.db.select().from(slaPolicies).where(eq(slaPolicies.id, t.slaPolicyId))
      : [];
    const now = Date.now();
    return {
      policy: policy ? { id: policy.id, name: policy.name } : null,
      state: (t.slaState as SlaState | null) ?? null,
      dueAt: t.slaDueAt?.toISOString() ?? null,
      timers: rows.map((x) => ({
        kind: x.kind as SlaKind,
        state: x.state as SlaTimerState,
        targetMinutes: x.targetMinutes,
        dueAt: x.dueAt?.toISOString() ?? null,
        atRisk:
          x.state === 'running' &&
          (x.atRiskNotified || (!!x.atRiskAt && x.atRiskAt.getTime() <= now)),
        startedAt: x.startedAt.toISOString(),
        metAt: x.metAt?.toISOString() ?? null,
        breachedAt: x.breachedAt?.toISOString() ?? null,
      })),
    };
  }

  /** Tickets with timers, for tests and the sample loader. */
  async timersFor(ticketIds: string[]): Promise<Timer[]> {
    if (!ticketIds.length) return [];
    return this.db.select().from(slaTimers).where(inArray(slaTimers.ticketId, ticketIds));
  }

  private async hoursRow(id: string) {
    const [h] = await this.db.select().from(businessHours).where(eq(businessHours.id, id));
    if (!h) throw new NotFoundException('Business hours not found');
    return h;
  }

  private async hoursFor(policy: Policy): Promise<Hours> {
    if (!policy.businessHoursId) return ALWAYS_OPEN;
    const h = await this.hoursRow(policy.businessHoursId).catch(() => null);
    if (!h) return ALWAYS_OPEN;
    const days = await this.db
      .select({ date: holidays.date })
      .from(holidays)
      .where(eq(holidays.businessHoursId, h.id));
    return {
      timezone: h.timezone,
      schedule: h.schedule,
      holidays: new Set(days.map((d) => d.date)),
    };
  }

  private async configChanged(
    tx: DbOrTx,
    ctx: RequestCtx,
    action: string,
    id: string,
    data: Record<string, unknown>,
  ) {
    await this.audit.record(tx, ctx, { action, targetType: 'sla', targetId: id, data });
    await this.outbox.publish(tx, ctx, {
      type: 'sla.config_changed',
      aggregateType: 'sla',
      aggregateId: id,
      payload: { action, ...data },
    });
  }
}

/** Due and at-risk instants for the business minutes left after `consumed`. */
function schedule(target: number, consumed: number, from: Date, hours: Hours) {
  const riskAfter = Math.ceil(target * SLA_AT_RISK_SHARE) - consumed;
  return {
    dueAt: addBusinessMinutes(from, Math.max(0, target - consumed), hours),
    atRiskAt: addBusinessMinutes(from, Math.max(0, riskAfter), hours),
  };
}

/**
 * The next row values for a timer moving toward `desired`, or null when
 * nothing changes. A breached timer stays breached; meeting it later only
 * records when.
 */
export function step(
  timer: Timer,
  desired: 'running' | 'paused' | 'met',
  o: { now: Date; hours: Hours; target: number; policyId: string | null; metAt: Date | null },
): Partial<Timer> | null {
  const used = () =>
    timer.consumedMinutes +
    (timer.resumedAt ? businessMinutesBetween(timer.resumedAt, o.now, o.hours) : 0);

  if (timer.state === 'breached') {
    return desired === 'met' && !timer.metAt ? { metAt: o.metAt ?? o.now } : null;
  }
  if (timer.state === 'met') {
    if (desired === 'met') return null;
    // Reopened: the clock carries on from where it stopped.
    return {
      state: desired,
      metAt: null,
      resumedAt: desired === 'running' ? o.now : null,
      targetMinutes: o.target,
      policyId: o.policyId,
      ...(desired === 'running'
        ? schedule(o.target, timer.consumedMinutes, o.now, o.hours)
        : { dueAt: null, atRiskAt: null }),
    };
  }
  if (desired === 'met') {
    const at = o.metAt ?? o.now;
    const consumed =
      timer.consumedMinutes +
      (timer.resumedAt ? businessMinutesBetween(timer.resumedAt, at, o.hours) : 0);
    return { state: 'met', metAt: at, consumedMinutes: consumed, resumedAt: null };
  }
  if (timer.state === 'running' && desired === 'paused') {
    return {
      state: 'paused',
      consumedMinutes: used(),
      resumedAt: null,
      dueAt: null,
      atRiskAt: null,
    };
  }
  if (timer.state === 'paused' && desired === 'running') {
    return {
      state: 'running',
      resumedAt: o.now,
      targetMinutes: o.target,
      policyId: o.policyId,
      ...schedule(o.target, timer.consumedMinutes, o.now, o.hours),
    };
  }
  // Same state: only a changed policy or target moves the deadline.
  if (timer.targetMinutes !== o.target || timer.policyId !== o.policyId) {
    if (timer.state === 'paused') return { targetMinutes: o.target, policyId: o.policyId };
    const consumed = used();
    return {
      targetMinutes: o.target,
      policyId: o.policyId,
      consumedMinutes: consumed,
      resumedAt: o.now,
      atRiskNotified: false,
      ...schedule(o.target, consumed, o.now, o.hours),
    };
  }
  return null;
}

/** The ticket-level SLA state: the most urgent thing a person can still act on. */
export function summarize(
  timers: Timer[],
  category: string,
  now: Date,
): { state: SlaState | null; dueAt: Date | null } {
  if (!timers.length) return { state: null, dueAt: null };
  if (category === 'resolved' || category === 'closed') {
    return { state: timers.some((x) => x.state === 'breached') ? 'breached' : 'met', dueAt: null };
  }
  const blown = timers.filter((x) => x.state === 'breached' && !x.metAt);
  if (blown.length) {
    const due = blown.map((x) => x.dueAt!).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    return { state: 'breached', dueAt: due };
  }
  const running = timers
    .filter((x) => x.state === 'running' && x.dueAt)
    .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime());
  if (running.length) {
    const first = running[0]!;
    const risky = running.some(
      (x) => x.atRiskNotified || (x.atRiskAt && x.atRiskAt.getTime() <= now.getTime()),
    );
    return { state: risky ? 'at_risk' : 'ok', dueAt: first.dueAt };
  }
  if (timers.some((x) => x.state === 'paused')) return { state: 'paused', dueAt: null };
  return { state: 'met', dueAt: null };
}
