import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { CsatModule } from '../csat/csat.module';
import { CustomersModule } from '../customers/customers.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { IntegrationApiController } from './integration-api.controller';
import { IntegrationTicketsService } from './integration-tickets.service';

/**
 * What integrations call with their API key (ADR 0023). Kept apart from
 * IntegrationsModule (keys and their management), which AuthModule imports.
 */
@Module({
  imports: [ChannelsModule, TicketsModule, CustomersModule, WorkflowModule, OrgModule, CsatModule],
  controllers: [IntegrationApiController],
  providers: [IntegrationTicketsService],
  exports: [IntegrationTicketsService],
})
export class IntegrationApiModule {}
