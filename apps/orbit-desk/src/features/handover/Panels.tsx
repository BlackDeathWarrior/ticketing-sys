import { CSAT_LABELS, type CsatView, type HandoverView, type TicketSlaView } from '@tms/shared';
import { useEffect, useState } from 'react';
import { Icon, SlaIndicator, Tabs } from '../../components/ui';
import { minutesSince } from '../../data/adapters';
import { relativeTime } from '../../lib/format';
import { useGet } from '../../lib/useGet';
import { AiMark } from '../ai/AiParts';
import styles from './Handover.module.css';
import { ACTOR_FILTERS, actionLabel, TIMER_LABELS, timerText } from './logic';

function useLive<T>(path: string, liveTick: number) {
  const r = useGet<T>(path);
  const reload = r.reload;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);
  return r;
}

const TIMER_UI = {
  running: 'on-track',
  paused: 'done',
  met: 'done',
  breached: 'breached',
} as const;

/** First-response and resolution timers for the ticket's SLA policy. */
export function SlaPanel({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const sla = useLive<TicketSlaView>(`/tickets/${ticketId}/sla`, liveTick);
  if (!sla.data?.timers.length) return null;
  return (
    <section className={styles.panel} aria-label="SLA">
      <h3 className={styles.panelTitle}>
        <Icon name="clock" size={14} />
        SLA · {sla.data.policy?.name ?? 'policy removed'}
      </h3>
      <dl className={styles.timers}>
        {sla.data.timers.map((t) => (
          <div key={t.kind} data-timer={t.kind} data-state={t.state}>
            <dt>{TIMER_LABELS[t.kind]}</dt>
            <dd>
              <SlaIndicator
                minutes={
                  t.dueAt ? Math.round((new Date(t.dueAt).getTime() - Date.now()) / 60_000) : null
                }
                state={t.state === 'running' && t.atRisk ? 'at-risk' : TIMER_UI[t.state]}
                label={timerText(t)}
              />
              <span className={styles.muted}>Target {t.targetMinutes} business minutes</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const RATED_IN = {
  email: 'from the survey email',
  chat: 'in the chat',
  portal: 'in the portal',
  api: 'in the app',
};

/** The customer's rating, once they have given one. Staff can read it, never set it. */
export function RatingPanel({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const r = useLive<{ rating: CsatView | null }>(`/tickets/${ticketId}/rating`, liveTick);
  const rating = r.data?.rating;
  if (!rating) return null;
  return (
    <section className={styles.panel} aria-label="Customer rating" data-rating={rating.rating}>
      <h3 className={styles.panelTitle}>
        <Icon name="target" size={14} />
        Customer rating
      </h3>
      <p className={styles.rating}>
        <span className="tabular">{rating.rating} / 5</span> · {CSAT_LABELS[rating.rating]}
      </p>
      {rating.comment && <p className={styles.ratingComment}>“{rating.comment}”</p>}
      <p className={styles.muted}>
        Given {RATED_IN[rating.source]} · {relativeTime(minutesSince(new Date(rating.updatedAt)))}
      </p>
    </section>
  );
}

const SOURCE_LABEL = { ai: 'the AI', agent: 'a colleague', customer: 'the customer' } as const;

/** The latest handover and its context pack: what happened, and what to do next. */
export function HandoverContext({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const list = useLive<HandoverView[]>(`/tickets/${ticketId}/handovers`, liveTick);
  const [latest, ...older] = list.data ?? [];
  if (!latest) return null;
  const p = latest.pack;
  return (
    <section className={styles.panel} aria-label="Handover context">
      <h3 className={styles.panelTitle}>
        <Icon name="users" size={14} />
        Handover from {SOURCE_LABEL[latest.source]} ·{' '}
        {relativeTime(minutesSince(new Date(latest.createdAt)))}
        {p?.writtenBy === 'model' && <AiMark label="Summary by AI" />}
      </h3>
      <div className={styles.pack}>
        <p className={styles.muted}>
          {latest.reason}
          {latest.routedUser
            ? ` · routed to ${latest.routedUser.name}`
            : latest.routedTeam
              ? ` · waiting in ${latest.routedTeam.name}`
              : ''}
        </p>
        {!p ? (
          <p className={styles.muted} role="status">
            Writing the context pack…
          </p>
        ) : (
          <>
            <p className={styles.lead}>{p.summary}</p>
            <div>
              <p className={styles.label}>Next step</p>
              <p className={styles.next}>{p.recommendedNextStep}</p>
            </div>
            {p.actions.length > 0 && (
              <div>
                <p className={styles.label}>Already done</p>
                <ul className={styles.list}>
                  {p.actions.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
            {p.retrieved.length > 0 && (
              <div>
                <p className={styles.label}>Looked up</p>
                <ul className={styles.list}>
                  {p.retrieved.map((a) => (
                    <li key={a}>{a}</li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {older.length > 0 && (
          <p className={styles.muted}>
            {older.length} earlier handover{older.length === 1 ? '' : 's'}
          </p>
        )}
      </div>
    </section>
  );
}

interface HistoryRow {
  id: number;
  occurredAt: string;
  action: string;
  actorType: string;
  actorName: string | null;
}

const ACTOR_NAME: Record<string, string> = { ai: 'AI', system: 'System', customer: 'Customer' };

/** The audit trail for the ticket, filterable by who acted (people, the AI, the system). */
export function History({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const [open, setOpen] = useState(false);
  const [actor, setActor] = useState<string>('');
  return (
    <section className={styles.panel} aria-label="History">
      <details onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
        <summary className={styles.summary}>History</summary>
        {open && (
          <>
            <Tabs
              label="Who acted"
              value={actor}
              onChange={setActor}
              items={ACTOR_FILTERS.map((f) => ({ value: f.value, label: f.label }))}
            />
            <HistoryList ticketId={ticketId} actor={actor} liveTick={liveTick} />
          </>
        )}
      </details>
    </section>
  );
}

function HistoryList({
  ticketId,
  actor,
  liveTick,
}: {
  ticketId: string;
  actor: string;
  liveTick: number;
}) {
  const rows = useLive<HistoryRow[]>(
    `/tickets/${ticketId}/history${actor ? `?actorType=${actor}` : ''}`,
    liveTick,
  );
  const items = [...(rows.data ?? [])].reverse().slice(0, 60);
  if (rows.data && !items.length) return <p className={styles.muted}>Nothing here.</p>;
  return (
    <ol className={styles.history} aria-label="History entries">
      {items.map((r) => (
        <li key={r.id} data-actor={r.actorType}>
          <time dateTime={r.occurredAt}>{relativeTime(minutesSince(new Date(r.occurredAt)))}</time>
          <span>
            <span className={styles.actor}>
              {r.actorType === 'user' ? (r.actorName ?? 'Someone') : ACTOR_NAME[r.actorType]}
            </span>{' '}
            · {actionLabel(r.action)}
          </span>
        </li>
      ))}
    </ol>
  );
}
