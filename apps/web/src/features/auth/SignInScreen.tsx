import { useState, type FormEvent } from 'react';
import type { SessionResponse } from '@widedrop/shared';
import { ApiError, api, setAccessToken } from '../../lib/api.js';
import { useAuth, type CurrentUser } from '../../app/AuthProvider.js';
import { Button } from '../../components/ui/Button.js';
import { Icon } from '../../components/ui/Icon.js';
import styles from './SignInScreen.module.css';

interface MfaChallenge {
  status: 'mfa-required';
  challengeId: string;
  expiresIn: number;
  enrolmentRequired: boolean;
}

type Step = { kind: 'credentials' } | { kind: 'second-factor'; challenge: MfaChallenge };

export function SignInScreen() {
  const { signIn } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function completeSignIn(session: SessionResponse) {
    setAccessToken(session.accessToken);
    const me = await api.get<CurrentUser>('/api/v1/auth/me');
    signIn(session.accessToken, me);
  }

  async function onSubmitCredentials(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    try {
      const result = await api.post<SessionResponse | MfaChallenge>(
        '/api/v1/auth/login',
        { email, password },
        { skipRefresh: true },
      );

      if ('status' in result && result.status === 'mfa-required') {
        setStep({ kind: 'second-factor', challenge: result });
        setPassword('');
        return;
      }

      await completeSignIn(result as SessionResponse);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  }

  async function onSubmitCode(event: FormEvent) {
    event.preventDefault();
    if (step.kind !== 'second-factor') return;
    setError(null);
    setBusy(true);

    try {
      const session = await api.post<SessionResponse>(
        '/api/v1/auth/mfa/verify',
        { challengeId: step.challenge.challengeId, code },
        { skipRefresh: true },
      );
      await completeSignIn(session);
    } catch (caught) {
      setError(messageFor(caught));
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <img className={styles.logo} src="/widedrop-logo.png" alt="" width={44} height={44} />
          <div>
            <h1 className={styles.title}>Widedrop</h1>
            <p className={styles.subtitle}>Employee portal</p>
          </div>
        </div>

        {error ? (
          <div className={styles.error} role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </div>
        ) : null}

        {step.kind === 'credentials' ? (
          <form className={styles.form} onSubmit={onSubmitCredentials} noValidate>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="email">
                Work email
              </label>
              <input
                id="email"
                className={styles.input}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoComplete="username"
                required
                autoFocus
                placeholder="you@widedrop.com"
              />
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor="password">
                Password
              </label>
              <input
                id="password"
                className={styles.input}
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                required
              />
            </div>

            <Button type="submit" variant="primary" fullWidth busy={busy} size="large">
              Sign in
            </Button>
          </form>
        ) : (
          <form className={styles.form} onSubmit={onSubmitCode} noValidate>
            {step.challenge.enrolmentRequired ? (
              <p className={styles.hint}>
                Your role requires two-factor authentication. Set it up from a device you have with
                you, then sign in again.
              </p>
            ) : (
              <>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="code">
                    Authentication code
                  </label>
                  <input
                    id="code"
                    className={`${styles.input} ${styles.codeInput}`}
                    type="text"
                    inputMode="numeric"
                    value={code}
                    onChange={(event) => setCode(event.target.value)}
                    autoComplete="one-time-code"
                    maxLength={14}
                    required
                    autoFocus
                    placeholder="000000"
                  />
                  <span className={styles.hint}>
                    Six digits from your authenticator app, or one of your recovery codes.
                  </span>
                </div>

                <Button type="submit" variant="primary" fullWidth busy={busy} size="large">
                  Verify
                </Button>
              </>
            )}

            <Button
              type="button"
              variant="ghost"
              fullWidth
              onClick={() => {
                setStep({ kind: 'credentials' });
                setCode('');
                setError(null);
              }}
            >
              Back
            </Button>
          </form>
        )}

        <p className={styles.footer}>
          Trouble signing in? Contact{' '}
          <a href="mailto:helpdesk@widedroptech.com">helpdesk@widedroptech.com</a>
        </p>
      </div>
    </div>
  );
}

/**
 * What to show the person.
 *
 * The server's message is already written for them and deliberately says no
 * more than it should; anything else gets a generic line rather than a stack
 * trace or a status code.
 */
function messageFor(caught: unknown): string {
  if (caught instanceof ApiError) return caught.message;
  return 'Could not reach the server. Check your connection and try again.';
}
