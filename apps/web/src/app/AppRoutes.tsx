import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { queryKeys } from '../lib/queryKeys.js';
import { SkeletonLines } from '../components/ui/Skeleton.js';
import { AppShell, type BadgeCounts } from './AppShell.js';
import { Toolbar } from './Toolbar.js';
import { useCurrentUser } from './AuthProvider.js';

const HomeScreen = lazy(() =>
  import('../features/home/HomeScreen.js').then((m) => ({ default: m.HomeScreen })),
);
const PayslipsScreen = lazy(() =>
  import('../features/payslips/PayslipsScreen.js').then((m) => ({ default: m.PayslipsScreen })),
);

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
          <Route path="/" element={<HomeScreen />} />
          <Route path="/payslips" element={<PayslipsScreen />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}
