import { Module } from '@nestjs/common';
import { TicketsModule } from '../tickets/tickets.module';
import { UsersModule } from '../users/users.module';
import { ApprovalsService } from './approvals.service';
import { ToolGatewayService } from './tool-gateway.service';
import { ApprovalsController, ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';

/**
 * Company-system tools over MCP and supervisor approvals (ADR 0013). The
 * worker adds ApprovalExpiryWorker and ApprovalsHandler (worker.module.ts).
 */
@Module({
  imports: [TicketsModule, UsersModule],
  controllers: [ToolsController, ApprovalsController],
  providers: [ToolsService, ToolGatewayService, ApprovalsService],
  exports: [ToolsService, ToolGatewayService, ApprovalsService],
})
export class ToolsModule {}
