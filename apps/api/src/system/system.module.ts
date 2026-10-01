import { Body, Controller, Delete, Get, HttpCode, Module, Param, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ChannelsModule } from '../channels/channels.module';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { LlmModule } from '../llm/llm.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { PortalModule } from '../portal/portal.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { RetentionService, SystemJobsService } from './system.service';

/** Housekeeping for admins: failed background jobs and data retention (ADR 0021). */
@ApiTags('system')
@ApiBearerAuth()
@Controller()
export class SystemController {
  constructor(
    private readonly jobs: SystemJobsService,
    private readonly retention: RetentionService,
  ) {}

  /** Every queue with its counts and its most recent failed jobs. */
  @Get('system/jobs')
  @RequirePermission('system:manage')
  listJobs() {
    return this.jobs.list();
  }

  @Post('system/jobs/:queue/:id/retry')
  @HttpCode(204)
  @RequirePermission('system:manage')
  retry(@Ctx() ctx: RequestCtx, @Param('queue') queue: string, @Param('id') id: string) {
    return this.jobs.retry(ctx, queue, id);
  }

  @Delete('system/jobs/:queue/:id')
  @HttpCode(204)
  @RequirePermission('system:manage')
  remove(@Ctx() ctx: RequestCtx, @Param('queue') queue: string, @Param('id') id: string) {
    return this.jobs.remove(ctx, queue, id);
  }

  @Get('settings/retention')
  @RequirePermission('system:manage')
  getRetention() {
    return this.retention.view();
  }

  @Put('settings/retention')
  @RequirePermission('system:manage')
  async saveRetention(@Ctx() ctx: RequestCtx, @Body() body: unknown) {
    await this.retention.save(ctx, body);
    return this.retention.view();
  }

  /** Runs retention now instead of waiting for the daily run. */
  @Post('system/retention/run')
  @HttpCode(200)
  @RequirePermission('system:manage')
  async runRetention(@Ctx() ctx: RequestCtx) {
    return { deleted: await this.retention.run(ctx) };
  }
}

@Module({
  imports: [LlmModule, NotificationsModule, PortalModule, ChannelsModule, WebhooksModule],
  controllers: [SystemController],
  // RetentionWorker is registered by the worker process only (worker.module.ts).
  providers: [RetentionService, SystemJobsService],
  exports: [RetentionService],
})
export class SystemModule {}
