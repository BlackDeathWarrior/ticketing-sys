import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { OutboxService } from './outbox.service';

@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService, OutboxService],
  exports: [AuditService, OutboxService],
})
export class AuditModule {}
