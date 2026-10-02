import {
  CHANNELS,
  type Channel,
  HANDLING_LABELS,
  TICKET_HANDLING,
  type TicketHandling,
} from '@tms/shared';
import { type RefObject, useMemo, useState } from 'react';
import { channelLabels, minutesSince } from '../../data/adapters';
import type { Ticket } from '../../data/types';
import { cx, relativeTime } from '../../lib/format';
import {
  Avatar,
  Badge,
  Button,
  Card,
  PriorityGlyph,
  SearchField,
  Select,
  SlaIndicator,
  StatusPill,
  Tabs,
  type TabItem,
} from '../../components/ui';
import { AiMark } from '../ai/AiParts';
import {
  inTab,
  isNewTicket,
  type SortBy,
  sortOptions,
  sortTickets,
  type StatusTab,
  statusTabs,
} from './logic';
import styles from './TicketTable.module.css';

const HANDLING_OPTIONS = [
  { value: '', label: 'Anyone handling' },
  ...TICKET_HANDLING.map((h) => ({ value: h, label: HANDLING_LABELS[h] })),
];

const CHANNEL_OPTIONS = [
  { value: '', label: 'All channels' },
  ...CHANNELS.map((c) => ({ value: c, label: channelLabels[c] })),
];

interface TicketTableProps {
  title: string;
  tickets: Ticket[];
  /** Server-side total for the view and search (the list may be capped). */
  total: number;
  loading: boolean;
  error?: string;
  search: string;
  onSearch: (value: string) => void;
  /** So "/" can put the cursor in the search box from anywhere. */
  searchRef?: RefObject<HTMLInputElement | null>;
  channel: Channel | '';
  onChannel: (channel: Channel | '') => void;
  /** AI-handled, human-handled or handed-over tickets only. */
  handling: TicketHandling | '';
  onHandling: (handling: TicketHandling | '') => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClearFilters: () => void;
}

