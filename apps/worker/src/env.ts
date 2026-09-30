import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  OUTBOX_POLL_MS: z.coerce.number().int().min(50).default(500),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
});

export type WorkerEnv = z.infer<typeof envSchema>;

export function loadEnv(): WorkerEnv {
  for (const file of [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ]) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      break;
    }
  }
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
