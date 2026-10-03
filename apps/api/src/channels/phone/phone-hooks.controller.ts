import {
  Body,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import {
  PHONE_TOOL_NAMES,
  type PhoneEndedInput,
  type PhoneStartInput,
  type PhoneStartReply,
  type PhoneToolInput,
  type PhoneToolName,
  type PhoneToolReply,
  phoneEndedSchema,
  phoneStartSchema,
  phoneToolSchema,
} from '@tms/shared';
import { RateLimit } from '../../common/rate-limit';
import { Public } from '../../common/request-context';
import { ZodBody } from '../../common/zod-openapi';
import { ZodPipe } from '../../common/zod.pipe';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { VoiceCallsService } from '../voice/voice-calls.service';
import { PhoneCallQueue } from './phone-call.queue';
import { fromSarvam, PhoneHookGuard } from './phone-hook.guard';
import { PhoneToolsService } from './phone-tools.service';

/**
 * What Sarvam's phone agent calls during a call (ADR 0039). Public for the
 * staff guard; `PhoneHookGuard` checks the hook token on the start hook and
 * the tools. Answers are flat JSON so Sarvam can map them to agent variables,
 * and a tool that cannot help still answers 200 with something to say: an
 * error status would leave the caller in silence.
 */
@ApiTags('channels')
@Public()
@Controller('phone/sarvam')
export class PhoneHooksController {
  constructor(
    private readonly tools: PhoneToolsService,
    private readonly queue: PhoneCallQueue,
    private readonly channels: ChannelConfigService,
    private readonly calls: VoiceCallsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Post('start')
  @HttpCode(200)
  @UseGuards(PhoneHookGuard)
  @RateLimit({ name: 'phone-hooks', limit: 600, windowSeconds: 60 })
  @ZodBody(phoneStartSchema)
  start(@Body(new ZodPipe(phoneStartSchema)) body: PhoneStartInput): Promise<PhoneStartReply> {
    return this.tools.start(body);
  }

  @Post('tools/:name')
  @HttpCode(200)
  @UseGuards(PhoneHookGuard)
  @RateLimit({ name: 'phone-hooks', limit: 600, windowSeconds: 60 })
  @ZodBody(phoneToolSchema)
  tool(
    @Param('name') name: string,
    @Body(new ZodPipe(phoneToolSchema)) body: PhoneToolInput,
  ): Promise<PhoneToolReply> {
    if (!(PHONE_TOOL_NAMES as readonly string[]).includes(name)) throw new NotFoundException();
    return this.tools.run(name as PhoneToolName, body);
  }

  /**
   * Sarvam's webhook when a call is over. It carries no token (Sarvam
   * documents no way to sign it), so it is only a trigger: the worker asks
   * Sarvam for the call with our own key, and an id Sarvam does not know
   * writes nothing.
   */
  @Post('ended')
  @HttpCode(200)
  @RateLimit({ name: 'phone-ended', limit: 60, windowSeconds: 60 })
  @ZodBody(phoneEndedSchema)
  async ended(
    @Req() req: FastifyRequest,
    @Body(new ZodPipe(phoneEndedSchema)) body: PhoneEndedInput,
  ): Promise<{ received: true }> {
    // With Sarvam's addresses set, a trigger from anywhere else is dropped without a word.
    if (fromSarvam(this.env, req.ip) && (await this.channels.phone())?.enabled) {
      const duration = (body as Record<string, unknown>).duration;
      await this.queue.add(
        body.interaction_id,
        {
          phone: body.user_phone_number,
          seconds:
            typeof duration === 'number' && duration >= 0 && duration < 86_400
              ? Math.round(duration)
              : null,
        },
        !!(await this.calls.byProvider(body.interaction_id)),
      );
    }
    return { received: true };
  }
}
