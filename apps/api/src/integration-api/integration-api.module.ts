import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { CsatModule } from '../csat/csat.module';
import { CustomersModule } from '../customers/customers.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { IncidentsService } from './incidents.service';
import { IntegrationApiController } from './integration-api.controller';
import {
  IntegrationEventsController,
  TicketIncidentsController,
} from './integration-events.controller';
import { IntegrationTicketsService } from './integration-tickets.service';

/**
 * What integrations call with their API key (ADR 0023). Kept apart from
 * IntegrationsModule (keys and their management), which AuthModule imports.
 */
@Module({
  imports: [ChannelsModule, TicketsModule, CustomersModule, WorkflowModule, OrgModule, CsatModule],
  controllers: [IntegrationApiController, IntegrationEventsController, TicketIncidentsController],
  providers: [IntegrationTicketsService, IncidentsService],
  exports: [IntegrationTicketsService, IncidentsService],
})
export class IntegrationApiModule {}
