import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateWebhookInput,
  createWebhookSchema,
  type ListDeliveriesQuery,
  listDeliveriesQuerySchema,
  type UpdateWebhookInput,
  updateWebhookSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { WebhooksService } from './webhooks.service';

/** Settings → Integrations: where an integration is told about events. Admin only. */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller()
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  @Get('integrations/:id/webhooks')
  @RequirePermission('integration:manage')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.list(id);
  }

  /** The answer carries the signing secret, once (like an API key, ADR 0022). */
  @Post('integrations/:id/webhooks')
  @RequirePermission('integration:manage', 'settings:secrets')
  create(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createWebhookSchema)) body: CreateWebhookInput,
  ) {
    return this.webhooks.create(ctx, id, body);
  }

  @Patch('webhooks/:id')
  @RequirePermission('integration:manage')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateWebhookSchema)) body: UpdateWebhookInput,
  ) {
    return this.webhooks.update(ctx, id, body);
  }

  @Delete('webhooks/:id')
  @HttpCode(204)
  @RequirePermission('integration:manage', 'settings:secrets')
  async remove(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.webhooks.remove(ctx, id);
  }

  @Post('webhooks/:id/rotate-secret')
  @HttpCode(200)
  @RequirePermission('integration:manage', 'settings:secrets')
  rotate(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.rotateSecret(ctx, id);
  }

  /** Sends a `ping` now and returns what the receiver answered. */
  @Post('webhooks/:id/test')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.test(id);
  }

  /** The delivery log: outcomes and identifiers, never what was sent. */
  @Get('webhooks/:id/deliveries')
  @RequirePermission('integration:manage')
  deliveries(
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(listDeliveriesQuerySchema)) q: ListDeliveriesQuery,
  ) {
    return this.webhooks.deliveries(id, q);
  }

  @Post('webhooks/deliveries/:id/redeliver')
  @HttpCode(202)
  @RequirePermission('integration:manage')
  redeliver(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.webhooks.redeliver(ctx, id);
  }
}
