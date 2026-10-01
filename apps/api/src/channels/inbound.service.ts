import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Database, DbOrTx } from '@tms/db';
import {
  type Channel,
  formatTicketNumber,
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
import { AiPolicyService } from './ai-policy.service';
import { extractTicketNumber } from './email/email.util';

export interface InboundResult {
  duplicate: boolean;
  messageId: string;
  conversationId: string;
  ticketId: string;
  customerId?: string;
  createdTicket: boolean;
  /** The ticket's reference, e.g. TMS-1042. Not set for a duplicate. */
  ticketReference?: string;
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
    private readonly aiPolicy: AiPolicyService,
  ) {}

  async handle(input: MessageEnvelope): Promise<InboundResult> {
    return this.db.transaction((tx) => this.handleInTx(tx, input));
  }

  /** The same pipeline inside the caller's transaction, for adapters that write more with it. */
  async handleInTx(tx: DbOrTx, input: MessageEnvelope): Promise<InboundResult> {
    const env = messageEnvelopeSchema.parse(input);
    const sender = normalizeIdentity(env.from.identity.type, env.from.identity.value);

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
        categoryId: env.ticket?.categoryId,
        priority: env.ticket?.priority ?? 'normal',
        tags: env.ticket?.tags ?? [],
        externalRef: env.ticket?.externalRef,
        metadata: env.ticket?.metadata,
        integrationId: env.ticket?.integrationId,
      });
      createdTicket = true;
    } else {
      await this.tickets.reopenOnCustomerReply(tx, ctx, ticket, {
        aiControlled: conversation?.controller === 'ai' && conversation.ticketId === ticket.id,
      });
    }

    if (!conversation || conversation.ticketId !== ticket.id) {
      // New conversations go to the AI when it is on for this channel and a model can serve it,
      // unless the sender asked for people only.
      const aiTakesIt =
        env.ai !== 'off' && (await this.aiPolicy.takesNewConversations(env.channel));
      conversation = await this.conversations.create(tx, ctx, {
        ticketId: ticket.id,
        customerId: customer.id,
        channel: env.channel,
        externalThreadId: env.threadKey,
        controller: aiTakesIt ? 'ai' : 'none',
        metadata: conversationMetadata(env),
      });
      if (aiTakesIt) {
        await this.tickets.moveIfAllowed(tx, ctx, ticket.id, 'ai_handling');
        await this.tickets.setHandling(tx, ticket.id, 'ai');
      }
    }

    const message = await this.conversations.addMessage(tx, {
      conversationId: conversation.id,
      channel: env.channel,
      direction: 'inbound',
      authorType: 'customer',
      body: env.text,
      attachments: env.attachments,
      channelMessageId: env.channelMessageId,
      metadata: { ...messageMetadata(env), ...(env.subject ? { subject: env.subject } : {}) },
    });

    if (env.channel === 'whatsapp') {
      // Keeps the send address and the 24-hour window current.
      await this.conversations.mergeMetadata(tx, conversation.id, conversationMetadata(env));
    }

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
      ticketReference: formatTicketNumber(ticket.number),
    };
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

    if (env.ticket?.id) {
      // The portal or an integration names the ticket. The sender must still be its customer.
      const pinned = await this.tickets.lockRow(tx, env.ticket.id);
      if (pinned.customerId === customerId) {
        return {
          conversation: await this.conversations.findLatestForTicket(
            tx,
            pinned.id,
            env.channel === 'api' ? API_THREADS : EMAIL_THREADS,
          ),
          ticket: pinned,
        };
      }
      this.logger.warn(`ignoring ticket ${pinned.id}: the sender is not its customer`);
    }

    if (env.channel === 'email') {
      // Replies to a web-form ticket's emails thread onto the form's conversation.
      conversation = await this.conversations.findByMessageIds(tx, EMAIL_THREADS, env.references);
      if (!conversation) {
        const num = extractTicketNumber(env.subject);
        if (num) {
          const tagged = await this.tickets.get(String(num)).catch(() => null);
          if (tagged && tagged.customerId === customerId) {
            ticketId = tagged.id;
            conversation = await this.conversations.findLatestForTicket(
              tx,
              tagged.id,
              EMAIL_THREADS,
            );
          } else if (tagged) {
            this.logger.warn(`ignoring ticket tag TMS-${num}: sender is not the ticket's customer`);
          }
        }
      }
    } else if (env.channel === 'whatsapp') {
      // One thread per person, whether Meta names them by phone or by user id this time.
      conversation = await this.conversations.findLatestForCustomer(tx, 'whatsapp', customerId);
    } else {
      conversation = await this.conversations.findByThread(tx, env.channel, env.threadKey);
    }

    ticketId = conversation?.ticketId ?? ticketId;
    const ticket = ticketId ? await this.tickets.lockRow(tx, ticketId) : null;
    return { conversation, ticket };
  }
}

/** Conversations whose replies travel by email. */
const EMAIL_THREADS: Channel[] = ['email', 'web_form'];
/** Conversations an integration reads through the API. */
const API_THREADS: Channel[] = ['api'];

function subjectFor(env: ParsedEnvelope): string {
  if (env.subject) return env.subject.slice(0, 300);
  const firstLine =
    env.text
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '';
  const label =
    env.channel === 'webchat'
      ? 'Chat'
      : env.channel === 'whatsapp'
        ? 'WhatsApp'
        : env.channel === 'api'
          ? 'Request'
          : env.channel;
  return firstLine ? `${label}: ${firstLine.slice(0, 120)}` : `${label} conversation`;
}

/** Envelope metadata kept on the message; `conversation` details go on the conversation. */
function messageMetadata(env: ParsedEnvelope): Record<string, unknown> {
  const { conversation: _conversation, ...rest } = env.metadata;
  return rest;
}

function conversationMetadata(env: ParsedEnvelope): Record<string, unknown> {
  if (env.channel === 'email') {
    return { address: env.from.identity.value.toLowerCase(), subject: env.subject };
  }
  if (env.channel === 'web_form') {
    return {
      address: env.from.identity.value.toLowerCase(),
      subject: env.subject,
      name: env.from.displayName,
    };
  }
  if (env.channel === 'webchat') {
    return { sessionId: env.threadKey, visitorName: env.from.displayName };
  }
  if (env.channel === 'whatsapp') {
    // Set by the WhatsApp adapter; see WaConversationMeta.
    return (env.metadata.conversation ?? {}) as Record<string, unknown>;
  }
  if (env.channel === 'api') {
    return { integrationId: env.ticket?.integrationId, customerName: env.from.displayName };
  }
  return {};
}
