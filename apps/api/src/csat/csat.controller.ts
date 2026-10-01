import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type CsatSubmit, csatSubmitSchema } from '@tms/shared';
import { Ctx, Public, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { CustomerExperienceService } from '../settings/customer-experience.service';
import { TicketsService } from '../tickets/tickets.service';
import { CsatService } from './csat.service';

/**
 * The page behind a survey link. The token in the link names one ticket and
 * allows one thing: rating it. Nothing else about the ticket is shown.
 */
@ApiTags('public')
@Public()
@Controller('public/csat')
export class PublicCsatController {
  constructor(private readonly csat: CsatService) {}

  @Get(':token')
  prompt(@Param('token') token: string) {
    return this.csat.prompt(token);
  }

  @Post(':token')
  @HttpCode(200)
  submit(@Param('token') token: string, @Body(new ZodPipe(csatSubmitSchema)) body: CsatSubmit) {
    return this.csat.submitWithToken(token, body, 'email');
  }
}

@ApiTags('csat')
@ApiBearerAuth()
@Controller()
export class CsatController {
  constructor(
    private readonly csat: CsatService,
    private readonly tickets: TicketsService,
    private readonly experience: CustomerExperienceService,
  ) {}

  /** The customer's rating of a ticket, or null. Staff can read it, never set it. */
  @Get('tickets/:id/rating')
  @RequirePermission('ticket:read')
  async rating(@Param('id', ParseUUIDPipe) id: string) {
    const ticket = await this.tickets.get(id);
    return { rating: await this.csat.forTicket(ticket.id) };
  }

  /** The portal and rating settings. */
  @Get('settings/customer-experience')
  @RequirePermission('settings:channels')
  settings() {
    return this.experience.get();
  }

  @Put('settings/customer-experience')
  @RequirePermission('settings:channels')
  saveSettings(@Ctx() ctx: RequestCtx, @Body() body: unknown) {
    return this.experience.save(ctx, body);
  }
}
