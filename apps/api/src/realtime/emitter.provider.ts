import type { Provider } from '@nestjs/common';
import { Emitter } from '@socket.io/redis-emitter';
import Redis from 'ioredis';
import { EMITTER, REDIS } from '../infra/tokens';

/** Lets the worker emit to Socket.IO rooms without running a Socket.IO server. */
export const emitterProvider: Provider = {
  provide: EMITTER,
  inject: [REDIS],
  useFactory: (redis: Redis) => new Emitter(redis),
};
