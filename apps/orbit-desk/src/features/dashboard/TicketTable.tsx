import { useMemo, useState } from 'react';
import { agentById } from '../../data/mock';
import type { Ticket, TicketStatus } from '../../data/types';
import { viewById, type ViewId } from '../../data/views';
import { cx, relativeTime } from '../../lib/format';
import {
  Avatar,
  Button,
  Card,
  PriorityGlyph,
  SlaIndicator,
  StatusPill,
  Tabs,
  type TabItem,
} from '../../components/ui';
import styles from './TicketTable.module.css';

type StatusFilter = 'any' | TicketStatus;

interface TicketTableProps {
  tickets: Ticket[];
  view: ViewId;
  search: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClearFilters: () => void;
}

const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 } as const;

/** Most time-critical first: breached/at-risk SLAs, then priority, then recency. */
function byUrgency(a: Ticket, b: Ticket) {
  const sa = a.slaMinutes ?? Number.POSITIVE_INFINITY;
  const sb = b.slaMinutes ?? Number.POSITIVE_INFINITY;
  if (sa !== sb) return sa - sb;
  if (a.priority !== b.priority) return priorityRank[a.priority] - priorityRank[b.priority];
  return a.updatedMinutesAgo - b.updatedMinutesAgo;
}

function matchesSearch(t: Ticket, q: string) {
  if (!q) return true;
  const hay = [t.id, t.subject, t.customer.name, t.customer.company, ...t.tags]
    .join(' ')
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((term) => hay.includes(term));
}

export function TicketTable({
  tickets,
  view,
  search,
  selectedId,
  onSelect,
  onClearFilters,
}: TicketTableProps) {
  const [status, setStatus] = useState<StatusFilter>('any');
  const currentView = viewById(view);

  const scoped = useMemo(
    () => tickets.filter((t) => currentView.match(t) && matchesSearch(t, search.trim())),
    [tickets, currentView, search],
  );
  const rows = useMemo(
    () => scoped.filter((t) => status === 'any' || t.status === status).sort(byUrgency),
    [scoped, status],
  );

  const count = (s: StatusFilter) =>
    s === 'any' ? scoped.length : scoped.filter((t) => t.status === s).length;
  const tabs: TabItem<StatusFilter>[] = [
    { value: 'any', label: 'All', count: count('any') },
    { value: 'open', label: 'Open', count: count('open') },
    { value: 'in_progress', label: 'In progress', count: count('in_progress') },
    { value: 'waiting', label: 'Waiting', count: count('waiting') },
    { value: 'resolved', label: 'Resolved', count: count('resolved') },
  ];

  return (
    <Card padding="none" aria-labelledby="queue-table-title" className={styles.card} id="queue">
      <header className={styles.header}>
        <div>
          <h2 id="queue-table-title" className={styles.title}>
            {currentView.label}
          </h2>
          <p className={styles.subtitle}>
            Sorted by SLA urgency
            {search.trim() && (
              <>
                {' '}
                · matching “<span className={styles.query}>{search.trim()}</span>”
              </>
            )}
          </p>
        </div>
        <Tabs label="Filter by status" items={tabs} value={status} onChange={setStatus} />
      </header>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <svg
            width="56"
            height="40"
            viewBox="0 0 56 40"
            aria-hidden="true"
            className={styles.emptyArt}
          >
            <path d="M6 30 20 12l14 10L50 6" />
            <circle cx="6" cy="30" r="2" />
            <circle cx="20" cy="12" r="2" />
            <circle cx="34" cy="22" r="2" />
            <circle cx="50" cy="6" r="2" />
          </svg>
          <p className={styles.emptyTitle}>No tickets in this part of the sky</p>
          <p className={styles.emptyText}>Try another status, view or search term.</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setStatus('any');
              onClearFilters();
            }}
          >
            Clear filters
          </Button>
        </div>
      ) : (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              {currentView.label}, {rows.length} tickets. Activate a row to open the ticket.
            </caption>
            <thead>
              <tr>
                <th scope="col" className={styles.colTicket}>
                  Ticket
                </th>
                <th scope="col" className={styles.colStatus}>
                  Status
                </th>
                <th scope="col" className={styles.colPriority}>
                  Priority
                </th>
                <th scope="col" className={styles.colAssignee}>
                  Assignee
                </th>
                <th scope="col" className={styles.colSla}>
                  SLA
                </th>
                <th scope="col" className={styles.colUpdated}>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const assignee = agentById(t.assigneeId);
                return (
                  <tr
                    key={t.id}
                    className={cx(
                      styles.row,
                      t.id === selectedId && styles.selected,
                      t.status === 'resolved' && styles.dim,
                    )}
                    onClick={() => onSelect(t.id)}
                  >
                    <td className={styles.colTicket}>
                      <button
                        type="button"
                        className={styles.subject}
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelect(t.id);
                        }}
                      >
                        <span className={styles.id}>{t.id}</span>
                        <span className={styles.subjectText}>{t.subject}</span>
                      </button>
                      <span className={styles.customer}>
                        {t.customer.name} · {t.customer.company}
                      </span>
                    </td>
                    <td className={styles.colStatus}>
                      <StatusPill status={t.status} />
                    </td>
                    <td className={styles.colPriority}>
                      <PriorityGlyph priority={t.priority} showLabel />
                    </td>
                    <td className={styles.colAssignee}>
                      {assignee ? (
                        <span className={styles.assignee}>
                          <Avatar initials={assignee.initials} size={24} />
                          <span>{assignee.name.split(' ')[0]}</span>
                        </span>
                      ) : (
                        <span className={styles.unassigned}>Unassigned</span>
                      )}
                    </td>
                    <td className={styles.colSla}>
                      <SlaIndicator minutes={t.status === 'resolved' ? null : t.slaMinutes} />
                    </td>
                    <td className={cx(styles.colUpdated, styles.updated, 'tabular')}>
                      {relativeTime(t.updatedMinutesAgo)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
