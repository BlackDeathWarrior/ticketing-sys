import { Module } from '@nestjs/common';
import { AiAutoResolveWorker } from '../ai/ai-auto-resolve';
import { AiDispatchHandler, AiWorker } from '../ai/ai.worker';
import { AiModule } from '../ai/ai.module';
import { AuditModule } from '../audit/audit.module';
import { ChannelsModule } from '../channels/channels.module';
import { EmailPollerService } from '../channels/email/email-poller.service';
import { loadEnv } from '../config/env';
import { ConversationsModule } from '../conversations/conversations.module';
import { CsatHandler } from '../csat/csat.handler';
import { CsatModule } from '../csat/csat.module';
import { DeliveryHandler } from '../delivery/delivery.handler';
import { ApiSender } from '../delivery/api.sender';
import { EmailSender } from '../delivery/email.sender';
import { CHANNEL_SENDERS } from '../delivery/senders';
import { WebchatSender } from '../delivery/webchat.sender';
import { WhatsAppSender } from '../delivery/whatsapp.sender';
import { ChannelHealthMonitor } from '../channels/health/channel-health.monitor';
import { PhoneCallCloser } from '../channels/phone/phone-call-closer.service';
import { PhoneCallWorker } from '../channels/phone/phone-call.queue';
import { SarvamAgentsClient } from '../channels/phone/sarvam-agents.client';
import { WhatsAppWebhookWorker } from '../channels/whatsapp/whatsapp-webhook.queue';
import { InfraModule } from '../infra/infra.module';
import { KbIndexerService } from '../kb/kb-indexer.service';
import { KbIngestHandler, KbIngestWorker } from '../kb/kb-ingest.worker';
import { KbSyncHandler, KbSyncWorker } from '../kb/connectors/kb-sync.worker';
import { KbModule } from '../kb/kb.module';
import { LearningHandler, LearningModule } from '../learning/learning.module';
import { LlmModule } from '../llm/llm.module';
import { loggerModule } from '../logging';
import { emitterProvider } from '../realtime/emitter.provider';
import { RealtimeFanoutHandler } from '../realtime/realtime-fanout.handler';
import { SettingsChangedHandler } from '../settings/settings-changed.handler';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
import { SystemModule } from '../system/system.module';
import { RetentionWorker } from '../system/system.service';
import { TicketsModule } from '../tickets/tickets.module';
import { HandoverHandler, RoutingHandler } from '../handover/handover.handler';
import { HandoverModule } from '../handover/handover.module';
import { NotificationMailer, NotificationsHandler } from '../notifications/notifications.handler';
import { NotificationsModule } from '../notifications/notifications.module';
import { PortalMailHandler, PortalModule } from '../portal/portal.module';
import { RoutingModule } from '../routing/routing.module';
import { SlaModule } from '../sla/sla.module';
import { SlaHandler, SlaSweepWorker } from '../sla/sla.worker';
import { UsersModule } from '../users/users.module';
import { ApprovalExpiryWorker, ApprovalsHandler } from '../tools/approvals.worker';
import { ToolsModule } from '../tools/tools.module';
import { WebFormAckHandler } from '../web-form/web-form-ack.handler';
import { WebFormModule } from '../web-form/web-form.module';
import { WebhookDeliveryWorker, WebhookDispatchHandler } from '../webhooks/webhook-delivery.worker';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { DOMAIN_EVENT_HANDLERS } from './domain-events';
import { DomainEventsConsumer } from './domain-events.consumer';
import { HeartbeatService } from './heartbeat.service';
import { OutboxRelayService } from './outbox-relay.service';

const env = loadEnv();

/**
 * The background process: relays the outbox, runs domain-event handlers
 * (delivery, realtime fan-out; later SLA, notifications, AI) and reads the
 * support mailbox. It shares the API's domain modules but serves no HTTP.
 */
@Module({
  imports: [
    loggerModule(env, 'worker'),
    InfraModule,
    AuditModule,
    SettingsModule,
    StorageModule,
    TicketsModule,
    ConversationsModule,
    ChannelsModule,
    LlmModule,
    KbModule,
    AiModule,
    WebFormModule,
    ToolsModule,
    SlaModule,
    RoutingModule,
    NotificationsModule,
    HandoverModule,
    UsersModule,
    CsatModule,
    PortalModule,
    LearningModule,
    SystemModule,
    WebhooksModule,
  ],
  providers: [
    emitterProvider,
    OutboxRelayService,
    HeartbeatService,
    WebchatSender,
    EmailSender,
    WhatsAppSender,
    ApiSender,
    WhatsAppWebhookWorker,
    SarvamAgentsClient,
    PhoneCallCloser,
    PhoneCallWorker,
    ChannelHealthMonitor,
    RetentionWorker,
    {
      provide: CHANNEL_SENDERS,
      inject: [WebchatSender, EmailSender, WhatsAppSender, ApiSender],
      useFactory: (...senders: unknown[]) => senders,
    },
    DeliveryHandler,
    RealtimeFanoutHandler,
    SettingsChangedHandler,
    KbIndexerService,
    KbIngestWorker,
    KbIngestHandler,
    KbSyncWorker,
    KbSyncHandler,
    AiWorker,
    AiDispatchHandler,
    AiAutoResolveWorker,
    ApprovalExpiryWorker,
    ApprovalsHandler,
    SlaSweepWorker,
    SlaHandler,
    NotificationsHandler,
    NotificationMailer,
    HandoverHandler,
    RoutingHandler,
    CsatHandler,
    WebhookDeliveryWorker,
    WebhookDispatchHandler,
    {
      provide: DOMAIN_EVENT_HANDLERS,
      inject: [
        RealtimeFanoutHandler,
        DeliveryHandler,
        SettingsChangedHandler,
        KbIngestHandler,
        KbSyncHandler,
        AiDispatchHandler,
        WebFormAckHandler,
        ApprovalsHandler,
        SlaHandler,
        NotificationsHandler,
        NotificationMailer,
        HandoverHandler,
        RoutingHandler,
        CsatHandler,
        PortalMailHandler,
        LearningHandler,
        WebhookDispatchHandler,
      ],
      useFactory: (...handlers: unknown[]) => handlers,
    },
    DomainEventsConsumer,
    EmailPollerService,
  ],
})
export class WorkerModule {}
