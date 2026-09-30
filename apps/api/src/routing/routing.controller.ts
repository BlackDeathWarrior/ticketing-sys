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
  reorderRulesSchema,
  type RoutingRuleInput,
  routingRuleSchema,
  type SetPresenceInput,
  setPresenceSchema,
  setSkillsSchema,
} from '@tms/shared';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { RoutingService } from './routing.service';

/** Settings → Routing (rules, skills, capacity) and each agent's own presence. */
@ApiTags('routing')
@ApiBearerAuth()
@Controller()
export class RoutingController {
  constructor(private readonly routing: RoutingService) {}

  @Get('routing/rules')
  @RequirePermission('settings:routing')
  rules() {
    return this.routing.listRules();
  }

  @Post('routing/rules')
  @RequirePermission('settings:routing')
  create(@Ctx() ctx: RequestCtx, @Body(new ZodPipe(routingRuleSchema)) body: RoutingRuleInput) {
    return this.routing.saveRule(ctx, body);
  }

  @Put('routing/rules/:id')
  @RequirePermission('settings:routing')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(routingRuleSchema)) body: RoutingRuleInput,
  ) {
    return this.routing.saveRule(ctx, body, id);
  }

  @Delete('routing/rules/:id')
  @HttpCode(204)
  @RequirePermission('settings:routing')
  async remove(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.routing.deleteRule(ctx, id);
  }

  @Put('routing/order')
  @RequirePermission('settings:routing')
  reorder(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(reorderRulesSchema)) body: z.infer<typeof reorderRulesSchema>,
  ) {
    return this.routing.reorder(ctx, body.ids);
  }

  /** Who is online, their load, skills and teams. Team leads see it to balance work. */
  @Get('routing/agents')
  @RequirePermission('ticket:assign')
  agents() {
    return this.routing.agents();
  }

  @Put('routing/agents/:id/skills')
  @HttpCode(204)
  @RequirePermission('settings:routing')
  async skills(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setSkillsSchema)) body: z.infer<typeof setSkillsSchema>,
  ) {
    await this.routing.setSkills(ctx, id, body.skills);
  }

  /** An admin sets someone's capacity (and presence, e.g. marking a leaver offline). */
  @Put('routing/agents/:id/presence')
  @RequirePermission('settings:routing')
  presenceFor(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(setPresenceSchema)) body: SetPresenceInput,
  ) {
    return this.routing.setPresence(ctx, id, body);
  }

  @Get('me/presence')
  @RequirePermission('ticket:read')
  myPresence(@Ctx() ctx: RequestCtx) {
    return this.routing.presenceOf(ctx.user!.id);
  }

  /** Online, away or offline: only online agents get routed tickets. */
  @Put('me/presence')
  @RequirePermission('ticket:read')
  setMyPresence(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(setPresenceSchema.pick({ status: true })))
    body: Pick<SetPresenceInput, 'status'>,
  ) {
    return this.routing.setPresence(ctx, ctx.user!.id, { status: body.status });
  }
}
