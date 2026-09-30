import type { Ticket } from '../../data/types';
import { AuroraDivider, Badge, Button, Card, GradientText, PriorityGlyph, SlaIndicator } from '../../components/ui';
import styles from './TriageCard.module.css';

interface TriageCardProps {
  tickets: Ticket[];
  onOpen: (id: string) => void;
  onShowUrgent: () => void;
}

/** AI triage summary — the one place the cosmic gradient appears on the dashboard. */
export function TriageCard({ tickets, onOpen, onShowUrgent }: TriageCardProps) {
  const focus = tickets
    .filter((t) => t.status !== 'resolved' && ((t.slaMinutes ?? Infinity) <= 60 || t.priority === 'urgent'))
    .sort((a, b) => (a.slaMinutes ?? Infinity) - (b.slaMinutes ?? Infinity))
    .slice(0, 3);

  return (
    <Card tone="raised" padding="lg" className={styles.card} aria-labelledby="triage-title">
      <div className={styles.intro}>
        <Badge tone="ai" icon="sparkle">
          Triage assistant
        </Badge>
        <h2 id="triage-title" className={styles.headline}>
          <GradientText>{focus.length === 1 ? '1 ticket needs' : `${focus.length} tickets need`} you first.</GradientText>
        </h2>
        <p className={styles.summary}>
          An SSO outage at Northwind is blocking 400+ users and EU webhook delays have breached SLA with nobody assigned. Everything else is on track.
        </p>
        <Button variant="link" onClick={onShowUrgent}>
          Review urgent queue
        </Button>
      </div>

      <AuroraDivider vertical className={styles.divider} />

      <ol className={styles.list}>
        {focus.map((t) => (
          <li key={t.id}>
            <button type="button" className={styles.item} onClick={() => onOpen(t.id)}>
              <span className={styles.itemTop}>
                <span className={styles.id}>{t.id}</span>
                <PriorityGlyph priority={t.priority} />
                <span className={styles.sla}>
                  <SlaIndicator minutes={t.slaMinutes} />
                </span>
              </span>
              <span className={styles.subject}>{t.subject}</span>
              <span className={styles.company}>{t.customer.company}</span>
            </button>
          </li>
        ))}
      </ol>
    </Card>
  );
}
