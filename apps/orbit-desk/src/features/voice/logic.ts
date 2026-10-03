import {
  VOICE_LANGUAGES,
  type VoiceCallView,
  type VoiceCaption,
  type VoiceEndReason,
} from '@tms/shared';
import { duration } from '../../lib/format';

export const WHO: Record<VoiceCaption['who'], string> = {
  caller: 'Caller',
  ai: 'AI',
  agent: 'Agent',
};

export const END_REASONS: Record<VoiceEndReason, string> = {
  caller_hung_up: 'The caller hung up',
  agent_ended: 'Ended by the agent',
  time_limit: 'Reached the time limit',
  error: 'Cut off by an error',
  server_shutdown: 'Cut off by a restart',
  provider_ended: 'The call ended',
};

/** "Call on 1 Oct, 14:05 · 3m 20s · Hindi". */
export function callLine(call: VoiceCallView, locale = 'en-GB'): string {
  const when = new Date(call.startedAt).toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const seconds = call.durationSeconds ?? 0;
  const length =
    seconds < 60
      ? `${seconds}s`
      : `${duration(Math.floor(seconds / 60))}${seconds % 60 ? ` ${seconds % 60}s` : ''}`;
  const language = call.language ? VOICE_LANGUAGES[call.language]?.name : null;
  const what = call.transport === 'phone' ? 'Phone call' : 'Call';
  return [`${what} on ${when}`, length, language].filter(Boolean).join(' · ');
}

export function answeredByText(call: VoiceCallView): string | null {
  switch (call.answeredBy) {
    case 'ai':
      return call.transport === 'phone' ? 'Answered by the phone assistant' : 'Answered by the AI';
    case 'human':
      return `Answered by ${call.agent?.name ?? 'a person'}`;
    case 'both':
      return `Answered by the AI, then ${call.agent?.name ?? 'a person'}`;
    default:
      return 'Nobody spoke for us';
  }
}
