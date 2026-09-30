import { Module } from '@nestjs/common';
import { AiRunsModule } from '../ai/ai-runs.module';
import { ChannelsModule } from '../channels/channels.module';
import { CustomersModule } from '../customers/customers.module';
import { LlmModule } from '../llm/llm.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ToolsModule } from '../tools/tools.module';
import { HandoverController } from './handover.controller';
import { HandoverService } from './handover.service';

/**
 * Take-over, hand-back, handovers and context packs (ADR 0014). The worker
 * adds HandoverHandler and RoutingHandler (worker.module.ts).
 */
@Module({
  imports: [ChannelsModule, TicketsModule, CustomersModule, LlmModule, AiRunsModule, ToolsModule],
  controllers: [HandoverController],
  providers: [HandoverService],
  exports: [HandoverService],
})
export class HandoverModule {}
