import type { TicketStatus } from '../../data/types';
import { cx } from '../../lib/format';
import styles from './StatusPill.module.css';

export const statusLabels: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  waiting: 'Waiting',
  resolved: 'Resolved',
};

/**
 * Status is encoded by glyph shape + label + opacity — never by semantic color
 * (DESIGN.md › Don't introduce red/green/yellow).
 */
export function StatusGlyph({ status, size = 12 }: { status: TicketStatus; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" className={cx(styles.glyph, styles[status])}>
      {status === 'open' && <circle cx="6" cy="6" r="4" fill="currentColor" />}
      {status === 'in_progress' && (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 3.25a2.75 2.75 0 0 1 0 5.5Z" fill="currentColor" />
        </>
      )}
      {status === 'waiting' && (
        <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 1.8" />
      )}
      {status === 'resolved' && (
        <>
          <circle cx="6" cy="6" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 6.2 5.4 7.6 8 4.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
    </svg>
  );
}

export function StatusPill({ status, bare }: { status: TicketStatus; bare?: boolean }) {
  return (
    <span className={cx(styles.pill, bare && styles.bare, styles[status])}>
      <StatusGlyph status={status} />
      <span className={styles.label}>{statusLabels[status]}</span>
    </span>
  );
}
