import { agents } from '../../data/mock';
import type { Ticket } from '../../data/types';
import type { ViewId } from '../../data/views';
import { AvatarGroup } from '../../components/ui';
import { ActivityFeed } from './ActivityFeed';
import { QueueBreakdown } from './QueueBreakdown';
import { StatsRow } from './StatsRow';
import { TeamLoad } from './TeamLoad';
import { TicketTable } from './TicketTable';
import { TriageCard } from './TriageCard';
import { VolumeChart } from './VolumeChart';
import styles from './DashboardPage.module.css';

interface DashboardPageProps {
  tickets: Ticket[];
  view: ViewId;
  search: string;
  selectedId: string | null;
  onOpenTicket: (id: string) => void;
  onSelectView: (view: ViewId) => void;
  onClearFilters: () => void;
}

export function DashboardPage({ tickets, view, search, selectedId, onOpenTicket, onSelectView, onClearFilters }: DashboardPageProps) {
  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <div>
          <p className={styles.eyebrow}>Tuesday, 30 September</p>
          <h1 className={styles.heading}>Good morning, Maya.</h1>
          <p className={styles.lede}>Here is the state of the support sky — 142 open tickets across four teams.</p>
        </div>
        <div className={styles.shift}>
          <AvatarGroup people={agents.map((a) => ({ initials: a.initials, name: a.name }))} max={5} size={32} />
          <span>6 agents on shift</span>
        </div>
      </header>

      <TriageCard tickets={tickets} onOpen={onOpenTicket} onShowUrgent={() => onSelectView('urgent')} />

      <StatsRow />

      <div className={styles.split}>
        <VolumeChart />
        <QueueBreakdown />
      </div>

      <TicketTable tickets={tickets} view={view} search={search} selectedId={selectedId} onSelect={onOpenTicket} onClearFilters={onClearFilters} />

      <div className={styles.pair}>
        <ActivityFeed onOpen={onOpenTicket} />
        <TeamLoad />
      </div>
    </div>
  );
}
