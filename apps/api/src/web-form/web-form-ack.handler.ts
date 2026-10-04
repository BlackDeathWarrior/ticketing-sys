import { Injectable } from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { OutboundService } from '../channels/outbound.service';
import type { DomainEventHandler } from '../worker/domain-events';

interface ReceivedPayload {
  conversationId: string;
  messageId: string;
  channel: string;
  createdTicket: boolean;
}

/** Emails the reference to whoever submitted the request form. */
@Injectable()
export class WebFormAckHandler implements DomainEventHandler {
  readonly name = 'web-form-ack';

  constructor(private readonly outbound: OutboundService) {}

  handles(type: DomainEventType): boolean {
    return type === 'message.received';
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as unknown as ReceivedPayload;
    if (p.channel !== 'web_form' || !p.createdTicket) return;
    await this.outbound.acknowledgeWebForm(p.conversationId, p.messageId);
  }
}
