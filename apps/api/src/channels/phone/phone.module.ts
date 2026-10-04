import { Module } from '@nestjs/common';
import { CustomersModule } from '../../customers/customers.module';
import { KbModule } from '../../kb/kb.module';
import { LlmModule } from '../../llm/llm.module';
import { TicketsModule } from '../../tickets/tickets.module';
import { ToolsModule } from '../../tools/tools.module';
import { ChannelsModule } from '../channels.module';
import { ElevenLabsHookGuard } from './elevenlabs/elevenlabs-hook.guard';
import { ElevenLabsHooksController } from './elevenlabs/elevenlabs-hooks.controller';
import { ElevenLabsSettingsController } from './elevenlabs/elevenlabs-settings.controller';
import { ElevenLabsSyncQueue } from './elevenlabs/elevenlabs-sync.queue';
import { PhoneCallQueue } from './phone-call.queue';
import { PhoneCallsController } from './phone-calls.controller';
import { PhoneHookGuard } from './phone-hook.guard';
import { PhoneEmailLink } from './phone-email-link.service';
import { PhoneHooksController } from './phone-hooks.controller';
import { PhoneOutboundModule } from './phone-outbound.module';
import { PhoneQueryTranslator } from './phone-query-translator.service';
import { PhoneToolsService } from './phone-tools.service';

/**
 * Phone calls answered by a hosted voice agent (ADR 0039, ADR 0040): the routes Sarvam's
 * and ElevenLabs' phone agents call, in the API process. The job that writes the ticket after
 * a call (`PhoneCallWorker`, `PhoneCallCloser`) runs in the worker.
 */
@Module({
  imports: [
    ChannelsModule,
    ToolsModule,
    KbModule,
    CustomersModule,
    TicketsModule,
    LlmModule,
    PhoneOutboundModule,
  ],
  controllers: [
    PhoneHooksController,
    PhoneCallsController,
    ElevenLabsHooksController,
    ElevenLabsSettingsController,
  ],
  providers: [
    PhoneToolsService,
    PhoneEmailLink,
    PhoneHookGuard,
    ElevenLabsHookGuard,
    ElevenLabsSyncQueue,
    PhoneCallQueue,
    PhoneQueryTranslator,
  ],
})
export class PhoneModule {}
