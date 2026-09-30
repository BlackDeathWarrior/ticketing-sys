import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Database } from '@tms/db';
import { WORKER_HEARTBEAT_KEY } from '@tms/shared';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { Public } from '../common/request-context';
import type { Env } from '../config/env';
import { DB, ENV, REDIS } from '../infra/tokens';

type Check = { status: 'up' | 'down'; latencyMs?: number; detail?: string };

async function timed(fn: () => Promise<unknown>, timeoutMs = 2000): Promise<Check> {
  const start = Date.now();
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return { status: 'up', latencyMs: Date.now() - start };
  } catch (err) {
    return { status: 'down', detail: err instanceof Error ? err.message : String(err) };
  }
}

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /**
   * Ready when Postgres and Redis answer. LiteLLM and the worker are reported
   * but don't fail readiness: the helpdesk still works without them.
   */
  @Get('ready')
  async ready() {
    const [database, redis, litellm] = await Promise.all([
      timed(() => this.db.execute(sql`select 1`)),
      timed(() => this.redis.ping()),
      timed(async () => {
        const res = await fetch(new URL('/health/liveliness', this.env.LITELLM_URL));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      }),
    ]);
    const beat = await this.redis.get(WORKER_HEARTBEAT_KEY).catch(() => null);
    const ageSec = beat ? Math.round((Date.now() - Number(beat)) / 1000) : null;
    const worker: Check =
      ageSec !== null && ageSec < 60
        ? { status: 'up', detail: `heartbeat ${ageSec}s ago` }
        : { status: 'down', detail: ageSec === null ? 'no heartbeat' : `heartbeat ${ageSec}s ago` };

    const body = {
      status: database.status === 'up' && redis.status === 'up' ? 'ok' : 'error',
      checks: { database, redis, litellm, worker },
    };
    if (body.status !== 'ok') throw new ServiceUnavailableException(body);
    return body;
  }
}
