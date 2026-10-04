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
    /** Sarvam's Voice Agents API (phone calls, ADR 0039). */
    SARVAM_AGENTS_URL: z.string().url().default('https://apps.sarvam.ai'),
    /**
     * Addresses Sarvam's agent calls our phone hooks from, comma-separated. Empty: any
     * address with the hook token. Sarvam documents 4.213.167.70.
     */
    PHONE_SARVAM_IPS: z.string().default(''),
    /** ElevenLabs' API for a workspace in no data residency region (phone calls, ADR 0040). */
    ELEVENLABS_API_URL: z.string().url().default('https://api.elevenlabs.io'),
    /** Meta Graph API base URL. Only change it to go through a proxy. */
    WHATSAPP_GRAPH_URL: z.string().url().default('https://graph.facebook.com'),
    /**
     * Rate limits on public and sign-in routes (ADR 0021). Only switch them off
     * for tests that hammer those routes on purpose.
     */
    RATE_LIMITS: z.enum(['on', 'off']).default('on'),
    /** Where customers reach the help center; used in the links we email them. */
    HELP_CENTER_URL: z.string().url().default('http://localhost:8080/help/'),
    /**
     * Where to send traces (an OTLP/HTTP collector, e.g. http://otel-collector:4318).
     * Unset: tracing is off and costs nothing.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
      // Compose passes an empty value when it isn't set.
      (v) => (v === '' ? undefined : v),
      z.string().url().optional(),
    ),
    /** Serve Swagger UI at /docs. Defaults to on outside production. */
    API_DOCS: bool.optional(),

    /** Let KB URL sources point at private addresses (local demos and tests only). */
    KB_ALLOW_PRIVATE_URLS: bool.default('false'),
    /** Concurrent KB ingestion jobs per worker. */
    /**
     * Folders a "shared folder" connector may read, comma-separated (ADR 0033):
     * where a NAS share is mounted into the worker. Empty: no folder connector works.
     */
    KB_CONNECTOR_PATHS: z.string().default(''),
    /** Hosts connectors may reach although they are private (an in-house database or wiki), comma-separated. */
    KB_CONNECTOR_PRIVATE_HOSTS: z.string().default(''),
    KB_INGEST_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),

    /** Concurrent AI jobs (turns and classifications) per worker. */
    AI_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(4),
    /**
     * How old the model routing settings a call uses may be, in milliseconds. A changed
     * cap or a model switched off reaches calls within this time; 0 reads them every time.
     */
    LLM_SNAPSHOT_MS: z.coerce.number().int().min(0).max(60_000).default(3000),
    /**
     * How long a typed message waits before its AI turn starts, in milliseconds, so a
     * customer who sends three short messages gets one answer. 0 starts the turn at once.
     */
    AI_SETTLE_MS: z.coerce.number().int().min(0).max(10_000).default(1200),

    /**
     * Host names MCP servers may use even though they resolve to private
     * addresses (compose services such as `fake-providers`). Comma-separated.
     */
    TOOL_PRIVATE_HOSTS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
      ),
    /**
     * Webhooks to integrations (ADR 0025). Hosts that may be private or use
     * plain http (a local demo, a compose service); everything else must be a
     * public https address. Comma-separated.
     */
    WEBHOOK_PRIVATE_HOSTS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean),
      ),
    /** How long a receiver has to answer. */
    WEBHOOK_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
    /** Attempts per delivery, and the first wait between them (doubling each time). */
    WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
    WEBHOOK_BACKOFF_MS: z.coerce.number().int().min(50).max(600_000).default(5000),
    /** Deliveries in a row that must fail for good before a subscription is switched off. */
    WEBHOOK_DISABLE_AFTER: z.coerce.number().int().min(1).max(1000).default(15),
    /** How often the worker resolves tickets the AI answered and the customer left alone. 0 = off. */
    // Quiet times are set per channel and can be minutes, so the check runs every minute.
    AI_AUTO_RESOLVE_SWEEP_SECONDS: z.coerce.number().int().min(0).max(86_400).default(60),
    /** How often the worker deletes operational data past its retention period. 0 = off. */
    RETENTION_SWEEP_HOURS: z.coerce.number().int().min(0).max(168).default(24),
    /** How long a transactional tool call waits for a supervisor before it expires. */
    APPROVAL_TTL_MINUTES: z.coerce.number().int().min(1).max(10_080).default(1440),
    /** How often the worker checks SLA timers for at-risk and breached tickets. */
    SLA_SWEEP_SECONDS: z.coerce.number().int().min(5).max(3600).default(30),
    /** Voice calls this API process handles at once (Sarvam's Starter plan allows 20 streams). */
    VOICE_MAX_CALLS: z.coerce.number().int().min(0).max(20).default(5),
    /**
     * How often the worker checks that the mail server and Meta still accept
     * our credentials, for the channel status lights. 0 turns the checks off.
     */
    CHANNEL_CHECK_SECONDS: z.coerce.number().int().min(0).max(86_400).default(300),

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
