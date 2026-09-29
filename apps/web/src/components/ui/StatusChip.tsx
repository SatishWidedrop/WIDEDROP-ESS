import type { Tone } from '@widedrop/shared';
import styles from './StatusChip.module.css';

export interface StatusChipProps {
  label: string;
  tone: Tone;
  /** Hidden text that explains the status where the label alone is terse. */
  description?: string;
  showDot?: boolean;
}

/**
 * The prototype's status pill.
 *
 * The tone is chosen by the caller from the status the server returned, never
 * inferred from the label text — a status the UI does not recognise renders
 * neutrally rather than guessing.
 */
export function StatusChip({ label, tone, description, showDot = true }: StatusChipProps) {
  return (
    <span className={`${styles.chip} ${styles[tone]}`}>
      {showDot ? <span className={styles.dot} aria-hidden="true" /> : null}
      {label}
      {description ? <span className="sr-only"> — {description}</span> : null}
    </span>
  );
}
