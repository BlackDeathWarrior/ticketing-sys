import { kpis } from '../../data/mock';
import { cx } from '../../lib/format';
import { Card, Icon, Sparkline } from '../../components/ui';
import styles from './StatsRow.module.css';

export function StatsRow() {
  return (
    <section className={styles.row} aria-label="Key metrics">
      {kpis.map((k) => (
        <Card key={k.id} as="article" className={styles.stat}>
          <p className={styles.label}>{k.label}</p>
          <p className={cx(styles.value, 'tabular')}>{k.value}</p>
          <div className={styles.foot}>
            <p className={styles.delta}>
              <span className={cx(styles.change, k.good && styles.good)}>
                <Icon name="arrowUpRight" size={12} className={k.trend === 'down' ? styles.down : undefined} />
                {k.delta}
              </span>
              <span className={styles.context}>{k.deltaLabel}</span>
            </p>
            <Sparkline data={k.series} width={96} height={32} label={`${k.label} trend, last 10 days`} />
          </div>
        </Card>
      ))}
    </section>
  );
}
