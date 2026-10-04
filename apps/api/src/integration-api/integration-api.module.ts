import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { CsatModule } from '../csat/csat.module';
import { CustomersModule } from '../customers/customers.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WorkflowModule } from '../workflow/workflow.module';
import { IncidentsService } from './incidents.service';
import { IntegrationApiController } from './integration-api.controller';
import { CallRequestService } from './call-request.service';
import { CustomerEmailService } from './customer-email.service';
import { CustomerNoticeService } from './customer-notice.service';
import { CustomerPhoneService } from './customer-phone.service';
import {
  IntegrationCallRequestsController,
  IntegrationCustomerEmailsController,
  IntegrationCustomerNoticesController,
  IntegrationCustomerPhonesController,
  IntegrationCustomersController,
} from './integration-customers.controller';
import {
  IntegrationEventsController,
  TicketIncidentsController,
} from './integration-events.controller';
import { IntegrationTicketsService } from './integration-tickets.service';
import { PhoneVerificationService } from './phone-verification.service';

/**
 * What integrations call with their API key (ADR 0023). Kept apart from
 * IntegrationsModule (keys and their management), which AuthModule imports.
 */
@Module({
  imports: [ChannelsModule, TicketsModule, CustomersModule, WorkflowModule, OrgModule, CsatModule],
  controllers: [
    IntegrationApiController,
    IntegrationCustomersController,
    IntegrationCustomerNoticesController,
    IntegrationCustomerEmailsController,
    IntegrationCallRequestsController,
    IntegrationCustomerPhonesController,
    IntegrationEventsController,
    TicketIncidentsController,
  ],
  providers: [
    IntegrationTicketsService,
    IncidentsService,
    PhoneVerificationService,
    CustomerNoticeService,
    CustomerEmailService,
    CallRequestService,
    CustomerPhoneService,
  ],
  exports: [IntegrationTicketsService, IncidentsService, PhoneVerificationService],
})
export class IntegrationApiModule {}
