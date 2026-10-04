import { Module } from '@nestjs/common';
import { ChannelsModule } from '../channels/channels.module';
import { OrgModule } from '../org/org.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WebFormAckHandler } from './web-form-ack.handler';
import { WebFormController } from './web-form.controller';
import { WebFormService } from './web-form.service';

/** The public "Submit a request" form (channel `web_form`). */
@Module({
  imports: [ChannelsModule, OrgModule, TicketsModule],
  controllers: [WebFormController],
  providers: [WebFormService, WebFormAckHandler],
  exports: [WebFormAckHandler],
})
export class WebFormModule {}
