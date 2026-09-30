import { existsSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');
const list = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    );

/** Shared by the API (main.ts) and the worker (worker.ts); each ignores what it doesn't use. */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    API_PORT: z.coerce.number().int().default(3000),
    CORS_ORIGINS: list('http://localhost:5173'),
    /** Sites allowed to embed the chat widget. "*" allows any origin. */
    CHAT_ORIGINS: list('*'),
    /** Optional HS256 secret for identity tokens that websites pass to the chat widget. */
    CHAT_IDENTITY_SECRET: z.string().min(32).optional(),
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL: z.string().default('15m'),
    JWT_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
    LITELLM_URL: z.string().url().default('http://localhost:4000'),
    LITELLM_MASTER_KEY: z.string().optional(),
    /** Master key for stored secrets: 32 bytes, base64. Required in production (ADR 0009). */
    TMS_SECRETS_KEY: z
      .string()
      .refine((v) => Buffer.from(v, 'base64').length === 32, 'Must be 32 bytes, base64-encoded')
      .optional(),
    /** Sarvam API base URL; tests point it at the fake provider. */
    SARVAM_API_URL: z.string().url().default('https://api.sarvam.ai'),
    /** Meta Graph API base URL; tests point it at the fake provider. */
    WHATSAPP_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),
    /** Serve Swagger UI at /docs. Defaults to on outside production. */
    API_DOCS: bool.optional(),

    /** Let KB URL sources point at private addresses (local demos and tests only). */
    KB_ALLOW_PRIVATE_URLS: bool.default('false'),
    /** Concurrent KB ingestion jobs per worker. */
    KB_INGEST_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

    // Worker
    OUTBOX_POLL_MS: z.coerce.number().int().min(50).default(1000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),

    // Object storage (S3 API)
    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default('us-east-1'),
    S3_ACCESS_KEY: z.string().optional(),
    S3_SECRET_KEY: z.string().optional(),
    S3_BUCKET: z.string().default('tms'),
    S3_FORCE_PATH_STYLE: bool.default('true'),
    /** `static`: S3_ACCESS_KEY/S3_SECRET_KEY. `iam`: the AWS default chain (an instance role). */
    S3_AUTH: z.enum(['static', 'iam']).default('static'),

    // Email channel: one support mailbox, read over IMAP and answered over SMTP.
    EMAIL_ENABLED: bool.default('false'),
    EMAIL_ADDRESS: z.string().email().optional(),
    EMAIL_FROM_NAME: z.string().default('Support'),
    EMAIL_IMAP_HOST: z.string().optional(),
    EMAIL_IMAP_PORT: z.coerce.number().int().default(993),
    EMAIL_IMAP_SECURE: bool.default('true'),
    EMAIL_IMAP_USER: z.string().optional(),
    EMAIL_IMAP_PASSWORD: z.string().optional(),
    EMAIL_IMAP_MAILBOX: z.string().default('INBOX'),
    EMAIL_POLL_SECONDS: z.coerce.number().int().min(5).default(60),
    EMAIL_SMTP_HOST: z.string().optional(),
    EMAIL_SMTP_PORT: z.coerce.number().int().default(587),
    EMAIL_SMTP_SECURE: bool.default('false'),
    EMAIL_SMTP_USER: z.string().optional(),
    EMAIL_SMTP_PASSWORD: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && !e.TMS_SECRETS_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['TMS_SECRETS_KEY'],
        message: 'Required in production (generate with: openssl rand -base64 32)',
      });
    }
    if (!e.EMAIL_ENABLED) return;
    for (const key of [
      'EMAIL_ADDRESS',
      'EMAIL_IMAP_HOST',
      'EMAIL_IMAP_USER',
      'EMAIL_SMTP_HOST',
    ] as const) {
      if (!e[key])
        ctx.addIssue({ code: 'custom', path: [key], message: 'Required when EMAIL_ENABLED=true' });
    }
  })
  .transform((e) => ({ ...e, API_DOCS: e.API_DOCS ?? e.NODE_ENV !== 'production' }));

export type Env = z.infer<typeof envSchema>;

/** Loads the repo-root .env (if present) without overriding variables already set. */
function loadDotEnv(): void {
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '../../.env'),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && process.env.NODE_ENV !== 'test') loadDotEnv();
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
  }
  return parsed.data;
}
