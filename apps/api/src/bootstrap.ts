import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import helmet from '@fastify/helmet';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env';
import { ENV } from './infra/tokens';

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
  app.enableShutdownHooks();
  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: env.CORS_ORIGINS, credentials: true });
  // The Swagger UI needs inline scripts, so CSP is only enforced when docs are off.
  // Cast: @fastify/helmet's plugin type and Nest's register() signature disagree on generics.
  await app.register(helmet as unknown as Parameters<NestFastifyApplication['register']>[0], {
    contentSecurityPolicy: !env.API_DOCS,
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
