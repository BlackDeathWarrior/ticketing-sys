import { type LlmUsageView, ROLE_REQUIREMENTS, type ModelRole } from '@tms/shared';
import { Card, CardHeader, Meter } from '../../components/ui';
import { useGet } from '../../lib/useGet';
import { formatUsd, relativeFromIso } from './logic';
import styles from './Settings.module.css';

export function UsagePanel() {
  const usage = useGet<LlmUsageView>('/settings/llm/usage?days=30');
  const u = usage.data;
  const calls = u?.byRole.reduce((s, r) => s + r.calls, 0) ?? 0;
  const errors = u?.recent.filter((r) => r.status === 'error').length ?? 0;

  return (
    <div className={styles.stack}>
      {usage.error && <p className={styles.error}>{usage.error}</p>}
      <Card padding="md">
        <CardHeader title="Last 30 days" subtitle="From every AI call TMS made through LiteLLM." />
        <div className={styles.kpis}>
          <div>
            <div className={`${styles.kpiValue} tabular`}>{formatUsd(u?.totalUsd ?? 0)}</div>
            <div className={styles.kpiLabel}>Spend</div>
          </div>
          <div>
            <div className={`${styles.kpiValue} tabular`}>{calls}</div>
            <div className={styles.kpiLabel}>Calls</div>
          </div>
          <div>
            <div className={`${styles.kpiValue} tabular`}>{errors}</div>
            <div className={styles.kpiLabel}>Errors in the last 25 calls</div>
          </div>
        </div>
      </Card>

      <div className={styles.grid2}>
        <Card padding="md">
          <CardHeader title="By provider" subtitle="Spend against each provider's current cap." />
          {!u?.byProvider.length && <p className={styles.note}>No calls yet.</p>}
          <div className={styles.stack}>
            {u?.byProvider.map((p) => (
              <div key={p.providerId ?? p.label} className={styles.budget}>
                <span>
                  {p.label}{' '}
                  <span className={styles.muted}>
                    · {p.calls} calls · {formatUsd(p.costUsd)}
                  </span>
                </span>
                {p.budgetUsd !== null && p.budgetUsd > 0 && (
                  <Meter
                    value={p.periodSpentUsd}
                    max={p.budgetUsd}
                    label={`${p.label} spend against cap`}
                  />
                )}
                <span className={styles.budgetText}>
                  {p.budgetUsd === null
                    ? 'No cap'
                    : `${formatUsd(p.periodSpentUsd)} of ${formatUsd(p.budgetUsd)} this period`}
                </span>
              </div>
            ))}
          </div>
        </Card>
        <Card padding="md">
          <CardHeader title="By role" />
          {!u?.byRole.length && <p className={styles.note}>No calls yet.</p>}
          <table className={styles.table}>
            <tbody>
              {u?.byRole.map((r) => (
                <tr key={r.role}>
                  <td>{ROLE_REQUIREMENTS[r.role as ModelRole]?.label ?? r.role}</td>
                  <td className="tabular">{r.calls}</td>
                  <td className="tabular">{formatUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card padding="md">
        <CardHeader title="Recent calls" />
        <div className={styles.scroller}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Role</th>
                <th scope="col">Model</th>
                <th scope="col">Result</th>
                <th scope="col">Latency</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {u?.recent.map((r) => (
                <tr key={r.id}>
                  <td className={styles.nowrap}>{relativeFromIso(r.createdAt)}</td>
                  <td>{r.role}</td>
                  <td className={styles.mono}>{r.model}</td>
                  <td title={r.error ?? undefined}>{r.status === 'ok' ? 'OK' : 'Error'}</td>
                  <td className="tabular">{r.latencyMs} ms</td>
                  <td className="tabular">{formatUsd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
