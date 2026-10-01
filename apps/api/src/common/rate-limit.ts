import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type Redis from 'ioredis';
import type { Env } from '../config/env';
import { ENV, REDIS } from '../infra/tokens';

export interface RateLimitRule {
  /** Names the counter; routes that share a name share the allowance. */
  name: string;
  /** Requests allowed per window, per caller (network address). */
  limit: number;
  windowSeconds: number;
}

const RATE_LIMIT = 'tms:rateLimit';

/** Limits how often one network address may call a route (ADR 0021). */
export const RateLimit = (rule: RateLimitRule) => SetMetadata(RATE_LIMIT, rule);

export interface Allowance {
  allowed: boolean;
  /** Seconds until the window ends. */
  retryAfter: number;
  count: number;
}

/**
 * Fixed-window counters in Redis, shared by every API instance. A window
 * starts with the first request and the counter expires with it. When Redis
 * is unreachable the request is let through: a limiter must not become the
 * outage.
 */
@Injectable()
export class RateLimiterService {
  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get enabled(): boolean {
    return this.env.RATE_LIMITS === 'on';
  }

  /** Counts one use of `name` by `who` and says whether it is within the limit. */
  async hit(name: string, who: string, limit: number, windowSeconds: number): Promise<Allowance> {
    const key = `tms:rl:${name}:${who}`;
    try {
      const count = await this.redis.incr(key);
      if (count === 1) await this.redis.expire(key, windowSeconds);
      let ttl = count > limit ? await this.redis.ttl(key) : windowSeconds;
      if (ttl < 0) {
        // A counter without an expiry would lock the caller out for ever.
        await this.redis.expire(key, windowSeconds);
        ttl = windowSeconds;
      }
      return { allowed: count <= limit, retryAfter: ttl, count };
    } catch {
      return { allowed: true, retryAfter: 0, count: 0 };
    }
  }

  /** How many uses are counted in the current window, without adding one. */
  async count(name: string, who: string): Promise<number> {
    return Number((await this.redis.get(`tms:rl:${name}:${who}`).catch(() => null)) ?? 0);
  }

  async reset(name: string, who: string): Promise<void> {
    await this.redis.del(`tms:rl:${name}:${who}`).catch(() => undefined);
  }
}

/** A 429. The exception filter adds the `Retry-After` header from `retryAfter` (seconds). */
export class TooManyRequestsException extends HttpException {
  constructor(
    message: string,
    readonly retryAfter: number,
  ) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

export function tooManyRequests(retryAfter: number, what = 'requests'): TooManyRequestsException {
  const wait =
    retryAfter >= 90
      ? `${Math.ceil(retryAfter / 60)} minutes`
      : `${Math.max(retryAfter, 1)} seconds`;
  return new TooManyRequestsException(
    `Too many ${what}. Try again in ${wait}.`,
    Math.max(retryAfter, 1),
  );
}

/** Global guard: applies `@RateLimit()` rules. Runs before authentication. */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limiter: RateLimiterService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http' || !this.limiter.enabled) return true;
    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!rule) return true;
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const res = await this.limiter.hit(rule.name, req.ip, rule.limit, rule.windowSeconds);
    if (res.allowed) return true;
    throw tooManyRequests(res.retryAfter);
  }
}
