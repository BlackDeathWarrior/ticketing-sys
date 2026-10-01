import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type Database, type DbOrTx, incidents } from '@tms/db';
import {
  type EventAction,
  formatTicketNumber,
  INCIDENT_NOTE_AT,
  INCIDENT_PRIORITY,
  INCIDENT_SEVERITIES,
  INCIDENT_TAG,
  INCIDENT_TICKET_KIND,
  type IncidentSeverity,
  type IncidentStatus,
  type IncidentView,
  integrationExternalId,
  type ListIncidentsQuery,
  PRIORITIES,
  type ReportEventInput,
  type ReportEventResult,
} from '@tms/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import { OutboxService } from '../audit/outbox.service';
import { InboundService } from '../channels/inbound.service';
import type { ApiKeyContext, RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { TicketsService } from '../tickets/tickets.service';
import { WorkflowService } from '../workflow/workflow.service';

type Row = typeof incidents.$inferSelect;

const worse = (a: IncidentSeverity, b: IncidentSeverity) =>
  INCIDENT_SEVERITIES.indexOf(a) > INCIDENT_SEVERITIES.indexOf(b);

function view(row: Row, ticketNumber: number | null): IncidentView {
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    status: row.status as IncidentStatus,
    severity: row.severity as IncidentSeverity,
    title: row.title,
    source: row.source,
    occurrences: row.occurrences,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    ticket: ticketNumber === null ? null : formatTicketNumber(ticketNumber),
  };
}

/**
 * Problems an app reports about itself (ADR 0024). Reports with the same
 * fingerprint are one incident with one ticket: the first report opens the
 * ticket through the inbound pipeline (so routing and SLA apply), repeats are
 * counted, and a recovery resolves the ticket when nobody has picked it up.
 */
