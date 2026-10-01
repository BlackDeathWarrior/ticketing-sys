import {
  type BeforeApplicationShutdown,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  baseLanguage,
  type CurrentUser,
  type VoiceCaption,
  type VoiceEndReason,
  type VoiceStartInput,
  type VoiceStartResult,
  type VoiceState,
  voiceStartSchema,
  VOICE_SAMPLE_RATE,
} from '@tms/shared';
import { AiAgentService, ConversationBusyError } from '../../ai/ai-agent.service';
import { type ChatSession, ChatSessionService } from '../../chat/chat-session.service';
import type { RequestCtx } from '../../common/request-context';
import { SYSTEM_CTX } from '../../common/request-context';
import type { Env } from '../../config/env';
import { ConversationsService } from '../../conversations/conversations.service';
import { HandoverService } from '../../handover/handover.service';
import { ENV } from '../../infra/tokens';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { InboundService } from '../inbound.service';
import { OutboundService } from '../outbound.service';
import { SPEECH_PROVIDER, type SpeechProvider, SpeechUnavailableError } from './speech';
import { VoiceCallsService } from './voice-calls.service';
import { type CallerTurn, VoiceSession } from './voice-session';

/** What a call sends to the sockets attached to it. */
export interface CallerLink {
  audio(pcm: Buffer): void;
  clear(): void;
  state(state: VoiceState): void;
  caption(caption: VoiceCaption): void;
  ended(reason: VoiceEndReason): void;
}
export interface AgentLink {
  audio(pcm: Buffer): void;
  caption(caption: VoiceCaption): void;
  state(state: VoiceState): void;
  ended(reason: VoiceEndReason): void;
}

interface LiveCall {
  id: string;
  session: VoiceSession;
  chat: ChatSession;
  caller: CallerLink;
  agent?: { user: CurrentUser; link: AgentLink };
  ticketId?: string;
  conversationId?: string;
  utterances: number;
  aiSpoke: boolean;
  humanSpoke: boolean;
  /** A person was asked for once (when the AI is off, or after it handed over). */
  personAsked: boolean;
}

const HOLD_LINE = 'Please stay on the line. I am connecting you with a member of our team.';

/**
 * Live voice calls on this API process (ADR 0018). A call is a VoiceSession
 * plus what ties it to the helpdesk: each thing the caller says becomes a
 * message through InboundService, the AI answers in the same breath
 * (`AiAgentService.runTurn`, not the queue), and an agent can join.
 *
 * Calls live in this process's memory, so an agent can only join a call that
 * is on the API instance their own socket reached.
 */
