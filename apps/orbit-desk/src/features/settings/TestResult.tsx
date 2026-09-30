import { Icon } from '../../components/ui';
import { cx } from '../../lib/format';
import { relativeFromIso } from './logic';
import styles from './Settings.module.css';

/** A connection test outcome: a check or an alert glyph with a label, never a colour. */
export function TestResult({
  result,
}: {
  result: { ok: boolean; at?: string; error?: string } | null | undefined;
}) {
  if (!result) return <span className={styles.muted}>Not tested</span>;
  return (
    <span
      className={cx(styles.result, !result.ok && styles.resultFail)}
      title={result.error ?? undefined}
    >
      <Icon name={result.ok ? 'check' : 'alert'} size={14} />
      {result.ok ? 'Connected' : 'Failed'}
      {result.at && <span className={styles.muted}>· {relativeFromIso(result.at)}</span>}
    </span>
  );
}
