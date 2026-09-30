import { Suspense, lazy, type ComponentType } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { Persona } from '@widedrop/shared';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/queryKeys.js';
import { EmptyState } from '../components/ui/EmptyState.js';
import { SkeletonLines } from '../components/ui/Skeleton.js';
import { AppShell, type BadgeCounts } from './AppShell.js';
import { Toolbar } from './Toolbar.js';
import { useCurrentUser } from './AuthProvider.js';

/**
 * The routing table.
 *
 * Every screen is code-split, so signing in loads the shell and Home rather
 * than fifteen screens most people will not open. Routes a persona cannot use
 * are not registered for them at all: a manager navigating to `/payroll/cycles`
 * gets the same "not available" screen as a typo, rather than a screen that
 * renders and then 403s on every request it makes.
 *
 * The server decides what is allowed; this only decides what is worth
 * rendering.
 */

const HomeScreen = lazy(() =>
  import('../features/home/HomeScreen.js').then((m) => ({ default: m.HomeScreen })),
);
const PayslipsScreen = lazy(() =>
  import('../features/payslips/PayslipsScreen.js').then((m) => ({ default: m.PayslipsScreen })),
);
const TaxScreen = lazy(() =>
  import('../features/tax/TaxScreen.js').then((m) => ({ default: m.TaxScreen })),
);
const ProfileScreen = lazy(() =>
  import('../features/profile/ProfileScreen.js').then((m) => ({ default: m.ProfileScreen })),
);
const LeaveScreen = lazy(() =>
  import('../features/leave/LeaveScreen.js').then((m) => ({ default: m.LeaveScreen })),
);
const BenefitsScreen = lazy(() =>
  import('../features/benefits/BenefitsScreen.js').then((m) => ({ default: m.BenefitsScreen })),
);
const ExpensesScreen = lazy(() =>
  import('../features/expenses/ExpensesScreen.js').then((m) => ({ default: m.ExpensesScreen })),
);
const DocumentsScreen = lazy(() =>
  import('../features/documents/DocumentsScreen.js').then((m) => ({ default: m.DocumentsScreen })),
);
const PoliciesScreen = lazy(() =>
  import('../features/policies/PoliciesScreen.js').then((m) => ({ default: m.PoliciesScreen })),
);
const DirectoryScreen = lazy(() =>
  import('../features/directory/DirectoryScreen.js').then((m) => ({ default: m.DirectoryScreen })),
);
const AnnouncementsScreen = lazy(() =>
  import('../features/announcements/AnnouncementsScreen.js').then((m) => ({
    default: m.AnnouncementsScreen,
  })),
);
const HelpScreen = lazy(() =>
  import('../features/help/HelpScreen.js').then((m) => ({ default: m.HelpScreen })),
);
const ApprovalsScreen = lazy(() =>
  import('../features/approvals/ApprovalsScreen.js').then((m) => ({ default: m.ApprovalsScreen })),
);
const AttendanceScreen = lazy(() =>
  import('../features/attendance/AttendanceScreen.js').then((m) => ({
    default: m.AttendanceScreen,
  })),
);
const EmployeesScreen = lazy(() =>
  import('../features/hr/EmployeesScreen.js').then((m) => ({ default: m.EmployeesScreen })),
);
const PolicyAdminScreen = lazy(() =>
  import('../features/hr/PolicyAdminScreen.js').then((m) => ({ default: m.PolicyAdminScreen })),
);
const AnnouncementAdminScreen = lazy(() =>
  import('../features/hr/AnnouncementAdminScreen.js').then((m) => ({
    default: m.AnnouncementAdminScreen,
  })),
);
const LetterRequestsScreen = lazy(() =>
  import('../features/hr/LetterRequestsScreen.js').then((m) => ({
    default: m.LetterRequestsScreen,
  })),
);
const TicketQueueScreen = lazy(() =>
  import('../features/hr/TicketQueueScreen.js').then((m) => ({ default: m.TicketQueueScreen })),
);
const PayrollCyclesScreen = lazy(() =>
  import('../features/payroll/PayrollCyclesScreen.js').then((m) => ({
    default: m.PayrollCyclesScreen,
  })),
);
const PayrollInputsScreen = lazy(() =>
  import('../features/payroll/PayrollInputsScreen.js').then((m) => ({
    default: m.PayrollInputsScreen,
  })),
);
const ReimbursementsScreen = lazy(() =>
  import('../features/payroll/ReimbursementsScreen.js').then((m) => ({
    default: m.ReimbursementsScreen,
  })),
);
const AuditScreen = lazy(() =>
  import('../features/audit/AuditScreen.js').then((m) => ({ default: m.AuditScreen })),
);

