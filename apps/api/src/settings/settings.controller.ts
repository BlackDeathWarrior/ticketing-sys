import {
  BadRequestException,
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
import {
  CHANNEL_KINDS,
  DESK_ONLY_SECRET_KEYS,
  type ChannelKind,
  secretKeySchema,
  setSecretSchema,
  type TestPriorityInput,
  testPrioritySchema,
} from '@tms/shared';
import { Ctx, type RequestCtx, RequirePermission } from '../common/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { BrandingService } from './branding.service';
import { ChannelConfigService } from './channel-config.service';
import { PriorityRulesService } from './priority-rules.service';
import { SecretsService } from './secrets.service';

/** Settings → Priority (ADR 0032): what makes a ticket urgent, high, normal or low. */
@ApiTags('settings')
@ApiBearerAuth()
@Controller('settings/priority-rules')
export class PriorityRulesController {
  constructor(private readonly rules: PriorityRulesService) {}

  @Get()
  @RequirePermission('settings:priority')
  get() {
    return this.rules.get();
  }

  /** Replaces the whole ordered list. */
  @Put()
  @RequirePermission('settings:priority')
  save(@Ctx() ctx: RequestCtx, @Body() body: unknown) {
    return this.rules.save(ctx, body);
  }

  /** Which rule a made-up message would match, with the rules as saved. */
  @Post('test')
  @HttpCode(200)
  @RequirePermission('settings:priority')
  async test(@Body(new ZodPipe(testPrioritySchema)) body: TestPriorityInput) {
    return (
      (await this.rules.evaluate({
        channel: body.channel,
        categoryId: null,
        subcategoryId: null,
        customerType: null,
        tags: [],
        text: body.text,
        intent: body.intent ?? null,
        sentiment: body.sentiment ?? null,
        metadata: {},
      })) ?? { priority: null, rule: null }
    );
  }
}

const channelKind = new ParseEnumPipe(Object.fromEntries(CHANNEL_KINDS.map((k) => [k, k])));
const secretKey = new ZodPipe(secretKeySchema);
/** Secrets the desk makes itself are not a person's to set: a typed one would lock the agent out. */
function refuseDeskOnly(key: string): void {
  if (DESK_ONLY_SECRET_KEYS.includes(key)) {
    throw new BadRequestException('This value is set by the desk when it sets the agent up');
  }
}

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
    refuseDeskOnly(key);
    return this.secrets.set(ctx, key, body.value);
  }

  @Delete('secrets/:key')
  @HttpCode(204)
  @RequirePermission('settings:secrets')
  async deleteSecret(@Ctx() ctx: RequestCtx, @Param('key', secretKey) key: string) {
    refuseDeskOnly(key);
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
