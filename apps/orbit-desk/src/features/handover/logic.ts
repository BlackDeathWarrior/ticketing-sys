import type { SlaTimerView } from '@tms/shared';
import type { Message } from '../../data/types';

export type Lane = 'customer' | 'ai' | 'human' | 'system';

/** Which lane a message sits in when the conversation is shown as AI and human lanes. */
export function laneOf(m: Pick<Message, 'kind' | 'byAi'>): Lane {
  if (m.kind === 'customer') return 'customer';
  if (m.kind === 'ai' || m.byAi) return 'ai';
  if (m.kind === 'agent' || m.kind === 'note') return 'human';
  return 'system';
}

export type LaneRow<M> =
  { type: 'message'; lane: Lane; message: M } | { type: 'switch'; to: 'ai' | 'human' };

/**
 * Messages with a marker wherever the replying side changes between the AI
 * and people, so a handover (or a hand-back) reads as a lane switch.
 */
export function laneRows<M extends Pick<Message, 'kind' | 'byAi'>>(messages: M[]): LaneRow<M>[] {
  const out: LaneRow<M>[] = [];
  let side: 'ai' | 'human' | null = null;
  for (const message of messages) {
    const lane = laneOf(message);
    if ((lane === 'ai' || lane === 'human') && side && lane !== side) {
      out.push({ type: 'switch', to: lane });
    }
    if (lane === 'ai' || lane === 'human') side = lane;
    out.push({ type: 'message', lane, message });
  }
  return out;
}

/** "AI is replying", "Maya is replying", "You are replying", "Waiting for a person". */
export function controllerText(
  conv: {
    controller: string;
    controllerUserId: string | null;
    controllerName?: string | null;
  } | null,
  meId: string,
): { text: string; tone: 'ai' | 'me' | 'human' | 'waiting' } {
  if (!conv) return { text: 'No conversation yet', tone: 'waiting' };
  if (conv.controller === 'ai') return { text: 'AI is replying', tone: 'ai' };
  if (conv.controller === 'human' && conv.controllerUserId) {
    if (conv.controllerUserId === meId) return { text: 'You are replying', tone: 'me' };
    return {
      text: `${conv.controllerName ?? 'A colleague'} is replying`,
      tone: 'human',
    };
  }
  return { text: 'Waiting for a person', tone: 'waiting' };
}

export const TIMER_LABELS: Record<SlaTimerView['kind'], string> = {
  first_response: 'First response',
  resolution: 'Resolution',
};

/** A timer's line for the SLA panel: its state and time left or when it ended. */
export function timerText(t: SlaTimerView, now = new Date()): string {
  if (t.state === 'met') return t.breachedAt ? 'Met late' : 'Met';
  if (t.state === 'paused') return 'Paused while waiting on the customer';
  if (t.state === 'breached') return t.metAt ? 'Missed, answered later' : 'Missed';
  if (!t.dueAt) return 'Running';
  const min = Math.round((new Date(t.dueAt).getTime() - now.getTime()) / 60_000);
  return t.atRisk ? `At risk · ${fmt(min)} left` : `${fmt(min)} left`;
}

function fmt(min: number): string {
  if (min < 60) return `${Math.max(0, min)} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.round(h / 24)} days`;
}

export const ACTOR_FILTERS = [
  { value: '', label: 'Everyone' },
  { value: 'user', label: 'People' },
  { value: 'ai', label: 'AI' },
  { value: 'system', label: 'System' },
  { value: 'customer', label: 'Customer' },
] as const;

/** A readable history line from an audit action, e.g. "handover.requested" → "Handover requested". */
export function actionLabel(action: string): string {
  const [, verb = action] = action.split('.');
  const text = verb.replace(/_/g, ' ');
  const noun = action.split('.')[0]!.replace(/_/g, ' ');
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${text}`;
}
