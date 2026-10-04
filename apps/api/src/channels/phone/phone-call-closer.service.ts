import { Injectable, Logger } from '@nestjs/common';
import { internationalCallerNumber, type MessageEnvelope } from '@tms/shared';
import { AiAutoResolveService } from '../../ai/ai-auto-resolve';
import { AI_CTX, SYSTEM_CTX } from '../../common/request-context';
import { HandoverService } from '../../handover/handover.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { ToolGatewayService } from '../../tools/tool-gateway.service';
import { InboundService } from '../inbound.service';
import { OutboundService } from '../outbound.service';
import { VoiceCallsService } from '../voice/voice-calls.service';
import { SarvamAgentsClient } from './sarvam-agents.client';

/** What the "ended" trigger said about the call. Hints only: nothing here is trusted as content. */
export interface PhoneCallHint {
  phone: string | null;
  seconds: number | null;
}

/**
 * Writes a phone call onto a ticket once it is over (ADR 0039): the
 * transcript from Sarvam, turn by turn, through the same intake as every
 * channel; then either a handover (the phone agent asked for a person) or a
 * ticket the AI resolved. Safe to run again: turns already written are
 * counted on the call's record and never repeated.
 */
@Injectable()
export class PhoneCallCloser {
  private readonly logger = new Logger(PhoneCallCloser.name);

  constructor(
    private readonly calls: VoiceCallsService,
    private readonly sarvam: SarvamAgentsClient,
    private readonly inbound: InboundService,
    private readonly outbound: OutboundService,
    private readonly gateway: ToolGatewayService,
    private readonly handover: HandoverService,
    private readonly autoResolve: AiAutoResolveService,
    private readonly channels: ChannelConfigService,
  ) {}

  /**
   * `waitForRecording`: the recording is not ready yet, so fail and let the job try once
   * more before writing the ticket without it. `recordingFollowUp`: the ticket is written
   * and this run is only for the recording, so fail while Sarvam still has none.
   */
  async close(
    interactionId: string,
    hint: PhoneCallHint,
    opts: { waitForRecording?: boolean; recordingFollowUp?: boolean } = {},
  ): Promise<'closed' | 'empty' | 'already'> {
    const known = await this.calls.byProvider(interactionId);
    if (known?.status === 'ended') {
      // Closed without its recording (Sarvam had none yet): a later run brings it.
      if (!known.recordingKey && !known.recordingDeletedAt && known.ticketId) {
        const late = await this.recording(interactionId);
        if (late) await this.calls.attachRecording(known.id, late);
        else if (opts.recordingFollowUp) throw new Error('Sarvam has no recording yet');
      }
      return 'already';
    }

    // Sarvam is asked before anything is written: the trigger carries no proof, and an id
    // Sarvam does not know must leave nothing behind.
    const transcript = await this.sarvam.transcript(interactionId);
    if (!transcript) {
      throw new Error(
        'Sarvam answered 404 for the transcript: not ready yet, or the ids in Settings are not this agent’s',
      );
    }
    // No hook reached us during the call (the agent used no tool): the record starts here.
    // The trigger's number is never stored on it: only token-protected hooks set that.
    const call = known ?? (await this.calls.beginPhone({ provider: 'sarvam', interactionId, phone: null }));
    const seconds =
      hint.seconds ??
      transcript.seconds ??
      Math.round((Date.now() - call.startedAt.getTime()) / 1000);
    const spoken = transcript.turns.some((t) => t.role === 'caller');
    // Kept like a browser call's recording: stored with the call, played only by people who
    // may, deleted after 30 days. A call nobody spoke on keeps none.
    const recording = spoken ? await this.recording(interactionId) : null;
    if (spoken && !recording && opts.waitForRecording) {
      throw new Error('Sarvam has no recording for this call yet');
    }
    const finish = (answeredBy: 'ai' | null) =>
      this.calls.finish(call.id, {
        reason: 'provider_ended',
        seconds,
        language: transcript.language,
        answeredBy,
        recording,
      });

    if (!spoken) {
      // The agent used a tool or asked for a person, so somebody spoke: the transcript is
      // not complete yet. Try again rather than lose the call.
      if (call.toolCallIds.length || call.handoverReason) {
        throw new Error('The transcript has no caller speech yet, but the call was not silent');
      }
      // Nobody said anything: like a browser call that never spoke, it leaves no ticket.
      await finish(null);
      return 'empty';
    }

    // Who the ticket is filed under. With no hook during the call, the trigger's number is
    // all there is: it files the ticket, and is never used to run a tool. A caller whose
    // number the network withheld is still one person for this call.
    const agentNumber = (await this.channels.phone())?.agentPhoneNumber ?? '';
    const phone = call.callerPhone ?? internationalCallerNumber(hint.phone, agentNumber);
    const from: MessageEnvelope['from'] = phone
      ? { identity: { type: 'phone', value: phone } }
      : { identity: { type: 'external_id', value: `sarvam-call:${interactionId}` } };
    let ticketId = call.ticketId;
    let conversationId = call.conversationId;
    for (let i = call.importedTurns; i < transcript.turns.length; i++) {
      const turn = transcript.turns[i]!;
      if (turn.role === 'caller') {
        const received = await this.inbound.handle({
          channel: 'voice',
          threadKey: call.id,
          channelMessageId: `${call.id}:${i}`,
          from,
          text: turn.text,
          receivedAt: new Date().toISOString(),
          metadata: { callId: call.id, transport: 'phone' },
        });
        if (!conversationId) {
          ticketId = received.ticketId;
          conversationId = received.conversationId;
          await this.calls.attach(call.id, ticketId, conversationId);
        }
      } else if (conversationId) {
        // What the agent said before the caller spoke (its greeting) has no ticket to go on.
        await this.outbound.aiReply(AI_CTX, conversationId, turn.text, {
          draft: false,
          metadata: { spokenBy: 'sarvam_agent' },
        });
      }
      await this.calls.importedUpTo(call.id, i + 1);
    }

    if (ticketId && conversationId) {
      await this.gateway.linkCalls(call.toolCallIds, ticketId, conversationId);
      if (call.handoverReason) {
        await this.handover.requestHandover(SYSTEM_CTX, ticketId, {
          reason:
            call.handoverReason.length >= 3 ? call.handoverReason : 'The caller asked for a person',
          source: 'ai',
        });
      } else if (!(await this.autoResolve.callEnded({ ticketId, conversationId }))) {
        // The AI does not own voice tickets here (its mode is off): the ticket waits in the queue.
        this.logger.log(`call ${call.id}: ticket left open for a person`);
      }
    }
    await finish('ai');
    return 'closed';
  }

  /** The call's audio from Sarvam; a failure to fetch it never costs the ticket. */
  private async recording(interactionId: string): Promise<Buffer | null> {
    return this.sarvam.recording(interactionId).catch((err: Error) => {
      this.logger.warn(`recording of a phone call was not fetched: ${err.message}`);
      return null;
    });
  }
}
