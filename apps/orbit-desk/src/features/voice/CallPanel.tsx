import {
  PHONE_CALL_ABOUT_MAX,
  VOICE_STATE_LABELS,
  type VoiceCallView,
  type VoiceCaption,
  type VoiceState,
} from '@tms/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, fetchBlob } from '../../api/client';
import { agentSocket } from '../../api/realtime';
import { Button, Icon, Input } from '../../components/ui';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import panel from '../handover/Handover.module.css';
import {
  answeredByText,
  callLine,
  END_REASONS,
  phoneCallProgress,
  placedCallText,
  WHO,
} from './logic';
import { type Mic, Speaker, startMic } from './voice-audio';
import styles from './Voice.module.css';

/**
 * A ticket's voice calls: a call in progress can be joined by voice (the AI
 * goes quiet and the agent talks to the caller); finished calls show their
 * length, who answered, and the recording for people allowed to listen.
 */
export function CallPanel({
  ticketId,
  liveTick,
  onChanged,
}: {
  ticketId: string;
  liveTick: number;
  onChanged: () => void;
}) {
  const calls = useGet<VoiceCallView[]>(`/tickets/${ticketId}/voice-calls`);
  const { reload } = calls;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);

  const { can } = useSession();
  const canCall = can('voice:call');
  if (!calls.data?.length && !canCall) return null;
  const all = calls.data ?? [];
  // A call in the browser can be joined. A phone call is the phone agent's: it is only shown.
  const live = all.find((c) => c.status === 'active' && c.transport === 'browser');
  const ringing = all.filter((c) => c.transport === 'phone' && c.status !== 'ended');
  return (
    <section className={panel.panel} aria-label="Voice call">
      <h3 className={panel.panelTitle}>
        <Icon name="phone" size={14} />
        Voice call
      </h3>
      {live && (
        <LiveCall
          call={live}
          onChanged={() => {
            void reload();
            onChanged();
          }}
        />
      )}
      {canCall && (
        <CallCustomer
          ticketId={ticketId}
          busy={ringing.length > 0}
          onRequested={() => {
            void reload();
            onChanged();
          }}
        />
      )}
      <ul className={styles.calls} aria-label="Calls on this ticket">
        {ringing.map((c) => (
          <li key={c.id} className={styles.ended} data-call={c.id}>
            <p>{phoneCallProgress(c)}</p>
          </li>
        ))}
        {all
          .filter((c) => c.status === 'ended')
          .map((c) => (
            <EndedCall key={c.id} call={c} />
          ))}
      </ul>
    </section>
  );
}

/**
 * Has the phone agent ring this ticket's customer. The request only asks for the call: the
 * worker places it, and how it went shows in the list below.
 */
