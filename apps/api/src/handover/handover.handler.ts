import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { handoverMessage } from '../ai/policy';
import { OutboundService } from '../channels/outbound.service';
import { AI_CTX } from '../common/request-context';
import { ConversationsService } from '../conversations/conversations.service';
import { NotificationsService } from '../notifications/notifications.service';
import { RoutingService } from '../routing/routing.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import type { DomainEventHandler } from '../worker/domain-events';
import { HandoverService } from './handover.service';

/**
 * After a handover: route the ticket, tell the customer who answers now, tell
 * the people it went to, then write the context pack (which may wait on a
 * model). Idempotent enough for retries: routing keeps an existing assignee,
 * the customer is told once per handover and notices are deduped.
 */
@Injectable()
export class HandoverHandler implements DomainEventHandler {
  readonly name = 'handover';
  private readonly logger = new Logger(HandoverHandler.name);

  constructor(
    private readonly handover: HandoverService,
    private readonly routing: RoutingService,
    private readonly notifications: NotificationsService,
    private readonly tickets: TicketsService,
    private readonly users: UsersService,
    private readonly conversations: ConversationsService,
    private readonly outbound: OutboundService,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'handover.requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as {
      handoverId: string;
      conversationId?: string | null;
      reason: string;
      teamId: string | null;
      tellCustomer?: boolean;
    };
    const decision = await this.routing.route(event.aggregateId, {
      teamId: p.teamId,
      reason: `handover: ${p.reason}`,
    });
    await this.handover.setRouted(p.handoverId, decision.teamId, decision.assigneeId);

    const ticket = await this.tickets.get(event.aggregateId);
    if (p.tellCustomer && p.conversationId) {
      await this.tellCustomer(
        p.handoverId,
        p.conversationId,
        decision.assigneeId ? (ticket.assignee?.name ?? null) : null,
      ).catch((err: Error) =>
        this.logger.warn(`handover ${ticket.reference}: customer not told: ${err.message}`),
      );
    }
    const to = decision.assigneeId
      ? [decision.assigneeId]
      : (
          await this.users.withPermission(
            decision.teamId ? 'ticket:read' : 'ticket:assign',
            decision.teamId,
          )
        ).map((u) => u.id);
    await this.notifications.notify(
      to.filter((id) => id !== event.actor.id),
      {
        kind: 'handover.requested',
        title: decision.assigneeId
          ? `${ticket.reference} was handed to you`
          : `${ticket.reference} needs a person`,
        body: p.reason,
        ticketId: ticket.id,
        dedupeKey: `handover:${p.handoverId}`,
      },
    );

    const pack = await this.handover.buildPack(p.handoverId);
    this.logger.log(`handover ${ticket.reference}: ${decision.reason}; pack by ${pack.writtenBy}`);
  }

  /**
   * The AI's "a person answers from here" message, sent after routing so it
   * can name the colleague (first name only, as on their replies). A notice,
   * not an answer: the first-response clock keeps running. Sent once per
   * handover, and not when a person has already replied.
   */
  private async tellCustomer(handoverId: string, conversationId: string, assignee: string | null) {
    const conv = await this.conversations.get(conversationId);
    const rows = await this.conversations.transcript(conversationId, 30);
    const told = rows.some(
      (m) => (m.metadata as { handoverId?: string } | null)?.handoverId === handoverId,
    );
    if (told || rows.at(-1)?.authorType === 'agent') return;
    await this.outbound.aiReply(
      AI_CTX,
      conversationId,
      handoverMessage(conv.language ?? null, conv.channel, assignee?.trim().split(/\s+/)[0]),
      { draft: false, notice: true, metadata: { handoverId } },
    );
  }
}

/** New tickets customers open through a channel go to a person when the AI isn't answering them. */
@Injectable()
export class RoutingHandler implements DomainEventHandler {
  readonly name = 'routing';

  constructor(
    private readonly routing: RoutingService,
    private readonly tickets: TicketsService,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'ticket.created';
  }

  async handle(event: DomainEvent): Promise<void> {
    // Agents who log a ticket decide where it goes themselves.
    if (event.actor.type !== 'customer') return;
    const t = await this.tickets.get(event.aggregateId);
    if (t.assignee || t.handling !== 'none') return;
    await this.routing.route(t.id, { reason: 'new ticket' });
  }
}
