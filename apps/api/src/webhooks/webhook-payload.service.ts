import { Injectable } from '@nestjs/common';
import type { WebhookEvent } from '@tms/shared';
import { CsatService } from '../csat/csat.service';
import { IncidentsService } from '../integration-api/incidents.service';
import { IntegrationTicketsService } from '../integration-api/integration-tickets.service';
import { ApprovalsService } from '../tools/approvals.service';
import type { WebhookRefs } from './webhook-events';

/**
 * Builds the `data` of a webhook body from current records, at the moment it
 * is sent. Nothing here is stored: a retry or a redelivery is built again, so
 * it shows the ticket as it is now.
 *
 * The body holds what the integration API would return for the same records:
 * no drafts, no internal notes, no staff-only fields.
 */
@Injectable()
export class WebhookPayloadService {
  constructor(
    private readonly tickets: IntegrationTicketsService,
    private readonly incidents: IncidentsService,
    private readonly approvals: ApprovalsService,
    private readonly csat: CsatService,
  ) {}

  /** The integration an event belongs to, or null for a ticket no integration raised. */
  async owner(refs: WebhookRefs): Promise<string | null> {
    if (refs.integrationId) return refs.integrationId;
    if (!refs.ticketId) return null;
    return (await this.tickets.forWebhook(refs.ticketId))?.integrationId ?? null;
  }

  /** Null when what the event was about no longer exists or must not be shown. */
  async data(type: WebhookEvent, refs: WebhookRefs): Promise<Record<string, unknown> | null> {
    if (type.startsWith('incident.')) {
      const found = refs.incidentId ? await this.incidents.byId(refs.incidentId) : null;
      return found ? { incident: found.incident } : null;
    }

    const found = refs.ticketId
      ? await this.tickets.forWebhook(refs.ticketId, refs.messageId)
      : null;
    if (!found) return null;
    const { ticket } = found;

    switch (type) {
      case 'ticket.status_changed':
        return { ticket, from: refs.from ?? null, to: refs.to ?? null };
      case 'ticket.updated':
        return { ticket, changed: refs.changed ?? [] };
      case 'message.created':
        // A draft, or a message that was discarded since: nothing to tell.
        return found.message ? { ticket, message: found.message } : null;
      case 'csat.submitted': {
        const rating = await this.csat.forTicket(refs.ticketId!);
        return rating
          ? { ticket, rating: { rating: rating.rating, comment: rating.comment } }
          : null;
      }
      case 'approval.requested':
      case 'approval.decided': {
        const approval = refs.approvalId
          ? await this.approvals.getAny(refs.approvalId).catch(() => null)
          : null;
        if (!approval) return null;
        return {
          ticket,
          approval: {
            id: approval.id,
            status: approval.status,
            action: approval.tool.title ?? approval.tool.name,
            tool: approval.tool.qualifiedName,
            summary: approval.summary,
            // Written for the customer by whoever decided; the note for colleagues is never sent.
            ...(type === 'approval.decided' ? { reason: approval.reason } : {}),
          },
        };
      }
      default:
        return { ticket };
    }
  }
}
