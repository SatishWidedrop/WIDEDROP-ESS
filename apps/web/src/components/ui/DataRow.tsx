import type { ReactNode } from 'react';
import { EMPTY_VALUE } from '@widedrop/shared';
import styles from './DataRow.module.css';

/**
 * The prototype's list row: a leading glyph or reference, a two-line middle,
 * an amount, and a status.
 *
 * Used for claims, tickets, documents, requests and payroll rows. Made one
 * component rather than five so they stay identical, which is what makes a
 * portal feel like one product.
 */
export interface DataRowProps {
  /** A monospace reference or an avatar. */
  leading?: ReactNode;
  title: string;
  meta?: string | null;
  value?: string | null;
  trailing?: ReactNode;
  onClick?: () => void;
  selected?: boolean;
}

export function DataRow({
  leading,
  title,
  meta,
  value,
  trailing,
  onClick,
  selected,
}: DataRowProps) {
  const content = (
    <>
      {leading ? <span className={styles.leading}>{leading}</span> : null}
      <span className={styles.main}>
        <span className={styles.title}>{title}</span>
        {meta ? <span className={styles.meta}>{meta}</span> : null}
      </span>
      {value !== undefined ? (
        <span className={`${styles.value} ${value === null ? styles.absent : ''}`}>
          {value ?? EMPTY_VALUE}
        </span>
      ) : null}
      {trailing ? <span className={styles.trailing}>{trailing}</span> : null}
    </>
  );

  if (!onClick) return <div className={styles.row}>{content}</div>;

  return (
    <button
      type="button"
      className={`${styles.row} ${styles.clickable} ${selected ? styles.selected : ''}`}
      onClick={onClick}
      aria-current={selected ? 'true' : undefined}
    >
      {content}
    </button>
  );
}

/** A monospace reference, as the prototype prints `EXP-2291` and `HD-4821`. */
export function Reference({ children }: { children: ReactNode }) {
  return <span className={styles.reference}>{children}</span>;
}

/** A label/value pair, as the prototype's detail grids show. */
export function DetailGrid({ children }: { children: ReactNode }) {
  return <div className={styles.detailGrid}>{children}</div>;
}

export function Detail({ label, value }: { label: string; value: string | null | undefined }) {
  const absent = value === null || value === undefined || value === '';
  return (
    <div className={styles.detail}>
      <div className={styles.detailLabel}>{label}</div>
      <div className={`${styles.detailValue} ${absent ? styles.absent : ''}`}>
        {absent ? EMPTY_VALUE : value}
      </div>
    </div>
  );
}

/** The prototype's progress bar: a used/total ratio, never a made-up one. */
export function Meter({
  value,
  max,
  label,
  tone = 'accent',
}: {
  value: number;
  max: number;
  label: string;
  tone?: 'accent' | 'green' | 'amber' | 'red';
}) {
  // A zero denominator is a real state — an entitlement nobody has been given
  // — and must not render as a full bar or a NaN width.
  const fraction = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;

  return (
    <div
      className={styles.meter}
      role="meter"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-label={label}
    >
      <div
        className={`${styles.meterFill} ${styles[tone]}`}
        style={{ width: `${(fraction * 100).toFixed(2)}%` }}
      />
    </div>
  );
}
