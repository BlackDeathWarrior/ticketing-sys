import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * Agent notifications (ADR 0014). The worker adds NotificationsHandler and
 * NotificationMailer (worker.module.ts).
 */
@Module({
  imports: [TicketsModule, UsersModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
