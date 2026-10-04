import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { listNotificationsQuerySchema } from '@tms/shared';
import type { z } from 'zod';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { NotificationsService } from './notifications.service';

/** The signed-in agent's own notifications. */
@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @RequirePermission('ticket:read')
  list(
    @Ctx() ctx: RequestCtx,
    @Query(new ZodPipe(listNotificationsQuerySchema))
    q: z.output<typeof listNotificationsQuerySchema>,
  ) {
    return this.notifications.list(ctx.user!.id, q);
  }

  @Post(':id/read')
  @HttpCode(204)
  @RequirePermission('ticket:read')
  async read(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.notifications.markRead(ctx.user!.id, id);
  }

  @Post('read-all')
  @HttpCode(204)
  @RequirePermission('ticket:read')
  async readAll(@Ctx() ctx: RequestCtx) {
    await this.notifications.markRead(ctx.user!.id);
  }
}
