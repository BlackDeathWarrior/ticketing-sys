import { Injectable, Logger } from '@nestjs/common';
import {
  type OutboundRefusal,
  PHONE_PROVIDER_NAMES,
  type PhoneCallOutcome,
  type PhoneCallPurpose,
  type PhoneProviderId,
} from '@tms/shared';
import { addressOf } from '../../ai/address';
import { type RequestCtx, SYSTEM_CTX } from '../../common/request-context';
import { CustomersService } from '../../customers/customers.service';
import { BrandingService } from '../../settings/branding.service';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { TicketsService } from '../../tickets/tickets.service';
import { type CallRow, VoiceCallsService } from '../voice/voice-calls.service';
import { withinCallingHours } from './calling-hours';
import { PhoneProviders } from './phone-providers';

const OUTCOME_WORDS: Record<Exclude<PhoneCallOutcome, 'connected'>, string> = {
  no_answer: 'nobody answered',
  busy: 'the line was busy',
  failed: 'the call could not be placed',
};

/**
 * Calls this desk places (ADR 0040): from a ticket, for a shopper who asked to
 * be rung, or with an approval's outcome. This is the only way one starts. A
 * request only writes the call's record; the worker places the call through
 * the provider chosen in Settings, and the provider tells us how it went.
 */
@Injectable()
export class PhoneOutboundService {
  private readonly logger = new Logger(PhoneOutboundService.name);

  constructor(
    private readonly channels: ChannelConfigService,
    private readonly customers: CustomersService,
    private readonly calls: VoiceCallsService,
    private readonly providers: PhoneProviders,
    private readonly tickets: TicketsService,
    private readonly branding: BrandingService,
  ) {}

  async request(
    ctx: RequestCtx,
    i: {
      customerId: string;
      ticketId: string | null;
      purpose: PhoneCallPurpose;
      /** A staff user's id, `customer` or `system`. */
      requestedBy: string;
      about: string | null;
    },
  ): Promise<{ callId: string } | { refused: OutboundRefusal }> {
    const { outboundProvider, callingHours } = await this.channels.calls();
    if (!(await this.ready(outboundProvider))) return { refused: 'phone_off' };
    const phone = await this.customers.phoneOf(i.customerId);
    if (!phone) return { refused: 'no_number' };
    if (callingHours && !withinCallingHours(new Date())) return { refused: 'outside_hours' };
    if (await this.calls.outboundInProgress(phone)) return { refused: 'call_in_progress' };
    const call = await this.calls.requestOutbound(ctx, {
      provider: outboundProvider,
      phone,
      customerId: i.customerId,
      ticketId: i.ticketId,
      purpose: i.purpose,
      requestedBy: i.requestedBy,
      about: i.about?.trim() || null,
    });
    return { callId: call.id };
  }

  /** Worker: hands the call to the provider. Throws when the provider refuses, so the job retries. */
  async place(callId: string): Promise<void> {
    const call = await this.calls.get(callId);
    if (call.status !== 'requested' || !call.callerPhone || !call.provider) return;
    const contact = call.customerId ? await this.customers.contactOf(call.customerId) : null;
    const name = contact ? (addressOf(contact.name, null)?.short ?? '') : '';
    const { companyName } = await this.branding.get();
    const reference = call.ticketId
      ? await this.tickets
          .get(call.ticketId)
          .then((t) => t.reference)
          .catch(() => '')
      : '';
    const ids = await this.providers.get(call.provider as PhoneProviderId).placeCall({
      to: `+${call.callerPhone}`,
      variables: {
        customer_name: name,
        company: companyName,
        about: call.about ?? '',
        ticket_reference: reference,
        direction: 'outbound',
        greeting: name
          ? `Hello ${name}, this is the assistant of ${companyName} calling.`
          : `Hello, this is the assistant of ${companyName} calling.`,
      },
    });
    await this.calls.placed(call.id, ids);
  }

  /** The call ended without anyone speaking to the customer: on record, and on the ticket. */
  async notConnected(call: CallRow, outcome: Exclude<PhoneCallOutcome, 'connected'>, why = '') {
    if (!(await this.calls.endOutbound(call.id, outcome))) return;
    if (!call.ticketId) return;
    const provider = PHONE_PROVIDER_NAMES[(call.provider as PhoneProviderId) ?? 'sarvam'];
    await this.tickets
      .addNote(
        SYSTEM_CTX,
        call.ticketId,
        `Phone call to the customer (${provider}): ${OUTCOME_WORDS[outcome]}.${why ? ` ${why.slice(0, 300)}` : ''}`,
      )
      .catch((err: Error) => this.logger.warn(`note for call ${call.id} failed: ${err.message}`));
  }

  /** Worker: a call that could not be handed to the provider after every try. */
  async failed(callId: string, why: string): Promise<void> {
    const call = await this.calls.get(callId).catch(() => null);
    if (call) await this.notConnected(call, 'failed', why);
  }

  /**
   * Sarvam's report on a call we placed. It carries no proof, so it is only believed for an
   * attempt this desk started, and a connected call is still read from Sarvam with our key.
   * Returns the id of the call to close when it connected.
   */
  async sarvamResult(
    attemptId: string,
    status: string | undefined,
    interactionId: string | null,
  ): Promise<string | null> {
    const call = await this.calls.byAttempt(attemptId);
    if (!call || call.status === 'ended') return null;
    if (status === 'connected' && interactionId) {
      // The agent's tools may already have tied the call to this id.
      const mine =
        call.providerCallId ?? (await this.calls.linkProviderCall(call.id, interactionId));
      if (!mine) {
        // Another record holds the id (a tool reached us without the customer's number):
        // that one becomes the ticket, this one only says the call went through.
        await this.calls.endOutbound(call.id, 'connected');
      }
      return interactionId;
    }
    await this.notConnected(call, status === 'no_answer' || status === 'busy' ? status : 'failed');
    return null;
  }

  /** ElevenLabs' signed report that a call we placed never connected. */
  async elevenlabsFailed(conversationId: string, reason: string | undefined): Promise<void> {
    const call = await this.calls.byProvider(conversationId);
    if (!call || call.direction !== 'outbound' || call.status === 'ended') return;
    await this.notConnected(
      call,
      reason === 'busy' ? 'busy' : reason === 'no-answer' ? 'no_answer' : 'failed',
    );
  }

  /** Whether the provider that places calls is switched on and has what a call needs. */
  private async ready(provider: PhoneProviderId): Promise<boolean> {
    if (provider === 'sarvam') {
      const c = await this.channels.phone();
      return !!(c?.enabled && c.apiKey);
    }
    const c = await this.channels.elevenlabs();
    const sync = await this.channels.elevenlabsSync();
    return !!(c?.enabled && c.apiKey && c.phoneNumberId && sync?.agentId);
  }
}
