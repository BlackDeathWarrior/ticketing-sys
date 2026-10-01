import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Emitter } from '@socket.io/redis-emitter';
import {
  CHAT_NAMESPACE,
  type ChatRatingPrompt,
  chatRoom,
  type DomainEvent,
  type DomainEventType,
  isLowRating,
} from '@tms/shared';
import { ConversationsService } from '../conversations/conversations.service';
import { EMITTER } from '../infra/tokens';
import { NotificationsService } from '../notifications/notifications.service';
import { ChannelConfigService } from '../settings/channel-config.service';
import { CustomerExperienceService } from '../settings/customer-experience.service';
import { SystemMailer } from '../settings/system-mailer.service';
import { TicketsService } from '../tickets/tickets.service';
import { UsersService } from '../users/users.service';
import type { DomainEventHandler } from '../worker/domain-events';
import { CsatService } from './csat.service';

/**
 * Asks for a rating when a ticket is resolved: in the chat window for chat
 * tickets, by email for email and request-form tickets. A ticket is asked
 * about once. Low ratings are brought to the team's attention.
 */
@Injectable()
export class CsatHandler implements DomainEventHandler {
  readonly name = 'csat';
  private readonly logger = new Logger(CsatHandler.name);

  constructor(
    @Inject(EMITTER) private readonly emitter: Emitter,
    private readonly csat: CsatService,
    private readonly experience: CustomerExperienceService,
    private readonly tickets: TicketsService,
    private readonly conversations: ConversationsService,
    private readonly channels: ChannelConfigService,
    private readonly mailer: SystemMailer,
    private readonly notifications: NotificationsService,
    private readonly users: UsersService,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'ticket.status_changed' || type === 'csat.submitted';
  }

  async handle(event: DomainEvent): Promise<void> {
    if (event.type === 'csat.submitted') return this.lowRating(event);
    if ((event.payload as { category?: string }).category !== 'resolved') return;
    await this.ask(event.aggregateId);
  }

  private async ask(ticketId: string): Promise<void> {
    const settings = await this.experience.get();
    if (!settings.csatByEmail && !settings.csatInChat) return;
    const ticket = await this.tickets.get(ticketId).catch(() => null);
    if (!ticket || (await this.csat.whyNotRatable(ticket))) return;
    if ((await this.csat.wasAsked(ticketId)) || (await this.csat.forTicket(ticketId))) return;

    // The channel the customer last used on this ticket decides how we ask.
    const conv = (await this.conversations.listForTicket(ticketId)).at(-1);
    if (!conv) return;

    if (conv.channel === 'webchat' && settings.csatInChat && conv.externalThreadId) {
      if (!(await this.csat.markAsked(ticketId, 'chat'))) return;
      const prompt: ChatRatingPrompt = {
        token: this.csat.tokenFor(ticketId),
        reference: ticket.reference,
      };
      this.emitter.of(CHAT_NAMESPACE).to(chatRoom(conv.externalThreadId)).emit('rate', prompt);
      return;
    }

    if ((conv.channel === 'email' || conv.channel === 'web_form') && settings.csatByEmail) {
      const meta = conv.metadata as { address?: string; name?: string };
      const to = meta.address ?? ticket.customer.primaryEmail;
      const email = await this.channels.email();
      if (!to || !email?.enabled) return;
      const sent = await this.mailer.send({
        to,
        subject: `How did we do? [${ticket.reference}]`,
        text: surveyMail({
          name: meta.name ?? ticket.customer.displayName,
          reference: ticket.reference,
          subject: ticket.subject,
          link: this.csat.linkFor(ticketId),
          team: email.fromName,
        }),
        // One survey per ticket: a retry of this event reuses the id.
        id: `csat-${ticketId}`,
      });
      if (sent) {
        await this.csat.markAsked(ticketId, 'email');
        this.logger.log(`asked for a rating of ${ticket.reference} by email`);
      }
    }
  }

  private async lowRating(event: DomainEvent): Promise<void> {
    const p = event.payload as { rating: number; previousRating: number | null };
    if (!isLowRating(p.rating)) return;
    const ticket = await this.tickets.get(event.aggregateId).catch(() => null);
    if (!ticket) return;
    const leads = await this.users.withPermission('ticket:assign', ticket.team?.id ?? null);
    await this.notifications.notify(
      [...leads.map((u) => u.id), ...(ticket.assignee ? [ticket.assignee.id] : [])],
      {
        kind: 'csat.low',
        title: `${ticket.reference} was rated ${p.rating} out of 5`,
        body: ticket.subject,
        ticketId: ticket.id,
        dedupeKey: `csat-low:${event.id}`,
      },
    );
  }
}

export function surveyMail(m: {
  name: string;
  reference: string;
  subject: string;
  link: string;
  team: string;
}): string {
  return [
    `Hi ${m.name},`,
    '',
    `Your request ${m.reference} ("${m.subject}") has been marked as solved.`,
    '',
    'How did we do? It takes a few seconds:',
    m.link,
    '',
    "If it isn't solved, reply to our last email and we'll pick it up again.",
    '',
    m.team,
  ].join('\n');
}
