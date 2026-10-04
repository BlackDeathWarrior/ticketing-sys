import { Global, Module } from '@nestjs/common';
import { APPROVAL_CALL_BACK } from '../../ai/approval-call-back';
import { CustomersModule } from '../../customers/customers.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { ChannelsModule } from '../channels.module';
import { ElevenLabsClient } from './elevenlabs/elevenlabs.client';
import { ElevenLabsProvider } from './elevenlabs/elevenlabs.provider';
import { PhoneApprovalCallBack } from './phone-approval-call-back';
import { PhoneOutboundService } from './phone-outbound.service';
import { PhoneProviders } from './phone-providers';
import { SarvamProvider } from './sarvam.provider';
import { SarvamAgentsClient } from './sarvam-agents.client';

/**
 * The phone agent providers and the engine that places calls (ADR 0040), for the API and
 * the worker alike. Global, so that the AI's follow-up of an approval can find the call
 * back without the AI module knowing about phone calls.
 */
@Global()
@Module({
  imports: [ChannelsModule, CustomersModule, TicketsModule],
  providers: [
    SarvamAgentsClient,
    SarvamProvider,
    ElevenLabsClient,
    ElevenLabsProvider,
    PhoneProviders,
    PhoneOutboundService,
    PhoneApprovalCallBack,
    { provide: APPROVAL_CALL_BACK, useExisting: PhoneApprovalCallBack },
  ],
  exports: [
    SarvamAgentsClient,
    ElevenLabsClient,
    PhoneProviders,
    PhoneOutboundService,
    APPROVAL_CALL_BACK,
  ],
})
export class PhoneOutboundModule {}
