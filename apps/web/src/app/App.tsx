import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from '../lib/api.js';
import { ToastProvider } from '../components/ui/Toast.js';
import { AuthProvider, useAuth } from './AuthProvider.js';
import { AppRoutes } from './AppRoutes.js';
import { SignInScreen } from '../features/auth/SignInScreen.js';
import { SkeletonLines } from '../components/ui/Skeleton.js';

/**
 * Query defaults.
 *
 * The important one is the retry rule: a 401, 403 or 404 is an answer, not a
 * failure to retry. Retrying a 403 three times just makes three audit entries
 * for the same refusal.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Payroll and leave data changes on someone else's action, so a stale
      // window of a minute is right: long enough to avoid refetch storms,
      // short enough that an approval shows up without a reload.
      staleTime: 60_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      retry: (failureCount, error) => {
        if (error instanceof ApiError) {
          if (error.status === 401 || error.status === 403 || error.status === 404) return false;
          if (error.status === 429) return false;
        }
        return failureCount < 2;
      },
    },
    mutations: {
      // A mutation is never retried automatically: the server may have applied
      // the first attempt, and a second could double an expense claim.
      retry: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <ToastProvider>
            <Gate />
          </ToastProvider>
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

/**
 * The auth boundary.
 *
 * Nothing behind it renders until the session is known, so a screen never
 * flashes signed-in content and then bounces to sign-in.
 */
function Gate() {
  const { status } = useAuth();

  if (status === 'restoring') {
    return (
      <div style={{ padding: 32, maxWidth: 480, margin: '0 auto' }}>
        <SkeletonLines count={4} />
      </div>
    );
  }

  if (status === 'signed-out') return <SignInScreen />;

  return <AppRoutes />;
}
