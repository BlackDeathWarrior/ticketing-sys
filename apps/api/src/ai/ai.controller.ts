import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CopilotInput,
  copilotSchema,
  type SimulateAiInput,
  simulateAiSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { AiBehaviourService } from '../settings/ai-behaviour.service';
import { TicketsService } from '../tickets/tickets.service';
import { AiAgentService } from './ai-agent.service';
import { AiAutoResolveService } from './ai-auto-resolve';
import { AiCopilotService } from './ai-copilot.service';
import { AiRunsService } from './ai-runs.service';
import { AiFastPathsService } from './fast-paths.service';

@ApiTags('ai')
@ApiBearerAuth()
@Controller()
export class AiController {
  constructor(
    private readonly behaviour: AiBehaviourService,
    private readonly agent: AiAgentService,
    private readonly runs: AiRunsService,
    private readonly tickets: TicketsService,
    private readonly copilot: AiCopilotService,
    private readonly autoResolve: AiAutoResolveService,
    private readonly fast: AiFastPathsService,
  ) {}

  /** A suggested reply for the agent to edit and send; nothing is stored. */
  @Post('tickets/:id/copilot')
  @HttpCode(200)
  @RequirePermission('message:send')
  suggest(@Param('id') id: string, @Body(new ZodPipe(copilotSchema)) body: CopilotInput) {
    return this.copilot.suggest(id, body.instruction ?? null);
  }

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

  /**
   * Resolves, now, the tickets the AI answered that have been quiet long
   * enough. The worker does the same on a timer.
   */
  @Post('ai/auto-resolve')
  @HttpCode(200)
  @RequirePermission('settings:ai')
  runAutoResolve() {
    return this.autoResolve.run();
  }

  /** Runs the agent on a made-up conversation; nothing is stored or sent. */
  @Post('ai/simulate')
  @HttpCode(200)
  @RequirePermission('settings:ai')
  simulate(@Body(new ZodPipe(simulateAiSchema)) body: SimulateAiInput) {
    return this.agent.simulate(body);
  }

  /** Turns answered without a chat model in the last 30 days, by kind (greetings, FAQ, repeats, closings, guard). */
  @Get('ai/savings')
  @RequirePermission('settings:ai')
  savings() {
    return this.fast.saved(30);
  }

  /** What the AI did on a ticket: each turn and classification, newest first. */
  @Get('tickets/:id/ai-runs')
  @RequirePermission('ticket:read')
  async ticketRuns(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.get(id);
    return this.runs.forTicket(ticket.id);
  }
}
