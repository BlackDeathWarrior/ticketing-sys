import { cx } from '../../lib/format';
import styles from './AuroraDivider.module.css';

export function AuroraDivider({ vertical, className }: { vertical?: boolean; className?: string }) {
  return (
    <span
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      className={cx(styles.aurora, vertical ? styles.vertical : styles.horizontal, className)}
    />
  );
}
