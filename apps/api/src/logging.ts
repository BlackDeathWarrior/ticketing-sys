import { RequestMethod } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from './config/env';

/** Pino logging for both processes; the worker just never serves HTTP. */
export function loggerModule(env: Env, name: 'api' | 'worker') {
  return LoggerModule.forRoot({
    // Named wildcard: Nest 11's router rejects the bare '*' nestjs-pino uses by default.
    forRoutes: [{ path: '{*path}', method: RequestMethod.ALL }],
    pinoHttp: {
      name,
      level: env.LOG_LEVEL,
      transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      autoLogging: { ignore: (req) => req.url?.includes('/health/') ?? false },
    },
  });
}
