import type { OverviewReport } from '@tms/shared';
import { channelIcons, channelLabels, glyphFor, isOpenCategory } from '../../data/adapters';
import { Card, CardHeader, Icon, Meter, StatusGlyph } from '../../components/ui';
import { cx } from '../../lib/format';
import styles from './QueueBreakdown.module.css';

export function QueueBreakdown({ overview }: { overview: OverviewReport }) {
  const rows = [
    ...overview.byStatus
      .filter((s) => isOpenCategory(s.category))
      .map((s) => ({
        key: s.status,
        name: s.name,
        glyph: glyphFor(s.status, s.category),
        count: s.count,
      })),
    {
      key: 'resolved_today',
      name: 'Resolved today',
      glyph: 'resolved' as const,
      count: overview.resolvedToday,
    },
  ];
  const maxStatus = Math.max(1, ...rows.map((s) => s.count));
  const openTotal = overview.byChannel.reduce((sum, c) => sum + c.count, 0);

  return (
    <Card aria-labelledby="queue-title" className={styles.card}>
      <CardHeader
        id="queue-title"
        title="Queue health"
        subtitle={`${overview.open} open · ${overview.resolvedToday} resolved today`}
      />

      <ul className={styles.list}>
        {rows.map(({ key, name, glyph, count }) => (
          <li key={key} className={styles.row} data-status={key}>
            <span className={styles.name}>
              <StatusGlyph status={glyph} />
              {name}
            </span>
            <span className={cx(styles.count, 'tabular')}>{count}</span>
            <Meter
              value={count}
              max={maxStatus}
              label={`${name}: ${count}`}
              alertAt={2}
              className={styles.meter}
            />
          </li>
        ))}
      </ul>

      <p className={styles.subhead}>Open by channel</p>
      {overview.byChannel.length === 0 ? (
        <p className={styles.channelName}>No open tickets.</p>
      ) : (
        <ul className={styles.channels}>
          {overview.byChannel.map((c) => (
            <li key={c.channel} data-channel={c.channel}>
              <Icon name={channelIcons[c.channel]} size={16} />
              <span className={styles.channelName}>{channelLabels[c.channel]}</span>
              <span className={cx(styles.count, 'tabular')}>
                {Math.round((c.count / Math.max(openTotal, 1)) * 100)}%
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
