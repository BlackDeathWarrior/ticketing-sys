import { z } from 'zod';
import { PHONE_PROVIDERS } from './phone';

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
  'phone.sarvam_api_key': { scope: 'channel', channel: 'phone', label: 'Voice Agents API key' },
  'phone.hook_token': { scope: 'channel', channel: 'phone', label: 'Hook token' },
  'elevenlabs.api_key': { scope: 'channel', channel: 'elevenlabs', label: 'API key' },
  'elevenlabs.hook_token': { scope: 'channel', channel: 'elevenlabs', label: 'Hook token' },
  'elevenlabs.webhook_secret': {
    scope: 'channel',
    channel: 'elevenlabs',
    label: 'Webhook secret',
  },
} as const satisfies Record<string, SecretDefinition>;
export type KnownSecretKey = keyof typeof SECRET_KEYS;

/**
 * Secrets the desk makes and saves by itself while it sets up the ElevenLabs
 * agent (ADR 0040). Nobody types them, so no route may set or delete them.
 */
export const DESK_ONLY_SECRET_KEYS: readonly string[] = [
  'elevenlabs.hook_token',
  'elevenlabs.webhook_secret',
] satisfies KnownSecretKey[];

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

export const CHANNEL_KINDS = [
  'email',
  'whatsapp',
  'sarvam',
  'phone',
  'elevenlabs',
  'calls',
] as const;
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

/**
 * Phone calls on a number rented from Sarvam (ADR 0039). A Sarvam Voice Agent
 * answers; these are the ids of that agent and its number in Sarvam's dashboard.
 */
export const phoneChannelConfigSchema = z.object({
  enabled: z.boolean(),
  orgId: z.string().trim().min(1).max(100),
  workspaceId: z.string().trim().min(1).max(100),
  /** The agent ("app") that answers, and the version that is deployed. */
  appId: z.string().trim().min(1).max(100),
  appVersion: z.coerce.number().int().min(1),
  connectionId: z.string().trim().min(1).max(100),
  /** The rented number, in international form. */
  agentPhoneNumber: z
    .string()
    .trim()
    .regex(/^\+\d{8,15}$/, 'Give the full international number, starting with +'),
  /** Where these two lived before `calls` (below); still read until that card is saved. */
  callingHours: z.boolean().default(false),
  linkTemplate: z.string().trim().max(512).nullish(),
});
export type PhoneChannelConfig = z.infer<typeof phoneChannelConfigSchema>;

/** Where an ElevenLabs workspace lives: the default, or one of its data residency regions. */
export const ELEVENLABS_REGIONS = ['default', 'eu', 'in', 'sg'] as const;
export type ElevenlabsRegion = (typeof ELEVENLABS_REGIONS)[number];
export const ELEVENLABS_VOICE_MODELS = ['auto', 'eleven_v3_conversational'] as const;

/**
 * Phone calls answered by an ElevenLabs agent (ADR 0040). The desk creates
 * that agent and its tools through ElevenLabs' API; these are the choices a
 * person makes for it.
 */
export const elevenlabsChannelConfigSchema = z.object({
  enabled: z.boolean(),
  region: z.enum(ELEVENLABS_REGIONS).default('default'),
  /** The language model the agent thinks with, by ElevenLabs' name for it. */
  model: z.string().trim().min(1).max(100).default('gemini-2.5-flash'),
  voiceId: z.string().trim().min(1).max(100),
  /**
   * The model that speaks. `auto`: ElevenLabs' v2 for an English agent and v2.5 for other
   * languages (about 32 of them). `eleven_v3_conversational`: its v3 model, which also
   * speaks Bengali and other languages v2.5 does not.
   */
  voiceModel: z.enum(ELEVENLABS_VOICE_MODELS).default('auto'),
  /** The language the agent starts in, and the others it may switch to. */
  language: z.string().trim().min(2).max(10).default('en'),
  moreLanguages: z.array(z.string().trim().min(2).max(10)).max(10).default([]),
  /** The number at ElevenLabs this agent answers on. Empty until one is connected there. */
  phoneNumberId: z.string().trim().max(100).nullish(),
});
export type ElevenlabsChannelConfig = z.infer<typeof elevenlabsChannelConfigSchema>;

/** What holds for phone calls whichever provider takes them (ADR 0040). */
export const callsChannelConfigSchema = z.object({
  /** Whose voice agent places the calls this desk starts. */
  outboundProvider: z.enum(PHONE_PROVIDERS).default('sarvam'),
  /** On: outbound calls only between 09:00 and 21:00 India time. */
  callingHours: z.boolean().default(false),
  /**
   * The WhatsApp template that carries a link to a caller (a payment link cannot be read
   * out). Its body has one variable, the link. Empty: the link only goes, as a plain
   * message, to a caller who wrote on WhatsApp in the last 24 hours.
   */
  linkTemplate: z.string().trim().max(512).nullish(),
});
export type CallsChannelConfig = z.infer<typeof callsChannelConfigSchema>;

export const CHANNEL_CONFIG_SCHEMAS = {
  email: emailChannelConfigSchema,
  whatsapp: whatsappChannelConfigSchema,
  sarvam: sarvamChannelConfigSchema,
  phone: phoneChannelConfigSchema,
  elevenlabs: elevenlabsChannelConfigSchema,
  calls: callsChannelConfigSchema,
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
