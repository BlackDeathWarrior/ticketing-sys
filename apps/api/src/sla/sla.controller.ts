import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type BusinessHoursInput,
  businessHoursSchema,
  type SlaPolicyInput,
  slaPolicySchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { SlaService } from './sla.service';

/** SLA policies and business hours (Settings → SLA), and a ticket's timers. */
@ApiTags('sla')
@ApiBearerAuth()
@Controller()
export class SlaController {
  constructor(private readonly sla: SlaService) {}

  @Get('sla/policies')
  @RequirePermission('ticket:read')
  policies() {
    return this.sla.listPolicies();
  }

  @Post('sla/policies')
  @RequirePermission('settings:sla')
  createPolicy(@Ctx() ctx: RequestCtx, @Body(new ZodPipe(slaPolicySchema)) body: SlaPolicyInput) {
    return this.sla.savePolicy(ctx, body);
  }

  @Put('sla/policies/:id')
  @RequirePermission('settings:sla')
  updatePolicy(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(slaPolicySchema)) body: SlaPolicyInput,
  ) {
    return this.sla.savePolicy(ctx, body, id);
  }

  @Delete('sla/policies/:id')
  @HttpCode(204)
  @RequirePermission('settings:sla')
  async deletePolicy(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.sla.deletePolicy(ctx, id);
  }

  @Get('sla/business-hours')
  @RequirePermission('ticket:read')
  hours() {
    return this.sla.listHours();
  }

  @Post('sla/business-hours')
  @RequirePermission('settings:sla')
  createHours(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(businessHoursSchema)) body: BusinessHoursInput,
  ) {
    return this.sla.saveHours(ctx, body);
  }

  @Put('sla/business-hours/:id')
  @RequirePermission('settings:sla')
  updateHours(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(businessHoursSchema)) body: BusinessHoursInput,
  ) {
    return this.sla.saveHours(ctx, body, id);
  }

  @Delete('sla/business-hours/:id')
  @HttpCode(204)
  @RequirePermission('settings:sla')
  async deleteHours(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.sla.deleteHours(ctx, id);
  }

  @Get('tickets/:id/sla')
  @RequirePermission('ticket:read')
  ticket(@Param('id') id: string) {
    return this.sla.forTicket(id);
  }
}
