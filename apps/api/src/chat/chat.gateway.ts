import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import {
  CHAT_NAMESPACE,
  chatHandshakeSchema,
  chatMessageSchema,
  chatRoom,
  type ChatMessageView,
} from '@tms/shared';
import type { Namespace, Socket } from 'socket.io';
import { InboundService } from '../channels/inbound.service';
import { ConversationsService } from '../conversations/conversations.service';
import { type ChatSession, ChatSessionService } from './chat-session.service';

const RATE_WINDOW_MS = 10_000;
const RATE_MAX_MESSAGES = 10;

type Ack<T> = { ok: true } & T;
type Nack = { ok: false; error: string };

/**
 * The web chat channel. Visitors connect to /chat; on connect they get a
 * session token to resume the same conversation later. Agent replies reach
 * them through the worker, which emits `message` to the session's room.
 */
@WebSocketGateway({ namespace: CHAT_NAMESPACE })
export class ChatGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  private readonly server?: Namespace;

  constructor(
    private readonly sessions: ChatSessionService,
    private readonly inbound: InboundService,
    private readonly conversations: ConversationsService,
  ) {}

  /** Visitors with the chat open on this API instance; null before the server is up. */
  connected(): number | null {
    return this.server?.sockets?.size ?? null;
  }

  async handleConnection(socket: Socket) {
    const auth = chatHandshakeSchema.safeParse(socket.handshake.auth ?? {});
    if (!auth.success) {
      socket.emit('error', { message: 'Invalid chat handshake' });
      socket.disconnect(true);
      return;
    }
    const { session, token } = await this.sessions.open(auth.data);
    socket.data.session = session;
    socket.data.sent = [] as number[];
    await socket.join(chatRoom(session.sid));
    socket.emit('session', { token, sessionId: session.sid, name: session.name ?? null });
  }

  @SubscribeMessage('message')
  async onMessage(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<Ack<{ message: ChatMessageView }> | Nack> {
    const session = socket.data.session as ChatSession | undefined;
    if (!session) return { ok: false, error: 'No session' };
    const parsed = chatMessageSchema.safeParse(body);
    if (!parsed.success) return { ok: false, error: 'Message must be 1–5000 characters' };
    if (this.rateLimited(socket))
      return { ok: false, error: 'You are sending messages too quickly' };

    try {
      const result = await this.inbound.handle({
        channel: 'webchat',
        threadKey: session.sid,
        // Stable per client message, so a resend after a lost ack is ignored.
        channelMessageId: `${session.sid}:${parsed.data.clientMessageId}`,
        from: this.sessions.sender(session),
        text: parsed.data.text,
        receivedAt: new Date().toISOString(),
        metadata: {
          origin: socket.handshake.headers.origin,
          userAgent: socket.handshake.headers['user-agent'],
        },
      });
      return {
        ok: true,
        message: {
          id: result.messageId,
          body: parsed.data.text,
          authorType: 'customer',
          createdAt: new Date().toISOString(),
        },
      };
    } catch (err) {
      this.logger.error(`chat message failed: ${(err as Error).stack}`);
      return { ok: false, error: 'Your message could not be sent. Please try again.' };
    }
  }

  @SubscribeMessage('history')
  async onHistory(
    @ConnectedSocket() socket: Socket,
  ): Promise<Ack<{ messages: ChatMessageView[] }> | Nack> {
    const session = socket.data.session as ChatSession | undefined;
    if (!session) return { ok: false, error: 'No session' };
    return { ok: true, messages: await this.conversations.chatHistory(session.sid) };
  }

  private rateLimited(socket: Socket): boolean {
    const now = Date.now();
    const sent = (socket.data.sent as number[]).filter((t) => now - t < RATE_WINDOW_MS);
    sent.push(now);
    socket.data.sent = sent;
    return sent.length > RATE_MAX_MESSAGES;
  }
}
