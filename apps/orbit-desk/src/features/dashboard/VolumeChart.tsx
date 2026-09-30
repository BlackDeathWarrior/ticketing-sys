import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { volume } from '../../data/mock';
import { Button, Card, CardHeader } from '../../components/ui';
import styles from './VolumeChart.module.css';

const MIN_HEIGHT = 232;
const M = { top: 12, right: 44, bottom: 28, left: 36 };

/** Tracks the plot box; the SVG is absolutely positioned so it never feeds back into this size. */
function useSize<T extends HTMLElement>(active: boolean) {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 640, height: MIN_HEIGHT });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) =>
      setSize({
        width: Math.round(entry.contentRect.width),
        height: Math.max(MIN_HEIGHT, Math.round(entry.contentRect.height)),
      }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, [active]);
  return [ref, size] as const;
}

const series = [
  { key: 'created', label: 'Created', values: volume.created, className: styles.created },
  { key: 'resolved', label: 'Resolved', values: volume.resolved, className: styles.resolved },
] as const;

/**
 * Created vs. resolved, 14 days. Two series on one axis: identity is carried by
 * line style (solid accent vs. dashed neutral) + legend + direct end labels.
 */
export function VolumeChart() {
  const [active, setActive] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const [wrapRef, { width, height: HEIGHT }] = useSize<HTMLDivElement>(!asTable);

  const n = volume.days.length;
  const innerW = Math.max(width - M.left - M.right, 10);
  const innerH = HEIGHT - M.top - M.bottom;
  const max = 140;
  const ticks = [0, 35, 70, 105, 140];
  const x = (i: number) => M.left + (i / (n - 1)) * innerW;
  const y = (v: number) => M.top + (1 - v / max) * innerH;
  const path = (values: readonly number[]) =>
    values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const labelEvery = width < 520 ? 4 : 2;

  const onPointerMove = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setActive(Math.max(0, Math.min(n - 1, Math.round(rel * (n - 1)))));
  };

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setActive((i) => {
      const cur = i ?? n - 1;
      return Math.max(0, Math.min(n - 1, cur + (e.key === 'ArrowRight' ? 1 : -1)));
    });
  };

  // Tooltip sits beside the crosshair (never over the markers), flipping left near the right edge.
  const flip = active !== null && x(active) > width - 190;
  const tipStyle =
    active !== null
      ? { left: x(active) + (flip ? -12 : 12), transform: flip ? 'translateX(-100%)' : undefined }
      : undefined;

  return (
    <Card className={styles.card} aria-labelledby="volume-title">
      <CardHeader
        id="volume-title"
        title="Ticket volume"
        subtitle="Created vs. resolved per day · last 14 days"
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
        {series.map((s) => (
          <li key={s.key}>
            <svg width="20" height="8" aria-hidden="true">
              <line x1="1" x2="19" y1="4" y2="4" className={s.className} />
            </svg>
            {s.label}
          </li>
        ))}
      </ul>

      {asTable ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <caption className="visually-hidden">Tickets created and resolved per day</caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Created</th>
                <th scope="col">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {volume.days.map((d, i) => (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  <td className="tabular">{volume.created[i]}</td>
                  <td className="tabular">{volume.resolved[i]}</td>
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
            aria-label={`Line chart. Created tickets rose from ${volume.created[0]} to ${volume.created[n - 1]} per day; resolved from ${volume.resolved[0]} to ${volume.resolved[n - 1]}. Use arrow keys to inspect days.`}
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
                  y1={y(t)}
                  y2={y(t)}
                  className={t === 0 ? styles.baseline : styles.grid}
                />
                <text x={M.left - 10} y={y(t)} dy="0.32em" textAnchor="end" className={styles.axis}>
                  {t}
                </text>
              </g>
            ))}
            {volume.days.map((d, i) =>
              (i % labelEvery === 0 && n - 1 - i >= labelEvery) || i === n - 1 ? (
                <text
                  key={d}
                  x={x(i)}
                  y={HEIGHT - 8}
                  textAnchor={i === n - 1 ? 'end' : i === 0 ? 'start' : 'middle'}
                  className={styles.axis}
                >
                  {i === n - 1 ? 'Today' : d}
                </text>
              ) : null,
            )}

            {active !== null && (
              <line
                x1={x(active)}
                x2={x(active)}
                y1={M.top}
                y2={M.top + innerH}
                className={styles.crosshair}
              />
            )}

            {series.map((s) => (
              <path key={s.key} d={path(s.values)} className={s.className} />
            ))}

            {/* Direct end labels */}
            {series.map((s, idx) => {
              const v = s.values[n - 1];
              const other = series[1 - idx].values[n - 1];
              const nudge = Math.abs(y(v) - y(other)) < 14 ? (v >= other ? -7 : 7) : 0;
              return (
                <text
                  key={s.key}
                  x={x(n - 1) + 8}
                  y={y(v) + nudge}
                  dy="0.32em"
                  className={styles.endLabel}
                >
                  {v}
                </text>
              );
            })}

            {active !== null &&
              series.map((s) => (
                <circle
                  key={s.key}
                  cx={x(active)}
                  cy={y(s.values[active])}
                  r="4.5"
                  className={`${styles.marker} ${s.className}`}
                />
              ))}

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
              <p className={styles.tipDay}>{volume.days[active]}</p>
              {series.map((s) => (
                <p key={s.key} className={styles.tipRow}>
                  <svg width="14" height="8" aria-hidden="true">
                    <line x1="1" x2="13" y1="4" y2="4" className={s.className} />
                  </svg>
                  <span>{s.label}</span>
                  <span className="tabular">{s.values[active]}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
