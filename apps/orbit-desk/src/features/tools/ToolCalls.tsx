import { APPROVAL_REASON_MIN, type ToolCallView } from '@tms/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Icon, type IconName, Textarea } from '../../components/ui';
import { AiMark } from '../ai/AiParts';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import { argsLine, CALL_STATUS_LABELS, resultPreview } from './logic';
import styles from './Tools.module.css';

const STATUS_ICON: Partial<Record<ToolCallView['status'], IconName>> = {
  ok: 'check',
  awaiting_approval: 'clock',
  approved: 'clock',
  running: 'clock',
  error: 'alert',
  denied: 'x',
  rejected: 'x',
  expired: 'x',
};

/** The drawer's "Company actions": what the AI looked up or asked to do, with approvals inline. */
export function ToolCalls({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const { can } = useSession();
  const calls = useGet<ToolCallView[]>(`/tickets/${ticketId}/tool-calls`);
  const reload = calls.reload;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The decision being made: it needs a reason before it can be sent.
  const [deciding, setDeciding] = useState<{
    approvalId: string;
    decision: 'approve' | 'reject';
  } | null>(null);
  const [reason, setReason] = useState('');

  if (!calls.data?.length) return null;

  const decide = async () => {
    if (!deciding) return;
    setBusy(deciding.approvalId);
    setError(null);
    try {
      await api('POST', `/approvals/${deciding.approvalId}/decide`, {
        decision: deciding.decision,
        reason: reason.trim(),
      });
      setDeciding(null);
      setReason('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
      void reload();
    }
  };

  return (
    <section className={styles.panel} aria-label="Company actions">
      <h3 className={styles.panelTitle}>Company actions</h3>
      <ul className={styles.calls}>
        {calls.data.map((c) => {
          const pending = c.status === 'awaiting_approval' && c.approval?.status === 'pending';
          return (
            <li key={c.id} className={styles.call} data-call-status={c.status}>
              <div className={styles.callHead}>
                <span>
                  {c.tool.title ?? c.tool.name}
                  {c.actor === 'ai' && <AiMark />}
                </span>
                <span className={cx(styles.status, pending && styles.attention)}>
                  <Icon name={STATUS_ICON[c.status] ?? 'more'} size={14} />
                  {CALL_STATUS_LABELS[c.status]}
                </span>
              </div>
              <p className={styles.callArgs}>
                {argsLine(c.args, c.tool.customerArg ? [c.tool.customerArg] : []) || 'No details'}
              </p>
              {c.error && <p className={styles.callArgs}>{c.error}</p>}
              {c.status === 'ok' && c.result !== null && (
                <p className={cx(styles.callArgs, styles.toolKey)}>
                  {resultPreview(c.result, 180)}
                </p>
              )}
              {pending &&
                can('approval:approve') &&
                (deciding?.approvalId === c.approval!.id ? (
                  <div className={styles.decide}>
                    <Textarea
                      id={`reason-${c.approval!.id}`}
                      label={`Reason for ${deciding.decision === 'approve' ? 'approving' : 'rejecting'} (the customer will be told this)`}
                      rows={2}
                      required
                      maxLength={1000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <div className={styles.decideButtons}>
                      <Button size="sm" variant="ghost" onClick={() => setDeciding(null)}>
                        Back
                      </Button>
                      <Button
                        size="sm"
                        icon={deciding.decision === 'approve' ? 'check' : undefined}
                        disabled={
                          busy === c.approval!.id || reason.trim().length < APPROVAL_REASON_MIN
                        }
                        onClick={() => void decide()}
                      >
                        {deciding.decision === 'approve' ? 'Approve' : 'Reject'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.decideButtons}>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setReason('');
                        setDeciding({ approvalId: c.approval!.id, decision: 'reject' });
                      }}
                    >
                      Reject…
                    </Button>
                    <Button
                      size="sm"
                      icon="check"
                      onClick={() => {
                        setReason('');
                        setDeciding({ approvalId: c.approval!.id, decision: 'approve' });
                      }}
                    >
                      Approve…
                    </Button>
                  </div>
                ))}
            </li>
          );
        })}
      </ul>
      {error && (
        <p className={styles.callArgs} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
