import { useId } from 'react';
import styles from './Sparkline.module.css';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  label: string;
}

/** Single-series trend mark for stat tiles — the tile's label names it, so no legend. */
export function Sparkline({ data, width = 120, height = 36, label }: SparklineProps) {
  const id = useId();
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map(
    (v, i) =>
      [
        pad + (i / (data.length - 1)) * (width - pad * 2),
        pad + (1 - (v - min) / span) * (height - pad * 2),
      ] as const,
  );
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
  const [lx, ly] = pts[pts.length - 1];

  return (
    <svg
      className={styles.spark}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="#9382ff" stopOpacity="0.18" />
          <stop offset="100%" stopColor="#9382ff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id}-fill)`} />
      <path d={line} className={styles.line} />
      <circle cx={lx} cy={ly} r="2.5" className={styles.dot} />
    </svg>
  );
}
