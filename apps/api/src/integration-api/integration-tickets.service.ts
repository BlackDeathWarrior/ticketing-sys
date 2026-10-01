import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  type CreateIntegrationTicketInput,
  type CsatSubmit,
  type CsatView,
  integrationExternalId,
  type IntegrationMessageView,
  type IntegrationTicketList,
  type IntegrationTicketView,
  type ListIntegrationTicketsQuery,
  type MessageEnvelope,
  type Priority,
  type StatusCategory,
} from '@tms/shared';
import { InboundService } from '../channels/inbound.service';
import type { ApiKeyContext } from '../common/request-context';
import { ConversationsService } from '../conversations/conversations.service';
import { CsatService } from '../csat/csat.service';
import { CustomersService } from '../customers/customers.service';
import { OrgService } from '../org/org.service';
import { TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';

type TicketRow = Awaited<ReturnType<TicketsService['get']>>;

/**
 * What an integration does with tickets through its API key (ADR 0023): raise
 * one in a single call, add the customer's follow-ups, and read the ticket and
 * the messages the customer may see. Everything goes through the same inbound
 * pipeline as the other channels, so the AI, routing and SLA all apply.
 *
 * An integration only ever reaches tickets it raised. Any other ticket looks
 * exactly like one that doesn't exist.
 */
@Injectable()
export class IntegrationTicketsService {
  constructor(
    private readonly inbound: InboundService,
    private readonly tickets: TicketsService,
    private readonly conversations: ConversationsService,
    private readonly customers: CustomersService,
    private readonly workflow: WorkflowService,
    private readonly org: OrgService,
    private readonly csat: CsatService,
  ) {}

  /**
   * Raises a ticket. With an idempotency key, a repeat of the same call
   * returns the ticket it made the first time and `created: false`.
   */
  async create(
    key: ApiKeyContext,
    input: CreateIntegrationTicketInput,
    idempotencyKey?: string,
  ): Promise<{ ticket: IntegrationTicketView; created: boolean }> {
    const categoryId = input.category ? await this.categoryId(input.category) : undefined;
    const { integration } = key;
    const unique = randomUUID();
    const result = await this.inbound.handle({
      channel: 'api',
      // Each call opens its own ticket; follow-ups name the ticket instead.
      threadKey: `api:${integration.id}:${unique}`,
      channelMessageId: `api:${integration.id}:${idempotencyKey ?? unique}`,
      from: this.sender(key, input.customer),
      subject: input.subject,
      text: input.body,
      receivedAt: new Date().toISOString(),
      metadata: { via: 'api', apiKeyId: key.id },
      ticket: {
        categoryId,
        priority: input.priority,
        tags: input.tags,
        externalRef: input.externalRef,
        metadata: input.metadata,
        integrationId: integration.id,
      },
      ai: input.ai,
    });
    const ticket = await this.tickets.get(result.ticketId);
    return { ticket: await this.view(ticket), created: !result.duplicate };
  }

  async list(key: ApiKeyContext, q: ListIntegrationTicketsQuery): Promise<IntegrationTicketList> {
    const { statuses } = await this.workflow.load();
    const { items, total } = await this.tickets.forIntegration(key.integration.id, {
      externalRef: q.externalRef,
      statuses: q.state
        ? statuses.filter((s) => s.category === q.state).map((s) => s.key)
        : undefined,
      limit: q.limit,
      offset: q.offset,
    });
    return { items: await Promise.all(items.map((t) => this.view(t))), total };
  }

  async get(key: ApiKeyContext, reference: string): Promise<IntegrationTicketView> {
    return this.view(await this.owned(key, reference));
  }

  /**
   * A ticket and one of its customer-visible messages as integrations see
   * them, for webhook bodies. Null for a ticket that is gone; `message` is
   * null for a draft or a message that is not on this ticket.
   */
  async forWebhook(
    ticketId: string,
    messageId?: string,
  ): Promise<{
    ticket: IntegrationTicketView;
    integrationId: string | null;
    message: IntegrationMessageView | null;
  } | null> {
    const ticket = await this.tickets.get(ticketId).catch(() => null);
    if (!ticket) return null;
    const message = messageId
      ? ((await this.visibleMessages(ticket.id)).find((m) => m.id === messageId) ?? null)
      : null;
    return { ticket: await this.view(ticket), integrationId: ticket.integrationId, message };
  }

  /** What the customer wrote and was sent, oldest first. Never drafts or internal notes. */
  async messages(
    key: ApiKeyContext,
    reference: string,
    after?: string,
  ): Promise<IntegrationMessageView[]> {
    const ticket = await this.owned(key, reference);
    const since = after ? new Date(after).getTime() : null;
    return (await this.visibleMessages(ticket.id)).filter(
      (m) => since === null || new Date(m.createdAt).getTime() > since,
    );
  }

  private async visibleMessages(ticketId: string): Promise<IntegrationMessageView[]> {
    return (await this.conversations.listForTicket(ticketId))
      .flatMap((c) => c.messages)
      .filter((m) => m.deliveryStatus !== 'draft' && m.deliveryStatus !== 'discarded')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((m) => ({
        id: m.id,
        from:
          m.authorType === 'customer'
            ? 'customer'
            : m.authorType === 'ai'
              ? 'assistant'
              : m.authorType === 'agent'
                ? 'support'
                : 'system',
        name: m.authorType === 'agent' ? (m.authorName?.split(' ')[0] ?? null) : null,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
      }));
  }

  /** The customer wrote again on a ticket the integration raised. */
  async addMessage(
    key: ApiKeyContext,
    reference: string,
    body: string,
    idempotencyKey?: string,
  ): Promise<{ message: IntegrationMessageView; created: boolean }> {
    const ticket = await this.owned(key, reference);
    const { category } = await this.workflow.status(ticket.status);
    if (category === 'closed') {
      throw new ConflictException('This ticket is closed. Create a new one.');
    }
    const { integration } = key;
    const result = await this.inbound.handle({
      channel: 'api',
      threadKey: `api:${integration.id}:ticket:${ticket.id}`,
      channelMessageId: `api:${integration.id}:${idempotencyKey ?? randomUUID()}`,
      from: { identity: await this.identityOf(ticket.customerId) },
      text: body,
      receivedAt: new Date().toISOString(),
      metadata: { via: 'api', apiKeyId: key.id },
      ticket: { id: ticket.id, integrationId: integration.id },
    });
    if (result.ticketId !== ticket.id) {
      // An idempotency key that was used before, on another ticket.
      throw new ConflictException('This Idempotency-Key was already used for another request');
    }
    const message = (await this.messages(key, reference)).find((m) => m.id === result.messageId);
    return { message: message!, created: !result.duplicate };
  }

  /** The customer's rating, passed on by the app that showed them the question. */
  async rate(key: ApiKeyContext, reference: string, input: CsatSubmit): Promise<CsatView> {
    const ticket = await this.owned(key, reference);
    return this.csat.submit(ticket.id, input, 'api');
  }

  /** The ticket, if this integration raised it. Otherwise it "doesn't exist". */
  private async owned(key: ApiKeyContext, reference: string): Promise<TicketRow> {
    const ticket = await this.tickets.get(reference).catch(() => null);
    if (!ticket || ticket.integrationId !== key.integration.id) {
      throw new NotFoundException('Ticket not found');
    }
    return ticket;
  }

  /**
   * The envelope's sender. The app's own id for the person is the identity
   * when there is one; an email next to it is attached unverified, because
   * TMS can't know whether the app checked it.
   */
  private sender(
    key: ApiKeyContext,
    c: CreateIntegrationTicketInput['customer'],
  ): MessageEnvelope['from'] {
    const displayName = c.name ?? c.email ?? `Customer ${c.externalId}`;
    if (c.externalId) {
      return {
        identity: {
          type: 'external_id',
          value: integrationExternalId(key.integration.slug, c.externalId),
        },
        displayName,
        extraIdentities: c.email ? [{ type: 'email', value: c.email, verified: false }] : [],
      };
    }
    return { identity: { type: 'email', value: c.email! }, displayName };
  }

  /** Any identity of the ticket's customer: a follow-up is from whoever the ticket is for. */
  private async identityOf(customerId: string): Promise<MessageEnvelope['from']['identity']> {
    const { identities } = await this.customers.get(customerId);
    const identity =
      identities.find((i) => i.type === 'external_id') ??
      identities.find((i) => i.type === 'email') ??
      identities[0];
    if (!identity) throw new ConflictException('The customer of this ticket has no identity');
    return {
      type: identity.type as MessageEnvelope['from']['identity']['type'],
      value: identity.value,
    };
  }

  private async categoryId(name: string): Promise<string> {
    const wanted = name.toLowerCase();
    const match = (await this.org.activeCategories()).find(
      (c) => !c.parentId && c.name.toLowerCase() === wanted,
    );
    if (!match) throw new BadRequestException(`Unknown category "${name}"`);
    return match.id;
  }

  private async view(t: TicketRow): Promise<IntegrationTicketView> {
    const status = await this.workflow.status(t.status);
    return {
      reference: t.reference,
      subject: t.subject,
      status: { key: status.key, name: status.name, state: status.category as StatusCategory },
      priority: t.priority as Priority,
      category: t.category?.name ?? null,
      tags: t.tags,
      externalRef: t.externalRef,
      metadata: t.metadata,
      customer: { name: t.customer.displayName, email: t.customer.primaryEmail },
      handling: t.handling,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      closedAt: t.closedAt?.toISOString() ?? null,
    };
  }
}
