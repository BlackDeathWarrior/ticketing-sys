import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseEnumPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CHANNEL_KINDS, type ChannelKind, secretKeySchema, setSecretSchema } from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { BrandingService } from './branding.service';
import { ChannelConfigService } from './channel-config.service';
import { SecretsService } from './secrets.service';

const channelKind = new ParseEnumPipe(Object.fromEntries(CHANNEL_KINDS.map((k) => [k, k])));
const secretKey = new ZodPipe(secretKeySchema);

@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings')
export class SettingsController {
  constructor(
    private readonly secrets: SecretsService,
    private readonly channels: ChannelConfigService,
    private readonly branding: BrandingService,
  ) {}

  /** Who the helpdesk speaks for: the company name, the sign-off, the help center's wording. */
  @Get('branding')
  @RequirePermission('settings:channels')
  getBranding() {
    return this.branding.get();
  }

  @Put('branding')
  @RequirePermission('settings:channels')
  saveBranding(@Ctx() ctx: RequestCtx, @Body() body: unknown) {
    return this.branding.save(ctx, body);
  }

  /** Masked list: key, scope, last four characters, who changed it. Never values. */
  @Get('secrets')
  @RequirePermission('settings:secrets')
  listSecrets() {
    return this.secrets.list();
  }

  /** Creates or rotates a secret. The response is the masked view. */
  @Put('secrets/:key')
  @RequirePermission('settings:secrets')
  setSecret(
    @Ctx() ctx: RequestCtx,
    @Param('key', secretKey) key: string,
    @Body(new ZodPipe(setSecretSchema)) body: { value: string },
  ) {
    return this.secrets.set(ctx, key, body.value);
  }

  @Delete('secrets/:key')
  @HttpCode(204)
  @RequirePermission('settings:secrets')
  async deleteSecret(@Ctx() ctx: RequestCtx, @Param('key', secretKey) key: string) {
    await this.secrets.delete(ctx, key);
  }

  @Get('channels')
  @RequirePermission('settings:channels')
  async listChannels() {
    return Promise.all(CHANNEL_KINDS.map((k) => this.channels.view(k)));
  }

  @Get('channels/:kind')
  @RequirePermission('settings:channels')
  getChannel(@Param('kind', channelKind) kind: ChannelKind) {
    return this.channels.view(kind);
  }

  /** Saves the non-secret part of a channel's configuration (validated per channel). */
  @Put('channels/:kind')
  @RequirePermission('settings:channels')
  saveChannel(
    @Ctx() ctx: RequestCtx,
    @Param('kind', channelKind) kind: ChannelKind,
    @Body() body: unknown,
  ) {
    return this.channels.save(ctx, kind, body);
  }

  @Post('channels/:kind/test')
  @HttpCode(200)
  @RequirePermission('settings:channels')
  testChannel(@Ctx() ctx: RequestCtx, @Param('kind', channelKind) kind: ChannelKind) {
    return this.channels.test(ctx, kind);
  }
}