interface RouteDefinition {
  path: string;
  element: ComponentType;
  /** Absent means every signed-in person. */
  personas?: Persona[];
}

const ROUTES: RouteDefinition[] = [
  { path: '/', element: HomeScreen },
  { path: '/payslips', element: PayslipsScreen },
  { path: '/tax', element: TaxScreen },
  { path: '/profile', element: ProfileScreen },
  { path: '/leave', element: LeaveScreen },
  { path: '/benefits', element: BenefitsScreen },
  { path: '/expenses', element: ExpensesScreen },
  { path: '/documents', element: DocumentsScreen },
  { path: '/policies', element: PoliciesScreen },
  { path: '/directory', element: DirectoryScreen },
  { path: '/announcements', element: AnnouncementsScreen },
  { path: '/help', element: HelpScreen },
  { path: '/attendance', element: () => <AttendanceScreen variant="self" /> },

  { path: '/approvals', element: ApprovalsScreen, personas: ['MANAGER'] },
  {
    path: '/team/attendance',
    element: () => <AttendanceScreen variant="team" />,
    personas: ['MANAGER'],
  },

  { path: '/hr/employees', element: EmployeesScreen, personas: ['HR'] },
  {
    path: '/hr/attendance',
    element: () => <AttendanceScreen variant="hr" />,
    personas: ['HR'],
  },
  { path: '/hr/policies', element: PolicyAdminScreen, personas: ['HR'] },
  { path: '/hr/announcements', element: AnnouncementAdminScreen, personas: ['HR'] },
  { path: '/hr/documents', element: LetterRequestsScreen, personas: ['HR'] },
  { path: '/hr/tickets', element: TicketQueueScreen, personas: ['HR'] },

  { path: '/payroll/cycles', element: PayrollCyclesScreen, personas: ['ACCOUNTS'] },
  { path: '/payroll/inputs', element: PayrollInputsScreen, personas: ['ACCOUNTS'] },
  { path: '/payroll/reimbursements', element: ReimbursementsScreen, personas: ['ACCOUNTS'] },

  { path: '/audit', element: AuditScreen, personas: ['HR', 'ACCOUNTS'] },
];

export function AppRoutes() {
  const user = useCurrentUser();

  /**
   * Badge counts.
   *
   * Every one is a count of real rows the server returns. Nothing here invents
   * a number, and a count the server has not sent renders as no badge rather
   * than as a zero.
   */
  const { data: badges } = useQuery({
    queryKey: queryKeys.badges,
    queryFn: () => api.get<BadgeCounts>('/api/v1/me/badges'),
    // A badge is a nudge, not a fact someone acts on directly, so a failure
    // shows no badge rather than an error screen.
    retry: false,
    staleTime: 30_000,
  });

  const visible = ROUTES.filter(
    (route) => !route.personas || route.personas.some((persona) => user.personas.includes(persona)),
  );

  return (
    <AppShell
      user={{
        displayName: user.displayName,
        initials: user.initials,
        employeeNumber: user.employeeNumber,
        location: user.location,
        department: user.department,
        personas: user.personas,
      }}
      badges={badges ?? {}}
      toolbar={<Toolbar />}
    >
      <Suspense fallback={<SkeletonLines count={5} />}>
        <Routes>
          {visible.map((route) => (
            <Route key={route.path} path={route.path} element={<route.element />} />
          ))}

          {/*
            A path that exists for somebody but not for this person says so,
            rather than silently redirecting home — which reads as a bug when
            a colleague shares a link.
          */}
          {ROUTES.filter((route) => !visible.includes(route)).map((route) => (
            <Route
              key={route.path}
              path={route.path}
              element={
                <EmptyState
                  icon="alert"
                  title="Not available to you"
                  body="This part of the portal belongs to a role you do not hold. If you think you should have it, raise a help-desk ticket."
                />
              }
            />
          ))}

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
