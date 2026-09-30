import type { DomainEvent, DomainEventType } from '@tms/shared';

export const DOMAIN_EVENT_HANDLERS = Symbol('DOMAIN_EVENT_HANDLERS');

export interface HandlerContext {
  /** 1-based attempt number of this delivery of the event. */
  attempt: number;
  maxAttempts: number;
}

/**
 * Something that reacts to domain events in the worker. Handlers must be
 * idempotent: an event is retried if any handler throws.
 */
export interface DomainEventHandler {
  readonly name: string;
  handles(type: DomainEventType): boolean;
  handle(event: DomainEvent, ctx: HandlerContext): Promise<void>;
}
