import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  type RawBodyRequest,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type ParsedWhatsappConnect, whatsappConnectSchema } from '@tms/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Ctx, Public, type RequestCtx, RequirePermission } from '../../common/request-context';
import { ZodPipe } from '../../common/zod.pipe';
import { ChannelSignalsService } from '../../settings/channel-signals.service';
import type { WaWebhookPayload } from './webhook-payload';
import { WhatsAppConnectService } from './whatsapp-connect.service';
import { WhatsAppTemplatesService } from './whatsapp-templates.service';
import { WhatsAppWebhookQueue } from './whatsapp-webhook.queue';
import { WhatsAppService } from './whatsapp.service';

/**
 * Meta calls these. They are public, so every request has to prove itself:
 * the handshake with the verify token, and each delivery with an HMAC of the
 * raw body under the app secret. Nothing is accepted until both are saved in
 * Settings.
 */
@ApiTags('channels')
@Public()
@Controller('channels/whatsapp/webhook')
export class WhatsAppWebhookController {
  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly queue: WhatsAppWebhookQueue,
    private readonly signals: ChannelSignalsService,
  ) {}

  /** The subscription handshake: echo `hub.challenge` when the verify token matches. */
  @Get()
  async verify(
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: FastifyReply,
  ): Promise<string> {
    const ok =
      query['hub.mode'] === 'subscribe' &&
      (await this.whatsapp.verifyToken(query['hub.verify_token']));
    if (!ok) throw new ForbiddenException('Verification failed');
    await this.signals.touch('whatsapp', 'handshakeAt');
    // Meta expects the bare challenge, not JSON.
    void res.type('text/plain; charset=utf-8');
    return query['hub.challenge'] ?? '';
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<FastifyRequest>): Promise<{ received: true }> {
    const raw = req.rawBody;
    const signature = req.headers['x-hub-signature-256'];
    if (
      !raw ||
      !(await this.whatsapp.verifySignature(
        raw,
        typeof signature === 'string' ? signature : undefined,
      ))
    ) {
      throw new UnauthorizedException('Invalid signature');
    }
    const payload = req.body as WaWebhookPayload | undefined;
    if (!payload || typeof payload !== 'object') throw new BadRequestException('Expected JSON');
    await this.queue.add(raw, payload);
    await this.signals.touch('whatsapp', 'webhookAt');
    return { received: true };
  }
}

@ApiTags('channels')
@ApiBearerAuth()
@Controller('whatsapp')
export class WhatsAppController {
  constructor(
    private readonly templates: WhatsAppTemplatesService,
    private readonly connector: WhatsAppConnectService,
  ) {}

  /**
   * Connects a number in one step: checks the values with Meta, saves them,
   * and subscribes the account. It stores keys, so it needs both permissions.
   */
  @Post('connect')
  @HttpCode(200)
  @RequirePermission('settings:channels', 'settings:secrets')
  connect(
    @Ctx() ctx: RequestCtx,
    @Body(new ZodPipe(whatsappConnectSchema)) body: ParsedWhatsappConnect,
  ) {
    return this.connector.connect(ctx, body);
  }

  /** Approved templates for the reply box; `all=true` adds the ones Meta hasn't approved. */
  @Get('templates')
  @RequirePermission('message:send')
  list(@Query('all') all?: string) {
    return this.templates.list({ approvedOnly: all !== 'true' });
  }

  @Post('templates/sync')
  @HttpCode(200)
  @RequirePermission('settings:channels')
  sync(@Ctx() ctx: RequestCtx) {
    return this.templates.sync(ctx);
  }

  /** Subscribes the WhatsApp Business account to the Meta app, so its webhooks reach us. */
  @Post('subscribe')
  @HttpCode(200)
  @RequirePermission('settings:channels')
  subscribe(@Ctx() ctx: RequestCtx) {
    return this.templates.subscribe(ctx);
  }
}
