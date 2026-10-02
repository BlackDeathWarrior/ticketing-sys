import type { Channel, OverviewReport, TicketHandling } from '@tms/shared';
import type { RefObject } from 'react';
import { initials } from '../../data/adapters';
import type { Ticket } from '../../data/types';
import { AvatarGroup } from '../../components/ui';
import { useSession } from '../../lib/session';
import { ActivityFeed } from './ActivityFeed';
import { triage } from './logic';
import { QueueBreakdown } from './QueueBreakdown';
import { StatsRow } from './StatsRow';
import { TeamLoad } from './TeamLoad';
import { TicketTable } from './TicketTable';
import { TriageCard } from './TriageCard';
import { VolumeChart } from './VolumeChart';
import styles from './DashboardPage.module.css';

interface DashboardPageProps {
  queue: {
    title: string;
    tickets: Ticket[];
    total: number;
    loading: boolean;
    error?: string;
  };
  /** Open tickets for triage, independent of the selected view and search. */
  openTickets: Ticket[];
  overview: OverviewReport | undefined;
  search: string;
  onSearch: (value: string) => void;
  searchRef?: RefObject<HTMLInputElement | null>;
  /** Queue filtered to one channel, or '' for all. */
  channel: Channel | '';
  onChannel: (channel: Channel | '') => void;
  handling: TicketHandling | '';
  onHandling: (handling: TicketHandling | '') => void;
  selectedId: string | null;
  onOpenTicket: (id: string) => void;
  onShowUrgent: () => void;
  onClearFilters: () => void;
}

function greeting(now: Date) {
  const h = now.getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage({
  queue,
  openTickets,
  overview,
  search,
  onSearch,
  searchRef,
  channel,
  onChannel,
  handling,
  onHandling,
  selectedId,
  onOpenTicket,
  onShowUrgent,
  onClearFilters,
}: DashboardPageProps) {
  const { user } = useSession();
  const now = new Date();
  const byPriority = (p: string) =>
    overview
      ? (overview.byPriority.find((x) => x.priority === p)?.count ?? 0)
      : openTickets.filter((t) => t.priority === p).length;
  const urgent = byPriority('urgent');
  const high = byPriority('high');
  const unassigned = overview?.unassigned ?? openTickets.filter((t) => !t.assignee).length;
  const open = overview?.open ?? openTickets.length;
  const agents = overview?.byAssignee ?? [];

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>
            {now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}
          </p>
          <h1 className={styles.heading}>
            {greeting(now)}, {user.name.split(' ')[0]}.
          </h1>
          <p className={styles.lede}>
            Here is the state of the support sky: {open} open {open === 1 ? 'ticket' : 'tickets'}
            {overview ? ` across ${overview.byChannel.length} channels.` : '.'}
          </p>
        </div>
        {agents.length > 0 && (
          <div className={styles.shift}>
            <AvatarGroup
              people={agents.map((a) => ({ initials: initials(a.name), name: a.name }))}
              max={5}
              size={32}
            />
            <span>
              {agents.length} {agents.length === 1 ? 'agent' : 'agents'} with open work
            </span>
          </div>
        )}
      </header>

      <TriageCard
        focus={triage(openTickets)}
        urgent={urgent}
        high={high}
        unassigned={unassigned}
        onOpen={onOpenTicket}
        onShowUrgent={onShowUrgent}
      />

      {overview && <StatsRow overview={overview} />}

      {overview && (
        <div className={styles.split}>
          <VolumeChart volume={overview.volume} />
          <QueueBreakdown overview={overview} />
        </div>
      )}

      <TicketTable
        {...queue}
        search={search}
        onSearch={onSearch}
        searchRef={searchRef}
        channel={channel}
        onChannel={onChannel}
        handling={handling}
        onHandling={onHandling}
        selectedId={selectedId}
        onSelect={onOpenTicket}
        onClearFilters={onClearFilters}
      />

      {overview && (
        <div className={styles.pair}>
          <ActivityFeed events={overview.activity} onOpen={onOpenTicket} />
          <TeamLoad overview={overview} meId={user.id} />
        </div>
      )}
    </div>
  );
}
