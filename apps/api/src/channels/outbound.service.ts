import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Database, DbOrTx } from '@tms/db';
import {
  type Channel,
  formatTicketNumber,
  type ParsedSendTemplate,
  WA_TEXT_MAX,
  type WaConversationMeta,
  waWindow,
} from '@tms/shared';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { type RequestCtx, SYSTEM_CTX } from '../common/request-context';
import { type Conversation, ConversationsService } from '../conversations/conversations.service';
import { CustomersService } from '../customers/customers.service';
import { DB } from '../infra/tokens';
import { ChannelConfigService } from '../settings/channel-config.service';
import { TicketsService } from '../tickets/tickets.service';
import { replySubject } from './email/email.util';
import { isValidE164 } from './whatsapp/phone-utils';
import { isBusinessScopedUserId } from './whatsapp/wa-identity';
import { lockTicketThenConversation } from './lock-order';
import { WhatsAppTemplatesService } from './whatsapp/whatsapp-templates.service';

/**
 * Agent and AI replies. A reply is stored as `pending` together with a
 * `message.outbound` event; the worker's delivery handler sends it on the
 * conversation's channel and records the result. AI drafts are stored as
 * `draft` and only go out once a human approves them.
 */
@Injectable()
export class OutboundService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly conversations: ConversationsService,
    private readonly tickets: TicketsService,
    private readonly customers: CustomersService,
    private readonly channels: ChannelConfigService,
    private readonly templates: WhatsAppTemplatesService,
  ) {}

  async reply(ctx: RequestCtx, conversationId: string, body: string) {
    return this.db.transaction(async (tx) => {
      const conv = await lockTicketThenConversation(
        tx,
        this.tickets,
        this.conversations,
        conversationId,
      );
      if (conv.channel === 'voice') {
        // A typed reply can't be heard: on a call, people talk.
        throw new BadRequestException(
          'This is a voice call. Join the call to talk to the caller, or add an internal note.',
        );
      }
      if (conv.channel === 'whatsapp') await this.checkWhatsAppText(conv, body);
      return this.replyInTx(tx, ctx, conv, body);
    });
  }

  /**
   * Sends an approved WhatsApp template on a conversation: the only way to
   * write to a customer more than 24 hours after their last message.
   */
  async replyWithTemplate(ctx: RequestCtx, conversationId: string, input: ParsedSendTemplate) {
    await this.requireWhatsApp();
    const { send, preview } = await this.templates.prepare(input);
    return this.db.transaction(async (tx) => {
      const conv = await lockTicketThenConversation(
        tx,
        this.tickets,
        this.conversations,
        conversationId,
      );
      if (conv.channel !== 'whatsapp') {
        throw new BadRequestException('Templates can only be sent on WhatsApp conversations');
      }
      return this.replyInTx(tx, ctx, conv, preview, { metadata: { waTemplate: send } });
    });
  }

  /** Opens a WhatsApp thread to the ticket's customer with an approved template. */
  async startWhatsAppConversation(ctx: RequestCtx, ticketId: string, input: ParsedSendTemplate) {
    await this.requireWhatsApp();
    const ticket = await this.tickets.get(ticketId);
    const customer = await this.customers.get(ticket.customerId);
    const identity = (type: string) => customer.identities.find((i) => i.type === type)?.value;
    const phone = identity('whatsapp') ?? identity('phone') ?? customer.primaryPhone ?? undefined;
    const waUserId = identity('whatsapp_bsuid');
    const meta: WaConversationMeta = {
      ...(phone && isValidE164(phone) ? { waPhone: phone } : {}),
      ...(isBusinessScopedUserId(waUserId) ? { waUserId } : {}),
      profileName: customer.displayName,
    };
    if (!meta.waPhone && !meta.waUserId) {
      throw new BadRequestException('The customer has no WhatsApp number');
    }
    const { send, preview } = await this.templates.prepare(input);

    return this.db.transaction(async (tx) => {
      const conv = await this.conversations.create(tx, ctx, {
        ticketId: ticket.id,
        customerId: customer.id,
        channel: 'whatsapp',
        externalThreadId: meta.waPhone ?? meta.waUserId!,
        controller: 'human',
        metadata: { ...meta },
      });
      return this.replyInTx(tx, ctx, conv, preview, { metadata: { waTemplate: send } });
    });
  }

  /**
   * What an agent said on a voice call, as transcribed. It was already heard,
   * so it is stored as sent and never queued for delivery.
   */
  async agentSpoke(ctx: RequestCtx, conversationId: string, body: string) {
    return this.db.transaction(async (tx) => {
      const conv = await lockTicketThenConversation(
        tx,
        this.tickets,
        this.conversations,
        conversationId,
      );
      if (conv.channel !== 'voice') throw new BadRequestException('Not a voice conversation');
      return this.replyInTx(tx, ctx, conv, body);
    });
  }

  /** Opens an email thread to the ticket's customer and sends the first message. */
  async startEmailConversation(ctx: RequestCtx, ticketId: string, body: string) {
    await this.emailAddress();
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

  /**
   * An AI reply on a conversation: `sent` is queued for delivery like an agent
   * reply; `draft` is stored for a human to approve (never delivered as is).
   */
  async aiReply(
    ctx: RequestCtx,
    conversationId: string,
    body: string,
    opts: {
      draft: boolean;
      metadata?: Record<string, unknown>;
      /** The AI says a person will answer (a handover): not an answer, so not a first response. */
      notice?: boolean;
    },
    tx?: DbOrTx,
  ) {
    const run = async (t: DbOrTx) => {
      const conv = await lockTicketThenConversation(
        t,
        this.tickets,
        this.conversations,
        conversationId,
      );
      return this.replyInTx(t, ctx, conv, body, {
        author: 'ai',
        draft: opts.draft,
        metadata: opts.metadata,
        notice: opts.notice,
      });
    };
    return tx ? run(tx) : this.db.transaction(run);
  }

  /**
   * Tells a customer on a live channel that a person will answer (the AI's
   * draft is waiting for approval). An automatic message: it is not the AI's
   * answer and not a first response.
   */
  async holdingReply(tx: DbOrTx, conversationId: string, body: string) {
    const conv = await lockTicketThenConversation(
      tx,
      this.tickets,
      this.conversations,
      conversationId,
    );
    return this.replyInTx(tx, SYSTEM_CTX, conv, body, {
      author: 'system',
      metadata: { holding: true },
    });
  }

  /** A human approves an AI draft, optionally edited; it is then delivered. */
  async approveDraft(ctx: RequestCtx, messageId: string, body?: string) {
    return this.db.transaction(async (tx) => {
      // Ticket and conversation first, the draft last: the same order a reply that
      // supersedes the draft takes them in.
      const peek = await this.conversations.getMessage(messageId);
      const conv = await lockTicketThenConversation(
        tx,
        this.tickets,
        this.conversations,
        peek.message.conversationId,
      );
      const message = await this.draft(tx, messageId);
      await this.conversations.reviewDraft(tx, messageId, {
        status: 'pending',
        body,
        reviewedBy: ctx.user?.id ?? null,
      });
      const ticket = await this.tickets.lockRow(tx, conv.ticketId);
      await this.tickets.recordAgentReply(tx, ctx, ticket, { byAi: true });
      const data = {
        conversationId: conv.id,
        messageId,
        channel: conv.channel,
        decision: 'approved',
        edited: body !== undefined && body !== message.body,
      };
      await this.audit.record(tx, ctx, {
        action: 'message.draft_approved',
        targetType: 'ticket',
        targetId: ticket.id,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'message.draft_reviewed',
        aggregateType: 'ticket',
        aggregateId: ticket.id,
        payload: data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'message.outbound',
        aggregateType: 'ticket',
        aggregateId: ticket.id,
        payload: { conversationId: conv.id, messageId, channel: conv.channel },
      });
      return { messageId, status: 'pending' as const };
    });
  }

  async discardDraft(ctx: RequestCtx, messageId: string) {
    return this.db.transaction(async (tx) => {
      const message = await this.draft(tx, messageId);
      const conv = await this.conversations.get(message.conversationId);
      await this.conversations.reviewDraft(tx, messageId, {
        status: 'discarded',
        reviewedBy: ctx.user?.id ?? null,
      });
      const data = {
        conversationId: conv.id,
        messageId,
        channel: conv.channel,
        decision: 'discarded',
      };
      await this.audit.record(tx, ctx, {
        action: 'message.draft_discarded',
        targetType: 'ticket',
        targetId: conv.ticketId,
        data,
      });
      await this.outbox.publish(tx, ctx, {
        type: 'message.draft_reviewed',
        aggregateType: 'ticket',
        aggregateId: conv.ticketId,
        payload: data,
      });
      return { messageId, status: 'discarded' as const };
    });
  }

  /**
   * The automatic "we've received your request" email for a web-form ticket.
   * Its Message-ID is derived from the submission, so a retried event never
   * sends it twice. Returns null when email is off (the ticket still exists).
   */
  async acknowledgeWebForm(conversationId: string, receivedMessageId: string) {
    const config = await this.channels.email();
    if (!config?.enabled) return null;
    return this.db.transaction(async (tx) => {
      const conv = await lockTicketThenConversation(
        tx,
        this.tickets,
        this.conversations,
        conversationId,
      );
      const messageId = `<ack-${receivedMessageId}@${config.address.split('@')[1]}>`;
      if (await this.conversations.findMessageByChannelId(tx, 'web_form', messageId)) return null;
      const ticket = await this.tickets.lockRow(tx, conv.ticketId);
      const meta = conv.metadata as { name?: string; subject?: string };
      const body = acknowledgement({
        name: meta.name,
        subject: meta.subject ?? ticket.subject,
        reference: formatTicketNumber(ticket.number),
        team: config.fromName,
      });
      return this.replyInTx(tx, SYSTEM_CTX, conv, body, {
        author: 'system',
        messageId,
        metadata: { kind: 'acknowledgement' },
      });
    });
  }

  private async draft(tx: DbOrTx, messageId: string) {
    const message = await this.conversations.lockMessage(tx, messageId);
    if (message.deliveryStatus !== 'draft') {
      throw new ConflictException('This message is not a draft waiting for review');
    }
    return message;
  }

  private async replyInTx(
    tx: DbOrTx,
    ctx: RequestCtx,
    conv: Conversation,
    body: string,
    opts: {
      author?: 'agent' | 'ai' | 'system';
      draft?: boolean;
      metadata?: Record<string, unknown>;
      /** A fixed email Message-ID (acknowledgements); otherwise a random one. */
      messageId?: string;
      /** Only says that someone will answer: the first-response clock keeps running. */
      notice?: boolean;
    } = {},
  ) {
    const author = opts.author ?? 'agent';
    const byAi = author === 'ai';
    // On a voice call a reply is spoken as it is stored: there is nothing left to deliver.
    const spoken = conv.channel === 'voice' && !opts.draft;
    const ourAddress = repliesByEmail(conv.channel) ? await this.emailAddress() : null;
    const ticket = await this.tickets.lockRow(tx, conv.ticketId);
    const email = ourAddress
      ? await this.emailHeaders(tx, conv, ticket.number, ourAddress, opts.messageId)
      : null;

    const message = await this.conversations.addMessage(tx, {
      conversationId: conv.id,
      channel: conv.channel as Channel,
      direction: 'outbound',
      authorType: author,
      authorUserId: author === 'agent' ? (ctx.user?.id ?? null) : null,
      body,
      channelMessageId: email?.messageId ?? null,
      deliveryStatus: opts.draft ? 'draft' : spoken ? 'sent' : 'pending',
      metadata: { ...(email ?? {}), ...(opts.metadata ?? {}), ...(spoken ? { spoken: true } : {}) },
    });
    if (!conv.externalThreadId && email) {
      // A thread we started: its first Message-ID is the thread key.
      await this.conversations.setThreadKey(tx, conv.id, email.messageId);
    }

    // Automatic messages (acknowledgements) and "a person will reply" notices are not a
    // first response: the customer has not been answered yet.
    if (!opts.draft && author !== 'system' && !opts.notice) {
      await this.tickets.recordAgentReply(tx, ctx, ticket, { byAi });
    }
    // A person replying takes the conversation over (from nobody, or from the AI),
    // and any AI draft still waiting is superseded by their reply.
    if (author === 'agent') {
      if (conv.controller !== 'human') {
        await this.conversations.setController(tx, ctx, conv, 'human', ctx.user?.id ?? null);
      }
      await this.tickets.setHandling(tx, ticket.id, 'human');
      for (const draftId of await this.conversations.pendingDraftIds(tx, conv.id)) {
        await this.conversations.reviewDraft(tx, draftId, {
          status: 'discarded',
          reviewedBy: ctx.user?.id ?? null,
        });
        const discarded = {
          conversationId: conv.id,
          messageId: draftId,
          channel: conv.channel,
          decision: 'superseded',
        };
        await this.audit.record(tx, ctx, {
          action: 'message.draft_discarded',
          targetType: 'ticket',
          targetId: ticket.id,
          data: discarded,
        });
        await this.outbox.publish(tx, ctx, {
          type: 'message.draft_reviewed',
          aggregateType: 'ticket',
          aggregateId: ticket.id,
          payload: discarded,
        });
      }
    }

    const data = { conversationId: conv.id, messageId: message.id, channel: conv.channel };
    await this.audit.record(tx, ctx, {
      action: opts.draft ? 'message.drafted' : 'message.sent',
      targetType: 'ticket',
      targetId: ticket.id,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type: opts.draft ? 'message.drafted' : spoken ? 'message.spoken' : 'message.outbound',
      aggregateType: 'ticket',
      aggregateId: ticket.id,
      payload: data,
    });
    return message;
  }

  /** Threading headers so the customer's mail client shows one conversation. */
  private async emailHeaders(
    tx: DbOrTx,
    conv: Conversation,
    ticketNumber: number,
    ourAddress: string,
    messageId?: string,
  ) {
    const domain = ourAddress.split('@')[1];
    const previous = await this.conversations.emailMessageIds(tx, conv.id);
    const lastInbound = [...previous].reverse().find((m) => m.direction === 'inbound');
    const meta = conv.metadata as { address?: string; subject?: string };
    if (!meta.address) throw new BadRequestException('This conversation has no email address');
    return {
      messageId: messageId ?? `<${randomUUID()}@${domain}>`,
      to: meta.address,
      subject: replySubject(meta.subject ?? '', ticketNumber),
      inReplyTo: lastInbound?.id ?? previous.at(-1)?.id ?? null,
      references: previous.slice(-20).map((m) => m.id),
    };
  }

  /** A 400 when WhatsApp can't send at all, so an agent hears it before writing. */
  private async requireWhatsApp() {
    const config = await this.channels.whatsapp();
    if (!config?.enabled || !config.accessToken) {
      throw new BadRequestException(
        'WhatsApp is not connected. An admin can connect it in Settings → Channels.',
      );
    }
  }

  /** Free text needs the channel connected, a short enough body and an open 24-hour window. */
  private async checkWhatsAppText(conv: Conversation, body: string) {
    await this.requireWhatsApp();
    if (body.length > WA_TEXT_MAX) {
      throw new BadRequestException(
        `WhatsApp messages can be up to ${WA_TEXT_MAX.toLocaleString('en')} characters`,
      );
    }
    const { lastInboundAt } = conv.metadata as WaConversationMeta;
    if (!waWindow(lastInboundAt).open) {
      throw new ConflictException({
        message: lastInboundAt
          ? "More than 24 hours have passed since the customer's last message. Send an approved template instead."
          : 'The customer has not written on WhatsApp yet. Send an approved template instead.',
        code: 'wa_window_closed',
      });
    }
  }

  /** The support address, or a 400 when the email channel is off. */
  private async emailAddress(): Promise<string> {
    const config = await this.channels.email();
    if (!config?.enabled) throw new BadRequestException('The email channel is not configured');
    return config.address;
  }
}

/** Web-form tickets are answered by email, like email tickets. */
const repliesByEmail = (channel: string) => channel === 'email' || channel === 'web_form';

function acknowledgement(a: { name?: string; subject: string; reference: string; team: string }) {
  const first = a.name?.trim().split(/\s+/)[0];
  return [
    `Hi ${first || 'there'},`,
    '',
    `Thanks for contacting ${a.team}. We've received your request "${a.subject}" and will reply to this email address.`,
    '',
    `Your reference is ${a.reference}. To add details or files, just reply to this email.`,
  ].join('\n');
}
