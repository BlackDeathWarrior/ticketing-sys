import { Injectable } from '@nestjs/common';
import type { ChannelSender } from './senders';

/**
 * Replies on tickets an integration raised (ADR 0023). There is nowhere to
 * push them from here: the app reads them through the integration API, and
 * webhooks tell it when to look. "Sent" therefore means "available to the app".
 */
@Injectable()
export class ApiSender implements ChannelSender {
  readonly channels = ['api'];

  async send(): Promise<void> {}
}
