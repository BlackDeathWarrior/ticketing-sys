import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { CustomersModule } from '../customers/customers.module';
import { KbModule } from '../kb/kb.module';
import { LlmModule } from '../llm/llm.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import { HandoverModule } from '../handover/handover.module';
import { LearningModule } from '../learning/learning.module';
import { ToolsModule } from '../tools/tools.module';
import { AiAgentService } from './ai-agent.service';
import { AiAutoResolveService } from './ai-auto-resolve';
import { AiClassifierService } from './ai-classifier.service';
import { AiCopilotService } from './ai-copilot.service';
import { AiRunsModule } from './ai-runs.module';
import { AiController } from './ai.controller';
import { LanguageService } from './language.service';

/**
 * The AI agent (ADR 0011): turns, classification, run records, settings and
 * the dry-run endpoint. The queue and dispatch handler live in the worker
 * (worker.module.ts).
 */
@Module({
  imports: [
    LlmModule,
    KbModule,
    ChannelsModule,
    TicketsModule,
    CustomersModule,
    OrgModule,
    ToolsModule,
    AiRunsModule,
    HandoverModule,
    LearningModule,
  ],
  controllers: [AiController],
  providers: [
    AiAgentService,
    AiClassifierService,
    AiCopilotService,
    LanguageService,
    AiAutoResolveService,
  ],
  exports: [AiAgentService, AiClassifierService, AiRunsModule, AiAutoResolveService],
})
export class AiModule {}
