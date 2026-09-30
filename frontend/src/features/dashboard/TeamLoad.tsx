import { agents } from '../../data/mock';
import { cx } from '../../lib/format';
import { Avatar, Card, CardHeader, Meter } from '../../components/ui';
import styles from './TeamLoad.module.css';

const load: Record<string, number> = { a1: 9, a2: 15, a3: 13, a4: 11, a5: 9, a6: 6 };

export function TeamLoad() {
  return (
    <Card aria-labelledby="load-title">
      <CardHeader id="load-title" title="Team load" subtitle="Open tickets vs. capacity" />
      <ul className={styles.list}>
        {agents.map((a) => {
          const value = load[a.id] ?? 0;
          const near = value / a.capacity >= 0.85;
          return (
            <li key={a.id} className={styles.row}>
              <Avatar initials={a.initials} size={28} />
              <div className={styles.info}>
                <p className={styles.top}>
                  <span className={styles.name}>{a.name}</span>
                  <span className={cx(styles.count, near && styles.near, 'tabular')}>
                    {value}/{a.capacity}
                    {near && <span className={styles.flag}> · near capacity</span>}
                  </span>
                </p>
                <Meter value={value} max={a.capacity} label={`${a.name}: ${value} of ${a.capacity}`} />
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
