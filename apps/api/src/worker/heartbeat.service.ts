import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type BeforeApplicationShutdown,
} from '@nestjs/common';
import { WORKER_HEARTBEAT_KEY } from '@tms/shared';
import Redis from 'ioredis';
import { REDIS } from '../infra/tokens';

const HEARTBEAT_MS = 10_000;

/** Lets the API's readiness check see that a worker is alive. */
@Injectable()
export class HeartbeatService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private timer?: NodeJS.Timeout;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  onApplicationBootstrap() {
    const beat = () =>
      this.redis.set(WORKER_HEARTBEAT_KEY, String(Date.now()), 'EX', 120).catch(() => undefined);
    void beat();
    this.timer = setInterval(beat, HEARTBEAT_MS);
  }

  beforeApplicationShutdown() {
    clearInterval(this.timer);
  }
}
