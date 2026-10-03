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
import { ChannelHealthService } from './health/channel-health.service';
import { VoiceCallsService } from './voice/voice-calls.service';
import { WhatsAppCodeSender } from './whatsapp/whatsapp-code.sender';
import { WhatsAppConnectService } from './whatsapp/whatsapp-connect.service';
import { WhatsAppLinkSender } from './whatsapp/whatsapp-link.sender';
import { WhatsAppTemplatesService } from './whatsapp/whatsapp-templates.service';
import { WhatsAppTypingService } from './whatsapp/whatsapp-typing.service';
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
    WhatsAppCodeSender,
    WhatsAppLinkSender,
    WhatsAppTypingService,
    WhatsAppService,
    WhatsAppWebhookQueue,
    WhatsAppConnectService,
    ChannelHealthService,
    VoiceCallsService,
  ],
  exports: [
    InboundService,
    OutboundService,
    AiPolicyService,
    ConversationsModule,
    WhatsAppService,
    WhatsAppTemplatesService,
    WhatsAppCodeSender,
    WhatsAppLinkSender,
    WhatsAppTypingService,
    ChannelHealthService,
    VoiceCallsService,
  ],
})
export class ChannelsModule {}
