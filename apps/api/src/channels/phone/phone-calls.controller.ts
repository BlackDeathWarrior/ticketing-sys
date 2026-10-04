import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  OUTBOUND_REFUSAL_TEXT,
  type RequestTicketCallInput,
  requestTicketCallSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../../common/request-context';
import { ZodBody } from '../../common/zod-openapi';
import { ZodPipe } from '../../common/zod.pipe';
import { ActsOnTicket } from '../../tickets/ticket-access';
import { TicketsService } from '../../tickets/tickets.service';
import { PhoneOutboundService } from './phone-outbound.service';

/** Staff start a phone call to a ticket's customer; the phone agent makes it (ADR 0040). */
@ApiTags('voice')
@ApiBearerAuth()
@Controller()
export class PhoneCallsController {
  constructor(
    private readonly outbound: PhoneOutboundService,
    private readonly tickets: TicketsService,
  ) {}

  /** Asks for the call. The worker places it; how it went shows on the ticket's calls. */
  @Post('tickets/:id/phone-calls')
  @HttpCode(202)
  @RequirePermission('voice:call')
  @ActsOnTicket()
  @ZodBody(requestTicketCallSchema)
  async call(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(requestTicketCallSchema)) body: RequestTicketCallInput,
  ): Promise<{ callId: string }> {
    const ticket = await this.tickets.get(id);
    const result = await this.outbound.request(ctx, {
      customerId: ticket.customerId,
      ticketId: ticket.id,
      purpose: 'ticket',
      requestedBy: ctx.user?.id ?? 'system',
      about: body.about ?? null,
    });
    if ('refused' in result) throw new ConflictException(OUTBOUND_REFUSAL_TEXT[result.refused]);
    return result;
  }
}
