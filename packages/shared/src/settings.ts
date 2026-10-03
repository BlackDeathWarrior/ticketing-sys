import { z } from 'zod';

/**
 * Secrets TMS stores itself (AES-256-GCM, see ADR 0009). LLM provider keys
 * are not here: they live in LiteLLM. Values are write-only: the API returns
 * the last four characters at most.
 */
export const SECRET_SCOPES = ['channel', 'tool', 'integration', 'kb'] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export interface SecretDefinition {
  scope: SecretScope;
  channel?: ChannelKind;
  label: string;
}

/** Well-known secret keys. Tool secrets use `tool.<name>.<field>` (Phase 6). */
export const SECRET_KEYS = {
  'email.imap_password': { scope: 'channel', channel: 'email', label: 'IMAP password' },
  'email.smtp_password': { scope: 'channel', channel: 'email', label: 'SMTP password' },
  'whatsapp.access_token': { scope: 'channel', channel: 'whatsapp', label: 'Access token' },
  'whatsapp.app_secret': { scope: 'channel', channel: 'whatsapp', label: 'App secret' },
  'whatsapp.verify_token': { scope: 'channel', channel: 'whatsapp', label: 'Webhook verify token' },
  'sarvam.api_key': { scope: 'channel', channel: 'sarvam', label: 'API subscription key' },
} as const satisfies Record<string, SecretDefinition>;
export type KnownSecretKey = keyof typeof SECRET_KEYS;

/** Known keys, or tool/integration keys such as `tool.orders.api_key`. */
export const secretKeySchema = z
  .string()
  .min(3)
  .max(120)
  .refine(
    (k) => k in SECRET_KEYS || /^(tool|integration|kb)\.[a-z0-9_-]{1,50}\.[a-z0-9_]{1,50}$/.test(k),
    { message: 'Unknown secret key' },
  );

export function secretScope(key: string): SecretScope {
  if (key in SECRET_KEYS) return SECRET_KEYS[key as KnownSecretKey].scope;
  if (key.startsWith('kb.')) return 'kb';
  return key.startsWith('tool.') ? 'tool' : 'integration';
}

export const setSecretSchema = z.object({
  value: z.string().min(1).max(10_000),
});

export interface SecretView {
  key: string;
  scope: SecretScope;
  label: string;
  /** Last four characters when the value is long enough to show them safely. */
  last4: string | null;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
}

/** Show the last four characters only for values of 12+ characters. */
export function maskedLast4(value: string): string | null {
  return value.length >= 12 ? value.slice(-4) : null;
}

// ---- Channel configuration (non-secret parts; secrets above) ----

export const CHANNEL_KINDS = ['email', 'whatsapp', 'sarvam'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

const host = z.string().trim().min(1).max(255);
const port = z.coerce.number().int().min(1).max(65_535);

export const emailChannelConfigSchema = z.object({
  enabled: z.boolean(),
  address: z.string().trim().email(),
  fromName: z.string().trim().min(1).max(100),
  imapHost: host,
  imapPort: port,
  imapSecure: z.boolean(),
  imapUser: z.string().trim().min(1).max(255),
  imapMailbox: z.string().trim().min(1).max(100).default('INBOX'),
  pollSeconds: z.coerce.number().int().min(5).max(3600).default(60),
  smtpHost: host,
  smtpPort: port,
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().max(255).nullable().default(null),
});
export type EmailChannelConfig = z.infer<typeof emailChannelConfigSchema>;

export const whatsappChannelConfigSchema = z.object({
  enabled: z.boolean(),
  phoneNumberId: z
    .string()
    .trim()
    .regex(/^\d{5,30}$/, 'Digits only'),
  wabaId: z
    .string()
    .trim()
    .regex(/^\d{5,30}$/, 'Digits only')
    .nullable()
    .default(null),
  graphVersion: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, 'Like v23.0')
    .default('v23.0'),
});
export type WhatsappChannelConfig = z.infer<typeof whatsappChannelConfigSchema>;

export const VOICE_DEFAULT_GREETING =
  'Hello, thanks for calling. This call is recorded and transcribed so we can help you. How can I help you today?';

export const sarvamChannelConfigSchema = z.object({
  enabled: z.boolean(),
  sttModel: z.string().trim().min(1).max(50).default('saaras:v4'),
  ttsModel: z.string().trim().min(1).max(50).default('bulbul:v3'),
  defaultSpeaker: z.string().trim().min(1).max(50).default('shubh'),
  /** Spoken when a call starts. It must tell the caller that the call is recorded. */
  greeting: z.string().trim().min(10).max(400).default(VOICE_DEFAULT_GREETING),
  /** A call ends by itself after this long. */
  maxCallMinutes: z.coerce.number().int().min(1).max(60).default(10),
  /** Keep a recording of each call for 30 days. Transcripts are always kept. */
  recordCalls: z.boolean().default(true),
});
export type SarvamChannelConfig = z.infer<typeof sarvamChannelConfigSchema>;

export const CHANNEL_CONFIG_SCHEMAS = {
  email: emailChannelConfigSchema,
  whatsapp: whatsappChannelConfigSchema,
  sarvam: sarvamChannelConfigSchema,
} as const;

export interface ChannelSettingsView<C = Record<string, unknown>> {
  kind: ChannelKind;
  /** `settings` when saved from the UI, `environment` when it still comes from env vars. */
  source: 'settings' | 'environment' | 'none';
  config: C | null;
  secrets: Array<{ key: string; label: string; set: boolean; last4: string | null }>;
  lastTest: { ok: boolean; at: string; error?: string } | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  detail?: string;
}
