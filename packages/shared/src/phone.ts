import { z } from 'zod';
import { normalizeIdentity } from './customers';

/**
 * Phone calls on a number rented from Sarvam (ADR 0039). A Sarvam Voice Agent
 * answers the call by itself; it reaches this desk through a start hook, four
 * tools and a trigger when the call is over. These are the bodies of those
 * requests: we choose the field names when the tools are set up in Sarvam.
 */
export const PHONE_TOOL_NAMES = [
  'desk_tool',
  'list_tools',
  'search_knowledge',
  'request_person',
] as const;
export type PhoneToolName = (typeof PHONE_TOOL_NAMES)[number];

/**
 * These bodies are filled in by Sarvam's platform and by its agent's model, on
 * a live call. Whatever can be read is read: a number where text was meant, a
 * null, an over-long sentence. Refusing the request would leave the caller in
 * silence, so only a missing call id is an error.
 */
const loose = z.union([z.string(), z.number()]).nullish();
const clipped = (max: number) =>
  loose.transform((v) => (v == null ? undefined : String(v).trim().slice(0, max) || undefined));

const interactionId = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .pipe(z.string().min(1).max(200));
/** The caller's number as Sarvam sends it; null when the network withheld it. */
const callerPhone = loose
  .transform((v) => (v == null ? '' : normalizeIdentity('phone', String(v))))
  .transform((v) => (/^\d{8,15}$/.test(v) ? v : null));

export const phoneStartSchema = z.object({ interactionId, phone: callerPhone });
export type PhoneStartInput = z.output<typeof phoneStartSchema>;

export const phoneToolSchema = z.object({
  interactionId,
  phone: callerPhone,
  /** `desk_tool`: which desk tool, and its arguments: a JSON object, as text or as it is. */
  name: clipped(200),
  arguments: z
    .union([z.string(), z.record(z.unknown())])
    .nullish()
    .transform((v) =>
      v == null ? undefined : typeof v === 'string' ? v.slice(0, 10_000) : JSON.stringify(v),
    ),
  /** `search_knowledge`. */
  query: clipped(500),
  /** `request_person`: why the caller needs a colleague. */
  reason: clipped(500),
});
export type PhoneToolInput = z.output<typeof phoneToolSchema>;

/** Sarvam's own webhook body. Only the id is used: the transcript is fetched with our key. */
export const phoneEndedSchema = z
  .object({ interaction_id: interactionId, user_phone_number: callerPhone })
  .passthrough();
export type PhoneEndedInput = z.output<typeof phoneEndedSchema>;

/** One desk tool as the phone agent sees it (the customer argument is hidden). */
export interface PhoneToolEntry {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** What the start hook answers: flat, so Sarvam can map each field to an agent variable. */
export interface PhoneStartReply {
  customer_name: string;
  known: boolean;
  company: string;
  /** The tool catalogue as JSON text. */
  desk_tools: string;
}

/** What every tool answers: `result` is text for the agent to speak from. */
export interface PhoneToolReply {
  ok: boolean;
  result: string;
}

/** A tool's answer is cut to this many characters before it goes to the agent. */
export const PHONE_TOOL_RESULT_MAX = 4_000;
