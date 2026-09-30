import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { CustomersModule } from '../customers/customers.module';
import { KbModule } from '../kb/kb.module';
import { LlmModule } from '../llm/llm.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import { AiAgentService } from './ai-agent.service';
import { AiClassifierService } from './ai-classifier.service';
import { AiRunsService } from './ai-runs.service';
import { AiController } from './ai.controller';
import { LanguageService } from './language.service';

/**
 * The AI agent (ADR 0011): turns, classification, run records, settings and
 * the dry-run endpoint. The queue and dispatch handler live in the worker
 * (worker.module.ts).
 */
@Module({
  imports: [LlmModule, KbModule, ChannelsModule, TicketsModule, CustomersModule, OrgModule],
  controllers: [AiController],
  providers: [AiAgentService, AiClassifierService, AiRunsService, LanguageService],
  exports: [AiAgentService, AiClassifierService, AiRunsService],
})
export class AiModule {}
