import { Module } from '@nestjs/common';
import { CustomersModule } from '../../customers/customers.module';
import { KbModule } from '../../kb/kb.module';
import { LlmModule } from '../../llm/llm.module';
import { ToolsModule } from '../../tools/tools.module';
import { ChannelsModule } from '../channels.module';
import { ElevenLabsHookGuard } from './elevenlabs/elevenlabs-hook.guard';
import { ElevenLabsHooksController } from './elevenlabs/elevenlabs-hooks.controller';
import { PhoneCallQueue } from './phone-call.queue';
import { PhoneHookGuard } from './phone-hook.guard';
import { PhoneHooksController } from './phone-hooks.controller';
import { PhoneQueryTranslator } from './phone-query-translator.service';
import { PhoneToolsService } from './phone-tools.service';

/**
 * Phone calls answered by a hosted voice agent (ADR 0039, ADR 0040): the routes Sarvam's
 * and ElevenLabs' phone agents call, in the API process. The job that writes the ticket after
 * a call (`PhoneCallWorker`, `PhoneCallCloser`) runs in the worker.
 */
@Module({
  imports: [ChannelsModule, ToolsModule, KbModule, CustomersModule, LlmModule],
  controllers: [PhoneHooksController, ElevenLabsHooksController],
  providers: [
    PhoneToolsService,
    PhoneHookGuard,
    ElevenLabsHookGuard,
    PhoneCallQueue,
    PhoneQueryTranslator,
  ],
})
export class PhoneModule {}
