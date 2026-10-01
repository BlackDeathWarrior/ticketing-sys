import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createDb, type DbHandle } from '@tms/db';
import Redis from 'ioredis';
import { RateLimiterService } from '../common/rate-limit';
import { type Env, loadEnv } from '../config/env';
import { DB, DB_HANDLE, ENV, REDIS } from './tokens';

/** Process-wide dependencies: validated config, the Postgres pool and a Redis client. */
@Global()
@Module({
  providers: [
    { provide: ENV, useFactory: () => loadEnv() },
    {
      provide: DB_HANDLE,
      inject: [ENV],
      useFactory: (env: Env) => createDb(env.DATABASE_URL, { max: 20 }),
    },
    { provide: DB, inject: [DB_HANDLE], useFactory: (h: DbHandle) => h.db },
    {
      provide: REDIS,
      inject: [ENV],
      useFactory: (env: Env) =>
        new Redis(env.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 }),
    },
    RateLimiterService,
  ],
  exports: [ENV, DB, DB_HANDLE, REDIS, RateLimiterService],
})
export class InfraModule implements OnApplicationShutdown {
  constructor(
    @Inject(DB_HANDLE) private readonly dbHandle: DbHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.dbHandle.close(), this.redis.quit()]);
  }
}
