import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { hasPermissionAtScope, type Permission, type Persona, type Scope } from '@widedrop/shared';
import { api, restoreSession, setAccessToken, setSessionLostHandler } from '../lib/api.js';

/**
 * Session state.
 *
 * `personas` is used to decide what to *render*. It is never used to decide
 * what is *allowed*: every request is authorised again on the server against
 * the roles current at that moment. A client that lied about its roles would
 * see extra menu items and get a 403 from every one of them.
 */

export interface CurrentUser {
  id: string;
  email: string;
  employeeId: string | null;
  displayName: string;
  initials: string;
  employeeNumber: string | null;
  designation: string | null;
  department: string | null;
  location: string | null;
  personas: Persona[];
  mustChangePassword: boolean;
  mfaEnrolled: boolean;
  mfaSatisfied: boolean;
}

type Status = 'restoring' | 'signed-out' | 'signed-in';

interface AuthContextValue {
  status: Status;
  user: CurrentUser | null;
  signIn: (token: string, user: CurrentUser) => void;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  /** What to render. Never what to allow — the server decides that. */
  can: (permission: Permission, scope?: Scope) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('restoring');
  const [user, setUser] = useState<CurrentUser | null>(null);

  const loadUser = useCallback(async () => {
    const me = await api.get<CurrentUser>('/api/v1/auth/me');
    setUser(me);
    return me;
  }, []);

  // A cold start has no access token, only the refresh cookie. One attempt to
  // exchange it decides between the portal and the sign-in screen.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const restored = await restoreSession();
      if (cancelled) return;

      if (!restored) {
        setStatus('signed-out');
        return;
      }

      try {
        await loadUser();
        if (!cancelled) setStatus('signed-in');
      } catch {
        if (!cancelled) {
          setAccessToken(null);
          setStatus('signed-out');
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadUser]);

  // A refresh that fails mid-session returns the user to sign-in rather than
  // leaving them clicking into errors.
  useEffect(() => {
    setSessionLostHandler(() => {
      setUser(null);
      setStatus('signed-out');
    });
  }, []);

  const signIn = useCallback((token: string, nextUser: CurrentUser) => {
    setAccessToken(token);
    setUser(nextUser);
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/v1/auth/logout');
    } catch {
      // Signing out locally must succeed even if the server cannot be reached;
      // the session is revoked server-side on its next use either way.
    }
    setAccessToken(null);
    setUser(null);
    setStatus('signed-out');
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      signIn,
      signOut,
      refreshUser: async () => {
        await loadUser();
      },
      can: (permission, scope = 'SELF') =>
        user ? hasPermissionAtScope(user.personas, permission, scope) : false,
    }),
    [status, user, signIn, signOut, loadUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside an AuthProvider');
  return context;
}

/** The signed-in user, or a throw. For screens behind the auth boundary. */
export function useCurrentUser(): CurrentUser {
  const { user } = useAuth();
  if (!user) throw new Error('No signed-in user: this screen is behind the auth boundary');
  return user;
}
