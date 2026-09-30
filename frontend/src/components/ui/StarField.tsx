import { useMemo } from 'react';
import { cx } from '../../lib/format';
import styles from './StarField.module.css';

/** Small deterministic PRNG so the sky is identical on every render. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stars(count: number, seed: number, width: number, height: number) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const x = Math.round(rand() * width);
    const y = Math.round(rand() * height);
    const a = (0.25 + rand() * 0.6).toFixed(2);
    return `${x}px ${y}px 0 0 rgba(244, 240, 255, ${a})`;
  }).join(', ');
}

interface StarFieldProps {
  className?: string;
  density?: number;
}

/**
 * Decorative constellation backdrop — 1px and 2px stars rendered as box-shadows
 * on two tiny elements (DESIGN.md › Star Field Background). Purely visual.
 */
export function StarField({ className, density = 1 }: StarFieldProps) {
  const layers = useMemo(
    () => ({
      small: stars(Math.round(180 * density), 7, 2000, 900),
      large: stars(Math.round(36 * density), 21, 2000, 900),
    }),
    [density],
  );
  return (
    <div className={cx(styles.field, className)} aria-hidden="true">
      <span className={styles.small} style={{ boxShadow: layers.small }} />
      <span className={styles.large} style={{ boxShadow: layers.large }} />
    </div>
  );
}
