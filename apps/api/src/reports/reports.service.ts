import { Inject, Injectable } from '@nestjs/common';
import { auditLog, type Database, ticketStatuses, tickets, users } from '@tms/db';
import {
  type ActivityEvent,
  type Channel,
  formatTicketNumber,
  lastDays,
  median,
  OVERVIEW_VOLUME_DAYS,
  type OverviewReport,
  type Priority,
  type StatusCategory,
} from '@tms/shared';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull, like, sql } from 'drizzle-orm';
import { DB } from '../infra/tokens';

const OPEN_CATEGORIES = ['open', 'pending'];
const ACTIVITY_LIMIT = 15;

/**
 * Read-only aggregates for dashboards. Reporting reads across modules' tables
 * (tickets, workflow, users, audit) by design; it never writes, so there is no
 * audit or outbox entry.
 */
@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async overview(now = new Date()): Promise<OverviewReport> {
    const days = lastDays(now, OVERVIEW_VOLUME_DAYS);
    const since = new Date(`${days[0]}T00:00:00.000Z`);
    const today = new Date(`${days[days.length - 1]}T00:00:00.000Z`);
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

    const openStatuses = this.db
      .select({ key: ticketStatuses.key })
      .from(ticketStatuses)
      .where(inArray(ticketStatuses.category, OPEN_CATEGORIES));
    const isOpen = inArray(tickets.status, openStatuses);

    const [statusRows, channelRows, priorityRows, assigneeRows, unassigned, created, resolved] =
      await Promise.all([
        this.db
          .select({
            status: ticketStatuses.key,
            name: ticketStatuses.name,
            category: ticketStatuses.category,
            count: sql<number>`count(${tickets.id})::int`,
          })
          .from(ticketStatuses)
          .leftJoin(tickets, eq(tickets.status, ticketStatuses.key))
          .where(eq(ticketStatuses.isActive, true))
          .groupBy(ticketStatuses.key)
          .orderBy(ticketStatuses.sortOrder),
        this.db
          .select({ channel: tickets.channel, count: count() })
          .from(tickets)
          .where(isOpen)
          .groupBy(tickets.channel),
        this.db
          .select({ priority: tickets.priority, count: count() })
          .from(tickets)
          .where(isOpen)
          .groupBy(tickets.priority),
        this.db
          .select({ id: users.id, name: users.name, open: count() })
          .from(tickets)
          .innerJoin(users, eq(users.id, tickets.assigneeId))
          .where(isOpen)
          .groupBy(users.id)
          .orderBy(desc(count()), users.name),
        this.db.$count(tickets, and(isOpen, isNull(tickets.assigneeId))),
        this.db
          .select({ createdAt: tickets.createdAt, firstResponseAt: tickets.firstResponseAt })
          .from(tickets)
          .where(gte(tickets.createdAt, since < weekAgo ? since : weekAgo)),
        this.db
          .select({ createdAt: tickets.createdAt, resolvedAt: tickets.resolvedAt })
          .from(tickets)
          .where(and(isNotNull(tickets.resolvedAt), gte(tickets.resolvedAt, since))),
      ]);

    const volume = days.map((date) => ({ date, created: 0, resolved: 0 }));
    const index = new Map(days.map((d, i) => [d, i]));
    const bump = (at: Date, key: 'created' | 'resolved') => {
      const i = index.get(at.toISOString().slice(0, 10));
      if (i !== undefined) volume[i]![key] += 1;
    };
    for (const t of created) bump(t.createdAt, 'created');
    for (const t of resolved) bump(t.resolvedAt!, 'resolved');

    const minutes = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 60_000);
    const resolvedWeek = resolved.filter((t) => t.resolvedAt! >= weekAgo);
    const respondedWeek = created.filter((t) => t.createdAt >= weekAgo && t.firstResponseAt);

    return {
      generatedAt: now.toISOString(),
      open: statusRows
        .filter((s) => OPEN_CATEGORIES.includes(s.category))
        .reduce((sum, s) => sum + s.count, 0),
      unassigned,
      resolvedToday: resolved.filter((t) => t.resolvedAt! >= today).length,
      resolvedLast7Days: resolvedWeek.length,
      medianResolutionMinutes: median(resolvedWeek.map((t) => minutes(t.createdAt, t.resolvedAt!))),
      medianFirstResponseMinutes: median(
        respondedWeek.map((t) => minutes(t.createdAt, t.firstResponseAt!)),
      ),
      byStatus: statusRows.map((s) => ({ ...s, category: s.category as StatusCategory })),
      byChannel: channelRows
        .map((r) => ({ channel: r.channel as Channel, count: r.count }))
        .sort((a, b) => b.count - a.count),
      byPriority: priorityRows.map((r) => ({ priority: r.priority as Priority, count: r.count })),
      volume,
      byAssignee: assigneeRows,
      activity: await this.activity(),
    };
  }

  /** Recent ticket events with actor names and ticket references. */
  private async activity(): Promise<ActivityEvent[]> {
    const rows = await this.db
      .select({
        id: auditLog.id,
        occurredAt: auditLog.occurredAt,
        action: auditLog.action,
        actorType: auditLog.actorType,
        actorId: auditLog.actorId,
        actorName: users.name,
        data: auditLog.data,
        ticketId: tickets.id,
        number: tickets.number,
        subject: tickets.subject,
      })
      .from(auditLog)
      .leftJoin(users, sql`${users.id}::text = ${auditLog.actorId}`)
      .leftJoin(tickets, sql`${tickets.id}::text = ${auditLog.targetId}`)
      .where(and(eq(auditLog.targetType, 'ticket'), like(auditLog.action, 'ticket.%')))
      .orderBy(desc(auditLog.id))
      .limit(ACTIVITY_LIMIT);
    return rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      action: r.action,
      actor: { type: r.actorType, id: r.actorId, name: r.actorName },
      ticket:
        r.ticketId && r.number !== null
          ? { id: r.ticketId, reference: formatTicketNumber(r.number), subject: r.subject! }
          : null,
      data: r.data,
    }));
  }
}
