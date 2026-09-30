import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

/**
 * The heading every screen opens with.
 *
 * One component rather than a heading and a paragraph repeated fifteen times,
 * so the type scale and the spacing cannot drift between screens — which is
 * most of what makes a set of pages feel like one product.
 */
export interface PageHeaderProps {
  title: string;
  /**
   * What the screen covers. Written from data where there is any: "12 published
   * payslips", not "Your payslips". Absent rather than invented when there is
   * nothing to say.
   */
  subtitle?: string | null;
  /** Filters, a year picker, a primary action. */
  actions?: ReactNode;
  /** A status pill beside the title, as the prototype shows on Tax slips. */
  badge?: ReactNode;
}

export function PageHeader({ title, subtitle, actions, badge }: PageHeaderProps) {
  return (
    <header className={styles.header}>
      <div className={styles.titleGroup}>
        <div className={styles.titleRow}>
          <h1 className={styles.title}>{title}</h1>
          {badge}
        </div>
        {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
      </div>
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </header>
  );
}

/** Two columns that stack when the main area is narrow. */
export function SplitLayout({
  children,
  variant = 'split',
}: {
  children: ReactNode;
  /**
   * `split` puts a list beside a detail pane, `form` a form beside lists, and
   * `calendar` the reverse. Each resolves to a custom property the shell sets
   * from its own width, so the layout follows the content area rather than the
   * viewport — the prototype's behaviour, which a media query cannot reproduce
   * when the sidebar collapses.
   */
  variant?: 'split' | 'form' | 'calendar';
}) {
  const modifier = { split: styles.asSplit, form: styles.asForm, calendar: styles.asCalendar }[
    variant
  ];
  return <div className={`${styles.split} ${modifier}`}>{children}</div>;
}

/** A vertical run of cards. */
export function Stack({ children }: { children: ReactNode }) {
  return <div className={styles.stack}>{children}</div>;
}
