import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type SimulateAiInput, simulateAiSchema } from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { TicketsService } from '../tickets/tickets.service';
import { AiAgentService } from './ai-agent.service';
import { AiRunsService } from './ai-runs.service';

@ApiTags('ai')
@ApiBearerAuth()
@Controller()
export class AiController {
  constructor(
    private readonly behaviour: AiBehaviourService,
    private readonly agent: AiAgentService,
    private readonly runs: AiRunsService,
    private readonly tickets: TicketsService,
  ) {}

  /** Autonomy per channel and the confidence thresholds. */
  @Get('settings/ai')
  @RequirePermission('settings:ai')
  getBehaviour() {
    return this.behaviour.get();
  }

  @Put('settings/ai')
  @RequirePermission('settings:ai')
  saveBehaviour(@Ctx() ctx: RequestCtx, @Body() body: unknown) {
    return this.behaviour.save(ctx, body);
  }

  /** Runs the agent on a made-up conversation; nothing is stored or sent. */
  @Post('ai/simulate')
  @HttpCode(200)
  @RequirePermission('settings:ai')
  simulate(@Body(new ZodPipe(simulateAiSchema)) body: SimulateAiInput) {
    return this.agent.simulate(body);
  }

  /** What the AI did on a ticket: each turn and classification, newest first. */
  @Get('tickets/:id/ai-runs')
  @RequirePermission('ticket:read')
  async ticketRuns(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.get(id);
    return this.runs.forTicket(ticket.id);
  }
}
