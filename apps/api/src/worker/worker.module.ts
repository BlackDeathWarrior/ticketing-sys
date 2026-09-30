import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ChannelsModule } from '../channels/channels.module';
import { EmailPollerService } from '../channels/email/email-poller.service';
import { loadEnv } from '../config/env';
import { ConversationsModule } from '../conversations/conversations.module';
import { DeliveryHandler } from '../delivery/delivery.handler';
import { EmailSender } from '../delivery/email.sender';
import { CHANNEL_SENDERS } from '../delivery/senders';
import { WebchatSender } from '../delivery/webchat.sender';
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
  ],
  providers: [
    emitterProvider,
    OutboxRelayService,
    HeartbeatService,
    WebchatSender,
    EmailSender,
    {
      provide: CHANNEL_SENDERS,
      inject: [WebchatSender, EmailSender],
      useFactory: (...senders: unknown[]) => senders,
    },
    DeliveryHandler,
    RealtimeFanoutHandler,
    SettingsChangedHandler,
    KbIndexerService,
    KbIngestWorker,
    KbIngestHandler,
    {
      provide: DOMAIN_EVENT_HANDLERS,
      inject: [RealtimeFanoutHandler, DeliveryHandler, SettingsChangedHandler, KbIngestHandler],
      useFactory: (...handlers: unknown[]) => handlers,
    },
    DomainEventsConsumer,
    EmailPollerService,
  ],
})
export class WorkerModule {}
