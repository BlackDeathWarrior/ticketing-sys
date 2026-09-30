import { type FormEvent, useState } from 'react';
import { api } from '../../api/client';
import { Button, Dialog, Icon, Select, Textarea } from '../../components/ui';
import type { Conversation, Ticket } from '../../data/types';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { AiMark } from '../ai/AiParts';
import styles from './Handover.module.css';
import { controllerText } from './logic';

interface Props {
  ticket: Ticket;
  /** The conversation replies go to. */
  target: Conversation | null;
  onChanged: () => void;
}

/**
 * Who is answering, and the buttons to change it (ADR 0014): take over from
 * the AI or the queue, hand back to the AI, pass the ticket on, escalate.
 */
export function ControlBar({ ticket, target, onChanged }: Props) {
  const { user, can } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'handover' | 'escalate' | null>(null);
  const who = controllerText(target, user.id);
  const teams = useGet<Array<{ id: string; name: string }>>(
    dialog === 'handover' ? '/teams' : null,
  );

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
      onChanged();
    }
  };

  const mayTake = can('conversation:takeover');
  const mine = target?.controller === 'human' && target.controllerUserId === user.id;
  const someoneElse = target?.controller === 'human' && !mine;

  return (
    <div className={styles.bar} aria-label="Who is answering" role="group">
      {who.tone === 'ai' ? (
        <AiMark label={who.text} />
      ) : (
        <span
          className={cx(
            styles.who,
            who.tone === 'waiting' && styles.waiting,
            who.tone === 'me' && styles.me,
          )}
          data-controller={target?.controller ?? 'none'}
        >
          <Icon name={who.tone === 'waiting' ? 'clock' : 'user'} size={14} />
          {who.text}
        </span>
      )}
      <span className={styles.spacer} />
      {mayTake && target && !mine && (
        <Button
          size="sm"
          icon="user"
          disabled={busy}
          onClick={() => void run(() => api('POST', `/conversations/${target.id}/take-over`))}
        >
          Take over
        </Button>
      )}
      {mayTake && target && target.controller !== 'ai' && !someoneElse && (
        <Button
          size="sm"
          variant="ghost"
          icon="sparkle"
          disabled={busy}
          onClick={() => void run(() => api('POST', `/conversations/${target.id}/hand-back`))}
        >
          Hand back to AI
        </Button>
      )}
      {mayTake && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog('handover')}>
          Hand over…
        </Button>
      )}
      {can('ticket:escalate') && (
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDialog('escalate')}>
          Escalate…
        </Button>
      )}
      {error && (
        <p className={cx(styles.error, styles.full)} role="alert">
          {error}
        </p>
      )}
      <ReasonDialog
        kind={dialog}
        teams={teams.data ?? []}
        onClose={() => setDialog(null)}
        onSubmit={async (reason, teamId) => {
          const ok = await run(() =>
            dialog === 'escalate'
              ? api('POST', `/tickets/${ticket.id}/escalate`, { reason })
              : api('POST', `/tickets/${ticket.id}/handover`, {
                  reason,
                  ...(teamId ? { teamId } : {}),
                }),
          );
          if (ok) setDialog(null);
        }}
      />
    </div>
  );
}

function ReasonDialog({
  kind,
  teams,
  onClose,
  onSubmit,
}: {
  kind: 'handover' | 'escalate' | null;
  teams: Array<{ id: string; name: string }>;
  onClose: () => void;
  onSubmit: (reason: string, teamId: string) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [teamId, setTeamId] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim().length < 3) return;
    await onSubmit(reason.trim(), teamId);
    setReason('');
    setTeamId('');
  };
  const title = kind === 'escalate' ? 'Escalate this ticket' : 'Hand this ticket over';
  return (
    <Dialog open={kind !== null} onClose={onClose} labelledBy="reason-title">
      <form className={styles.form} onSubmit={submit} aria-label={title}>
        <h2 id="reason-title" className={styles.dialogTitle}>
          {title}
        </h2>
        <p className={styles.muted}>
          {kind === 'escalate'
            ? 'Raises the priority one step and tells the team leads.'
            : 'Nobody answers until routing or a person picks it up. A context pack is written for them.'}
        </p>
        <Textarea
          id="reason-text"
          label="Reason"
          rows={3}
          required
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {kind === 'handover' && (
          <Select
            id="reason-team"
            label="Send to"
            value={teamId}
            onChange={(e) => setTeamId(e.target.value)}
            options={[
              { value: '', label: 'Let routing decide' },
              ...teams.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
        )}
        <div className={styles.actions}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={reason.trim().length < 3}>
            {kind === 'escalate' ? 'Escalate' : 'Hand over'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
