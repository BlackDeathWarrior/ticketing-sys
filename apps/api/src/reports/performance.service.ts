import { Inject, Injectable } from '@nestjs/common';
import type { Database } from '@tms/db';
import {
  type AiHuman,
  type Channel,
  type CsatSummary,
  daysBetween,
  formatTicketNumber,
  type HandledBy,
  median,
  type PerformanceReport,
  type Priority,
  rate,
  REPORT_EXPORT_MAX_ROWS,
  reportPeriod,
  type ReportQuery,
  type SlaCount,
  type TicketReport,
  type TicketReportQuery,
  type TicketReportRow,
} from '@tms/shared';
import { type SQL, sql } from 'drizzle-orm';
import { AuditService } from '../audit/audit.service';
import type { RequestCtx } from '../common/request-context';
import { DB } from '../infra/tokens';
import { CustomerExperienceService } from '../settings/customer-experience.service';

/**
 * Who handled a ticket (see HANDLED_BY). "The AI worked on it" means it took
 * at least one turn; classifying a ticket doesn't count.
 */
const AI_WORKED = sql`exists (select 1 from ai_runs r where r.ticket_id = t.id and r.kind in ('turn', 'followup'))`;
const HANDLED_BY_SQL = sql`case when t.handling = 'ai' then 'ai' when ${AI_WORKED} then 'ai_then_human' else 'human' end`;

interface Scope {
  from: string;
  to: string;
  start: Date;
  /** The first moment after the period. */
  end: Date;
  /** Conditions on `tickets t`, starting with " and " (or empty). */
  where: SQL;
  filtered: boolean;
}

/**
 * The AI-versus-team report and the ticket list behind it (ADR 0019). Like
 * the overview, it reads other modules' tables; its only write is the audit
 * entry for an export. Everything
 * is computed on request (ADR 0006): fine at this size, and always current.
 */
