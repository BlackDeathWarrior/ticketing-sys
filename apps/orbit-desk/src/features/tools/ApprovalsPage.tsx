import type { ApprovalView } from '@tms/shared';
import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { Button, Card, Icon, Tabs, Textarea } from '../../components/ui';
import { minutesSince } from '../../data/adapters';
import { cx, relativeTime } from '../../lib/format';
import { useGet } from '../../lib/useGet';
import page from '../settings/Settings.module.css';
import { APPROVAL_STATUS_LABELS, argRows, resultPreview, tierLabel, timeLeft } from './logic';
import styles from './Tools.module.css';

type Tab = 'pending' | 'decided';

/**
 * #/approvals: actions the AI asked for that need a supervisor, such as a
 * refund. Approving runs the action in the company system, then the AI tells
 * the customer; rejecting tells them it wasn't approved.
 */
export function ApprovalsPage({
  liveTick,
  onOpenTicket,
}: {
  liveTick: number;
  onOpenTicket: (ticketId: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('pending');
  const list = useGet<ApprovalView[]>('/approvals?limit=100');
  const reload = list.reload;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);

  const items = (list.data ?? []).filter((a) =>
    tab === 'pending' ? a.status === 'pending' : a.status !== 'pending',
  );
  const pending = (list.data ?? []).filter((a) => a.status === 'pending').length;

  return (
    <div className={page.page}>
      <header className={page.hero}>
        <p className={page.eyebrow}>Company actions</p>
        <h1 className={page.heading}>Approvals</h1>
        <p className={page.lede}>
          The AI can’t move money or make commitments on its own. Check each request against the
          customer’s words, then approve or reject it.
        </p>
      </header>
      <Tabs
        className={page.tabs}
        label="Approval status"
        value={tab}
        onChange={setTab}
        items={[
          { value: 'pending', label: 'Waiting', count: pending },
          { value: 'decided', label: 'Decided' },
        ]}
      />
      <div
        className={page.stack}
        role="tabpanel"
        aria-label={tab === 'pending' ? 'Waiting' : 'Decided'}
      >
        {list.error && <p className={page.error}>{list.error}</p>}
        {list.data && items.length === 0 && (
          <p className={page.note}>
            {tab === 'pending' ? 'Nothing is waiting for a decision.' : 'No decisions yet.'}
          </p>
        )}
        {items.map((a) => (
          <ApprovalCard key={a.id} approval={a} onOpenTicket={onOpenTicket} onDecided={reload} />
        ))}
      </div>
    </div>
  );
}

export function ApprovalCard({
  approval: a,
  onOpenTicket,
  onDecided,
}: {
  approval: ApprovalView;
  onOpenTicket?: (ticketId: string) => void;
  onDecided: () => void;
}) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hide = a.tool.customerArg ? [a.tool.customerArg] : [];

  const decide = async (decision: 'approve' | 'reject') => {
    setBusy(true);
    setError(null);
    try {
      await api('POST', `/approvals/${a.id}/decide`, {
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      onDecided();
    } catch (err) {
      setError((err as Error).message);
      onDecided();
    } finally {
      setBusy(false);
    }
  };

  const titleId = `approval-${a.id}`;
  return (
    <Card padding="md" aria-labelledby={titleId} data-approval={a.id}>
      <div className={styles.approval}>
        <div className={styles.approvalHead}>
          <h2 className={styles.approvalTitle} id={titleId}>
            {a.tool.title ?? a.tool.name}
            {' · '}
            {onOpenTicket ? (
              <button
                type="button"
                className={cx(page.mono, styles.linkish)}
                onClick={() => onOpenTicket(a.ticket.id)}
              >
                {a.ticket.reference}
              </button>
            ) : (
              <span className={page.mono}>{a.ticket.reference}</span>
            )}
          </h2>
          <span className={cx(styles.status, a.status === 'pending' && styles.attention)}>
            <Icon
              name={a.status === 'pending' ? 'clock' : a.status === 'approved' ? 'check' : 'x'}
              size={14}
            />
            {APPROVAL_STATUS_LABELS[a.status]}
            {a.status === 'pending' && ` · expires ${timeLeft(a.expiresAt)}`}
          </span>
        </div>

        <dl className={styles.facts}>
          <div>
            <dt>Customer</dt>
            <dd>{a.customer.name}</dd>
          </div>
          {argRows(a.args, hide).map((r) => (
            <div key={r.label}>
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
          <div>
            <dt>System</dt>
            <dd>
              {a.tool.serverName} · {tierLabel(a.tool.tier)}
            </dd>
          </div>
          <div>
            <dt>Asked</dt>
            <dd>{relativeTime(minutesSince(new Date(a.requestedAt)))}</dd>
          </div>
        </dl>

        {a.evidence && (
          <div>
            <p className={styles.label}>What the customer wrote</p>
            <blockquote className={styles.quote}>{a.evidence}</blockquote>
          </div>
        )}
        {a.reasoning && (
          <div>
            <p className={styles.label}>The AI’s reasoning</p>
            <blockquote className={styles.quote}>{a.reasoning}</blockquote>
          </div>
        )}

        {a.status === 'pending' ? (
          <div className={styles.decide}>
            <Textarea
              id={`${titleId}-note`}
              label="Note (internal, optional)"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <div className={styles.decideButtons}>
              <Button variant="ghost" onClick={() => void decide('reject')} disabled={busy}>
                Reject
              </Button>
              <Button icon="check" onClick={() => void decide('approve')} disabled={busy}>
                Approve
              </Button>
            </div>
          </div>
        ) : (
          <p className={styles.meta}>
            {a.decidedBy && <span>By {a.decidedBy.name}</span>}
            {a.decidedAt && <span>{relativeTime(minutesSince(new Date(a.decidedAt)))}</span>}
            {a.note && <span>Note: {a.note}</span>}
            {a.error && <span className={styles.attention}>Failed: {a.error}</span>}
            {a.result !== null && a.result !== undefined && (
              <span className={page.mono}>{resultPreview(a.result, 160)}</span>
            )}
          </p>
        )}
        {error && (
          <p className={page.error} role="alert">
            {error}
          </p>
        )}
      </div>
    </Card>
  );
}
