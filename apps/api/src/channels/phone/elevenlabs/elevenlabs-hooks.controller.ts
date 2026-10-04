import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  type ElevenlabsEventInput,
  type ElevenlabsStartInput,
  elevenlabsEventSchema,
  elevenlabsStartSchema,
  normalizeIdentity,
  type PhoneToolReply,
  phoneNamedToolBodySchema,
} from '@tms/shared';
import { RateLimit } from '../../../common/rate-limit';
import { Public } from '../../../common/request-context';
import { ZodBody } from '../../../common/zod-openapi';
import { ZodPipe } from '../../../common/zod.pipe';
import { ChannelConfigService } from '../../../settings/channel-config.service';
import { VoiceCallsService } from '../../voice/voice-calls.service';
import { PhoneCallQueue } from '../phone-call.queue';
import { PhoneToolsService } from '../phone-tools.service';
import { ElevenLabsHookGuard } from './elevenlabs-hook.guard';
import { verifyElevenLabsSignature } from './elevenlabs-signature';

/** A signed event older than this is refused, as ElevenLabs' own SDK does. */
const EVENT_MAX_AGE_SECONDS = 30 * 60;

/** A header ElevenLabs fills from its own variables; one left as `{{…}}` was not filled. */
function filled(value: string | undefined): string | null {
  const v = (value ?? '').trim().slice(0, 200);
  return v && !v.includes('{{') ? v : null;
}

/** The caller's number from the header, as digits with the country code; null when withheld. */
function callerOf(value: string | undefined): string | null {
  const raw = filled(value);
  if (!raw) return null;
  const digits = normalizeIdentity('phone', raw);
  return /^\d{8,15}$/.test(digits) ? digits : null;
}

/**
 * What the ElevenLabs agent calls during and after a call (ADR 0040). Public
 * for the staff guard. The start webhook and the tools carry the hook token;
 * the call's id and the caller's number come from headers that ElevenLabs
 * fills by itself, never from what the agent's model writes. A tool that
 * cannot help still answers 200 with something to say.
 */
@ApiTags('channels')
@Public()
@Controller('phone/elevenlabs')
export class ElevenLabsHooksController {
  private readonly logger = new Logger(ElevenLabsHooksController.name);

  constructor(
    private readonly tools: PhoneToolsService,
    private readonly queue: PhoneCallQueue,
    private readonly channels: ChannelConfigService,
    private readonly calls: VoiceCallsService,
  ) {}

  /** The call begins: ElevenLabs asks who is calling. The answer fills the agent's variables. */
  @Post('start')
  @HttpCode(200)
  @UseGuards(ElevenLabsHookGuard)
  @RateLimit({ name: 'phone-hooks', limit: 600, windowSeconds: 60 })
  @ZodBody(elevenlabsStartSchema)
  async start(@Body(new ZodPipe(elevenlabsStartSchema)) body: ElevenlabsStartInput) {
    const reply = await this.tools.start(
      { interactionId: body.conversation_id, phone: body.caller_id },
      'elevenlabs',
    );
    return {
      type: 'conversation_initiation_client_data',
      dynamic_variables: {
        customer_name: reply.customer_name,
        greeting: reply.greeting,
        known: reply.known ? 'true' : 'false',
        company: reply.company,
      },
    };
  }

  /** One of the company's tools, by its id here. The body is that tool's inputs. */
  @Post('tools/desk/:toolId')
  @HttpCode(200)
  @UseGuards(ElevenLabsHookGuard)
  @RateLimit({ name: 'phone-hooks', limit: 600, windowSeconds: 60 })
  @ZodBody(phoneNamedToolBodySchema)
  deskTool(
    @Param('toolId') toolId: string,
    @Headers('x-call-id') callId: string | undefined,
    @Headers('x-caller') caller: string | undefined,
    @Body(new ZodPipe(phoneNamedToolBodySchema)) body: Record<string, unknown>,
  ): Promise<PhoneToolReply> {
    return this.tools.runNamed(
      'elevenlabs',
      toolId.slice(0, 100),
      { interactionId: filled(callId), phone: callerOf(caller) },
      body,
    );
  }

  /** The desk's own phone tools: `search_knowledge`, `request_person`, `send_whatsapp`. */
  @Post('tools/:name')
  @HttpCode(200)
  @UseGuards(ElevenLabsHookGuard)
  @RateLimit({ name: 'phone-hooks', limit: 600, windowSeconds: 60 })
  @ZodBody(phoneNamedToolBodySchema)
  ownTool(
    @Param('name') name: string,
    @Headers('x-call-id') callId: string | undefined,
    @Headers('x-caller') caller: string | undefined,
    @Body(new ZodPipe(phoneNamedToolBodySchema)) body: Record<string, unknown>,
  ): Promise<PhoneToolReply> {
    return this.tools.runNamed(
      'elevenlabs',
      name.slice(0, 100),
      { interactionId: filled(callId), phone: callerOf(caller) },
      body,
    );
  }

  /**
   * ElevenLabs' post-call webhook. The signature is checked over the raw body
   * before anything else. Even signed, the body is only a trigger: the worker
   * fetches the call with our own key, as it does for Sarvam.
   */
  @Post('events')
  @HttpCode(200)
  @RateLimit({ name: 'phone-ended', limit: 60, windowSeconds: 60 })
  @ZodBody(elevenlabsEventSchema)
  async events(
    @Req() req: FastifyRequest & { rawBody?: Buffer },
    @Headers('elevenlabs-signature') signature: string | undefined,
    @Body(new ZodPipe(elevenlabsEventSchema)) body: ElevenlabsEventInput,
  ): Promise<{ received: true }> {
    const config = await this.channels.elevenlabs();
    if (
      !config?.enabled ||
      !config.webhookSecret ||
      !req.rawBody ||
      !verifyElevenLabsSignature(
        signature,
        req.rawBody,
        config.webhookSecret,
        EVENT_MAX_AGE_SECONDS,
      )
    ) {
      throw new UnauthorizedException('Invalid signature');
    }
    const id = body.data.conversation_id;
    if (body.type === 'post_call_transcription') {
      await this.queue.add(
        'elevenlabs',
        id,
        { phone: null, seconds: null },
        !!(await this.calls.byProvider(id)),
      );
    } else {
      // A call that never connected matters once the desk places calls itself.
      this.logger.log(`ElevenLabs event ${body.type.slice(0, 40)} for a conversation: not used`);
    }
    return { received: true };
  }
}
