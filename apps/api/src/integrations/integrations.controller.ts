import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import {
  type ApiKeyScope,
  type CreateApiKeyInput,
  createApiKeySchema,
  type CreateIntegrationInput,
  createIntegrationSchema,
  type IntegrationIdentity,
  type UpdateIntegrationInput,
  updateIntegrationSchema,
} from '@tms/shared';
import {
  type ApiKeyContext,
  ApiKey,
  ApiKeyAuth,
  Ctx,
  type RequestCtx,
  RequirePermission,
} from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { ApiKeysService } from './api-keys.service';
import { IntegrationsService } from './integrations.service';

/** Settings → Integrations: the outside apps connected to TMS and their API keys. Admin only. */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(
    private readonly integrations: IntegrationsService,
    private readonly keys: ApiKeysService,
  ) {}

  @Get()
  @RequirePermission('integration:manage')
  list() {
    return this.integrations.list();
  }

  @Post()
  @RequirePermission('integration:manage')
  create(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(createIntegrationSchema)) body: CreateIntegrationInput,
  ) {
    return this.integrations.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('integration:manage')
  update(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(updateIntegrationSchema)) body: UpdateIntegrationInput,
  ) {
    return this.integrations.update(ctx, id, body);
  }

  @Get(':id/keys')
  @RequirePermission('integration:manage')
  async listKeys(@Param('id', ParseUUIDPipe) id: string) {
    await this.integrations.get(id);
    return this.keys.list(id);
  }

  /** The answer carries the key itself, once; it cannot be read again (ADR 0022). */
  @Post(':id/keys')
  @RequirePermission('integration:manage', 'settings:secrets')
  createKey(
    @Ctx() ctx: RequestCtx,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    return this.keys.create(ctx, id, body);
  }

  @Post('keys/:keyId/revoke')
  @HttpCode(200)
  @RequirePermission('integration:manage')
  revokeKey(@Ctx() ctx: RequestCtx, @Param('keyId', ParseUUIDPipe) keyId: string) {
    return this.keys.revoke(ctx, keyId);
  }
}

/** What an integration calls with its API key. Staff access tokens are refused here. */
@ApiTags('integration API')
@ApiBearerAuth('apiKey')
@ApiKeyAuth()
@Controller('integration')
export class IntegrationIdentityController {
  /** Who the key is: for checking a connection. Any working key may ask. */
  @Get()
  whoAmI(@ApiKey() key: ApiKeyContext): IntegrationIdentity {
    return {
      integration: { slug: key.integration.slug, name: key.integration.name },
      key: {
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes as ApiKeyScope[],
        rateLimitPerMinute: key.rateLimitPerMinute,
      },
    };
  }
}
