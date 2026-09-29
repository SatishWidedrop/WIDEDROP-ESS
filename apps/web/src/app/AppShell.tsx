import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { Persona } from '@widedrop/shared';
import { Avatar } from '../components/ui/Avatar.js';
import { Icon } from '../components/ui/Icon.js';
import { useContainerBreakpoints } from '../hooks/useContainerBreakpoints.js';
import { navigationFor, tabBarFor, titleForPath, type NavItem } from './navigation.js';
import { ShellLayoutContext } from './ShellLayoutContext.js';
import styles from './AppShell.module.css';

export interface ShellUser {
  displayName: string;
  initials: string;
  employeeNumber: string | null;
  location: string | null;
  department: string | null;
  personas: Persona[];
}

/** Counts the shell shows on nav badges. Every one is a count of real rows. */
export interface BadgeCounts {
  approvals?: number;
  policies?: number;
  tickets?: number;
  payrollActions?: number;
  attendanceActions?: number;
}

export interface AppShellProps {
  user: ShellUser;
  badges: BadgeCounts;
  /** Rendered into the top bar: search, notifications, account menu. */
  toolbar?: ReactNode;
  children: ReactNode;
}

export function AppShell({ user, badges, toolbar, children }: AppShellProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const { compact, stack } = useContainerBreakpoints(shellRef, mainRef);
  const [moreOpen, setMoreOpen] = useState(false);
  const location = useLocation();

  const groups = navigationFor(user.personas);
  const tabs = tabBarFor(user.personas);

  // A route change returns the reader to the top of the page and closes the
  // sheet. Without this, a long scroll position carries into the next screen.
  useEffect(() => {
    setMoreOpen(false);
    mainRef.current?.scrollTo({ top: 0, behavior: 'auto' });
  }, [location.pathname]);

  // Escape closes the sheet, which is what a keyboard user will try first.
  useEffect(() => {
    if (!moreOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [moreOpen]);

  return (
    <ShellLayoutContext.Provider value={{ compact, stack }}>
      <div className={styles.page}>
        <div
          ref={shellRef}
          className={styles.shell}
          // Drives the grid templates and the toast offset from one place.
          data-compact={compact ? 'true' : 'false'}
          data-stack={stack ? 'true' : 'false'}
        >
          <a className="skip-link" href="#main-content">
            Skip to content
          </a>

          {!compact ? (
            <aside className={styles.sidebar} aria-label="Main">
              <div className={styles.brand}>
                <img
                  className={styles.brandLogo}
                  src="/widedrop-logo.png"
                  alt=""
                  width={30}
                  height={30}
                />
                <div className={styles.brandText}>
                  <div className={styles.brandName}>Widedrop</div>
                  <div className={styles.brandSub}>Employee portal</div>
                </div>
              </div>

              <nav className={styles.nav}>
                {groups.map((group) => (
                  <div key={group.name}>
                    <div className={styles.groupLabel} id={`nav-group-${slug(group.name)}`}>
                      {group.name}
                    </div>
                    <div
                      className={styles.groupItems}
                      role="group"
                      aria-labelledby={`nav-group-${slug(group.name)}`}
                    >
                      {group.items.map((item) => (
                        <SidebarItem key={item.id} item={item} badges={badges} />
                      ))}
                    </div>
                  </div>
                ))}
              </nav>

              <div className={styles.userCard}>
                <Avatar
                  initials={user.initials}
                  department={user.department}
                  name={user.displayName}
                  size={34}
                />
                <div className={styles.userInfo}>
                  <div className={styles.userName}>{user.displayName}</div>
                  <div className={styles.userMeta}>
                    {[user.employeeNumber, user.location].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
              </div>
            </aside>
          ) : null}

          <div className={styles.column}>
            {compact ? (
              <header className={styles.mobileHeader}>
                <img
                  className={styles.mobileLogo}
                  src="/widedrop-logo.png"
                  alt="Widedrop"
                  width={26}
                  height={26}
                />
                <h1 className={styles.mobileTitle}>{titleForPath(location.pathname)}</h1>
                {toolbar}
              </header>
            ) : (
              <header className={styles.topBar}>{toolbar}</header>
            )}

            <main className={styles.main} id="main-content" ref={mainRef} tabIndex={-1}>
              <div className={styles.mainInner}>{children}</div>
            </main>

            {compact ? (
              <nav className={styles.tabBar} aria-label="Sections">
                {tabs.map((item) => (
                  <TabItem key={item.id} item={item} badges={badges} />
                ))}
                <button
                  type="button"
                  className={styles.tab}
                  onClick={() => setMoreOpen(true)}
                  aria-expanded={moreOpen}
                  aria-haspopup="dialog"
                >
                  <Icon name="menu" size={20} />
                  More
                </button>
              </nav>
            ) : null}

            {moreOpen ? (
              <MoreSheet groups={groups} badges={badges} onClose={() => setMoreOpen(false)} />
            ) : null}
          </div>
        </div>
      </div>
    </ShellLayoutContext.Provider>
  );
}

function SidebarItem({ item, badges }: { item: NavItem; badges: BadgeCounts }) {
  const count = item.badgeKey ? (badges[item.badgeKey] ?? 0) : 0;

  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) => `${styles.navItem} ${isActive ? styles.navItemActive : ''}`}
    >
      {({ isActive }) => (
        <>
          <Icon
            name={item.icon}
            size={20}
            color={isActive ? 'var(--accent-soft)' : 'var(--text-muted)'}
          />
          <span className={styles.navLabel}>{item.label}</span>
          {count > 0 ? (
            <span className={styles.badge}>
              {count}
              <span className="sr-only"> items need your attention</span>
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

function TabItem({ item, badges }: { item: NavItem; badges: BadgeCounts }) {
  const count = item.badgeKey ? (badges[item.badgeKey] ?? 0) : 0;

  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) => `${styles.tab} ${isActive ? styles.tabActive : ''}`}
    >
      <Icon name={item.icon} size={20} />
      {item.label}
      {count > 0 ? (
        <span className={styles.tabBadge}>
          {count > 99 ? '99+' : count}
          <span className="sr-only"> items need your attention</span>
        </span>
      ) : null}
    </NavLink>
  );
}

function MoreSheet({
  groups,
  badges,
  onClose,
}: {
  groups: ReturnType<typeof navigationFor>;
  badges: BadgeCounts;
  onClose: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Focus moves into the sheet so the keyboard follows the eye, and the first
  // Tab lands inside rather than behind it.
  useEffect(() => {
    sheetRef.current?.focus();
  }, []);

  return (
    <>
      <div className={styles.scrim} onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-label="All sections"
        tabIndex={-1}
      >
        <div className={styles.sheetHandle} aria-hidden="true" />
        {groups.map((group) => (
          <div key={group.name} className={styles.sheetGroup}>
            <div className={styles.groupLabel}>{group.name}</div>
            <div className={styles.groupItems}>
              {group.items.map((item) => (
                <SidebarItem key={item.id} item={item} badges={badges} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function slug(value: string): string {
  return value.toLowerCase().replace(/\W+/g, '-');
}
