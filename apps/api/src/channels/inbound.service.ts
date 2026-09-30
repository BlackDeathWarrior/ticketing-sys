import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database, DbOrTx } from '@tms/db';
import {
  type MessageEnvelope,
  messageEnvelopeSchema,
  normalizeIdentity,
  type ParsedEnvelope,
} from '@tms/shared';
import { sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { type Conversation, ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { type Ticket, TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';
import { extractTicketNumber } from './email/email.util';

export interface InboundResult {
  duplicate: boolean;
  messageId: string;
  conversationId: string;
  ticketId: string;
  customerId?: string;
  createdTicket: boolean;
}

/**
 * The orchestrator's inbound pipeline, shared by every channel:
 * dedupe → resolve customer → match conversation → open or reopen ticket →
 * store message, all in one transaction.
 */
@Injectable()
export class InboundService {
  private readonly logger = new Logger(InboundService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly tickets: TicketsService,
    private readonly workflow: WorkflowService,
  ) {}

  async handle(input: MessageEnvelope): Promise<InboundResult> {
    const env = messageEnvelopeSchema.parse(input);
    const sender = normalizeIdentity(env.from.identity.type, env.from.identity.value);

    return this.db.transaction(async (tx) => {
      // Serialize messages from the same sender on the same channel, so two
      // quick messages can't both open a new ticket.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${env.channel}:${env.from.identity.type}:${sender}`}))`,
      );

      const dup = await this.conversations.findMessageByChannelId(
        tx,
        env.channel,
        env.channelMessageId,
      );
      if (dup) {
        return {
          duplicate: true,
          messageId: dup.message.id,
          conversationId: dup.message.conversationId,
          ticketId: dup.ticketId,
          createdTicket: false,
        };
      }

      const { customer } = await this.customers.resolveOrCreate(
        SYSTEM_CTX,
        {
          type: env.from.identity.type,
          value: env.from.identity.value,
          displayName: env.from.displayName,
        },
        tx,
      );
      const ctx: RequestCtx = { actor: { type: 'customer', id: customer.id } };
      for (const extra of env.from.extraIdentities) {
        await this.customers.attachIdentity(tx, ctx, customer.id, extra);
      }

      let { conversation, ticket } = await this.match(tx, env, customer.id);
      if (ticket && (await this.workflow.status(ticket.status)).category === 'closed') {
        // Closed tickets stay closed; the customer gets a fresh one.
        conversation = null;
        ticket = null;
      }

      let createdTicket = false;
      if (!ticket) {
        ticket = await this.tickets.createInTx(tx, ctx, {
          customerId: customer.id,
          channel: env.channel,
          subject: subjectFor(env),
          description: env.text,
          priority: 'normal',
          tags: [],
        });
        createdTicket = true;
      } else {
        await this.tickets.reopenOnCustomerReply(tx, ctx, ticket);
      }

      if (!conversation || conversation.ticketId !== ticket.id) {
        conversation = await this.conversations.create(tx, ctx, {
          ticketId: ticket.id,
          customerId: customer.id,
          channel: env.channel,
          externalThreadId: env.threadKey,
          metadata: conversationMetadata(env),
        });
      }

      const message = await this.conversations.addMessage(tx, {
        conversationId: conversation.id,
        channel: env.channel,
        direction: 'inbound',
        authorType: 'customer',
        body: env.text,
        attachments: env.attachments,
        channelMessageId: env.channelMessageId,
        metadata: { ...env.metadata, ...(env.subject ? { subject: env.subject } : {}) },
      });

      const data = {
        conversationId: conversation.id,
        messageId: message.id,
        channel: env.channel,
        createdTicket,
      };
      await this.audit.record(tx, ctx, {
        action: 'message.received',
        targetType: 'ticket',
        targetId: ticket.id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'message.received',
        aggregateType: 'ticket',
        aggregateId: ticket.id,
        payload: data,
      });

      return {
        duplicate: false,
        messageId: message.id,
        conversationId: conversation.id,
        ticketId: ticket.id,
        customerId: customer.id,
        createdTicket,
      };
    });
  }

  /**
   * Finds where a message belongs. Email threads by Message-ID references,
   * then by a [TMS-123] subject tag (only if the sender owns that ticket);
   * other channels by their thread key.
   */
  private async match(
    tx: DbOrTx,
    env: ParsedEnvelope,
    customerId: string,
  ): Promise<{ conversation: Conversation | null; ticket: Ticket | null }> {
    let conversation: Conversation | null = null;
    let ticketId: string | undefined;

    if (env.channel === 'email') {
      conversation = await this.conversations.findByMessageIds(tx, 'email', env.references);
      if (!conversation) {
        const num = extractTicketNumber(env.subject);
        if (num) {
          const tagged = await this.tickets.get(String(num)).catch(() => null);
          if (tagged && tagged.customerId === customerId) {
            ticketId = tagged.id;
            conversation = await this.conversations.findLatestForTicket(tx, tagged.id, 'email');
          } else if (tagged) {
            this.logger.warn(`ignoring ticket tag TMS-${num}: sender is not the ticket's customer`);
          }
        }
      }
    } else {
      conversation = await this.conversations.findByThread(tx, env.channel, env.threadKey);
    }

    ticketId = conversation?.ticketId ?? ticketId;
    const ticket = ticketId ? await this.tickets.lockRow(tx, ticketId) : null;
    return { conversation, ticket };
  }
}

function subjectFor(env: ParsedEnvelope): string {
  if (env.subject) return env.subject.slice(0, 300);
  const firstLine =
    env.text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  const label = env.channel === 'webchat' ? 'Chat' : env.channel;
  return firstLine ? `${label}: ${firstLine.slice(0, 120)}` : `${label} conversation`;
}

function conversationMetadata(env: ParsedEnvelope): Record<string, unknown> {
  if (env.channel === 'email') {
    return { address: env.from.identity.value.toLowerCase(), subject: env.subject };
  }
  if (env.channel === 'webchat') {
    return { sessionId: env.threadKey, visitorName: env.from.displayName };
  }
  return {};
}
