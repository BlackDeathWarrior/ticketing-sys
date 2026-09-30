import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { ChannelsModule } from './channels/channels.module';
import { ChatModule } from './chat/chat.module';
import { AllExceptionsFilter } from './common/exception.filter';
import { loadEnv } from './config/env';
import { CustomersModule } from './customers/customers.module';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { loggerModule } from './logging';
import { OrgModule } from './org/org.module';
import { RealtimeModule } from './realtime/realtime.module';
import { StorageModule } from './storage/storage.module';
import { TicketsModule } from './tickets/tickets.module';
import { UsersModule } from './users/users.module';
import { WorkflowModule } from './workflow/workflow.module';

const env = loadEnv();

@Module({
  imports: [
    loggerModule(env, 'api'),
    InfraModule,
    AuditModule,
    StorageModule,
    UsersModule,
    AuthModule,
    WorkflowModule,
    OrgModule,
    CustomersModule,
    TicketsModule,
    ChannelsModule,
    RealtimeModule,
    ChatModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
