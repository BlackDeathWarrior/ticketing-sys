import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
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
  type WidgetHost,
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
import type { Env } from '../config/env';
import { ENV } from '../infra/tokens';
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
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get()
  @RequirePermission('integration:manage')
  list() {
    return this.integrations.list();
  }

  /** Where a site loads the chat widget from: the address the help center is served at. */
  @Get('widget-host')
  @RequirePermission('integration:manage')
  widgetHost(): WidgetHost {
    return { origin: new URL(this.env.HELP_CENTER_URL).origin };
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

  /**
   * Generates the secret the integration's site signs chat identity tokens
   * with, replacing any earlier one. The answer carries it, once.
   */
  @Post(':id/chat-identity-secret')
  @RequirePermission('integration:manage', 'settings:secrets')
  newChatIdentitySecret(@Ctx() ctx: RequestCtx, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.newChatIdentitySecret(ctx, id);
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
