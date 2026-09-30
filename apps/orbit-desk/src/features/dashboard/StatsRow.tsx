import type { OverviewReport } from '@tms/shared';
import { cx } from '../../lib/format';
import { Card, Sparkline } from '../../components/ui';
import { kpis } from './logic';
import styles from './StatsRow.module.css';

export function StatsRow({ overview }: { overview: OverviewReport }) {
  return (
    <section className={styles.row} aria-label="Key metrics">
      {kpis(overview).map((k) => (
        <Card key={k.id} as="article" className={styles.stat} data-kpi={k.id}>
          <p className={styles.label}>{k.label}</p>
          <p className={cx(styles.value, 'tabular')}>{k.value}</p>
          <div className={styles.foot}>
            <p className={styles.delta}>
              <span className={styles.context}>{k.context}</span>
            </p>
            {k.series && (
              <Sparkline data={k.series} width={96} height={32} label={k.seriesLabel ?? k.label} />
            )}
          </div>
        </Card>
      ))}
    </section>
  );
}
