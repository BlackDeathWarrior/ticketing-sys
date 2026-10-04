import { Injectable, Logger } from '@nestjs/common';
import {
  internationalCallerNumber,
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
    const from = await this.ready(outboundProvider);
    if (from === null) return { refused: 'phone_off' };
    // A number kept without its country code is in the country of the number we call from.
    const phone = internationalCallerNumber(await this.customers.phoneOf(i.customerId), from);
    if (!phone || phone.length < 11) return { refused: 'no_number' };
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

  /**
   * Worker: hands the call to the provider. The call is taken first, so it is dialled at most
   * once: a refusal or a failure ends it with the reason, and nothing is tried again by
   * itself. A person can ask for the call again.
   */
  async place(callId: string): Promise<void> {
    const call = await this.calls.claimForPlacing(callId);
    if (!call?.callerPhone || !call.provider) return;
    try {
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
      if (!(await this.calls.placedAs(call.id, ids))) {
        // Another record already carries this call (a hook reached us first): that one
        // becomes the ticket, this one only says the call was made.
        await this.calls.endOutbound(call.id, 'connected');
      }
    } catch (err) {
      await this.notConnected(call, 'failed', (err as Error).message);
    }
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
        // A provider's refusal can quote the number it was given: never onto the ticket.
        `Phone call to the customer (${provider}): ${OUTCOME_WORDS[outcome]}.${why ? ` ${why.replace(/\d{7,}/g, '…').slice(0, 300)}` : ''}`,
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
   * `known` is false for an attempt that is not ours; `close` is the call to close, if any.
   */
  async sarvamResult(
    attemptId: string,
    status: string | undefined,
    interactionId: string | null,
  ): Promise<{ known: boolean; close: string | null }> {
    const call = await this.calls.byAttempt(attemptId);
    if (!call) return { known: false, close: null };
    if (call.status === 'ended') return { known: true, close: null };
    // The agent's tools already tied this record to a call: whatever the report says, that
    // call has a transcript to write, so it is closed like any other.
    if (call.providerCallId) return { known: true, close: call.providerCallId };
    if (status === 'connected' && interactionId) {
      if (!(await this.calls.linkProviderCall(call.id, interactionId))) {
        // Another record holds the id (a tool reached us without the customer's number):
        // that one becomes the ticket, this one only says the call went through.
        await this.calls.endOutbound(call.id, 'connected');
      }
      return { known: true, close: interactionId };
    }
    await this.notConnected(call, status === 'no_answer' || status === 'busy' ? status : 'failed');
    return { known: true, close: null };
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

  /**
   * The number calls are placed from, when the provider that places them is switched on and
   * has what a call needs; null when it does not.
   */
  private async ready(provider: PhoneProviderId): Promise<string | null> {
    if (provider === 'sarvam') {
      const c = await this.channels.phone();
      return c?.enabled && c.apiKey ? c.agentPhoneNumber : null;
    }
    const c = await this.channels.elevenlabs();
    const sync = await this.channels.elevenlabsSync();
    // A number that reaches ElevenLabs some other way cannot place calls yet.
    const canDial = sync?.agentNumberKind === 'twilio' || sync?.agentNumberKind === 'sip_trunk';
    return c?.enabled && c.apiKey && c.phoneNumberId && sync?.agentId && canDial
      ? (sync.agentNumber ?? '')
      : null;
  }
}
