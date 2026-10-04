import type { Conversation, Message } from '../conversations/conversations.service';

export const CHANNEL_SENDERS = Symbol('CHANNEL_SENDERS');

export interface DeliveryItem {
  message: Message;
  conversation: Conversation;
  ticket: { id: string; number: number; subject: string };
  authorName: string | null;
}

/**
 * What the provider said about a send; its message id lets later status reports find the message.
 * `metadata` is merged into the message's own when it is marked sent (WhatsApp: why cards went as text).
 */
export interface DeliveryReceipt {
  channelMessageId?: string;
  metadata?: Record<string, unknown>;
}

/** A failure that another attempt can't fix (a closed window, a bad token): fail at once. */
export class PermanentDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentDeliveryError';
  }
}

/** Sends an outbound message on one channel. Throwing means "retry later". */
export interface ChannelSender {
  /** Conversation channels this sender delivers for. */
  readonly channels: readonly string[];
  send(item: DeliveryItem): Promise<DeliveryReceipt | void>;
}
