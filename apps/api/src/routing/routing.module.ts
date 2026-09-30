import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { RoutingController } from './routing.controller';
import { RoutingService } from './routing.service';

/** Routing rules, skills, presence and the router (ADR 0014). */
@Module({
  imports: [TicketsModule, CustomersModule, WorkflowModule],
  controllers: [RoutingController],
  providers: [RoutingService],
  exports: [RoutingService],
})
export class RoutingModule {}
