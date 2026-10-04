import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type RequestHandoverInput, requestHandoverSchema } from '@tms/shared';
import { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { ActsOnTicket } from '../tickets/ticket-access';
import { TicketsService } from '../tickets/tickets.service';
import { HandoverService } from './handover.service';

const escalateSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/** Take-over, hand-back, handover with context packs, and escalation. */
@ApiTags('handover')
@ApiBearerAuth()
@Controller()
export class HandoverController {
  constructor(
    private readonly handover: HandoverService,
    private readonly tickets: TicketsService,
  ) {}

  /** The caller answers from now on; the AI stops. 409 names whoever already has it. */
  @Post('conversations/:id/take-over')
  @HttpCode(200)
  @RequirePermission('conversation:takeover')
  @ActsOnTicket('conversation')
  takeOver(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.takeOver(ctx, id);
  }

  @Post('conversations/:id/hand-back')
  @HttpCode(200)
  @RequirePermission('conversation:takeover')
  @ActsOnTicket('conversation')
  handBack(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.handover.handBack(ctx, id);
  }

  /** Pass the ticket on: to the queue (routing decides) or to a team. */
  @Post('tickets/:id/handover')
  @RequirePermission('conversation:takeover')
  @ActsOnTicket('ticket')
  requestHandover(
    @Ctx() ctx: RequestCtx,
    @Param('id') id: string,
    @Body(new ZodPipe(requestHandoverSchema)) body: RequestHandoverInput,
  ) {
    return this.handover.requestHandover(ctx, id, body);
  }

  @Get('tickets/:id/handovers')
  @RequirePermission('ticket:read')
  list(@Param('id') id: string) {
    return this.handover.forTicket(id);
  }

  @Post('tickets/:id/escalate')
  @HttpCode(200)
  @RequirePermission('ticket:escalate')
  async escalate(
    @Ctx() ctx: RequestCtx,
    @Param('id') id: string,
    @Body(new ZodPipe(escalateSchema)) body: z.infer<typeof escalateSchema>,
  ) {
    const t = await this.tickets.get(id);
    return this.tickets.escalate(ctx, t.id, body.reason);
  }
}
