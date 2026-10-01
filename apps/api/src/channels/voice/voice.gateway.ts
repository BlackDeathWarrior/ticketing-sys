import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import {
  AGENT_NAMESPACE,
  VOICE_NAMESPACE,
  VOICE_SAMPLE_RATE,
  voiceJoinSchema,
  type VoiceStartInput,
  type VoiceStartResult,
} from '@tms/shared';
import type { Socket } from 'socket.io';
import { UsersService } from '../../users/users.service';
import { VoiceService } from './voice.service';

/** A second of audio is the most one frame may carry; the page sends a tenth of that. */
const MAX_FRAME_BYTES = VOICE_SAMPLE_RATE * 2;

function frame(body: unknown): Buffer | null {
  const pcm = Buffer.isBuffer(body) ? body : body instanceof ArrayBuffer ? Buffer.from(body) : null;
  return pcm && pcm.length > 0 && pcm.length <= MAX_FRAME_BYTES ? pcm : null;
}

/**
 * The caller's side of a voice call. Public, like the chat widget: `start`
 * begins a call (the caller has accepted the recording notice), `audio`
 * carries microphone frames, and the server sends speech, captions and state.
 */
@WebSocketGateway({ namespace: VOICE_NAMESPACE })
export class VoiceGateway implements OnGatewayDisconnect {
  private readonly logger = new Logger(VoiceGateway.name);

  constructor(private readonly voice: VoiceService) {}

  @SubscribeMessage('start')
  async onStart(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: VoiceStartInput,
  ): Promise<VoiceStartResult> {
    if (socket.data.callId) return { ok: false, error: 'A call is already in progress' };
    try {
      const result = await this.voice.start(body, {
        audio: (pcm) => socket.emit('audio', pcm),
        clear: () => socket.emit('clear'),
        state: (state) => socket.emit('state', state),
        caption: (caption) => socket.emit('caption', caption),
        ended: (reason) => {
          socket.data.callId = undefined;
          socket.emit('ended', { reason });
        },
      });
      if (result.ok) {
        // The visitor may have left while the call was being set up.
        if (socket.disconnected) void this.voice.hangUp(result.callId);
        else socket.data.callId = result.callId;
      }
      return result;
    } catch (err) {
      this.logger.error(`voice start failed: ${(err as Error).stack}`);
      return { ok: false, error: 'The call could not be started. Please try again.' };
    }
  }

  @SubscribeMessage('audio')
  onAudio(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const callId = socket.data.callId as string | undefined;
    const pcm = frame(body);
    if (callId && pcm) this.voice.callerAudio(callId, pcm);
  }

  @SubscribeMessage('hangup')
  async onHangup(@ConnectedSocket() socket: Socket): Promise<{ ok: true }> {
    const callId = socket.data.callId as string | undefined;
    if (callId) await this.voice.hangUp(callId);
    return { ok: true };
  }

  handleDisconnect(socket: Socket) {
    const callId = socket.data.callId as string | undefined;
    if (callId) void this.voice.hangUp(callId);
  }
}

/**
 * The agent's side: joining a live call from Orbit Desk. It shares the
 * authenticated `/agent` socket (AgentGateway checks the access token and
 * sets `userId`).
 */
@WebSocketGateway({ namespace: AGENT_NAMESPACE })
export class VoiceAgentGateway implements OnGatewayDisconnect {
  constructor(
    private readonly voice: VoiceService,
    private readonly users: UsersService,
  ) {}

  @SubscribeMessage('voice:join')
  async onJoin(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true; sampleRate: number } | { ok: false; error: string }> {
    const userId = socket.data.userId as string | undefined;
    const user = userId ? await this.users.getAuthContext(userId) : null;
    const parsed = voiceJoinSchema.safeParse(body);
    if (!user || !parsed.success) return { ok: false, error: 'Not allowed' };
    const { callId } = parsed.data;
    try {
      await this.voice.join(user, callId, {
        audio: (pcm) => socket.emit('voice:audio', { callId, pcm }),
        caption: (caption) => socket.emit('voice:caption', { callId, caption }),
        state: (state) => socket.emit('voice:state', { callId, state }),
        ended: (reason) => socket.emit('voice:ended', { callId, reason }),
      });
      return { ok: true, sampleRate: VOICE_SAMPLE_RATE };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  @SubscribeMessage('voice:audio')
  onAudio(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown): void {
    const userId = socket.data.userId as string | undefined;
    const b = body as { callId?: unknown; pcm?: unknown } | null;
    const pcm = frame(b?.pcm);
    if (userId && pcm && typeof b?.callId === 'string')
      this.voice.agentAudio(userId, b.callId, pcm);
  }

  @SubscribeMessage('voice:leave')
  async onLeave(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<{ ok: true }> {
    const userId = socket.data.userId as string | undefined;
    const b = body as { callId?: unknown; end?: unknown } | null;
    if (userId && typeof b?.callId === 'string') {
      await this.voice.leave(userId, b.callId, b.end === true);
    }
    return { ok: true };
  }

  handleDisconnect(socket: Socket) {
    const userId = socket.data.userId as string | undefined;
    if (userId) this.voice.agentDisconnected(userId);
  }
}
