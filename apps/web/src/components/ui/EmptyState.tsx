import type { ReactNode } from 'react';
import { Icon } from './Icon.js';
import type { IconName } from '@widedrop/shared';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  /** What is absent, stated plainly. */
  title: string;
  /**
   * Why it is absent and what would change that. Never "No data available" —
   * a person reading an empty screen deserves to know whether they should do
   * something or wait for someone else to.
   */
  body: string;
  icon?: IconName;
  /** Offered only when this person can actually do the thing. */
  action?: ReactNode;
  compact?: boolean;
}

export function EmptyState({ title, body, icon = 'inbox', action, compact }: EmptyStateProps) {
  return (
    <div className={`${styles.root} ${compact ? styles.compact : ''}`} role="status">
      <Icon name={icon} size={compact ? 24 : 32} className={styles.glyph} />
      <p className={styles.title}>{title}</p>
      <p className={styles.body}>{body}</p>
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
