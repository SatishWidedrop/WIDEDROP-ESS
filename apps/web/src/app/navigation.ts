import type { IconName, Persona } from '@widedrop/shared';

/**
 * The navigation tree.
 *
 * Groups, order, labels and icons are the prototype's, unchanged. The HR and
 * Accounts surfaces the payroll pipeline needs are appended as their own
 * groups, after Manager, in the same visual treatment.
 *
 * Every item names the permission it needs. The client uses that to decide what
 * to render; the server decides what to allow. A nav item nobody can reach is
 * not a security boundary — it is a courtesy.
 */
export interface NavItem {
  id: string;
  label: string;
  path: string;
  icon: IconName;
  group: string;
  /** Personas that see this item. Empty means everyone. */
  personas?: Persona[];
  /** Key into the badge counts the shell fetches. */
  badgeKey?: 'approvals' | 'policies' | 'tickets' | 'payrollActions' | 'attendanceActions';
}

export const NAV_ITEMS: NavItem[] = [
  // ── The prototype's own navigation, in its order ──────────────────
  { id: 'home', label: 'Home', path: '/', icon: 'home', group: 'Overview' },

  { id: 'payslips', label: 'Payslips', path: '/payslips', icon: 'payslips', group: 'Pay & tax' },
  { id: 'tax', label: 'Tax slips', path: '/tax', icon: 'tax', group: 'Pay & tax' },

  { id: 'profile', label: 'My profile', path: '/profile', icon: 'profile', group: 'My workplace' },
  { id: 'leave', label: 'Leave', path: '/leave', icon: 'leave', group: 'My workplace' },
  { id: 'benefits', label: 'Benefits', path: '/benefits', icon: 'benefits', group: 'My workplace' },
  { id: 'expenses', label: 'Expenses', path: '/expenses', icon: 'expenses', group: 'My workplace' },
  {
    id: 'documents',
    label: 'Documents',
    path: '/documents',
    icon: 'documents',
    group: 'My workplace',
  },

  {
    id: 'policies',
    label: 'Policies',
    path: '/policies',
    icon: 'policies',
    group: 'Company',
    badgeKey: 'policies',
  },
  { id: 'directory', label: 'Directory', path: '/directory', icon: 'directory', group: 'Company' },
  {
    id: 'announcements',
    label: 'Announcements',
    path: '/announcements',
    icon: 'announcements',
    group: 'Company',
  },

  { id: 'help', label: 'Help desk', path: '/help', icon: 'help', group: 'Support' },

  {
    id: 'approvals',
    label: 'Approvals',
    path: '/approvals',
    icon: 'approvals',
    group: 'Manager',
    personas: ['MANAGER'],
    badgeKey: 'approvals',
  },
  {
    id: 'team-attendance',
    label: 'Team attendance',
    path: '/team/attendance',
    icon: 'attendance',
    group: 'Manager',
    personas: ['MANAGER'],
    badgeKey: 'attendanceActions',
  },

  // ── HR ────────────────────────────────────────────────────────────
  {
    id: 'hr-employees',
    label: 'Employees',
    path: '/hr/employees',
    icon: 'employees',
    group: 'People Ops',
    personas: ['HR'],
  },
  {
    id: 'hr-attendance',
    label: 'Attendance',
    path: '/hr/attendance',
    icon: 'attendance',
    group: 'People Ops',
    personas: ['HR'],
    badgeKey: 'attendanceActions',
  },
  {
    id: 'hr-policies',
    label: 'Policy admin',
    path: '/hr/policies',
    icon: 'policies',
    group: 'People Ops',
    personas: ['HR'],
  },
  {
    id: 'hr-announcements',
    label: 'Announcement admin',
    path: '/hr/announcements',
    icon: 'announcements',
    group: 'People Ops',
    personas: ['HR'],
  },
  {
    id: 'hr-documents',
    label: 'Letter requests',
    path: '/hr/documents',
    icon: 'documents',
    group: 'People Ops',
    personas: ['HR'],
  },
  {
    id: 'hr-tickets',
    label: 'Help desk queue',
    path: '/hr/tickets',
    icon: 'help',
    group: 'People Ops',
    personas: ['HR'],
    badgeKey: 'tickets',
  },

  // ── Accounts ──────────────────────────────────────────────────────
  {
    id: 'payroll-cycles',
    label: 'Payroll cycles',
    path: '/payroll/cycles',
    icon: 'payroll',
    group: 'Payroll',
    personas: ['ACCOUNTS'],
    badgeKey: 'payrollActions',
  },
  {
    id: 'payroll-inputs',
    label: 'Payroll inputs',
    path: '/payroll/inputs',
    icon: 'upload',
    group: 'Payroll',
    personas: ['ACCOUNTS'],
  },
  {
    id: 'payroll-reimbursements',
    label: 'Reimbursements',
    path: '/payroll/reimbursements',
    icon: 'reimbursements',
    group: 'Payroll',
    personas: ['ACCOUNTS'],
  },

  // ── Compliance ────────────────────────────────────────────────────
  {
    id: 'audit',
    label: 'Audit trail',
    path: '/audit',
    icon: 'audit',
    group: 'Compliance',
    personas: ['HR', 'ACCOUNTS'],
  },
];

/** The group order. Anything unlisted sorts last, alphabetically. */
const GROUP_ORDER = [
  'Overview',
  'Pay & tax',
  'My workplace',
  'Company',
  'Support',
  'Manager',
  'People Ops',
  'Payroll',
  'Compliance',
];

export interface NavGroup {
  name: string;
  items: NavItem[];
}

/** The navigation this person actually sees, grouped and ordered. */
export function navigationFor(personas: readonly Persona[]): NavGroup[] {
  const visible = NAV_ITEMS.filter(
    (item) => !item.personas || item.personas.some((persona) => personas.includes(persona)),
  );

  const byGroup = new Map<string, NavItem[]>();
  for (const item of visible) {
    const existing = byGroup.get(item.group);
    if (existing) existing.push(item);
    else byGroup.set(item.group, [item]);
  }

  return [...byGroup.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => {
      const indexA = GROUP_ORDER.indexOf(a.name);
      const indexB = GROUP_ORDER.indexOf(b.name);
      if (indexA === -1 && indexB === -1) return a.name.localeCompare(b.name);
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
}

/**
 * The five slots in the compact tab bar.
 *
 * The prototype's choice: Home, Payslips, Leave, then Approvals for a manager
 * or My profile for everyone else, then More. Held to five because a sixth
 * makes each target too narrow to hit reliably on a phone.
 */
export function tabBarFor(personas: readonly Persona[]): NavItem[] {
  const byId = new Map(NAV_ITEMS.map((item) => [item.id, item]));
  const fourth = personas.includes('MANAGER')
    ? 'approvals'
    : personas.includes('ACCOUNTS')
      ? 'payroll-cycles'
      : personas.includes('HR')
        ? 'hr-attendance'
        : 'profile';

  return ['home', 'payslips', 'leave', fourth]
    .map((id) => byId.get(id))
    .filter((item): item is NavItem => item !== undefined);
}

/** The label the compact header shows for the current route. */
export function titleForPath(path: string): string {
  const exact = NAV_ITEMS.find((item) => item.path === path);
  if (exact) return exact.label;
  const prefix = NAV_ITEMS.filter((item) => item.path !== '/' && path.startsWith(item.path)).sort(
    (a, b) => b.path.length - a.path.length,
  )[0];
  return prefix?.label ?? 'Widedrop';
}
