import { Controller, Get, Header, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ReportQuery,
  reportQuerySchema,
  ticketReportCsv,
  type TicketReportQuery,
  ticketReportQuerySchema,
} from '@tms/shared';
import type { FastifyReply } from 'fastify';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PerformanceService } from './performance.service';
import { ReportsService } from './reports.service';

/** Makes spreadsheet apps read the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly performanceReport: PerformanceService,
  ) {}

  /** Queue counts, 14-day volume, per-agent load and recent ticket activity. */
  @Get('overview')
  @RequirePermission('report:read')
  overview() {
    return this.reports.overview();
  }

  /** The AI and the team side by side: resolution, handover, speed, SLA, ratings and cost. */
  @Get('performance')
  @RequirePermission('report:read')
  performance(@Query(new ZodPipe(reportQuerySchema)) query: ReportQuery) {
    return this.performanceReport.performance(query);
  }

  /** The tickets behind the report, one page at a time. */
  @Get('tickets')
  @RequirePermission('report:read')
  tickets(@Query(new ZodPipe(ticketReportQuerySchema)) query: TicketReportQuery) {
    return this.performanceReport.tickets(query);
  }

  /** The same tickets as a CSV file. Exports carry customer names, so each one is audited. */
  @Get('tickets.csv')
  @RequirePermission('report:export')
  @Header('cache-control', 'no-store')
  async exportTickets(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(ticketReportQuerySchema)) query: TicketReportQuery,
    @Res({ passthrough: true }) res: FastifyReply,
  ) {
    const rows = await this.performanceReport.exportRows(ctx, query);
    void res.header('content-type', 'text/csv; charset=utf-8');
    void res.header('content-disposition', 'attachment; filename="tickets.csv"');
    return `${BOM}${ticketReportCsv(rows)}`;
  }
}
