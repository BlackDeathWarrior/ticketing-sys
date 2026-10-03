import { Module } from '@nestjs/common';
import { CustomersModule } from '../../customers/customers.module';
import { KbModule } from '../../kb/kb.module';
import { ToolsModule } from '../../tools/tools.module';
import { ChannelsModule } from '../channels.module';
import { PhoneCallQueue } from './phone-call.queue';
import { PhoneHookGuard } from './phone-hook.guard';
import { PhoneHooksController } from './phone-hooks.controller';
import { PhoneToolsService } from './phone-tools.service';

/**
 * Phone calls on a number rented from Sarvam (ADR 0039): the routes Sarvam's
 * phone agent calls, in the API process. The job that writes the ticket after
 * a call (`PhoneCallWorker`, `PhoneCallCloser`) runs in the worker.
 */
@Module({
  imports: [ChannelsModule, ToolsModule, KbModule, CustomersModule],
  controllers: [PhoneHooksController],
  providers: [PhoneToolsService, PhoneHookGuard, PhoneCallQueue],
})
export class PhoneModule {}
