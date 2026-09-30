import type { ReactNode } from 'react';
import styles from './GradientText.module.css';

/** Cosmic gradient — text and thin strokes only, never fills. */
export function GradientText({ children }: { children: ReactNode }) {
  return <span className={styles.gradient}>{children}</span>;
}
