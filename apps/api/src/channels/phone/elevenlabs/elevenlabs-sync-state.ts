import { z } from 'zod';

/** Where the outcome of the last set-up of the ElevenLabs agent is kept (a setting, not a secret). */
export const ELEVENLABS_SYNC_KEY = 'channel.elevenlabs.sync';

export const syncStateSchema = z.object({
  agentId: z.string().nullable().default(null),
  webhookId: z.string().nullable().default(null),
  secretId: z.string().nullable().default(null),
  at: z.string().nullable().default(null),
  ok: z.boolean().nullable().default(null),
  error: z.string().nullable().default(null),
  skipped: z.array(z.object({ tool: z.string(), reason: z.string() })).default([]),
  tools: z.number().default(0),
});