@Injectable()
export class IncidentsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly inbound: InboundService,
    private readonly tickets: TicketsService,
    private readonly workflow: WorkflowService,
  ) {}

  async report(ctx: RequestCtx, key: ApiKeyContext, input: ReportEventInput) {
    return this.db.transaction(async (tx): Promise<ReportEventResult> => {
      // One report at a time per fingerprint, so two can't both open a ticket.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`incident:${key.integration.id}:${input.fingerprint}`}))`,
      );
      let open = await this.openIncident(tx, key.integration.id, input.fingerprint);

      if (input.status === 'resolved') {
        if (!open) return { action: 'ignored', incident: null };
        return this.result(tx, 'resolved', await this.resolve(tx, ctx, key, open, input));
      }

      if (open && !(await this.ticketIsLive(tx, open.ticketId))) {
        // Someone solved or closed the ticket by hand, and the problem is back.
        await this.close(tx, ctx, open, 'ticket_closed');
        open = null;
      }
      if (open) return this.result(tx, 'updated', await this.repeat(tx, ctx, open, input));
      return this.result(tx, 'opened', await this.open(tx, ctx, key, input));
    });
  }

  /** The integration's incidents, most recently reported first. */
  async list(key: ApiKeyContext, q: ListIncidentsQuery): Promise<IncidentView[]> {
    const rows = await this.db
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.integrationId, key.integration.id),
          q.status ? eq(incidents.status, q.status) : undefined,
        ),
      )
      .orderBy(desc(incidents.lastSeenAt))
      .limit(q.limit);
    const numbers = await this.tickets.numbersFor(
      this.db,
      rows.flatMap((r) => (r.ticketId ? [r.ticketId] : [])),
    );
    return rows.map((r) => view(r, (r.ticketId && numbers.get(r.ticketId)) || null));
  }

  /** One incident with the integration it belongs to, for webhook bodies. */
  async byId(id: string): Promise<{ incident: IncidentView; integrationId: string } | null> {
    const [row] = await this.db.select().from(incidents).where(eq(incidents.id, id));
    if (!row) return null;
    const numbers = await this.tickets.numbersFor(this.db, row.ticketId ? [row.ticketId] : []);
    return {
      incident: view(row, (row.ticketId && numbers.get(row.ticketId)) || null),
      integrationId: row.integrationId,
    };
  }

  /** The incidents a ticket tracks or tracked, newest first (for agents). */
  async forTicket(ticketRef: string): Promise<IncidentView[]> {
    const ticket = await this.tickets.get(ticketRef);
    const rows = await this.db
      .select()
      .from(incidents)
      .where(eq(incidents.ticketId, ticket.id))
      .orderBy(desc(incidents.firstSeenAt));
    return rows.map((r) => view(r, ticket.number));
  }

  private async open(
    tx: DbOrTx,
    ctx: RequestCtx,
    key: ApiKeyContext,
    input: ReportEventInput,
  ): Promise<Row> {
    const { integration } = key;
    const title = input.title!;
    const result = await this.inbound.handleInTx(tx, {
      channel: 'api',
      // The fingerprint is the thread: a new report after a recovery returns
      // to the same ticket while it is not closed.
      threadKey: `api:${integration.id}:incident:${input.fingerprint}`,
      channelMessageId: `api:${integration.id}:incident:${randomUUID()}`,
      from: {
        identity: { type: 'external_id', value: integrationExternalId(integration.slug, 'system') },
        displayName: `${integration.name} (automatic reports)`,
      },
      subject: title,
      text: describe(input),
      receivedAt: new Date().toISOString(),
      metadata: { via: 'api', apiKeyId: key.id, incident: true },
      ticket: {
        priority: INCIDENT_PRIORITY[input.severity],
        tags: [INCIDENT_TAG],
        externalRef: input.fingerprint,
        metadata: {
          ...input.details,
          kind: INCIDENT_TICKET_KIND,
          severity: input.severity,
          ...(input.source ? { source: input.source } : {}),
        },
        integrationId: integration.id,
      },
      // A person looks at incidents; there is no customer to answer.
      ai: 'off',
    });
    if (!result.createdTicket) {
      // The same ticket as before the recovery: it may need its priority back.
      await this.raisePriority(tx, ctx, result.ticketId, input.severity);
    }
    const [row] = await tx
      .insert(incidents)
      .values({
        integrationId: integration.id,
        fingerprint: input.fingerprint,
        severity: input.severity,
        title,
        source: input.source ?? null,
        ticketId: result.ticketId,
      })
      .returning();
    await this.record(tx, ctx, 'incident.opened', row!, {
      ticketId: result.ticketId,
      reopened: !result.createdTicket,
    });
    return row!;
  }

  private async repeat(tx: DbOrTx, ctx: RequestCtx, open: Row, input: ReportEventInput) {
    const escalated = worse(input.severity, open.severity as IncidentSeverity);
    const [row] = await tx
      .update(incidents)
      .set({
        occurrences: sql`${incidents.occurrences} + 1`,
        lastSeenAt: new Date(),
        ...(escalated ? { severity: input.severity } : {}),
      })
      .where(eq(incidents.id, open.id))
      .returning();
    const noteworthy = (INCIDENT_NOTE_AT as readonly number[]).includes(row!.occurrences);
    if (open.ticketId && (noteworthy || escalated)) {
      const lines = [
        `Reported again: ${row!.occurrences} times since ${open.firstSeenAt.toISOString()}.`,
        ...(escalated ? [`Severity is now ${input.severity} (was ${open.severity}).`] : []),
        ...(input.message ? [`Latest report: ${input.message}`] : []),
      ];
      await this.tickets.addNoteInTx(tx, ctx, open.ticketId, lines.join('\n'));
      if (escalated) await this.raisePriority(tx, ctx, open.ticketId, input.severity);
      // Counting alone is not recorded (ADR 0024); these moments are.
      await this.record(tx, ctx, 'incident.updated', row!, {
        ticketId: open.ticketId,
        ...(escalated ? { severityFrom: open.severity } : {}),
      });
    }
    return row!;
  }

  private async resolve(
    tx: DbOrTx,
    ctx: RequestCtx,
    key: ApiKeyContext,
    open: Row,
    input: ReportEventInput,
  ) {
    const row = await this.close(tx, ctx, open, 'recovered');
    if (!open.ticketId) return row;
    const times = `${open.occurrences} ${open.occurrences === 1 ? 'report' : 'reports'}`;
    const summary = `${key.integration.name} reported that this has recovered (${times}).`;
    await this.tickets.addNoteInTx(
      tx,
      ctx,
      open.ticketId,
      input.message ? `${summary}\n${input.message}` : summary,
    );
    // Only when nobody has picked it up: a person working on it decides when it is done.
    const ticket = await this.tickets.lockRow(tx, open.ticketId);
    const unattended =
      !ticket.assigneeId && ticket.handling !== 'human' && ticket.handling !== 'handed_over';
    if (unattended) await this.tickets.resolveOpenInTx(tx, ctx, open.ticketId, summary);
    return row;
  }

  /** Marks the incident resolved and records why. */
  private async close(
    tx: DbOrTx,
    ctx: RequestCtx,
    open: Row,
    reason: 'recovered' | 'ticket_closed',
  ) {
    const [row] = await tx
      .update(incidents)
      .set({ status: 'resolved', resolvedAt: new Date() })
      .where(eq(incidents.id, open.id))
      .returning();
    await this.record(tx, ctx, 'incident.resolved', row!, { ticketId: open.ticketId, reason });
    return row!;
  }

  /** Raises the ticket's priority to the severity's, never lowers it. */
  private async raisePriority(
    tx: DbOrTx,
    ctx: RequestCtx,
    ticketId: string,
    severity: IncidentSeverity,
  ) {
    const ticket = await this.tickets.lockRow(tx, ticketId);
    const wanted = INCIDENT_PRIORITY[severity];
    // PRIORITIES runs from urgent to low.
    const rank = (p: string) => (PRIORITIES as readonly string[]).indexOf(p);
    if (rank(wanted) < rank(ticket.priority)) {
      await this.tickets.updateInTx(tx, ctx, ticketId, { priority: wanted });
    }
  }

  private async openIncident(tx: DbOrTx, integrationId: string, fingerprint: string) {
    const [row] = await tx
      .select()
      .from(incidents)
      .where(
        and(
          eq(incidents.integrationId, integrationId),
          eq(incidents.fingerprint, fingerprint),
          eq(incidents.status, 'open'),
        ),
      )
      .for('update');
    return row ?? null;
  }

  /** Whether the incident's ticket is still open or pending. */
  private async ticketIsLive(tx: DbOrTx, ticketId: string | null): Promise<boolean> {
    if (!ticketId) return false;
    const ticket = await this.tickets.lockRow(tx, ticketId).catch((err) => {
      if (err instanceof NotFoundException) return null;
      throw err;
    });
    if (!ticket) return false;
    const { category } = await this.workflow.status(ticket.status);
    return category === 'open' || category === 'pending';
  }

  private async record(
    tx: DbOrTx,
    ctx: RequestCtx,
    type: 'incident.opened' | 'incident.updated' | 'incident.resolved',
    row: Row,
    extra: Record<string, unknown>,
  ) {
    const data = {
      fingerprint: row.fingerprint,
      severity: row.severity,
      occurrences: row.occurrences,
      integrationId: row.integrationId,
      ...extra,
    };
    await this.audit.record(tx, ctx, {
      action: type,
      targetType: 'incident',
      targetId: row.id,
      data,
    });
    await this.outbox.publish(tx, ctx, {
      type,
      aggregateType: 'incident',
      aggregateId: row.id,
      payload: data,
    });
  }

  private async result(tx: DbOrTx, action: EventAction, row: Row): Promise<ReportEventResult> {
    const numbers = await this.tickets.numbersFor(tx, row.ticketId ? [row.ticketId] : []);
    return { action, incident: view(row, (row.ticketId && numbers.get(row.ticketId)) || null) };
  }
}

/** The first message on the ticket: what an agent needs to start looking. */
function describe(input: ReportEventInput): string {
  return [
    input.message ?? input.title!,
    '',
    `Severity: ${input.severity}`,
    ...(input.source ? [`Source: ${input.source}`] : []),
    `Fingerprint: ${input.fingerprint}`,
  ].join('\n');
}
