import type { PerformanceReport } from '@tms/shared';
import { type KeyboardEvent, type PointerEvent, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card, CardHeader } from '../../components/ui';
import { chartScale, shortDate } from '../dashboard/logic';
import styles from './Reports.module.css';

const HEIGHT = 240;
const M = { top: 12, right: 12, bottom: 28, left: 36 };
/** Surface shown between the two parts of a bar, so they read as two marks. */
const GAP = 2;

function useWidth<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return [ref, width] as const;
}

/**
 * Tickets resolved per day, stacked: the AI (accent) on the baseline, people
 * (neutral) above it. One axis, a legend, a tooltip per day and a table view.
 */
export function ResolvedChart({ daily }: { daily: PerformanceReport['daily'] }) {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [wrapRef, width] = useWidth<HTMLDivElement>(!asTable);

  const n = daily.length;
  const innerW = Math.max(width - M.left - M.right, 10);
  const innerH = HEIGHT - M.top - M.bottom;
  const { max, ticks } = chartScale(daily.map((d) => d.resolvedAi + d.resolvedHuman));
  const band = innerW / Math.max(n, 1);
  const barW = Math.max(2, Math.min(28, band * 0.62));
  const x = (i: number) => M.left + band * i + (band - barW) / 2;
  const h = (v: number) => (v / max) * innerH;
  const base = M.top + innerH;
  const labelEvery = Math.max(1, Math.ceil(n / (width < 520 ? 4 : 8)));
  const total = daily.reduce((sum, d) => sum + d.resolvedAi + d.resolvedHuman, 0);
  const byAi = daily.reduce((sum, d) => sum + d.resolvedAi, 0);

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor(((e.clientX - rect.left) / rect.width) * n);
    setActive(Math.max(0, Math.min(n - 1, i)));
  };
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((i) =>
      Math.max(0, Math.min(n - 1, (i ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))),
    );
  };

  const center = active === null ? 0 : x(active) + barW / 2;
  const flip = center > width - 190;
  const tipStyle =
    active === null
      ? undefined
      : { left: center + (flip ? -12 : 12), transform: flip ? 'translateX(-100%)' : undefined };

  return (
    <Card className={styles.chartCard} aria-labelledby="resolved-title">
      <CardHeader
        id="resolved-title"
        title="Resolved per day"
        subtitle="By the AI alone, and by people"
        actions={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setAsTable((v) => !v)}
            aria-pressed={asTable}
          >
            {asTable ? 'View chart' : 'View table'}
          </Button>
        }
      />
      <ul className={styles.legend} aria-label="Legend">
        <li>
          <span className={`${styles.swatch} ${styles.ai}`} aria-hidden="true" />
          The AI alone
        </li>
        <li>
          <span className={`${styles.swatch} ${styles.human}`} aria-hidden="true" />
          People
        </li>
      </ul>

      {asTable ? (
        <div className={styles.chartTableWrap}>
          <table className={styles.chartTable}>
            <caption className="visually-hidden">Tickets created and resolved per day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Created</th>
                <th scope="col">Resolved by the AI</th>
                <th scope="col">Resolved by people</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((d) => (
                <tr key={d.date}>
                  <th scope="row">{shortDate(d.date)}</th>
                  <td className="tabular">{d.created}</td>
                  <td className="tabular">{d.resolvedAi}</td>
                  <td className="tabular">{d.resolvedHuman}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={wrapRef} className={styles.plot}>
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-label={`Stacked bar chart of tickets resolved per day over ${n} days: ${total} in all, ${byAi} by the AI alone. Use arrow keys to inspect days.`}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
            className={styles.svg}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line
                  x1={M.left}
                  x2={M.left + innerW}
                  y1={base - h(t)}
                  y2={base - h(t)}
                  className={t === 0 ? styles.baseline : styles.grid}
                />
                <text
                  x={M.left - 10}
                  y={base - h(t)}
                  dy="0.32em"
                  textAnchor="end"
                  className={styles.axis}
                >
                  {t}
                </text>
              </g>
            ))}
            {daily.map((d, i) =>
              (i % labelEvery === 0 && n - 1 - i >= labelEvery) || i === n - 1 ? (
                <text
                  key={d.date}
                  x={x(i) + barW / 2}
                  y={HEIGHT - 8}
                  textAnchor={i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
                  className={styles.axis}
                >
                  {shortDate(d.date)}
                </text>
              ) : null,
            )}
            {daily.map((d, i) => {
              const ai = h(d.resolvedAi);
              const human = h(d.resolvedHuman);
              const gap = ai > 0 && human > 0 ? GAP : 0;
              return (
                <g key={d.date} opacity={active === null || active === i ? 1 : 0.45}>
                  {ai > 0 && (
                    <rect
                      x={x(i)}
                      y={base - ai}
                      width={barW}
                      height={ai}
                      rx={human > 0 ? 0 : Math.min(4, barW / 2)}
                      className={styles.ai}
                    />
                  )}
                  {human > 0 && (
                    <rect
                      x={x(i)}
                      y={base - ai - gap - Math.max(human - gap, 1)}
                      width={barW}
                      height={Math.max(human - gap, 1)}
                      rx={Math.min(4, barW / 2)}
                      className={styles.human}
                    />
                  )}
                </g>
              );
            })}
            <rect
              x={M.left}
              y={M.top}
              width={innerW}
              height={innerH}
              className={styles.hit}
              onPointerMove={onPointerMove}
              onPointerLeave={() => setActive(null)}
            />
          </svg>
          {active !== null && (
            <div className={styles.tooltip} style={tipStyle} role="status">
              <p className={styles.tipDay}>{shortDate(daily[active]!.date)}</p>
              <p className={styles.tipRow}>
                <span className={`${styles.swatch} ${styles.ai}`} aria-hidden="true" />
                <span>The AI alone</span>
                <span className="tabular">{daily[active]!.resolvedAi}</span>
              </p>
              <p className={styles.tipRow}>
                <span className={`${styles.swatch} ${styles.human}`} aria-hidden="true" />
                <span>People</span>
                <span className="tabular">{daily[active]!.resolvedHuman}</span>
              </p>
              <p className={styles.tipRow}>
                <span />
                <span>Created</span>
                <span className="tabular">{daily[active]!.created}</span>
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
