import type { ReactNode } from 'react';
import styles from './Tabs.module.css';

export interface TabDefinition {
  id: string;
  label: string;
  /** A count beside the label. Omitted, not zero, when there is nothing. */
  count?: number | undefined;
}

export interface TabsProps {
  tabs: readonly TabDefinition[];
  active: string;
  onChange: (id: string) => void;
  /** Labels the tab list for assistive technology. */
  label: string;
}

/**
 * The prototype's segmented tab strip.
 *
 * A real tab list: arrow keys move between tabs and the panel is associated
 * with its tab, so a screen reader user is not left with a row of buttons that
 * change something invisible.
 */
export function Tabs({ tabs, active, onChange, label }: TabsProps) {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === active);
    if (index === -1) return;

    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;

    if (next === -1) return;
    event.preventDefault();
    onChange(tabs[next]!.id);
  }

  return (
    <div className={styles.strip} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          id={`tab-${tab.id}`}
          aria-selected={tab.id === active}
          aria-controls={`panel-${tab.id}`}
          tabIndex={tab.id === active ? 0 : -1}
          className={`${styles.tab} ${tab.id === active ? styles.active : ''}`}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 ? (
            <span className={styles.count}>{tab.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export function TabPanel({
  id,
  active,
  children,
}: {
  id: string;
  active: string;
  children: ReactNode;
}) {
  if (id !== active) return null;
  return (
    <div role="tabpanel" id={`panel-${id}`} aria-labelledby={`tab-${id}`} tabIndex={0}>
      {children}
    </div>
  );
}
