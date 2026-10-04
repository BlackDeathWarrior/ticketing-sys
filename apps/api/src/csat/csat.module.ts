import { Module } from '@nestjs/common';
import { AiRunsModule } from '../ai/ai-runs.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { CsatController, PublicCsatController } from './csat.controller';
import { CsatService } from './csat.service';

/**
 * Customer ratings (ADR 0019). The worker adds CsatHandler, which asks for a
 * rating when a ticket is resolved (worker.module.ts).
 */
@Module({
  imports: [TicketsModule, WorkflowModule, ConversationsModule, AiRunsModule],
  controllers: [PublicCsatController, CsatController],
  providers: [CsatService],
  exports: [CsatService],
})
export class CsatModule {}
