import {
  CHANNELS,
  type Channel,
  HANDLED_BY,
  HANDLED_BY_LABELS,
  type HandledBy,
  type PerformanceReport,
  type TicketReport,
} from '@tms/shared';
import { useEffect, useState } from 'react';
import { downloadFile, qs } from '../../api/client';
import { Button, Card, CardHeader, Input, Meter, Select } from '../../components/ui';
import { channelLabels } from '../../data/adapters';
import { cx } from '../../lib/format';
import { useSession } from '../../lib/session';
import { useGet } from '../../lib/useGet';
import {
  compareRows,
  minutesText,
  percent,
  periodText,
  RANGE_OPTIONS,
  type RangePreset,
  ratingText,
  type ReportFilters,
  reportKpis,
  reportParams,
  resolvedSegments,
  usd,
} from './logic';
import { ResolvedChart } from './ResolvedChart';
import styles from './Reports.module.css';

const PAGE = 25;

/** Reports (#/reports): the AI and the team side by side, and the tickets behind the numbers. */
export function ReportsPage({ onOpenTicket }: { onOpenTicket: (id: string) => void }) {
  const { can } = useSession();
  const [filters, setFilters] = useState<ReportFilters>({
    range: '30',
    from: '',
    to: '',
    channel: '',
    teamId: '',
  });
  const [handledBy, setHandledBy] = useState<HandledBy | ''>('');
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const params = reportParams(filters);
  const teams = useGet<Array<{ id: string; name: string }>>('/teams');
  const report = useGet<PerformanceReport>(params ? `/reports/performance${qs(params)}` : null);
  const listParams = params && { ...params, handledBy: handledBy || undefined };
  const list = useGet<TicketReport>(
    listParams
      ? `/reports/tickets${qs({ ...listParams, limit: PAGE, offset: page * PAGE })}`
      : null,
  );

  // A new filter starts the list at its first page.
  const filterKey = JSON.stringify([params, handledBy]);
  useEffect(() => setPage(0), [filterKey]);

  const set = (patch: Partial<ReportFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const r = report.data;

  const exportCsv = async () => {
    if (!listParams) return;
    setExporting(true);
    setExportError(null);
    try {
      await downloadFile(`/reports/tickets.csv${qs(listParams)}`, 'tickets.csv');
    } catch (err) {
      setExportError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.hero}>
        <p className={styles.eyebrow}>Reports</p>
        <h1 className={styles.heading}>The AI and the team</h1>
        <p className={styles.lede}>
          {r
            ? `${periodText(r.from, r.to)} · ${r.created} tickets opened, ${r.resolved.total} resolved.`
            : 'What the AI resolved on its own, what it passed on, and how customers rated both.'}
        </p>
      </header>

      <form
        className={styles.filters}
        aria-label="Report filters"
        onSubmit={(e) => e.preventDefault()}
      >
        <Select
          id="report-range"
          label="Period"
          value={filters.range}
          options={RANGE_OPTIONS}
          onChange={(e) => set({ range: e.target.value as RangePreset })}
        />
        {filters.range === 'custom' && (
          <>
            <Input
              id="report-from"
              label="From"
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => set({ from: e.target.value })}
            />
            <Input
              id="report-to"
              label="To"
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => set({ to: e.target.value })}
            />
          </>
        )}
        <Select
          id="report-channel"
          label="Channel"
          value={filters.channel}
          options={[
            { value: '', label: 'All channels' },
            ...CHANNELS.map((c) => ({ value: c, label: channelLabels[c] })),
          ]}
          onChange={(e) => set({ channel: e.target.value })}
        />
        <Select
          id="report-team"
          label="Team"
          value={filters.teamId}
          options={[
            { value: '', label: 'All teams' },
            ...(teams.data ?? []).map((t) => ({ value: t.id, label: t.name })),
          ]}
          onChange={(e) => set({ teamId: e.target.value })}
        />
      </form>

      {!params && <p className={styles.note}>Choose the first and last day of the period.</p>}
      {report.error && (
        <p className={styles.error} role="alert">
          {report.error}
        </p>
      )}

      {r && (
        <>
          <section className={styles.kpis} aria-label="Key figures">
            {reportKpis(r).map((k) => (
              <Card key={k.id} as="article" className={styles.kpi} data-kpi={k.id}>
                <p className={styles.kpiLabel}>{k.label}</p>
                <p className={cx(styles.kpiValue, 'tabular')}>{k.value}</p>
                <p className={styles.kpiContext}>{k.context}</p>
              </Card>
            ))}
          </section>

          <div className={styles.split}>
            <ResolvedChart daily={r.daily} />
            <WhoResolved report={r} />
          </div>

          <div className={styles.pair}>
            <Card padding="md" aria-labelledby="compare-title">
              <CardHeader
                id="compare-title"
                title="Side by side"
                subtitle="The same measures for tickets the AI handled alone and tickets people handled"
              />
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Measure</th>
                      <th scope="col">The AI</th>
                      <th scope="col">People</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compareRows(r).map((row) => (
                      <tr key={row.metric}>
                        <th scope="row">
                          {row.metric}
                          <span className={styles.rowNote}>{row.note}</span>
                        </th>
                        <td className="tabular">{row.ai}</td>
                        <td className="tabular">{row.human}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card padding="md" aria-labelledby="cost-title">
              <CardHeader
                id="cost-title"
                title="AI cost"
                subtitle={
                  r.filters.channel || r.filters.teamId
                    ? 'Model calls made for these tickets'
                    : 'Every model call in the period'
                }
              />
              <dl className={styles.costFigures}>
                <div>
                  <dt>Total</dt>
                  <dd className="tabular">{usd(r.cost.totalUsd)}</dd>
                </div>
                <div>
                  <dt>Per ticket the AI resolved</dt>
                  <dd className="tabular">{usd(r.cost.perAiResolvedUsd)}</dd>
                </div>
                <div>
                  <dt>Model calls</dt>
                  <dd className="tabular">{r.cost.calls}</dd>
                </div>
              </dl>
              {r.cost.byProvider.length > 0 ? (
                <ul className={styles.providers} aria-label="Cost by provider">
                  {r.cost.byProvider.map((p) => (
                    <li key={p.provider}>
                      <span className={styles.providerName}>{p.provider}</span>
                      <span className={cx(styles.providerCost, 'tabular')}>{usd(p.usd)}</span>
                      <Meter
                        value={p.usd}
                        max={Math.max(r.cost.totalUsd, 0.000001)}
                        label={`${p.provider}: ${usd(p.usd)} of ${usd(r.cost.totalUsd)}`}
                        alertAt={2}
                        className={styles.providerBar}
                      />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={styles.note}>No model calls in this period.</p>
              )}
            </Card>
          </div>

          <Card padding="md" aria-labelledby="agents-rating-title">
            <CardHeader
              id="agents-rating-title"
              title="Ratings by agent"
              subtitle="How customers rated each person’s tickets, next to the AI’s own. For coaching, not for ranking: a few ratings say little."
            />
            {r.csat.all.responses === 0 ? (
              <p className={styles.note}>No ratings in this period.</p>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Handled by</th>
                      <th scope="col">Ratings</th>
                      <th scope="col">Average</th>
                      <th scope="col">Happy customers</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.csat.ai.responses > 0 && (
                      <tr data-agent="ai">
                        <th scope="row">The AI alone</th>
                        <td className="tabular">{r.csat.ai.responses}</td>
                        <td className="tabular">{ratingText(r.csat.ai.average)}</td>
                        <td className="tabular">{percent(r.csat.ai.satisfied)}</td>
                      </tr>
                    )}
                    {r.csat.byAgent.map((a) => (
                      <tr key={a.agent} data-agent={a.agent}>
                        <th scope="row">{a.agent}</th>
                        <td className="tabular">{a.responses}</td>
                        <td className="tabular">{ratingText(a.average)}</td>
                        <td className="tabular">{percent(a.satisfied)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card padding="md" aria-labelledby="channels-title">
            <CardHeader
              id="channels-title"
              title="By channel"
              subtitle="Where tickets came from, and how much of each channel the AI resolved"
            />
            {r.byChannel.length === 0 ? (
              <p className={styles.note}>No tickets in this period.</p>
            ) : (
              <div className={styles.scroller}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th scope="col">Channel</th>
                      <th scope="col">Opened</th>
                      <th scope="col">Resolved</th>
                      <th scope="col">By the AI alone</th>
                      <th scope="col">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.byChannel.map((c) => (
                      <tr key={c.channel}>
                        <th scope="row">{channelLabels[c.channel]}</th>
                        <td className="tabular">{c.created}</td>
                        <td className="tabular">{c.resolved}</td>
                        <td className="tabular">
                          {c.resolvedAi}
                          <span className={styles.rowAside}>
                            {c.resolved ? percent(c.resolvedAi / c.resolved) : ''}
                          </span>
                        </td>
                        <td className="tabular">
                          {ratingText(c.csatAverage)}
                          <span className={styles.rowAside}>
                            {c.csatResponses ? `${c.csatResponses} ratings` : ''}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}

      {params && (
        <Card padding="md" aria-labelledby="report-tickets-title">
          <CardHeader
            id="report-tickets-title"
            title="Tickets"
            subtitle={
              list.data
                ? `${list.data.total} opened in the period${handledBy ? `, handled by ${HANDLED_BY_LABELS[handledBy].toLowerCase()}` : ''}`
                : 'Opened in the period'
            }
            actions={
              <div className={styles.listActions}>
                <Select
                  id="report-handled"
                  aria-label="Handled by"
                  value={handledBy}
                  options={[
                    { value: '', label: 'Handled by anyone' },
                    ...HANDLED_BY.map((h) => ({ value: h, label: HANDLED_BY_LABELS[h] })),
                  ]}
                  onChange={(e) => setHandledBy(e.target.value as HandledBy | '')}
                />
                {can('report:export') && (
                  <Button onClick={() => void exportCsv()} disabled={exporting}>
                    {exporting ? 'Preparing…' : 'Export CSV'}
                  </Button>
                )}
              </div>
            }
          />
          {(exportError ?? list.error) && (
            <p className={styles.error} role="alert">
              {exportError ?? list.error}
            </p>
          )}
          {list.data?.items.length === 0 ? (
            <p className={styles.note}>No tickets match.</p>
          ) : (
            <div className={styles.scroller}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th scope="col">Ticket</th>
                    <th scope="col">Channel</th>
                    <th scope="col">Status</th>
                    <th scope="col">Handled by</th>
                    <th scope="col">First reply</th>
                    <th scope="col">Resolved in</th>
                    <th scope="col">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {(list.data?.items ?? []).map((t) => (
                    <tr key={t.id} data-ticket={t.reference}>
                      <th scope="row">
                        <button
                          type="button"
                          className={styles.ticketLink}
                          onClick={() => onOpenTicket(t.id)}
                        >
                          <span className={styles.reference}>{t.reference}</span>
                          <span className={styles.subject}>{t.subject}</span>
                        </button>
                        <span className={styles.rowNote}>
                          {t.customer}
                          {t.team ? ` · ${t.team}` : ''}
                        </span>
                      </th>
                      <td>{channelLabels[t.channel as Channel]}</td>
                      <td>{t.status}</td>
                      <td>{HANDLED_BY_LABELS[t.handledBy]}</td>
                      <td className="tabular">{minutesText(t.firstResponseMinutes)}</td>
                      <td className="tabular">{minutesText(t.resolutionMinutes)}</td>
                      <td className="tabular">{t.rating === null ? '—' : `${t.rating} / 5`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {list.data && list.data.total > PAGE && (
            <nav className={styles.pager} aria-label="Pages">
              <Button
                size="sm"
                variant="ghost"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <span className="tabular">
                {page * PAGE + 1}–{Math.min((page + 1) * PAGE, list.data.total)} of{' '}
                {list.data.total}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={(page + 1) * PAGE >= list.data.total}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </nav>
          )}
        </Card>
      )}
    </div>
  );
}

/** Who resolved the period's tickets: one bar split three ways, each part labelled with its count. */
function WhoResolved({ report: r }: { report: PerformanceReport }) {
  const segments = resolvedSegments(r.resolved);
  return (
    <Card padding="md" aria-labelledby="who-title" className={styles.who}>
      <CardHeader
        id="who-title"
        title="Who resolved them"
        subtitle={`${r.resolved.total} tickets resolved`}
      />
      {segments.length === 0 ? (
        <p className={styles.note}>Nothing was resolved in this period.</p>
      ) : (
        <>
          <div
            className={styles.splitBar}
            role="img"
            aria-label={segments.map((s) => `${s.label}: ${s.count}`).join(', ')}
          >
            {segments.map((s) => (
              <span
                key={s.key}
                className={styles[`seg-${s.key}`]}
                style={{ flexGrow: s.count }}
                title={`${s.label}: ${s.count}`}
              />
            ))}
          </div>
          <ul className={styles.splitLegend}>
            {segments.map((s) => (
              <li key={s.key} data-segment={s.key}>
                <span className={cx(styles.swatch, styles[`seg-${s.key}`])} aria-hidden="true" />
                <span>{s.label}</span>
                <span className="tabular">
                  {s.count} · {percent(s.share)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <dl className={styles.aiFlow}>
        <div>
          <dt>Tickets the AI worked on</dt>
          <dd className="tabular">{r.aiWorked.total}</dd>
        </div>
        <div>
          <dt>Resolved without a person</dt>
          <dd className="tabular">
            {r.aiWorked.deflected} · {percent(r.aiWorked.deflectionRate)}
          </dd>
        </div>
        <div>
          <dt>Passed to a person</dt>
          <dd className="tabular">
            {r.aiWorked.toPerson} · {percent(r.aiWorked.handoverRate)}
          </dd>
        </div>
        <div>
          <dt>Still with the AI</dt>
          <dd className="tabular">{r.aiWorked.open}</dd>
        </div>
      </dl>
    </Card>
  );
}
