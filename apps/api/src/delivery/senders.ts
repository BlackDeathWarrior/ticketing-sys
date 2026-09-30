import type { Conversation, Message } from '../conversations/conversations.service';

export const CHANNEL_SENDERS = Symbol('CHANNEL_SENDERS');

export interface DeliveryItem {
  message: Message;
  conversation: Conversation;
  ticket: { id: string; number: number; subject: string };
  authorName: string | null;
}

/** Sends an outbound message on one channel. Throwing means "retry later". */
export interface ChannelSender {
  readonly channel: string;
  send(item: DeliveryItem): Promise<void>;
}
