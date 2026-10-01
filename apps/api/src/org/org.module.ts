import { Module } from '@nestjs/common';
import { RoutingModule } from '../routing/routing.module';
import { TicketsModule } from '../tickets/tickets.module';
import { OrgController } from './org.controller';
import { OrgService } from './org.service';

@Module({
  imports: [TicketsModule, RoutingModule],
  controllers: [OrgController],
  providers: [OrgService],
  exports: [OrgService],
})
export class OrgModule {}
