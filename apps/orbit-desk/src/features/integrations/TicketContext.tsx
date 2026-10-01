import { Icon } from '../../components/ui';
import type { Ticket } from '../../data/types';
import panels from '../handover/Handover.module.css';
import styles from './Integrations.module.css';
import { metadataRows } from './logic';

/**
 * What the outside app said about a ticket it raised: which app, its own
 * reference, and the context it sent. Shown as plain text only.
 */
export function TicketContext({ ticket }: { ticket: Ticket }) {
  const rows = metadataRows(ticket.metadata);
  if (!ticket.integration && !ticket.externalRef && !rows.length) return null;
  return (
    <section className={panels.panel} aria-label="Context from the app">
      <h3 className={panels.panelTitle}>
        <Icon name="layers" size={14} />
        Context{ticket.integration ? ` from ${ticket.integration}` : ''}
      </h3>
      <dl className={styles.context}>
        {ticket.externalRef && (
          <div>
            <dt>Reference</dt>
            <dd>{ticket.externalRef}</dd>
          </div>
        )}
        {rows.map((r) => (
          <div key={r.key}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
