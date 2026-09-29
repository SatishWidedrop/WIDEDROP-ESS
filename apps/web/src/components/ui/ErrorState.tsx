import { ApiError } from '../../lib/api.js';
import { Button } from './Button.js';
import { Icon } from './Icon.js';
import styles from './ErrorState.module.css';

export interface ErrorStateProps {
  error: unknown;
  /** Offered when the failure is worth another attempt. */
  onRetry?: () => void;
  title?: string;
}

/**
 * What a screen shows when a request failed.
 *
 * Distinguishes the three cases a person can act on differently: they are not
 * allowed, the thing is not there, or something broke and retrying may work.
 * The request id is shown so the help desk can find the exact request.
 */
export function ErrorState({ error, onRetry, title }: ErrorStateProps) {
  const api = error instanceof ApiError ? error : undefined;

  const heading =
    title ??
    (api?.isPermissionError
      ? 'You do not have access to this'
      : api?.status === 404
        ? 'Not found'
        : 'Something went wrong');

  const body =
    api?.message ??
    'The request could not be completed. If this keeps happening, contact the help desk.';

  // Retrying a 403 or a 404 will fail the same way, so it is not offered.
  const retryable = onRetry && !api?.isPermissionError && api?.status !== 404;

  return (
    <div className={styles.root} role="alert">
      <Icon name="alert" size={28} className={styles.glyph} />
      <p className={styles.title}>{heading}</p>
      <p className={styles.body}>{body}</p>
      {api?.requestId ? <p className={styles.reference}>Reference {api.requestId}</p> : null}
      {retryable ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
