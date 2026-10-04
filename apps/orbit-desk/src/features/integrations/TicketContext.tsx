import { INCIDENT_TICKET_KIND, type IncidentView } from '@tms/shared';
import { useEffect } from 'react';
import { Icon } from '../../components/ui';
import type { Ticket } from '../../data/types';
import { useGet } from '../../lib/useGet';
import panels from '../handover/Handover.module.css';
import styles from './Integrations.module.css';
import { incidentLine, metadataRows } from './logic';

/**
 * What the outside app said about a ticket it raised: which app, its own
 * reference, and the context it sent. Shown as plain text only. A ticket that
 * tracks an incident also shows how often it was reported and whether it
 * has recovered.
 */
export function TicketContext({ ticket, liveTick }: { ticket: Ticket; liveTick: number }) {
  const isIncident = ticket.metadata.kind === INCIDENT_TICKET_KIND;
  const rows = metadataRows(ticket.metadata).filter((r) => !(isIncident && r.key === 'kind'));
  if (!ticket.integration && !ticket.externalRef && !rows.length) return null;
  return (
    <section className={panels.panel} aria-label="Context from the app">
      <h3 className={panels.panelTitle}>
        <Icon name={isIncident ? 'alert' : 'layers'} size={14} />
        {isIncident ? 'Incident reported by' : 'Context from'} {ticket.integration ?? 'an app'}
      </h3>
      {isIncident && <Incidents ticketId={ticket.id} liveTick={liveTick} />}
      <dl className={styles.context}>
        {ticket.externalRef && (
          <div>
            <dt>{isIncident ? 'Fingerprint' : 'Reference'}</dt>
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

/** The episodes this ticket has tracked, newest first: the open one, then earlier recoveries. */
function Incidents({ ticketId, liveTick }: { ticketId: string; liveTick: number }) {
  const incidents = useGet<IncidentView[]>(`/tickets/${ticketId}/incidents`);
  const { reload } = incidents;
  useEffect(() => {
    if (liveTick) void reload();
  }, [liveTick, reload]);
  if (!incidents.data?.length) return null;
  return (
    <ul className={styles.incidents} aria-label="Incident reports">
      {incidents.data.map((i) => (
        <li key={i.id} data-status={i.status}>
          {incidentLine(i)}
        </li>
      ))}
    </ul>
  );
}
