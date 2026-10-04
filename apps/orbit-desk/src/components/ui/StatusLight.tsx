import { HEALTH_LABELS, type HealthState } from '@tms/shared';
import { cx } from '../../lib/format';
import styles from './StatusLight.module.css';

interface StatusLightProps {
  state: HealthState;
  /** Text next to the light; defaults to "Working", "Needs attention", "Not working" or "Off". */
  label?: string;
  /** Show only the light; the label is still read out. */
  compact?: boolean;
  className?: string;
}

/**
 * A connection light: green works, amber needs a look, red is broken, grey is
 * off. The one place the console uses these colours (DESIGN.md › Connection
 * lights); the label always says the same thing in words. Also used, at the
 * user's request, for a customer's phone number: green when it is verified.
 */
export function StatusLight({ state, label, compact, className }: StatusLightProps) {
  const text = label ?? HEALTH_LABELS[state];
  return (
    <span className={cx(styles.light, className)} data-state={state}>
      <span className={styles.dot} aria-hidden="true" />
      <span className={compact ? 'visually-hidden' : styles.label}>{text}</span>
    </span>
  );
}
