import { Inject, Injectable } from '@nestjs/common';
import type { Emitter } from '@socket.io/redis-emitter';
import {
  AGENT_NAMESPACE,
  type AgentEvent,
  AGENTS_ROOM,
  type DomainEvent,
  type DomainEventType,
} from '@tms/shared';
import { EMITTER } from '../infra/tokens';
import type { DomainEventHandler } from '../worker/domain-events';

/** Tells agent consoles that a ticket changed so they can refresh it. */
@Injectable()
export class RealtimeFanoutHandler implements DomainEventHandler {
  readonly name = 'realtime-fanout';

  constructor(@Inject(EMITTER) private readonly emitter: Emitter) {}

  handles(type: DomainEventType): boolean {
    return (
      type.startsWith('ticket.') ||
      type.startsWith('message.') ||
      type.startsWith('conversation.') ||
      type.startsWith('kb.') ||
      type.startsWith('ai.') ||
      type.startsWith('approval.') ||
      type === 'tool.called'
    );
  }

  async handle(event: DomainEvent): Promise<void> {
    const p = event.payload as {
      conversationId?: string;
      messageId?: string;
      documentId?: string;
      ticketId?: string;
    };
    const payload: AgentEvent = {
      type: event.type,
      // Approval events are about an approval; their payload names the ticket.
      ticketId: event.aggregateType === 'ticket' ? event.aggregateId : p.ticketId,
      conversationId: p.conversationId,
      messageId: p.messageId,
      documentId: event.aggregateType === 'kb' ? (p.documentId ?? undefined) : undefined,
    };
    this.emitter.of(AGENT_NAMESPACE).to(AGENTS_ROOM).emit('event', payload);
  }
}
