import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent, DomainEventType } from '@tms/shared';
import { EmailPollerService } from '../channels/email/email-poller.service';
import type { DomainEventHandler } from '../worker/domain-events';
import { AppSettingsService } from './app-settings.service';

/**
 * Worker side of a Settings change: forget cached settings and reconnect the
 * mailbox when its settings or password changed. Senders read settings per
 * message, so they need nothing more.
 */
@Injectable()
export class SettingsChangedHandler implements DomainEventHandler {
  readonly name = 'settings-changed';
  private readonly logger = new Logger(SettingsChangedHandler.name);

  constructor(
    private readonly settings: AppSettingsService,
    private readonly poller: EmailPollerService,
  ) {}

  handles(type: DomainEventType): boolean {
    return type === 'settings.updated' || type === 'settings.secret_changed';
  }

  async handle(event: DomainEvent): Promise<void> {
    const key = event.aggregateId;
    this.settings.invalidate(key);
    if (key === 'channel.email' || key.startsWith('email.')) {
      this.logger.log(`${key} changed`);
      await this.poller.restart();
    }
  }
}
