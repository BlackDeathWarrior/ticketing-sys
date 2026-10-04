import { Injectable, Logger } from '@nestjs/common';
import {
  type DomainEvent,
  type DomainEventType,
  EMAILED_NOTIFICATIONS,
  type NotificationKind,
} from '@tms/shared';
import { SystemMailer } from '../settings/system-mailer.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import type { DomainEventHandler } from '../worker/domain-events';
import { NotificationsService } from './notifications.service';

const KIND_LABEL: Record<string, string> = {
  first_response: 'first response',
  resolution: 'resolution',
};

/**
 * Turns domain events into notifications for the people who need to act
 * (ADR 0014). Handover notices are sent by the handover handler once routing
 * knows where the ticket went.
 */
@Injectable()
export class NotificationsHandler implements DomainEventHandler {
  readonly name = 'notifications';

  constructor(
    private readonly notifications: NotificationsService,
    private readonly tickets: TicketsService,
    private readonly users: UsersService,
  ) {}

  handles(type: DomainEventType): boolean {
    return (
      type === 'ticket.assigned' ||
      type === 'sla.at_risk' ||
      type === 'sla.breached' ||
      type === 'approval.requested' ||
      type === 'ticket.escalated'
    );
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as Record<string, unknown>;
    const ticketId =
      event.aggregateType === 'ticket' ? event.aggregateId : (p.ticketId as string | undefined);
    const ticket = ticketId ? await this.tickets.get(ticketId).catch(() => null) : null;
    if (!ticket) return;
    const ref = ticket.reference;

    switch (event.type) {
      case 'ticket.assigned': {
        const to = p.assigneeId as string | null | undefined;
        // Assigning yourself needs no notice.
        if (!to || to === event.actor.id) return;
        await this.notifications.notify([to], {
          kind: 'ticket.assigned',
          title: `${ref} was assigned to you`,
          body: ticket.subject,
          ticketId: ticket.id,
          dedupeKey: `assigned:${event.id}`,
        });
        return;
      }
      case 'sla.at_risk':
      case 'sla.breached': {
        const leads = await this.users.withPermission('ticket:assign', ticket.team?.id ?? null);
        const to = [...leads.map((u) => u.id), ...(ticket.assignee ? [ticket.assignee.id] : [])];
        const breached = event.type === 'sla.breached';
        const kind = KIND_LABEL[String(p.kind)] ?? 'SLA';
        await this.notifications.notify(to, {
          kind: event.type as NotificationKind,
          title: breached
            ? `${ref} missed its ${kind} target`
            : `${ref} is close to its ${kind} target`,
          body: ticket.subject,
          ticketId: ticket.id,
          dedupeKey: `${event.type}:${String(p.timerId)}`,
        });
        return;
      }
      case 'approval.requested': {
        // The deciding team's members; with no team, the people who may approve any request.
        const teamId = (p.teamId as string | null | undefined) ?? null;
        const approvers = teamId
          ? await this.users.withPermission('ticket:read', teamId)
          : await this.users.withPermission('approval:approve');
        await this.notifications.notify(
          approvers.map((u) => u.id),
          {
            kind: 'approval.requested',
            title: `${ref}: approval needed`,
            body: String(p.summary ?? ticket.subject),
            ticketId: ticket.id,
            dedupeKey: `approval:${String(p.approvalId)}`,
          },
        );
        return;
      }
      case 'ticket.escalated': {
        const leads = await this.users.withPermission('ticket:assign', ticket.team?.id ?? null);
        await this.notifications.notify(
          leads.map((u) => u.id).filter((id) => id !== event.actor.id),
          {
            kind: 'ticket.escalated',
            title: `${ref} was escalated`,
            body: String(p.reason ?? ticket.subject),
            ticketId: ticket.id,
            dedupeKey: `escalated:${event.id}`,
          },
        );
        return;
      }
    }
  }
}

/** Emails the notifications that shouldn't wait for someone to open Orbit Desk. */
@Injectable()
export class NotificationMailer implements DomainEventHandler {
  readonly name = 'notification-mailer';
  private readonly logger = new Logger(NotificationMailer.name);

  constructor(
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
    private readonly mailer: SystemMailer,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'notification.created';
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as { notificationId: string; userId: string; kind: NotificationKind };
    if (!EMAILED_NOTIFICATIONS.includes(p.kind)) return;
    const n = await this.notifications.get(p.notificationId);
    const user = await this.users.get(p.userId).catch(() => null);
    if (!user) return;
    const sent = await this.mailer.send({
      to: user.email,
      subject: n.title,
      text: `${n.body}\n\nOpen Orbit Desk to act on it.`,
      // Retries of this event reuse the id, so mail servers can drop duplicates.
      id: `notify-${n.id}`,
      fromSuffix: 'Orbit Desk',
    });
    if (sent) this.logger.log(`emailed ${p.kind} to ${user.email}`);
  }
}
