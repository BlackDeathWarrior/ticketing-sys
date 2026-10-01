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
import { WhatsAppTemplatesService } from './whatsapp/whatsapp-templates.service';
import { WhatsAppWebhookQueue } from './whatsapp/whatsapp-webhook.queue';
import { WhatsAppController, WhatsAppWebhookController } from './whatsapp/whatsapp.controller';
import { WhatsAppService } from './whatsapp/whatsapp.service';

/**
 * Channel-agnostic intake (InboundService) and agent replies (OutboundService),
 * plus the WhatsApp Cloud API adapter (ADR 0015).
 */
@Module({
  imports: [ConversationsModule, CustomersModule, TicketsModule, WorkflowModule, LlmModule],
  controllers: [ChannelsController, WhatsAppWebhookController, WhatsAppController],
  providers: [
    InboundService,
    OutboundService,
    AiPolicyService,
    WhatsAppTemplatesService,
    WhatsAppService,
    WhatsAppWebhookQueue,
  ],
  exports: [
    InboundService,
    OutboundService,
    AiPolicyService,
    ConversationsModule,
    WhatsAppService,
    WhatsAppTemplatesService,
  ],
})
export class ChannelsModule {}
