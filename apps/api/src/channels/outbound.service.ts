import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Database, DbOrTx } from '@tms/db';
import type { Channel } from '@tms/shared';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import type { RequestCtx } from '../common/request-context';
import type { Env } from '../config/env';
import { type Conversation, ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DB, ENV } from '../infra/tokens';
import { TicketsService } from '../tickets/tickets.service';
import { replySubject } from './email/email.util';

/**
 * Agent replies. The message is stored as `pending` together with a
 * `message.outbound` event; the worker's delivery handler sends it on the
 * conversation's channel and records the result.
 */
@Injectable()
export class OutboundService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
  ) {}

  async reply(ctx: RequestCtx, conversationId: string, body: string) {
    return this.db.transaction(async (tx) => {
      const conv = await this.conversations.lock(tx, conversationId);
      return this.replyInTx(tx, ctx, conv, body);
    });
  }

  /** Opens an email thread to the ticket's customer and sends the first message. */
  async startEmailConversation(ctx: RequestCtx, ticketId: string, body: string) {
    this.assertEmailEnabled();
    const ticket = await this.tickets.get(ticketId);
    const customer = await this.customers.get(ticket.customerId);
    const address =
      customer.primaryEmail ?? customer.identities.find((i) => i.type === 'email')?.value;
    if (!address) throw new BadRequestException('The customer has no email address');

    return this.db.transaction(async (tx) => {
      const conv = await this.conversations.create(tx, ctx, {
        ticketId: ticket.id,
        customerId: customer.id,
        channel: 'email',
        externalThreadId: null,
        controller: 'human',
        metadata: { address, subject: ticket.subject },
      });
      return this.replyInTx(tx, ctx, conv, body);
    });
  }

  private async replyInTx(tx: DbOrTx, ctx: RequestCtx, conv: Conversation, body: string) {
    if (conv.channel === 'email') this.assertEmailEnabled();
    const ticket = await this.tickets.lockRow(tx, conv.ticketId);
    const email =
      conv.channel === 'email' ? await this.emailHeaders(tx, conv, ticket.number) : null;

    const message = await this.conversations.addMessage(tx, {
      conversationId: conv.id,
      channel: conv.channel as Channel,
      direction: 'outbound',
      authorType: 'agent',
      authorUserId: ctx.user?.id ?? null,
      body,
      channelMessageId: email?.messageId ?? null,
      deliveryStatus: 'pending',
      metadata: email ?? {},
    });
    if (!conv.externalThreadId && email) {
      // A thread we started: its first Message-ID is the thread key.
      await this.conversations.setThreadKey(tx, conv.id, email.messageId);
    }

    await this.tickets.recordAgentReply(tx, ctx, ticket);
    if (conv.controller === 'none') {
      await this.conversations.setController(tx, ctx, conv, 'human', ctx.user?.id ?? null);
    }

    const data = { conversationId: conv.id, messageId: message.id, channel: conv.channel };
    await this.audit.record(tx, ctx, {
      action: 'message.sent',
      targetType: 'ticket',
      targetId: ticket.id,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: 'message.outbound',
      aggregateType: 'ticket',
      aggregateId: ticket.id,
      payload: data,
    });
    return message;
  }

  /** Threading headers so the customer's mail client shows one conversation. */
  private async emailHeaders(tx: DbOrTx, conv: Conversation, ticketNumber: number) {
    const domain = this.env.EMAIL_ADDRESS!.split('@')[1];
    const previous = await this.conversations.emailMessageIds(tx, conv.id);
    const lastInbound = [...previous].reverse().find((m) => m.direction === 'inbound');
    const meta = conv.metadata as { address?: string; subject?: string };
    if (!meta.address) throw new BadRequestException('This conversation has no email address');
    return {
      messageId: `<${randomUUID()}@${domain}>`,
      to: meta.address,
      subject: replySubject(meta.subject ?? '', ticketNumber),
      inReplyTo: lastInbound?.id ?? previous.at(-1)?.id ?? null,
      references: previous.slice(-20).map((m) => m.id),
    };
  }

  private assertEmailEnabled() {
    if (!this.env.EMAIL_ENABLED || !this.env.EMAIL_ADDRESS) {
      throw new BadRequestException('The email channel is not configured');
    }
  }
}
