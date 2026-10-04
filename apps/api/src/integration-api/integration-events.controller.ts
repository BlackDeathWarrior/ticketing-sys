import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  type ListIncidentsQuery,
  listIncidentsQuerySchema,
  type ReportEventInput,
  reportEventSchema,
} from '@tms/shared';
import {
  ApiKey,
  ApiKeyAuth,
  type ApiKeyContext,
  Ctx,
  type RequestCtx,
  RequirePermission,
} from '../common/request-context';
import { ZodBody, ZodQuery } from '../common/zod-openapi';
import { ZodPipe } from '../common/zod.pipe';
import { IncidentsService } from './incidents.service';

/**
 * The integration API for incidents (ADR 0024): an app reports that something
 * of its own is failing, and later that it has recovered.
 */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@RequirePermission('integration:event')
@Controller('integration')
export class IntegrationEventsController {
  constructor(private readonly incidents: IncidentsService) {}

  /** 202: the report was taken. The answer says what it did and which ticket tracks it. */
  @Post('events')
  @HttpCode(202)
  @ApiOperation({ summary: 'Report a problem of your own, or its recovery' })
  @ZodBody(reportEventSchema)
  report(
    @Ctx() ctx: RequestCtx,
    @ApiKey() key: ApiKeyContext,
    @Body(new ZodPipe(reportEventSchema)) body: ReportEventInput,
  ) {
    return this.incidents.report(ctx, key, body);
  }

  /** The integration's own incidents, e.g. to show what is open right now. */
  @Get('incidents')
  @ApiOperation({ summary: "List this integration's incidents" })
  @ZodQuery(listIncidentsQuerySchema)
  list(
    @ApiKey() key: ApiKeyContext,
    @Query(new ZodPipe(listIncidentsQuerySchema)) q: ListIncidentsQuery,
  ) {
    return this.incidents.list(key, q);
  }
}

/** For agents: the incidents a ticket tracks. */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketIncidentsController {
  constructor(private readonly incidents: IncidentsService) {}

  @Get(':id/incidents')
  @RequirePermission('ticket:read')
  list(@Param('id') id: string) {
    return this.incidents.forTicket(id);
  }
}
