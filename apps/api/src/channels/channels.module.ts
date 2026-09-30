import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { ChannelsController } from './channels.controller';
import { InboundService } from './inbound.service';
import { OutboundService } from './outbound.service';

/** Channel-agnostic intake (InboundService) and agent replies (OutboundService). */
@Module({
  imports: [ConversationsModule, CustomersModule, TicketsModule, WorkflowModule],
  controllers: [ChannelsController],
  providers: [InboundService, OutboundService],
  exports: [InboundService, OutboundService, ConversationsModule],
})
export class ChannelsModule {}
