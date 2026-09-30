import type { OverviewReport } from '@tms/shared';
import { initials } from '../../data/adapters';
import { cx } from '../../lib/format';
import { Avatar, Card, CardHeader, Meter } from '../../components/ui';
import styles from './TeamLoad.module.css';

/** Open tickets per agent, relative to the busiest agent (capacity isn't modelled yet). */
export function TeamLoad({ overview, meId }: { overview: OverviewReport; meId: string }) {
  const rows = overview.byAssignee;
  const busiest = Math.max(1, ...rows.map((r) => r.open));
  return (
    <Card aria-labelledby="load-title">
      <CardHeader id="load-title" title="Team load" subtitle="Open tickets per agent" />
      {rows.length === 0 ? (
        <p className={styles.top}>Nobody has open tickets assigned.</p>
      ) : (
        <ul className={styles.list}>
          {rows.map((a) => {
            const top = a.open === busiest && rows.length > 1;
            return (
              <li key={a.id} className={styles.row}>
                <Avatar initials={initials(a.name)} size={28} highlight={a.id === meId} />
                <div className={styles.info}>
                  <p className={styles.top}>
                    <span className={styles.name}>{a.name}</span>
                    <span className={cx(styles.count, top && styles.near, 'tabular')}>
                      {a.open} open
                      {top && <span className={styles.flag}> · busiest</span>}
                    </span>
                  </p>
                  <Meter value={a.open} max={busiest} label={`${a.name}: ${a.open} open tickets`} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
