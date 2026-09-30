import { Module, RequestMethod } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { AllExceptionsFilter } from './common/exception.filter';
import { loadEnv } from './config/env';
import { CustomersModule } from './customers/customers.module';
import { HealthController } from './health/health.controller';
import { InfraModule } from './infra/infra.module';
import { OrgModule } from './org/org.module';
import { TicketsModule } from './tickets/tickets.module';
import { UsersModule } from './users/users.module';
import { WorkflowModule } from './workflow/workflow.module';

const env = loadEnv();

@Module({
  imports: [
    LoggerModule.forRoot({
      // Named wildcard: Nest 11's router rejects the bare '*' nestjs-pino uses by default.
      forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
      pinoHttp: {
        level: env.LOG_LEVEL,
        transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
        redact: ['req.headers.authorization', 'req.headers.cookie'],
        autoLogging: { ignore: (req) => req.url?.includes('/health/') ?? false },
      },
    }),
    InfraModule,
    AuditModule,
    UsersModule,
    AuthModule,
    WorkflowModule,
    OrgModule,
    CustomersModule,
    TicketsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_FILTER, useClass: AllExceptionsFilter }],
})
export class AppModule {}
