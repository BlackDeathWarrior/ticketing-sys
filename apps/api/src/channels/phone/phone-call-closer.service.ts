import { Injectable, Logger } from '@nestjs/common';
import type { MessageEnvelope } from '@tms/shared';
import { AiAutoResolveService } from '../../ai/ai-auto-resolve';
import { AI_CTX, SYSTEM_CTX } from '../../common/request-context';
import { HandoverService } from '../../handover/handover.service';
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
  ) {}

  async close(interactionId: string, hint: PhoneCallHint): Promise<'closed' | 'empty' | 'already'> {
    const known = await this.calls.byProvider(interactionId);
    if (known?.status === 'ended') return 'already';

    // Sarvam is asked before anything is written: the trigger carries no proof, and an id
    // Sarvam does not know must leave nothing behind.
    const transcript = await this.sarvam.transcript(interactionId);
    if (!transcript) throw new Error('Sarvam has no transcript for this call (yet)');
    // No hook reached us during the call (the agent used no tool): the record starts here.
    const call = known ?? (await this.calls.beginPhone({ interactionId, phone: hint.phone }));
    const seconds =
      hint.seconds ??
      transcript.seconds ??
      Math.round((Date.now() - call.startedAt.getTime()) / 1000);
    const finish = (answeredBy: 'ai' | null) =>
      this.calls.finish(call.id, {
        reason: 'provider_ended',
        seconds,
        language: transcript.language,
        answeredBy,
        recording: null,
      });

    if (!transcript.turns.some((t) => t.role === 'caller')) {
      // Nobody said anything: like a browser call that never spoke, it leaves no ticket.
      await finish(null);
      return 'empty';
    }

    // A caller whose number the network withheld is still one person for this call.
    const from: MessageEnvelope['from'] = call.callerPhone
      ? { identity: { type: 'phone', value: call.callerPhone } }
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
}
