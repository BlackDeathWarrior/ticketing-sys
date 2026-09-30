import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { SlaController } from './sla.controller';
import { SlaService } from './sla.service';

/**
 * SLA policies, business hours and timers (ADR 0014). The worker adds
 * SlaSweepWorker and SlaHandler (worker.module.ts).
 */
@Module({
  imports: [TicketsModule, CustomersModule, WorkflowModule],
  controllers: [SlaController],
  providers: [SlaService],
  exports: [SlaService],
})
export class SlaModule {}