@Injectable()
export class PerformanceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditService,
    private readonly experience: CustomerExperienceService,
  ) {}

  async performance(q: ReportQuery, now = new Date()): Promise<PerformanceReport> {
    const s = scope(q, now);
    const inPeriod = (column: SQL) => sql`${column} >= ${s.start} and ${column} < ${s.end}`;

    const [resolved, created, sla, csat, asked, cost, settings, byAgent] = await Promise.all([
      this.rows<{ day: string; channel: Channel; handled_by: HandledBy; minutes: number }>(sql`
        select to_char(t.resolved_at at time zone 'UTC', 'YYYY-MM-DD') as day,
               t.channel,
               ${HANDLED_BY_SQL} as handled_by,
               (extract(epoch from (coalesce(la.at, t.resolved_at) - t.created_at)) / 60)::float8
                 as minutes
        from tickets t
        -- The last reply before it was resolved: a ticket that waited days for the
        -- customer to confirm was, for the customer, answered when that reply went out.
        left join lateral (
          select max(coalesce(m.sent_at, m.created_at)) as at
          from messages m
          join conversations c on c.id = m.conversation_id
          where c.ticket_id = t.id
            and m.direction = 'outbound'
            and m.author_type in ('ai', 'agent')
            and (m.delivery_status is null or m.delivery_status not in ('draft', 'discarded'))
            and m.created_at <= t.resolved_at
        ) la on true
        where ${inPeriod(sql`t.resolved_at`)} ${s.where}`),
      this.rows<{
        day: string;
        channel: Channel;
        handling: string;
        settled: boolean;
        ai_worked: boolean;
        first_author: string | null;
        first_minutes: number | null;
      }>(sql`
        select to_char(t.created_at at time zone 'UTC', 'YYYY-MM-DD') as day,
               t.channel,
               t.handling,
               (t.resolved_at is not null or t.closed_at is not null) as settled,
               ${AI_WORKED} as ai_worked,
               -- When: the ticket's own first-response time (the one SLA uses).
               -- Who: the author of the first reply the customer could see.
               case when t.first_response_at is null then null else fr.author_type end
                 as first_author,
               (extract(epoch from (t.first_response_at - t.created_at)) / 60)::float8
                 as first_minutes
        from tickets t
        left join lateral (
          select m.author_type
          from messages m
          join conversations c on c.id = m.conversation_id
          where c.ticket_id = t.id
            and m.direction = 'outbound'
            and m.author_type in ('ai', 'agent')
            and (m.delivery_status is null or m.delivery_status not in ('draft', 'discarded'))
          order by m.created_at
          limit 1
        ) fr on true
        where ${inPeriod(sql`t.created_at`)} ${s.where}`),
      this.rows<{ kind: string; ai: boolean; met: number; breached: number }>(sql`
        select st.kind,
               (t.handling = 'ai') as ai,
               count(*) filter (where st.breached_at is null and st.met_at is not null)::int as met,
               count(*) filter (where st.breached_at is not null)::int as breached
        from sla_timers st
        join tickets t on t.id = st.ticket_id
        where ${inPeriod(sql`coalesce(st.breached_at, st.met_at)`)} ${s.where}
        group by 1, 2`),
      this.rows<{
        ai: boolean;
        channel: Channel;
        responses: number;
        total: number;
        satisfied: number;
      }>(sql`
        select (cr.handling = 'ai') as ai,
               t.channel,
               count(*)::int as responses,
               sum(cr.rating)::int as total,
               count(*) filter (where cr.rating >= 4)::int as satisfied
        from csat_responses cr
        join tickets t on t.id = cr.ticket_id
        where ${inPeriod(sql`cr.created_at`)} ${s.where}
        group by 1, 2`),
      this.rows<{ asked: number }>(sql`
        select count(*)::int as asked
        from csat_requests rq
        join tickets t on t.id = rq.ticket_id
        where ${inPeriod(sql`rq.requested_at`)} ${s.where}`),
      // Cost is the whole AI bill for the period; with a filter, only calls made for those tickets.
      this.rows<{ provider: string; usd: number; calls: number }>(
        s.filtered
          ? sql`
        select coalesce(p.label, 'Removed provider') as provider,
               coalesce(sum(l.cost_usd), 0)::float8 as usd,
               count(*)::int as calls
        from llm_calls l
        join tickets t on t.id = l.ticket_id
        left join llm_providers p on p.id = l.provider_id
        where ${inPeriod(sql`l.created_at`)} ${s.where}
        group by 1
        order by 2 desc, 1`
          : sql`
        select coalesce(p.label, 'Removed provider') as provider,
               coalesce(sum(l.cost_usd), 0)::float8 as usd,
               count(*)::int as calls
        from llm_calls l
        left join llm_providers p on p.id = l.provider_id
        where ${inPeriod(sql`l.created_at`)}
        group by 1
        order by 2 desc, 1`,
      ),
      this.experience.get(),
      this.rows<{ agent: string; responses: number; total: number; satisfied: number }>(sql`
        select coalesce(u.name, 'No assignee') as agent,
               count(*)::int as responses,
               sum(cr.rating)::int as total,
               count(*) filter (where cr.rating >= 4)::int as satisfied
        from csat_responses cr
        join tickets t on t.id = cr.ticket_id
        left join users u on u.id = cr.assignee_id
        where ${inPeriod(sql`cr.created_at`)} and cr.handling <> 'ai' ${s.where}
        group by 1
        order by 2 desc, 1`),
    ]);

    const count = (by: HandledBy) => resolved.filter((r) => r.handled_by === by).length;
    const resolvedBy = {
      ai: count('ai'),
      ai_then_human: count('ai_then_human'),
      human: count('human'),
    };

    const worked = created.filter((t) => t.ai_worked);
    const toPerson = worked.filter((t) => t.handling !== 'ai').length;
    const deflected = worked.filter((t) => t.handling === 'ai' && t.settled).length;

    const firstBy = (author: string) =>
      median(created.filter((t) => t.first_author === author).map((t) => t.first_minutes!));
    const resolutionBy = (ai: boolean) =>
      median(resolved.filter((r) => (r.handled_by === 'ai') === ai).map((r) => r.minutes));

    const slaCount = (kind: string | null, ai: boolean | null): SlaCount => {
      const rows = sla.filter(
        (r) => (kind === null || r.kind === kind) && (ai === null || r.ai === ai),
      );
      const met = rows.reduce((n, r) => n + r.met, 0);
      const breached = rows.reduce((n, r) => n + r.breached, 0);
      return { met, breached, compliance: rate(met, met + breached) };
    };
    const slaSplit = (kind: string | null): AiHuman<SlaCount> => ({
      ai: slaCount(kind, true),
      human: slaCount(kind, false),
    });

    const csatSummary = (rows: typeof csat): CsatSummary => {
      const responses = rows.reduce((n, r) => n + r.responses, 0);
      const total = rows.reduce((n, r) => n + r.total, 0);
      return {
        responses,
        average: responses ? round(total / responses, 2) : null,
        satisfied: rate(
          rows.reduce((n, r) => n + r.satisfied, 0),
          responses,
        ),
      };
    };

    const totalUsd = cost.reduce((n, r) => n + r.usd, 0);
    const days = daysBetween(s.from, s.to);
    const channels = [...new Set([...created, ...resolved].map((r) => r.channel))].sort();

    return {
      generatedAt: now.toISOString(),
      from: s.from,
      to: s.to,
      filters: { channel: q.channel ?? null, teamId: q.teamId ?? null },
      created: created.length,
      resolved: { total: resolved.length, ...resolvedBy },
      aiResolutionRate: rate(resolvedBy.ai, resolved.length),
      aiWorked: {
        total: worked.length,
        deflected,
        toPerson,
        open: worked.length - deflected - toPerson,
        deflectionRate: rate(deflected, worked.length),
        handoverRate: rate(toPerson, worked.length),
      },
      medianFirstResponseMinutes: {
        ai: roundOrNull(firstBy('ai')),
        human: roundOrNull(firstBy('agent')),
      },
      medianResolutionMinutes: {
        ai: roundOrNull(resolutionBy(true)),
        human: roundOrNull(resolutionBy(false)),
      },
      timeSaved: {
        minutes: resolvedBy.ai * settings.agentMinutesPerTicket,
        minutesPerTicket: settings.agentMinutesPerTicket,
      },
      sla: {
        firstResponse: slaSplit('first_response'),
        resolution: slaSplit('resolution'),
        overall: { ...slaSplit(null), all: slaCount(null, null) },
      },
      csat: {
        all: csatSummary(csat),
        ai: csatSummary(csat.filter((r) => r.ai)),
        human: csatSummary(csat.filter((r) => !r.ai)),
        asked: asked[0]?.asked ?? 0,
        byAgent: byAgent.map((a) => ({
          agent: a.agent,
          responses: a.responses,
          average: round(a.total / a.responses, 2),
          satisfied: rate(a.satisfied, a.responses),
        })),
      },
      cost: {
        totalUsd: round(totalUsd, 6),
        calls: cost.reduce((n, r) => n + r.calls, 0),
        byProvider: cost.map((r) => ({ ...r, usd: round(r.usd, 6) })),
        perAiResolvedUsd: resolvedBy.ai ? round(totalUsd / resolvedBy.ai, 6) : null,
      },
      daily: days.map((date) => ({
        date,
        created: created.filter((t) => t.day === date).length,
        resolvedAi: resolved.filter((r) => r.day === date && r.handled_by === 'ai').length,
        resolvedHuman: resolved.filter((r) => r.day === date && r.handled_by !== 'ai').length,
      })),
      byChannel: channels.map((channel) => {
        const ratings = csatSummary(csat.filter((r) => r.channel === channel));
        const done = resolved.filter((r) => r.channel === channel);
        return {
          channel,
          created: created.filter((t) => t.channel === channel).length,
          resolved: done.length,
          resolvedAi: done.filter((r) => r.handled_by === 'ai').length,
          csatAverage: ratings.average,
          csatResponses: ratings.responses,
        };
      }),
    };
  }

  /** Tickets created in the period, newest first, one page at a time. */
  async tickets(q: TicketReportQuery, now = new Date()): Promise<TicketReport> {
    const s = scope(q, now);
    const handled = q.handledBy ? sql`and ${HANDLED_BY_SQL} = ${q.handledBy}` : sql``;
    const where = sql`t.created_at >= ${s.start} and t.created_at < ${s.end} ${s.where} ${handled}`;
    const [items, total] = await Promise.all([
      this.ticketRows(where, q.limit, q.offset),
      this.rows<{ total: number }>(
        sql`select count(*)::int as total from tickets t where ${where}`,
      ),
    ]);
    return { from: s.from, to: s.to, total: total[0]?.total ?? 0, items };
  }

  /**
   * Every ticket of the report (up to the export limit), for the CSV download.
   * The file carries customer names out of the system, so who took it is audited.
   */
  async exportRows(
    ctx: RequestCtx,
    q: TicketReportQuery,
    now = new Date(),
  ): Promise<TicketReportRow[]> {
    const s = scope(q, now);
    const handled = q.handledBy ? sql`and ${HANDLED_BY_SQL} = ${q.handledBy}` : sql``;
    const rows = await this.ticketRows(
      sql`t.created_at >= ${s.start} and t.created_at < ${s.end} ${s.where} ${handled}`,
      REPORT_EXPORT_MAX_ROWS,
      0,
    );
    await this.audit.record(this.db, ctx, {
      action: 'report.exported',
      targetType: 'report',
      targetId: 'tickets',
      data: {
        from: s.from,
        to: s.to,
        channel: q.channel ?? null,
        teamId: q.teamId ?? null,
        handledBy: q.handledBy ?? null,
        rows: rows.length,
      },
    });
    return rows;
  }

  private async ticketRows(where: SQL, limit: number, offset: number): Promise<TicketReportRow[]> {
    const rows = await this.rows<{
      id: string;
      number: string;
      subject: string;
      channel: Channel;
      status: string;
      priority: Priority;
      team: string | null;
      assignee: string | null;
      customer: string;
      handled_by: HandledBy;
      created_at: string;
      first_response_at: string | null;
      resolved_at: string | null;
      first_response_minutes: number | null;
      resolution_minutes: number | null;
      sla_state: string | null;
      rating: number | null;
    }>(sql`
      select t.id, t.number, t.subject, t.channel, coalesce(s.name, t.status) as status, t.priority,
             tm.name as team, u.name as assignee, c.display_name as customer,
             ${HANDLED_BY_SQL} as handled_by,
             ${isoUtc(sql`t.created_at`)} as created_at,
             ${isoUtc(sql`t.first_response_at`)} as first_response_at,
             ${isoUtc(sql`t.resolved_at`)} as resolved_at,
             round(extract(epoch from (t.first_response_at - t.created_at)) / 60)::int
               as first_response_minutes,
             round(extract(epoch from (t.resolved_at - t.created_at)) / 60)::int
               as resolution_minutes,
             t.sla_state, cr.rating
      from tickets t
      join customers c on c.id = t.customer_id
      left join ticket_statuses s on s.key = t.status
      left join teams tm on tm.id = t.team_id
      left join users u on u.id = t.assignee_id
      left join csat_responses cr on cr.ticket_id = t.id
      where ${where}
      order by t.created_at desc, t.number desc
      limit ${limit} offset ${offset}`);
    return rows.map((r) => ({
      id: r.id,
      reference: formatTicketNumber(Number(r.number)),
      subject: r.subject,
      channel: r.channel,
      status: r.status,
      priority: r.priority,
      team: r.team,
      assignee: r.assignee,
      customer: r.customer,
      handledBy: r.handled_by,
      createdAt: r.created_at,
      firstResponseAt: r.first_response_at,
      resolvedAt: r.resolved_at,
      firstResponseMinutes: r.first_response_minutes,
      resolutionMinutes: r.resolution_minutes,
      slaState: r.sla_state,
      rating: r.rating,
    }));
  }

  private async rows<T>(query: SQL): Promise<T[]> {
    return (await this.db.execute(query)).rows as T[];
  }
}

function scope(
  q: { days: number; from?: string; to?: string; channel?: Channel; teamId?: string },
  now: Date,
): Scope {
  const { from, to } = reportPeriod(q, now);
  const parts: SQL[] = [];
  if (q.channel) parts.push(sql`and t.channel = ${q.channel}`);
  if (q.teamId) parts.push(sql`and t.team_id = ${q.teamId}`);
  return {
    from,
    to,
    start: new Date(`${from}T00:00:00.000Z`),
    end: new Date(Date.parse(`${to}T00:00:00.000Z`) + 86_400_000),
    where: sql.join(parts, sql` `),
    filtered: parts.length > 0,
  };
}

/** A timestamp as ISO 8601 text (the driver hands raw timestamps back in Postgres's own format). */
const isoUtc = (column: SQL) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

const roundOrNull = (value: number | null) => (value === null ? null : Math.round(value));
