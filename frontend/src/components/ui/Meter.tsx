import { cx } from '../../lib/format';
import styles from './Meter.module.css';

interface MeterProps {
  value: number;
  max: number;
  label: string;
  /** Fill switches to the lavender accent at/above this ratio. */
  alertAt?: number;
  className?: string;
}

/** Thin magnitude bar — one hue, rounded data end anchored at the baseline. */
export function Meter({ value, max, label, alertAt = 0.85, className }: MeterProps) {
  const ratio = Math.min(value / max, 1);
  return (
    <span
      className={cx(styles.track, className)}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-label={label}
    >
      <span className={cx(styles.fill, ratio >= alertAt && styles.alert)} style={{ width: `${ratio * 100}%` }} />
    </span>
  );
}