@Injectable()
export class VoiceService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger = new Logger(VoiceService.name);
  private readonly calls = new Map<string, LiveCall>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SPEECH_PROVIDER) private speech: SpeechProvider,
    private readonly channels: ChannelConfigService,
    private readonly sessions: ChatSessionService,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
    private readonly conversations: ConversationsService,
    private readonly ai: AiAgentService,
    private readonly handover: HandoverService,
    private readonly records: VoiceCallsService,
  ) {}

  async onApplicationBootstrap() {
    const abandoned = await this.records.closeAbandoned().catch(() => 0);
    if (abandoned) this.logger.warn(`closed ${abandoned} call(s) left open by a previous run`);
  }

  async beforeApplicationShutdown() {
    await Promise.all([...this.calls.values()].map((c) => c.session.end('server_shutdown')));
  }

  /** Tests swap the speech service for one that needs no network. */
  useSpeech(provider: SpeechProvider): void {
    this.speech = provider;
  }

  get activeCalls(): number {
    return this.calls.size;
  }

  stateOf(callId: string): VoiceState | null {
    return this.calls.get(callId)?.session.current ?? null;
  }

  /** Starts a call for a visitor. The answer says why when it can't. */
  async start(input: VoiceStartInput, caller: CallerLink): Promise<VoiceStartResult> {
    const parsed = voiceStartSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request' };
    }
    const config = await this.channels.sarvam();
    if (!config?.enabled || !config.apiKey) {
      return { ok: false, error: 'Voice calls are not available right now. Please use the chat.' };
    }
    if (this.calls.size >= this.env.VOICE_MAX_CALLS) {
      return { ok: false, error: 'All our lines are busy. Please try again in a few minutes.' };
    }

    const { session: chat, token } = await this.sessions.open({
      token: parsed.data.token,
      name: parsed.data.name,
      email: parsed.data.email,
    });
    const record = await this.records.begin();
    const call: LiveCall = {
      id: record.id,
      chat,
      caller,
      utterances: 0,
      aiSpoke: false,
      humanSpoke: false,
      personAsked: false,
      session: undefined as unknown as VoiceSession,
    };
    const maxSeconds = config.maxCallMinutes * 60;
    call.session = new VoiceSession(
      this.speech,
      {
        audio: (pcm) => call.caller.audio(pcm),
        clear: () => call.caller.clear(),
        state: (state) => {
          call.caller.state(state);
          call.agent?.link.state(state);
        },
        caption: (caption) => {
          call.caller.caption(caption);
          call.agent?.link.caption(caption);
          if (caption.who === 'ai') call.aiSpoke = true;
        },
        toAgent: (pcm) => call.agent?.link.audio(pcm),
        callerSaid: (text, language) => this.callerSaid(call, text, language),
        agentSaid: (text) => this.agentSaid(call, text),
        ended: async (result) => {
          this.calls.delete(call.id);
          call.caller.ended(result.reason);
          call.agent?.link.ended(result.reason);
          await this.records.finish(call.id, {
            reason: result.reason,
            seconds: result.seconds,
            language: baseLanguage(result.language),
            answeredBy:
              call.aiSpoke && call.humanSpoke
                ? 'both'
                : call.humanSpoke
                  ? 'human'
                  : call.aiSpoke
                    ? 'ai'
                    : null,
            // A call where the caller never spoke has nothing worth keeping.
            recording: call.ticketId ? result.recording : null,
          });
        },
        warn: (message) => this.logger.warn(`call ${call.id}: ${message}`),
      },
      { greeting: config.greeting, maxSeconds, record: config.recordCalls },
    );

    this.calls.set(call.id, call);
    try {
      await call.session.start();
    } catch (err) {
      this.calls.delete(call.id);
      await this.records.finish(call.id, {
        reason: 'error',
        seconds: 0,
        language: null,
        answeredBy: null,
        recording: null,
      });
      this.logger.warn(`call ${call.id} could not start: ${(err as Error).message}`);
      return {
        ok: false,
        error:
          err instanceof SpeechUnavailableError
            ? 'Voice calls are not available right now. Please use the chat.'
            : 'The call could not be started. Please try again.',
      };
    }
    return { ok: true, callId: call.id, token, sampleRate: VOICE_SAMPLE_RATE, maxSeconds };
  }

  callerAudio(callId: string, pcm: Buffer): void {
    this.calls.get(callId)?.session.callerAudio(pcm);
  }

  async hangUp(callId: string, reason: VoiceEndReason = 'caller_hung_up'): Promise<void> {
    await this.calls.get(callId)?.session.end(reason);
  }

  /**
   * An agent joins a live call by voice. Joining takes the conversation over
   * (one person at a time, as on every channel); the AI stops talking.
   */
  async join(user: CurrentUser, callId: string, link: AgentLink): Promise<void> {
    if (!user.permissions.includes('voice:answer')) {
      throw new ForbiddenException('You are not allowed to answer voice calls');
    }
    const call = this.calls.get(callId);
    if (!call) throw new NotFoundException('This call has ended, or is on another server');
    if (!call.conversationId) throw new ConflictException('The caller has not said anything yet');
    if (call.agent && call.agent.user.id !== user.id) {
      throw new ConflictException('A colleague is already on this call');
    }
    const ctx: RequestCtx = { actor: { type: 'user', id: user.id }, user };
    await this.handover.takeOver(ctx, call.conversationId);
    call.agent = { user, link };
    await call.session.agentJoined();
    await this.records.agentJoined(ctx, call.id, user.id);
    link.state(call.session.current);
  }

  agentAudio(userId: string, callId: string, pcm: Buffer): void {
    const call = this.calls.get(callId);
    if (call?.agent?.user.id !== userId) return;
    call.humanSpoke = true;
    call.session.agentAudio(pcm);
  }

  /** The agent leaves; `end` also hangs up on the caller. */
  async leave(userId: string, callId: string, end: boolean): Promise<void> {
    const call = this.calls.get(callId);
    if (call?.agent?.user.id !== userId) return;
    if (end) return call.session.end('agent_ended');
    call.agent = undefined;
    call.session.agentLeft();
  }

  /** An agent's socket dropped: they leave every call they were on. */
  agentDisconnected(userId: string): void {
    for (const call of this.calls.values()) {
      if (call.agent?.user.id === userId) {
        call.agent = undefined;
        call.session.agentLeft();
      }
    }
  }

  /** Stores what the caller said and, while the AI owns the call, gets its answer. */
  private async callerSaid(call: LiveCall, text: string, language: string | null) {
    const received = await this.inbound.handle({
      channel: 'voice',
      threadKey: call.id,
      channelMessageId: `${call.id}:${++call.utterances}`,
      from: this.sessions.sender(call.chat),
      text,
      receivedAt: new Date().toISOString(),
      metadata: { callId: call.id, ...(language ? { spokenLanguage: language } : {}) },
    });
    if (!call.conversationId) {
      call.ticketId = received.ticketId;
      call.conversationId = received.conversationId;
      await this.records.attach(call.id, received.ticketId, received.conversationId);
    }

    const conv = await this.conversations.get(received.conversationId);
    if (conv.controller !== 'ai') {
      // Nobody answers by themselves: ask for a person once, and tell the caller.
      if (conv.controller === 'none' && !call.personAsked) {
        call.personAsked = true;
        await this.handover
          .requestHandover(SYSTEM_CTX, received.ticketId, {
            reason: 'A caller is waiting on a live voice call',
          })
          .catch((err: Error) => this.logger.warn(`handover for call ${call.id}: ${err.message}`));
        return { replies: [HOLD_LINE], language: 'en', handedOver: true } satisfies CallerTurn;
      }
      return { replies: [], language: null, handedOver: true } satisfies CallerTurn;
    }

    const decision = await this.turn(received.conversationId, received.messageId);
    const after = await this.conversations.transcript(received.conversationId, 12);
    const from = after.findIndex((m) => m.id === received.messageId);
    const replies = after
      .slice(from + 1)
      .filter((m) => m.authorType === 'ai' && m.deliveryStatus === 'sent')
      .map((m) => m.body);
    const handedOver = decision === 'handover' || decision === 'error';
    if (handedOver) call.personAsked = true;
    return {
      replies,
      language: (await this.conversations.get(received.conversationId)).language,
      handedOver,
    } satisfies CallerTurn;
  }

  /** One AI turn, waiting briefly if a turn for the same conversation is still finishing. */
  private async turn(conversationId: string, messageId: string) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.ai.runTurn(conversationId, messageId);
      } catch (err) {
        if (!(err instanceof ConversationBusyError) || attempt >= 5) throw err;
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
    }
  }

  private async agentSaid(call: LiveCall, text: string): Promise<void> {
    if (!call.conversationId || !call.agent) return;
    const { user } = call.agent;
    await this.outbound.agentSpoke(
      { actor: { type: 'user', id: user.id }, user },
      call.conversationId,
      text,
    );
  }
}
