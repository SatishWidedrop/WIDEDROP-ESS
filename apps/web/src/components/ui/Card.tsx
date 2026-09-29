import type { ReactNode } from 'react';
import styles from './Card.module.css';

export interface CardProps {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Removes body padding, for a card whose content is a full-bleed table. */
  flush?: boolean;
  className?: string;
  /** Renders as a section with an accessible name, for landmark navigation. */
  as?: 'div' | 'section';
}

export function Card({
  title,
  subtitle,
  actions,
  children,
  flush = false,
  className,
  as: Element = 'section',
}: CardProps) {
  const labelId = title ? `card-${title.replace(/\W+/g, '-').toLowerCase()}` : undefined;

  return (
    <Element
      className={`${styles.card} ${className ?? ''}`}
      {...(labelId ? { 'aria-labelledby': labelId } : {})}
    >
      {title ? (
        <header className={styles.header}>
          <div className={styles.titleGroup}>
            <h2 className={styles.title} id={labelId}>
              {title}
            </h2>
            {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
          </div>
          {actions ? <div className={styles.actions}>{actions}</div> : null}
        </header>
      ) : null}
      <div className={`${styles.body} ${flush ? styles.bodyFlush : ''}`}>{children}</div>
    </Element>
  );
}
