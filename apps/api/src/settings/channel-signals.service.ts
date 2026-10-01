import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { REDIS } from '../infra/tokens';

/** The outcome of a live connection check against the real service. */
export interface ProbeResult {
  ok: boolean;
  at: string;
  error?: string;
  detail?: string;
  /** What the check learned, e.g. the WhatsApp number's name and quality. */
  facts?: Record<string, unknown>;
}

/** What the mailbox reader is doing right now. */
export interface PollerSignal {
  state: 'watching' | 'error' | 'off';
  detail?: string;
  at: string;
}

export interface ChannelSignals {
  probe?: ProbeResult;
  poller?: PollerSignal;
  /** WhatsApp: the last time Meta called the webhook with a valid signature. */
  webhookAt?: string;
  /** WhatsApp: the last time Meta verified the webhook address. */
  handshakeAt?: string;
}

const key = (channel: string) => `tms:channel-health:${channel}`;

/**
 * Small facts about each channel that the API and the worker share through
 * Redis, for the status lights (ADR 0016). They are observations, not
 * records: losing them only means a light shows "not checked yet" until the
 * next check. Writing one must never break the work it describes.
 */
@Injectable()
export class ChannelSignalsService {
  private readonly logger = new Logger(ChannelSignalsService.name);

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async set<K extends keyof ChannelSignals>(
    channel: string,
    field: K,
    value: NonNullable<ChannelSignals[K]>,
  ): Promise<void> {
    try {
      await this.redis.hset(key(channel), field, JSON.stringify(value));
    } catch (err) {
      this.logger.warn(`could not record ${channel}.${field}: ${(err as Error).message}`);
    }
  }

  /** Records "this just happened". */
  touch(channel: string, field: 'webhookAt' | 'handshakeAt'): Promise<void> {
    return this.set(channel, field, new Date().toISOString());
  }

  async get(channel: string): Promise<ChannelSignals> {
    try {
      const raw = await this.redis.hgetall(key(channel));
      return Object.fromEntries(
        Object.entries(raw).map(([field, value]) => [field, JSON.parse(value) as unknown]),
      ) as ChannelSignals;
    } catch (err) {
      this.logger.warn(`could not read ${channel} signals: ${(err as Error).message}`);
      return {};
    }
  }

  async clear(channel: string, field: keyof ChannelSignals): Promise<void> {
    await this.redis.hdel(key(channel), field).catch(() => undefined);
  }
}
