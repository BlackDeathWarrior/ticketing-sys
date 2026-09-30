import type { Priority } from '../../data/types';
import { cx } from '../../lib/format';
import styles from './PriorityGlyph.module.css';

export const priorityLabels: Record<Priority, string> = {
  urgent: 'Urgent',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const level: Record<Priority, number> = { low: 1, medium: 2, high: 3, urgent: 4 };

/** Signal-bar priority: magnitude by filled bars; only "urgent" takes the accent. */
export function PriorityGlyph({ priority, showLabel }: { priority: Priority; showLabel?: boolean }) {
  const filled = level[priority];
  return (
    <span className={cx(styles.priority, styles[priority])} title={`${priorityLabels[priority]} priority`}>
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={1 + i * 3.25}
            y={10 - i * 2.5}
            width="2"
            height={3 + i * 2.5}
            rx="1"
            className={i < filled ? styles.on : styles.off}
          />
        ))}
      </svg>
      {showLabel ? <span className={styles.label}>{priorityLabels[priority]}</span> : <span className="visually-hidden">{priorityLabels[priority]} priority</span>}
    </span>
  );
}
