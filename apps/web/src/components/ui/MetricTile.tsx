import type { ReactNode } from 'react';
import { EMPTY_VALUE } from '@widedrop/shared';
import styles from './MetricTile.module.css';

export interface MetricTileProps {
  label: string;
  /**
   * The formatted value, or null when it does not exist yet.
   *
   * Null renders an em dash — never a zero. The distinction matters: a zero
   * asserts that someone earned nothing; an em dash says the figure does not
   * exist, which is what is true before payroll has run.
   */
  value: string | null;
  /** What the figure covers, so the number is never unexplained. */
  sub?: string | null;
  /** Shown in place of `sub` when the value is absent, explaining why. */
  absentSub?: string;
}

export function MetricTile({ label, value, sub, absentSub }: MetricTileProps) {
  const absent = value === null || value === EMPTY_VALUE;
  const caption = absent ? (absentSub ?? sub) : sub;

  return (
    <div className={styles.tile}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${absent ? styles.absent : ''}`}>
        {absent ? EMPTY_VALUE : value}
      </span>
      {caption ? <span className={styles.sub}>{caption}</span> : null}
    </div>
  );
}

export function MetricGrid({ children }: { children: ReactNode }) {
  return <div className={styles.grid}>{children}</div>;
}
