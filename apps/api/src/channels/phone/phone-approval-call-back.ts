import { Injectable } from '@nestjs/common';
import { OUTBOUND_REFUSAL_TEXT } from '@tms/shared';
import type { ApprovalCallBack } from '../../ai/approval-call-back';
import { SYSTEM_CTX } from '../../common/request-context';
import { TicketsService } from '../../tickets/tickets.service';
import { VoiceCallsService } from '../voice/voice-calls.service';
import { PhoneOutboundService } from './phone-outbound.service';

/** What the phone agent is given to say on a call back; an outcome and a reason fit well inside it. */
const SAID_MAX = 600;

/**
 * An approval asked for on a phone call is answered by a call back (ADR 0040): the phone
 * agent rings the customer and says the outcome and the team's reason.
 */
@Injectable()
export class PhoneApprovalCallBack implements ApprovalCallBack {
  constructor(
    private readonly outbound: PhoneOutboundService,
    private readonly calls: VoiceCallsService,
    private readonly tickets: TicketsService,
  ) {}

  async ring(i: { ticketId: string; conversationId: string; said: string }) {
    // A call in the browser is answered there, by the AI's own follow-up.
    if (!(await this.calls.isPhoneConversation(i.conversationId))) return null;
    const ticket = await this.tickets.get(i.ticketId);
    const result = await this.outbound.request(SYSTEM_CTX, {
      customerId: ticket.customerId,
      ticketId: ticket.id,
      purpose: 'approval',
      requestedBy: 'system',
      about: i.said.slice(0, SAID_MAX),
    });
    return 'refused' in result
      ? ({ asked: false, why: OUTBOUND_REFUSAL_TEXT[result.refused] } as const)
      : ({ asked: true } as const);
  }
}
