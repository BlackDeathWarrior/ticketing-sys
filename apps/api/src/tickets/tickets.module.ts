import { Module } from '@nestjs/common';
import { CustomersModule } from '../customers/customers.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [CustomersModule, WorkflowModule],
  controllers: [TicketsController],
  providers: [TicketsService],
  exports: [TicketsService],
})
export class TicketsModule {}
