import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { CustomersModule } from '../customers/customers.module';
import { LlmModule } from '../llm/llm.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { AiPolicyService } from './ai-policy.service';
import { ChannelsController } from './channels.controller';
import { InboundService } from './inbound.service';
import { OutboundService } from './outbound.service';

/** Channel-agnostic intake (InboundService) and agent replies (OutboundService). */
@Module({
  imports: [ConversationsModule, CustomersModule, TicketsModule, WorkflowModule, LlmModule],
  controllers: [ChannelsController],
  providers: [InboundService, OutboundService, AiPolicyService],
  exports: [InboundService, OutboundService, ConversationsModule],
})
export class ChannelsModule {}
