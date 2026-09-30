import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../common/request-context';
import { ReportsService } from './reports.service';

@ApiTags('reports')
@ApiBearerAuth()
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /** Queue counts, 14-day volume, per-agent load and recent ticket activity. */
  @Get('overview')
  @RequirePermission('report:read')
  overview() {
    return this.reports.overview();
  }
}
