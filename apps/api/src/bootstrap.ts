import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { KB_MAX_FILE_BYTES } from '@tms/shared';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { ENV } from './infra/tokens';
import { RedisIoAdapter } from './realtime/redis-io.adapter';

export const API_PREFIX = 'api/v1';

/** Builds the configured application. Shared by main.ts and the integration tests. */
export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
    genReqId: (req: IncomingMessage) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && header.length <= 128 ? header : randomUUID();
    },
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });
  const env = app.get<Env>(ENV);

  app.useLogger(app.get(Logger));
  app.useWebSocketAdapter(new RedisIoAdapter(app, env));
  app.enableShutdownHooks();
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  // The Swagger UI needs inline scripts, so CSP is only enforced when docs are off.
  // Cast: @fastify/helmet's plugin type and Nest's register() signature disagree on generics.
  await app.register(helmet as unknown as Parameters<NestFastifyApplication['register']>[0], {
    contentSecurityPolicy: !env.API_DOCS,
  });

  // Knowledge-base uploads: one file per request, read into memory by the handler.
  await app.register(multipart as unknown as Parameters<NestFastifyApplication['register']>[0], {
    limits: { fileSize: KB_MAX_FILE_BYTES, files: 1, fields: 10 },
  });

  if (env.API_DOCS) {
    const config = new DocumentBuilder()
      .setTitle('TMS API')
      .setDescription('Ticket Management System')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
