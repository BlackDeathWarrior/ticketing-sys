import { Injectable } from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import type { DomainEventHandler } from '../../worker/domain-events';
import { PhoneCallQueue } from './phone-call.queue';

/** Worker side of a call the desk asked for: queues it to be placed. */
@Injectable()
export class PhoneOutboundHandler implements DomainEventHandler {
  readonly name = 'phone-outbound';

  constructor(private readonly queue: PhoneCallQueue) {}

  handles(type: DomainEventType): boolean {
    return type === 'voice.call_requested';
  }

  async handle(event: DomainEvent): Promise<void> {
    await this.queue.place(event.aggregateId);
  }
}
