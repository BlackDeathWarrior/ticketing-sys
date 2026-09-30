import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { setTransitionsSchema, upsertStatusSchema } from '@tms/shared';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { WorkflowService } from './workflow.service';

@ApiTags('workflow')
@ApiBearerAuth()
@Controller('workflow')
export class WorkflowController {
  constructor(private readonly workflow: WorkflowService) {}

  @Get()
  @RequirePermission('ticket:read')
  get() {
    return this.workflow.load();
  }

  @Put('statuses')
  @RequirePermission('settings:workflow')
  upsertStatus(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(upsertStatusSchema)) body: z.infer<typeof upsertStatusSchema>,
  ) {
    return this.workflow.upsertStatus(ctx, body);
  }

  @Delete('statuses/:key')
  @RequirePermission('settings:workflow')
  deactivate(@Ctx() ctx: RequestCtx, @Param('key') key: string) {
    return this.workflow.deactivateStatus(ctx, key);
  }

  @Put('transitions')
  @RequirePermission('settings:workflow')
  setTransitions(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(setTransitionsSchema)) body: z.infer<typeof setTransitionsSchema>,
  ) {
    return this.workflow.setTransitions(ctx, body.transitions);
  }
}
