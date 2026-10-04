import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type CreateKbConnectorInput,
  createKbConnectorSchema,
  type UpdateKbConnectorInput,
  updateKbConnectorSchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { KbConnectorsService } from './kb-connectors.service';

/** Credentials need `settings:secrets` as well as `kb:manage`, like every other key field (ADR 0009). */
function assertMayWriteSecrets(ctx: RequestCtx, secrets: Record<string, string> | undefined) {
  if (!secrets || !Object.values(secrets).some((v) => v.trim())) return;
  if (!ctx.user?.permissions.includes('settings:secrets')) {
    throw new ForbiddenException('Saving credentials needs the permission to manage keys');
  }
}

/** Knowledge base → Sources (ADR 0033): outside sources kept in sync. */
@ApiTags('kb')
@ApiBearerAuth()
@Controller('kb/connectors')
export class KbConnectorsController {
  constructor(private readonly connectors: KbConnectorsService) {}

  @Get()
  @RequirePermission('kb:manage')
  list() {
    return this.connectors.list();
  }

  @Post()
  @RequirePermission('kb:manage')
  create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createKbConnectorSchema)) body: CreateKbConnectorInput,
  ) {
    assertMayWriteSecrets(ctx, body.secrets);
    return this.connectors.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('kb:manage')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateKbConnectorSchema)) body: UpdateKbConnectorInput,
  ) {
    assertMayWriteSecrets(ctx, body.secrets);
    return this.connectors.update(ctx, id, body);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermission('kb:manage')
  async delete(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.connectors.delete(ctx, id);
  }

  /** Lists the source once and changes nothing: do the address and credentials work? */
  @Post(':id/test')
  @HttpCode(200)
  @RequirePermission('kb:manage')
  test(@Param('id', ParseUUIDPipe) id: string) {
    return this.connectors.test(id);
  }

  /** Syncs now, in the worker. */
  @Post(':id/sync')
  @HttpCode(202)
  @RequirePermission('kb:manage')
  async sync(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    await this.connectors.requestSync(ctx, id);
    return { queued: true };
  }
}
