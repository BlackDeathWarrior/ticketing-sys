import { minutesSince } from '../../data/adapters';
import type { Ticket } from '../../data/types';
import { relativeTime } from '../../lib/format';
import {
  AuroraDivider,
  Badge,
  Button,
  Card,
  GradientText,
  PriorityGlyph,
} from '../../components/ui';
import { triageSummary } from './logic';
import styles from './TriageCard.module.css';

interface TriageCardProps {
  /** Already picked and ordered (see `triage()`). */
  focus: Ticket[];
  urgent: number;
  high: number;
  unassigned: number;
  onOpen: (id: string) => void;
  onShowUrgent: () => void;
}

/** What to pick up first — the one place the cosmic gradient appears on the dashboard. */
export function TriageCard({
  focus,
  urgent,
  high,
  unassigned,
  onOpen,
  onShowUrgent,
}: TriageCardProps) {
  const total = urgent + high;
  return (
    <Card tone="raised" padding="lg" className={styles.card} aria-labelledby="triage-title">
      <div className={styles.intro}>
        <Badge tone="ai" icon="bolt">
          Triage
        </Badge>
        <h2 id="triage-title" className={styles.headline}>
          <GradientText>
            {total === 0
              ? 'Nothing needs you first.'
              : total === 1
                ? '1 ticket needs you first.'
                : `${total} tickets need you first.`}
          </GradientText>
        </h2>
        <p className={styles.summary}>{triageSummary(urgent, high, unassigned)}</p>
        {urgent > 0 && (
          <Button variant="link" onClick={onShowUrgent}>
            Review urgent queue
          </Button>
        )}
      </div>

      <AuroraDivider vertical className={styles.divider} />

      <ol className={styles.list}>
        {focus.map((t) => (
          <li key={t.id}>
            <button type="button" className={styles.item} onClick={() => onOpen(t.id)}>
              <span className={styles.itemTop}>
                <span className={styles.id}>{t.reference}</span>
                <PriorityGlyph priority={t.priority} />
                <span className={styles.age}>opened {relativeTime(minutesSince(t.createdAt))}</span>
              </span>
              <span className={styles.subject}>{t.subject}</span>
              <span className={styles.company}>
                {t.customer.company ?? t.customer.name}
                {t.assignee ? ` · ${t.assignee.name}` : ' · Unassigned'}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}
