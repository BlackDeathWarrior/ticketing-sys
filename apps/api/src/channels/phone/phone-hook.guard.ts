import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Env } from '../../config/env';
import { ENV } from '../../infra/tokens';
import { ChannelConfigService } from '../../settings/channel-config.service';
import { ChannelSignalsService } from '../../settings/channel-signals.service';

const digest = (value: string) => createHash('sha256').update(value).digest();

/** True unless `PHONE_SARVAM_IPS` lists Sarvam's addresses and this is not one of them. */
export function fromSarvam(env: Env, address: string): boolean {
  const allowed = env.PHONE_SARVAM_IPS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return !allowed.length || allowed.includes(address);
}

/**
 * Lets Sarvam's phone agent in (ADR 0039): the routes it protects are
 * `@Public()` for the staff guard, and every request must carry the hook
 * token saved in Settings. Nothing is accepted until phone calls are switched
 * on and a token is saved.
 */
@Injectable()
export class PhoneHookGuard implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly channels: ChannelConfigService,
    private readonly signals: ChannelSignalsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const config = await this.channels.phone();
    if (!config?.enabled) throw new NotFoundException();

    const header = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!config.hookToken || !token || !timingSafeEqual(digest(token), digest(config.hookToken))) {
      throw new UnauthorizedException('Invalid hook token');
    }

    if (!fromSarvam(this.env, req.ip)) throw new ForbiddenException();

    await this.signals.touch('phone', 'webhookAt');
    return true;
  }
}
