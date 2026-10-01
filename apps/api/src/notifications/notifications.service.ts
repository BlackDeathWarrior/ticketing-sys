import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Database, notifications, tickets } from '@tms/db';
import { formatTicketNumber, type NotificationKind, type NotificationView } from '@tms/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { SYSTEM_CTX } from '../common/request-context';
import { DB } from '../infra/tokens';

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body?: string;
  ticketId?: string | null;
  /** One notification per user per key (e.g. `breach:<timerId>`), so retried events don't repeat. */
  dedupeKey?: string;
}

/** In-app notifications for agents (ADR 0014), pushed live to the `user:<id>` room. */
@Injectable()
export class NotificationsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
  ) {}

  /** Creates one notification per user; returns how many were new. */
  async notify(userIds: string[], n: NewNotification): Promise<number> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return 0;
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(notifications)
        .values(
          unique.map((userId) => ({
            userId,
            kind: n.kind,
            title: n.title.slice(0, 200),
            body: (n.body ?? '').slice(0, 1000),
            ticketId: n.ticketId ?? null,
            dedupeKey: n.dedupeKey ?? null,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: notifications.id, userId: notifications.userId });
      for (const r of rows) {
        const data = {
          notificationId: r.id,
          userId: r.userId,
          kind: n.kind,
          ticketId: n.ticketId ?? null,
        };
        await this.audit.record(tx, SYSTEM_CTX, {
          action: 'notification.created',
          targetType: 'user',
          targetId: r.userId,
          data,
        });
        await this.outbox.publish(tx, SYSTEM_CTX, {
          type: 'notification.created',
          aggregateType: 'notification',
          aggregateId: r.id,
          payload: data,
        });
      }
      return rows.length;
    });
  }

  async list(userId: string, q: { unread: boolean; limit: number }) {
    const rows = await this.db
      .select({ n: notifications, number: tickets.number })
      .from(notifications)
      .leftJoin(tickets, eq(tickets.id, notifications.ticketId))
      .where(
        and(eq(notifications.userId, userId), q.unread ? isNull(notifications.readAt) : undefined),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(q.limit);
    const [unread] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
    return {
      unread: unread?.n ?? 0,
      items: rows.map(({ n, number }): NotificationView => ({
        id: n.id,
        kind: n.kind as NotificationKind,
        title: n.title,
        body: n.body,
        ticket:
          n.ticketId && number ? { id: n.ticketId, reference: formatTicketNumber(number) } : null,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  async get(id: string) {
    const [n] = await this.db.select().from(notifications).where(eq(notifications.id, id));
    if (!n) throw new NotFoundException('Notification not found');
    return n;
  }

  /** Reading your own notifications is not audited: it changes nothing anyone else sees. */
  async markRead(userId: string, id?: string) {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          id ? eq(notifications.id, id) : undefined,
        ),
      );
  }

  /** Deletes notifications created before `before`, read or not. */
  async purge(before: Date): Promise<number> {
    const rows = await this.db
      .delete(notifications)
      .where(lt(notifications.createdAt, before))
      .returning({ id: notifications.id });
    return rows.length;
  }
}
