import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ChannelConfigService } from '../../../settings/channel-config.service';
import { ChannelSignalsService } from '../../../settings/channel-signals.service';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * Lets the ElevenLabs agent in (ADR 0040): its start webhook and its tools
 * carry the hook token the desk made and stored at ElevenLabs during set-up.
 * Nothing is accepted until the ElevenLabs card is on and a token exists.
 * There is no address list: ElevenLabs calls from a range, not one address.
 */
@Injectable()
export class ElevenLabsHookGuard implements CanActivate {
  constructor(
    private readonly channels: ChannelConfigService,
    private readonly signals: ChannelSignalsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const config = await this.channels.elevenlabs();
    if (!config?.enabled) throw new NotFoundException();

    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!config.hookToken || !token || !timingSafeEqual(digest(token), digest(config.hookToken))) {
      throw new UnauthorizedException('Invalid hook token');
    }

    await this.signals.touch('elevenlabs', 'webhookAt');
    return true;
  }
}