function CallCustomer({
  ticketId,
  busy,
  onRequested,
}: {
  ticketId: string;
  busy: boolean;
  onRequested: () => void;
}) {
  const [about, setAbout] = useState('');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const call = async () => {
    setSending(true);
    setMessage(null);
    try {
      await api('POST', `/tickets/${ticketId}/phone-calls`, about.trim() ? { about } : {});
      setAbout('');
      setMessage('The phone assistant is calling the customer.');
      onRequested();
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div>
      <Input
        id={`call-about-${ticketId}`}
        label="What is the call about? (optional)"
        value={about}
        maxLength={PHONE_CALL_ABOUT_MAX}
        onChange={(e) => setAbout(e.target.value)}
      />
      <Button size="sm" onClick={() => void call()} disabled={sending || busy}>
        Call customer
      </Button>
      {message && (
        <p className={styles.note} role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function LiveCall({ call, onChanged }: { call: VoiceCallView; onChanged: () => void }) {
  const { can } = useSession();
  const [joined, setJoined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<VoiceState | null>(call.state);
  const [captions, setCaptions] = useState<VoiceCaption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mic = useRef<Mic | null>(null);
  const speaker = useRef<Speaker | null>(null);

  useEffect(() => setState(call.state), [call.state]);

  const hangUpLocal = useCallback(() => {
    mic.current?.stop();
    mic.current = null;
    speaker.current?.close();
    speaker.current = null;
    setJoined(false);
  }, []);

  // Whatever happens to this panel, the microphone must not stay open.
  useEffect(() => hangUpLocal, [hangUpLocal]);

  useEffect(() => {
    if (!joined) return;
    const socket = agentSocket();
    const mine = <T extends { callId: string }>(fn: (m: T) => void) => {
      return (m: T) => {
        if (m.callId === call.id) fn(m);
      };
    };
    const onAudio = mine<{ callId: string; pcm: ArrayBuffer }>((m) => speaker.current?.play(m.pcm));
    const onCaption = mine<{ callId: string; caption: VoiceCaption }>((m) =>
      setCaptions((list) => [...list.slice(-30), m.caption]),
    );
    const onState = mine<{ callId: string; state: VoiceState }>((m) => setState(m.state));
    const onEnded = mine<{ callId: string }>(() => {
      hangUpLocal();
      onChanged();
    });
    socket.on('voice:audio', onAudio);
    socket.on('voice:caption', onCaption);
    socket.on('voice:state', onState);
    socket.on('voice:ended', onEnded);
    return () => {
      socket.off('voice:audio', onAudio);
      socket.off('voice:caption', onCaption);
      socket.off('voice:state', onState);
      socket.off('voice:ended', onEnded);
    };
  }, [joined, call.id, hangUpLocal, onChanged]);

  const join = async () => {
    setBusy(true);
    setError(null);
    try {
      // Created inside the click, so the browser lets it play.
      speaker.current = new Speaker();
      await speaker.current.resume();
      const socket = agentSocket();
      const result = (await socket.timeout(10_000).emitWithAck('voice:join', {
        callId: call.id,
      })) as { ok: boolean; error?: string };
      if (!result.ok) throw new Error(result.error ?? 'Could not join the call');
      mic.current = await startMic((frame) =>
        socket.emit('voice:audio', { callId: call.id, pcm: frame.buffer }),
      );
      setJoined(true);
      onChanged();
    } catch (err) {
      const denied = err instanceof DOMException && /NotAllowed|Permission/i.test(err.name);
      if (speaker.current) agentSocket().emit('voice:leave', { callId: call.id });
      hangUpLocal();
      setError(
        denied
          ? 'The microphone is blocked. Allow it for this page, then join again.'
          : (err as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const leave = (end: boolean) => {
    agentSocket().emit('voice:leave', { callId: call.id, end });
    hangUpLocal();
    onChanged();
  };

  return (
    <div className={styles.live} data-call={call.id} data-joined={joined || undefined}>
      <p className={styles.state} role="status">
        <span className={styles.pulse} aria-hidden="true" />
        Call in progress · {state ? VOICE_STATE_LABELS[state] : 'on another server'}
      </p>
      {joined && captions.length > 0 && (
        <ol className={styles.captions} aria-label="Live captions">
          {captions.map((c, i) => (
            <li key={`${c.at}-${i}`} data-who={c.who}>
              <b>{WHO[c.who]}</b> {c.text}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {can('voice:answer') && (
        <div className={styles.actions}>
          {joined ? (
            <>
              <Button size="sm" onClick={() => leave(false)}>
                Leave call
              </Button>
              <Button size="sm" variant="ghost" onClick={() => leave(true)}>
                End call
              </Button>
            </>
          ) : (
            <Button size="sm" icon="phone" onClick={() => void join()} disabled={busy || !state}>
              {busy ? 'Joining…' : 'Join call'}
            </Button>
          )}
        </div>
      )}
      {!joined && (
        <p className={styles.note}>
          Joining takes the call over: the AI stops talking and the caller hears you.
        </p>
      )}
    </div>
  );
}

function EndedCall({ call }: { call: VoiceCallView }) {
  const { can } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setUrl(URL.createObjectURL(await fetchBlob(`/voice/calls/${call.id}/recording`)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <li className={styles.ended} data-call={call.id}>
      <p>{callLine(call)}</p>
      <p className={styles.note}>
        {[
          placedCallText(call),
          placedCallText(call) && call.outcome !== 'connected' ? null : answeredByText(call),
          call.endedReason ? END_REASONS[call.endedReason] : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {call.recording ? (
        can('voice:recording_read') ? (
          url ? (
            // The recording is stereo: the caller on the left, our side on the right.
            <audio className={styles.player} controls src={url} aria-label="Call recording" />
          ) : (
            <Button size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? 'Loading…' : 'Play recording'}
            </Button>
          )
        ) : (
          <p className={styles.note}>Recorded. Supervisors can listen.</p>
        )
      ) : (
        <p className={styles.note}>No recording (not kept, or deleted after 30 days).</p>
      )}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </li>
  );
}
