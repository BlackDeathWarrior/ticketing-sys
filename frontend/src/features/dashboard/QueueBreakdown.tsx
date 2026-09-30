import type { TicketStatus } from '../../data/types';
import { Card, CardHeader, Icon, Meter, StatusGlyph, statusLabels, type IconName } from '../../components/ui';
import { cx } from '../../lib/format';
import styles from './QueueBreakdown.module.css';

const byStatus: { status: TicketStatus; count: number }[] = [
  { status: 'open', count: 58 },
  { status: 'in_progress', count: 47 },
  { status: 'waiting', count: 37 },
  { status: 'resolved', count: 64 },
];

const byChannel: { icon: IconName; label: string; share: number }[] = [
  { icon: 'mail', label: 'Email', share: 46 },
  { icon: 'chat', label: 'Live chat', share: 28 },
  { icon: 'globe', label: 'Web form', share: 18 },
  { icon: 'phone', label: 'Phone', share: 8 },
];

export function QueueBreakdown() {
  const maxStatus = Math.max(...byStatus.map((s) => s.count));
  return (
    <Card aria-labelledby="queue-title" className={styles.card}>
      <CardHeader id="queue-title" title="Queue health" subtitle="142 open · 64 resolved today" />

      <ul className={styles.list}>
        {byStatus.map(({ status, count }) => (
          <li key={status} className={styles.row}>
            <span className={styles.name}>
              <StatusGlyph status={status} />
              {status === 'resolved' ? 'Resolved today' : statusLabels[status]}
            </span>
            <span className={cx(styles.count, 'tabular')}>{count}</span>
            <Meter value={count} max={maxStatus} label={`${statusLabels[status]}: ${count}`} alertAt={2} className={styles.meter} />
          </li>
        ))}
      </ul>

      <p className={styles.subhead}>By channel</p>
      <ul className={styles.channels}>
        {byChannel.map((c) => (
          <li key={c.label}>
            <Icon name={c.icon} size={16} />
            <span className={styles.channelName}>{c.label}</span>
            <span className={cx(styles.count, 'tabular')}>{c.share}%</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
