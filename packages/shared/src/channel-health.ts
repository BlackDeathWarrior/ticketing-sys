import { z } from 'zod';

/**
 * How a channel is doing, for the status lights in Settings → Channels:
 * `ok` (green) it works, `warning` (amber) it works but something needs a
 * look, `down` (red) it does not work, `off` (grey) it is not in use.
 */
export const HEALTH_STATES = ['ok', 'warning', 'down', 'off'] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

export const HEALTH_LABELS: Record<HealthState, string> = {
  ok: 'Working',
  warning: 'Needs attention',
  down: 'Not working',
  off: 'Off',
};

export const HEALTH_CHANNELS = ['email', 'whatsapp', 'webchat', 'web_form', 'voice'] as const;
export type HealthChannel = (typeof HEALTH_CHANNELS)[number];

export const HEALTH_CHANNEL_LABELS: Record<HealthChannel, string> = {
  email: 'Email',
  whatsapp: 'WhatsApp',
  webchat: 'Web chat',
  web_form: 'Help-center form',
  voice: 'Voice',
};

/** One thing that was checked, in words an admin can act on. */
export interface HealthCheck {
  key: string;
  label: string;
  state: HealthState;
  detail: string;
}

export interface ChannelActivity {
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  /** Messages that could not be delivered in the last 24 hours. */
  failed24h: number;
  lastFailure: { at: string; reason: string } | null;
}

export interface ChannelHealth {
  channel: HealthChannel;
  label: string;
  state: HealthState;
  /** One line next to the light. */
  summary: string;
  checks: HealthCheck[];
  activity: ChannelActivity;
  /** When the live connection check last ran; null when it never has. */
  checkedAt: string | null;
}

const RANK: Record<HealthState, number> = { off: 0, ok: 1, warning: 2, down: 3 };

/** The state a channel shows: its worst check. Checks that are off don't count. */
export function worstState(states: HealthState[]): HealthState {
  const active = states.filter((s) => s !== 'off');
  if (!active.length) return 'off';
  return active.reduce((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ok');
}

// ---- Connecting WhatsApp in one step ----

const metaId = z
  .string()
  .trim()
  .regex(/^\d{5,30}$/, 'Digits only, copied from Meta → WhatsApp → API setup');
const secret = z.string().trim().min(1).max(10_000);

/**
 * Everything Meta needs, in one form. Keys left empty keep their stored
 * value, so reconnecting doesn't mean pasting the token again.
 */
export const whatsappConnectSchema = z.object({
  phoneNumberId: metaId,
  wabaId: metaId,
  graphVersion: z
    .string()
    .trim()
    .regex(/^v\d+\.\d+$/, 'Like v23.0')
    .default('v23.0'),
  accessToken: secret.optional(),
  appSecret: secret.optional(),
  verifyToken: secret.optional(),
  /** Two-step verification PIN; only needed to register a number that isn't registered yet. */
  pin: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Six digits')
    .optional(),
});
export type WhatsappConnectInput = z.input<typeof whatsappConnectSchema>;
export type ParsedWhatsappConnect = z.output<typeof whatsappConnectSchema>;

export interface WhatsappConnectResult {
  /** Meta accepted the token and the number, and the settings were saved. */
  connected: boolean;
  steps: HealthCheck[];
  number: { display: string; name: string | null; quality: string | null } | null;
}
