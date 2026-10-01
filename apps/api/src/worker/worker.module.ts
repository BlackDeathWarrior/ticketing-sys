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
import { EmailSender } from '../delivery/email.sender';
import { CHANNEL_SENDERS } from '../delivery/senders';
import { WebchatSender } from '../delivery/webchat.sender';
import { WhatsAppSender } from '../delivery/whatsapp.sender';
import { ChannelHealthMonitor } from '../channels/health/channel-health.monitor';
import { VoiceRetentionWorker } from '../channels/voice/voice.module';
import { WhatsAppWebhookWorker } from '../channels/whatsapp/whatsapp-webhook.queue';
import { InfraModule } from '../infra/infra.module';
import { KbIndexerService } from '../kb/kb-indexer.service';
import { KbIngestHandler, KbIngestWorker } from '../kb/kb-ingest.worker';
import { KbModule } from '../kb/kb.module';
import { LlmModule } from '../llm/llm.module';
import { loggerModule } from '../logging';
import { emitterProvider } from '../realtime/emitter.provider';
import { RealtimeFanoutHandler } from '../realtime/realtime-fanout.handler';
import { SettingsChangedHandler } from '../settings/settings-changed.handler';
import { SettingsModule } from '../settings/settings.module';
import { StorageModule } from '../storage/storage.module';
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
  ],
  providers: [
    emitterProvider,
    OutboxRelayService,
    HeartbeatService,
    WebchatSender,
    EmailSender,
    WhatsAppSender,
    WhatsAppWebhookWorker,
    ChannelHealthMonitor,
    VoiceRetentionWorker,
    {
      provide: CHANNEL_SENDERS,
      inject: [WebchatSender, EmailSender, WhatsAppSender],
      useFactory: (...senders: unknown[]) => senders,
    },
    DeliveryHandler,
    RealtimeFanoutHandler,
    SettingsChangedHandler,
    KbIndexerService,
    KbIngestWorker,
    KbIngestHandler,
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
    {
      provide: DOMAIN_EVENT_HANDLERS,
      inject: [
        RealtimeFanoutHandler,
        DeliveryHandler,
        SettingsChangedHandler,
        KbIngestHandler,
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
      ],
      useFactory: (...handlers: unknown[]) => handlers,
    },
    DomainEventsConsumer,
    EmailPollerService,
  ],
})
export class WorkerModule {}
