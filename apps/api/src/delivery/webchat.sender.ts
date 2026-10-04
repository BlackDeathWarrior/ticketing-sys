import { Inject, Injectable } from '@nestjs/common';
import type { Emitter } from '@socket.io/redis-emitter';
import { CHAT_NAMESPACE, chatRoom } from '@tms/shared';
import { toChatView } from '../conversations/conversations.service';
import { EMITTER } from '../infra/tokens';
import type { ChannelSender, DeliveryItem } from './senders';

/**
 * Pushes the reply to the visitor's chat room. If they are offline they see
 * it in their history when they come back.
 */
@Injectable()
export class WebchatSender implements ChannelSender {
  readonly channels = ['webchat'];

  constructor(@Inject(EMITTER) private readonly emitter: Emitter) {}

  async send({ message, conversation, authorName }: DeliveryItem): Promise<void> {
    const sessionId = conversation.externalThreadId;
    if (!sessionId) throw new Error('Chat conversation has no session id');
    this.emitter
      .of(CHAT_NAMESPACE)
      .to(chatRoom(sessionId))
      .emit('message', toChatView(message, authorName));
  }
}
