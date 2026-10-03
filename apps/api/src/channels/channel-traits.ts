import { CHANNELS, type Channel } from '@tms/shared';

/** How a customer experiences one channel. The same for every company; the AI's mode is not in here. */
export interface ChannelTraits {
  /** Replies travel by email: email wording, headers, threads, the rating request by mail. */
  readonly repliesByEmail: boolean;
  /** A draft leaves a live customer waiting, so the holding message is sent. */
  readonly holdingMessage: boolean;
  /** Messages come in bursts; a turn waits a moment for them to settle. */
  readonly settlesBursts: boolean;
  /** With mode auto, the AI may warn, offer or close without a person. */
  readonly actsAlone: boolean;
  /** With mode auto, how the customer learns of a handover. */
  readonly handoverNotice: 'none' | 'in_turn' | 'after_routing';
  /** Told when the request is closed because they went quiet. */
  readonly toldWhenClosedForSilence: boolean;
  /** Answers that need no model may be used. */
  readonly quickAnswers: boolean;
  /** What the customer writes is screened for conduct. */
  readonly conductScreened: boolean;
  /** Which style line the prompt uses. */
  readonly style: 'email' | 'webchat' | 'whatsapp' | 'api' | 'voice';
}

/**
 * One block per channel, the fields in the same order, so a rule is the same
 * line in seven blocks. A new channel, or a new trait, does not compile until
 * every cell is written. Three traits are half a condition: the caller adds
 * `mode === 'auto'` to `holdingMessage`, `actsAlone` and `handoverNotice`.
 */
const TRAITS = {
  email: {
    repliesByEmail: true,
    holdingMessage: false,
    settlesBursts: false,
    actsAlone: false,
    handoverNotice: 'after_routing',
    toldWhenClosedForSilence: false,
    quickAnswers: false,
    conductScreened: true,
    style: 'email',
  },
  // Answered by email: the form only ever creates a request (ADR 0012).
  web_form: {
    repliesByEmail: true,
    holdingMessage: false,
    settlesBursts: false,
    actsAlone: false,
    handoverNotice: 'after_routing',
    toldWhenClosedForSilence: false,
    quickAnswers: false,
    conductScreened: true,
    style: 'email',
  },
  webchat: {
    repliesByEmail: false,
    holdingMessage: true,
    settlesBursts: true,
    actsAlone: true,
    handoverNotice: 'after_routing',
    toldWhenClosedForSilence: true,
    quickAnswers: true,
    conductScreened: true,
    style: 'webchat',
  },
  whatsapp: {
    repliesByEmail: false,
    holdingMessage: true,
    settlesBursts: true,
    actsAlone: true,
    handoverNotice: 'after_routing',
    // Its 24-hour window is normally closed by the time the quiet timer fires.
    toldWhenClosedForSilence: false,
    quickAnswers: true,
    conductScreened: true,
    style: 'whatsapp',
  },
  // Read inside the app that raised the ticket, on its request page.
  api: {
    repliesByEmail: false,
    holdingMessage: true,
    settlesBursts: true,
    actsAlone: true,
    handoverNotice: 'after_routing',
    toldWhenClosedForSilence: true,
    quickAnswers: true,
    conductScreened: true,
    style: 'api',
  },
  // A call never drafts; the caller hears a handover at once.
  voice: {
    repliesByEmail: false,
    holdingMessage: false,
    settlesBursts: false,
    actsAlone: false,
    handoverNotice: 'in_turn',
    toldWhenClosedForSilence: false,
    quickAnswers: true,
    conductScreened: false,
    style: 'voice',
  },
  // Logged by an employee; the AI is off. A draft asked for by hand reads like web chat.
  agent: {
    repliesByEmail: false,
    holdingMessage: false,
    settlesBursts: false,
    actsAlone: false,
    handoverNotice: 'none',
    toldWhenClosedForSilence: false,
    quickAnswers: true,
    conductScreened: true,
    style: 'webchat',
  },
} as const satisfies Record<Channel, ChannelTraits>;

for (const traits of Object.values(TRAITS)) Object.freeze(traits);

/**
 * The traits of a channel. Throws for a string that is not a Channel: there is
 * no fallback row. Channels are checked on the way in, so that means corrupt
 * data or a worker older than the API; the job fails and is retried.
 */
export function traitsOf(channel: string): ChannelTraits {
  if (!Object.hasOwn(TRAITS, channel)) throw new Error(`Unknown channel "${channel}"`);
  return TRAITS[channel as Channel];
}

/** The channels whose replies travel by email, for conversation lookups. */
export const CHANNELS_ANSWERED_BY_EMAIL: readonly Channel[] = CHANNELS.filter(
  (channel) => TRAITS[channel].repliesByEmail,
);
