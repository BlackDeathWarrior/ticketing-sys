import 'reflect-metadata';
import type { INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';

/** Starts the worker as a Nest application context (no HTTP server). */
export async function createWorker(): Promise<INestApplicationContext> {
  // Imported lazily so callers (tests) can set the environment first.
  const { WorkerModule } = await import('./worker.module');
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  await app.init();
  app.get(Logger).log('worker started');
  return app;
}
