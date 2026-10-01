import { Module } from '@nestjs/common';
import { CsatModule } from '../csat/csat.module';
import { IntegrationApiModule } from '../integration-api/integration-api.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ToolsModule } from '../tools/tools.module';
import { UsersModule } from '../users/users.module';
import { WebhookPayloadService } from './webhook-payload.service';
import { WebhookSender } from './webhook-sender';
import { WebhooksController } from './webhooks.controller';
import { WebhooksService } from './webhooks.service';

/**
 * Outbound webhooks to integrations (ADR 0025). The worker adds
 * WebhookDispatchHandler and WebhookDeliveryWorker (worker.module.ts).
 */
@Module({
  imports: [
    IntegrationsModule,
    IntegrationApiModule,
    CsatModule,
    ToolsModule,
    NotificationsModule,
    UsersModule,
  ],
  controllers: [WebhooksController],
  providers: [WebhooksService, WebhookSender, WebhookPayloadService],
  exports: [WebhooksService, WebhookSender, WebhookPayloadService],
})
export class WebhooksModule {}
