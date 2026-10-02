import { z } from 'zod';
import { NOTIFICATION_KINDS, type NotificationKind } from './notifications';

/** The sounds Orbit Desk can make. They are generated in the browser; there are no audio files. */
export const NOTIFICATION_TONES = ['chime', 'ping', 'knock'] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

export const NOTIFICATION_TONE_LABELS: Record<NotificationTone, string> = {
  chime: 'Chime (two rising notes)',
  ping: 'Ping (one short note)',
  knock: 'Knock (two low taps)',
};

/** What each notification kind is called in settings. */
export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  'ticket.assigned': 'A ticket is assigned to me',
  'handover.requested': 'The AI hands a ticket to me or my team',
  'sla.at_risk': 'A response time is at risk',
  'sla.breached': 'A response time was missed',
  'approval.requested': 'A request is waiting for approval',
  'ticket.escalated': 'A ticket was escalated',
  'llm.budget_warning': 'An AI budget is nearly used up',
  'channel.down': 'A channel stopped working',
  'csat.low': 'A customer gave a low rating',
  'webhook.disabled': 'A webhook was switched off',
};

/**
 * One person's own settings for Orbit Desk. They follow the person to any
 * browser, and nobody else can read or change them.
 */
export const userPreferencesSchema = z
  .object({
    sound: z
      .object({
        /** Play a sound when a notification arrives. */
        enabled: z.boolean().default(true),
        volume: z.number().min(0).max(1).default(0.6),
        tone: z.enum(NOTIFICATION_TONES).default('chime'),
        /** Notification kinds that arrive silently. */
        muted: z.array(z.enum(NOTIFICATION_KINDS)).max(NOTIFICATION_KINDS.length).default([]),
        /** Also play a quieter sound when any new ticket is opened. */
        newTickets: z.boolean().default(false),
      })
      .default({}),
  })
  .default({});
export type UserPreferences = z.output<typeof userPreferencesSchema>;
export type UserPreferencesInput = z.input<typeof userPreferencesSchema>;

export const DEFAULT_USER_PREFERENCES: UserPreferences = userPreferencesSchema.parse({});
