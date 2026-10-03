import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { SYSTEM_CTX } from '../common/request-context';
import { ConversationsService } from '../conversations/conversations.service';
import { TicketsService } from '../tickets/tickets.service';
import type { DomainEventHandler, HandlerContext } from '../worker/domain-events';
import {
  CHANNEL_SENDERS,
  type ChannelSender,
  type DeliveryReceipt,
  PermanentDeliveryError,
} from './senders';

/**
 * Delivers `message.outbound` events. Idempotent: a message that is no longer
 * `pending` is skipped. Failures are retried by the queue; after the last
 * attempt, or at once for a failure retrying can't fix, the message is marked
 * `failed` with the error.
 */
@Injectable()
export class DeliveryHandler implements DomainEventHandler {
  readonly name = 'delivery';
  private readonly logger = new Logger(DeliveryHandler.name);
  private readonly senders: Map<string, ChannelSender>;

  constructor(
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
    @Inject(CHANNEL_SENDERS) senders: ChannelSender[],
  ) {
    this.senders = new Map(senders.flatMap((s) => s.channels.map((c) => [c, s] as const)));
  }

  handles(type: DomainEventType): boolean {
    return type === 'message.outbound';
  }

  async handle(event: DomainEvent, ctx: HandlerContext): Promise<void> {
    const { messageId } = event.payload as { messageId: string };
    const found = await this.conversations.getForDelivery(messageId);
    if (!found || found.message.deliveryStatus !== 'pending') return;

    const ticketId = found.conversation.ticketId;
    const sender = this.senders.get(found.conversation.channel);
    if (!sender) {
      await this.conversations.markDelivery(
        SYSTEM_CTX,
        messageId,
        ticketId,
        'failed',
        `No sender for channel ${found.conversation.channel}`,
      );
      return;
    }

    const ticket = await this.tickets.get(ticketId);
    let receipt: DeliveryReceipt | void;
    try {
      receipt = await sender.send({
        ...found,
        ticket: { id: ticket.id, number: ticket.number, subject: ticket.subject },
      });
    } catch (err) {
      const reason = (err as Error).message;
      this.logger.warn(
        `delivery of ${messageId} failed (attempt ${ctx.attempt}/${ctx.maxAttempts}): ${reason}`,
      );
      if (err instanceof PermanentDeliveryError || ctx.attempt >= ctx.maxAttempts) {
        await this.conversations.markDelivery(SYSTEM_CTX, messageId, ticketId, 'failed', reason);
        return;
      }
      throw err;
    }
    await this.conversations.markDelivery(
      SYSTEM_CTX,
      messageId,
      ticketId,
      'sent',
      undefined,
      receipt?.channelMessageId,
      receipt?.metadata,
    );
  }
}
