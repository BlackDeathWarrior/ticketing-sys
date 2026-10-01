import { Module } from '@nestjs/common';
import { PerformanceService } from './performance.service';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({
  controllers: [ReportsController],
  providers: [ReportsService, PerformanceService],
})
export class ReportsModule {}