export function TicketTable({
  title,
  tickets,
  total,
  loading,
  error,
  search,
  onSearch,
  searchRef,
  channel,
  onChannel,
  handling,
  onHandling,
  selectedId,
  onSelect,
  onClearFilters,
}: TicketTableProps) {
  const [tab, setTab] = useState<StatusTab>('any');
  const [sort, setSort] = useState<SortBy>('newest');

  const rows = useMemo(
    () =>
      sortTickets(
        tickets.filter((t) => inTab(t.status.category, tab)),
        sort,
      ),
    [tickets, tab, sort],
  );
  const filtered = Boolean(search.trim() || channel || handling || tab !== 'any');
  const tabs: TabItem<StatusTab>[] = statusTabs.map((s) => ({
    ...s,
    count: tickets.filter((t) => inTab(t.status.category, s.value)).length,
  }));
  const q = search.trim();

  return (
    <Card padding="none" aria-labelledby="queue-table-title" className={styles.card} id="queue">
      <header className={styles.header}>
        <div>
          <h2 id="queue-table-title" className={styles.title}>
            {title}
          </h2>
          <p className={styles.subtitle} aria-live="polite">
            {loading && !tickets.length
              ? 'Loading…'
              : sortOptions.find((s) => s.value === sort)!.label}
            {q && (
              <>
                {' '}
                · matching “<span className={styles.query}>{q}</span>”
              </>
            )}
            {channel && ` · ${channelLabels[channel]} only`}
            {handling && ` · ${HANDLING_LABELS[handling]}`}
            {total > tickets.length && ` · showing ${tickets.length} of ${total}`}
            {filtered && (
              <>
                {' · '}
                <button
                  type="button"
                  className={styles.clear}
                  onClick={() => {
                    setTab('any');
                    onClearFilters();
                  }}
                >
                  Clear filters
                </button>
              </>
            )}
          </p>
        </div>
        <div className={styles.controls}>
          <div className={styles.search} role="search">
            <label htmlFor="global-search" className="visually-hidden">
              Search tickets
            </label>
            <SearchField
              id="global-search"
              ref={searchRef}
              placeholder="Search subject or TMS number…"
              shortcut="/"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  onSearch('');
                  e.currentTarget.blur();
                }
              }}
            />
          </div>
          <Select
            id="queue-sort"
            label="Sort"
            hideLabel
            className={styles.channelSelect}
            value={sort}
            options={sortOptions}
            onChange={(e) => setSort(e.target.value as SortBy)}
          />
          <Select
            id="queue-handling"
            label="Handled by"
            hideLabel
            className={styles.channelSelect}
            value={handling}
            options={HANDLING_OPTIONS}
            onChange={(e) => onHandling(e.target.value as TicketHandling | '')}
          />
          <Select
            id="queue-channel"
            label="Channel"
            hideLabel
            className={styles.channelSelect}
            value={channel}
            options={CHANNEL_OPTIONS}
            onChange={(e) => onChannel(e.target.value as Channel | '')}
          />
          <Tabs label="Filter by status" items={tabs} value={tab} onChange={setTab} />
        </div>
      </header>

      {error ? (
        <div className={styles.empty} role="alert">
          <p className={styles.emptyTitle}>Couldn’t load tickets</p>
          <p className={styles.emptyText}>{error}</p>
        </div>
      ) : rows.length === 0 ? (
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
          <p className={styles.emptyTitle}>
            {loading ? 'Loading tickets…' : 'No tickets in this part of the sky'}
          </p>
          {!loading && (
            <>
              <p className={styles.emptyText}>Try another status, view or search term.</p>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setTab('any');
                  onClearFilters();
                }}
              >
                Clear filters
              </Button>
            </>
          )}
        </div>
      ) : (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <caption className="visually-hidden">
              {title}, {rows.length} tickets. Activate a row to open the ticket.
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
                  Channel
                </th>
                <th scope="col" className={styles.colUpdated}>
                  Updated
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr
                  key={t.id}
                  data-ticket={t.reference}
                  className={cx(
                    styles.row,
                    t.id === selectedId && styles.selected,
                    t.status.glyph === 'resolved' && styles.dim,
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
                      <span className={styles.id}>{t.reference}</span>
                      <span className={styles.subjectText}>{t.subject}</span>
                    </button>
                    {isNewTicket(t) && (
                      <Badge tone="ai" className={styles.newBadge} data-new>
                        New
                      </Badge>
                    )}
                    <span className={styles.customer}>
                      {t.customer.name}
                      {t.customer.company && ` · ${t.customer.company}`}
                    </span>
                  </td>
                  <td className={styles.colStatus}>
                    <StatusPill status={t.status.glyph} label={t.status.name} />
                    {t.sla && t.sla.raw !== 'met' && (
                      <span className={styles.sla} data-sla={t.sla.raw}>
                        <SlaIndicator
                          minutes={t.sla.minutes}
                          state={t.sla.state}
                          label={t.sla.label}
                        />
                      </span>
                    )}
                  </td>
                  <td className={styles.colPriority}>
                    <PriorityGlyph priority={t.priority} showLabel />
                  </td>
                  <td className={styles.colAssignee}>
                    {t.assignee ? (
                      <span className={styles.assignee}>
                        <Avatar initials={t.assignee.initials} size={24} />
                        <span>{t.assignee.name.split(' ')[0]}</span>
                      </span>
                    ) : (
                      <span className={styles.unassigned}>Unassigned</span>
                    )}
                    {t.handling === 'ai' && (
                      <span className={styles.handling} data-handling="ai">
                        <AiMark label="AI" />
                      </span>
                    )}
                    {t.handling === 'handed_over' && (
                      <span
                        className={cx(styles.handling, styles.handedOver)}
                        data-handling="handed_over"
                      >
                        Handed over
                      </span>
                    )}
                  </td>
                  <td className={cx(styles.colSla, styles.updated)}>{channelLabels[t.channel]}</td>
                  <td className={cx(styles.colUpdated, styles.updated, 'tabular')}>
                    {relativeTime(minutesSince(t.updatedAt))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
