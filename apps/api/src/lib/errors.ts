/**
 * The API's error model.
 *
 * Every failure leaves the process as an `AppError` and is serialised into one
 * envelope:
 *
 *   { "error": { "code": "...", "message": "...", "details": [...], "requestId": "..." } }
 *
 * `message` is written for the person reading it and never carries internals —
 * no stack traces, no SQL, no file paths, no upstream provider text. Anything an
 * operator needs goes to the structured log under the same `requestId`.
 */

export const ERROR_CODES = {
  /* 400 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',

  /* 401 */
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  MFA_REQUIRED: 'MFA_REQUIRED',
  INVALID_MFA_CODE: 'INVALID_MFA_CODE',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  TOKEN_REUSE_DETECTED: 'TOKEN_REUSE_DETECTED',

  /* 403 */
  FORBIDDEN: 'FORBIDDEN',
  OUT_OF_SCOPE: 'OUT_OF_SCOPE',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  ACCOUNT_INACTIVE: 'ACCOUNT_INACTIVE',
  MFA_ENROLMENT_REQUIRED: 'MFA_ENROLMENT_REQUIRED',
  CSRF_CHECK_FAILED: 'CSRF_CHECK_FAILED',

  /* 404 */
  NOT_FOUND: 'NOT_FOUND',

  /* 409 */
  CONFLICT: 'CONFLICT',
  ALREADY_EXISTS: 'ALREADY_EXISTS',
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',
  CONCURRENT_MODIFICATION: 'CONCURRENT_MODIFICATION',
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',

  /* 422 */
  BUSINESS_RULE_VIOLATION: 'BUSINESS_RULE_VIOLATION',
  INSUFFICIENT_LEAVE_BALANCE: 'INSUFFICIENT_LEAVE_BALANCE',
  OVERLAPPING_REQUEST: 'OVERLAPPING_REQUEST',
  PAYROLL_PREREQUISITE_NOT_MET: 'PAYROLL_PREREQUISITE_NOT_MET',
  PAYROLL_VALIDATION_FAILED: 'PAYROLL_VALIDATION_FAILED',
  EXPENSE_CAP_EXCEEDED: 'EXPENSE_CAP_EXCEEDED',
  POLICY_VERSION_SUPERSEDED: 'POLICY_VERSION_SUPERSEDED',

  /* 429 */
  RATE_LIMITED: 'RATE_LIMITED',

  /* 5xx */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  DEPENDENCY_FAILURE: 'DEPENDENCY_FAILURE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ErrorDetail {
  /** Dotted path into the request body/query, e.g. `dates.from`. */
  path?: string;
  message: string;
  /** Machine-readable sub-reason, e.g. `too_small`. */
  rule?: string;
}

export interface AppErrorOptions {
  /** Context for the log only — never serialised to the client. */
  meta?: Record<string, unknown>;
  details?: ErrorDetail[];
  cause?: unknown;
  /** Seconds the client should wait before retrying (429/503). */
  retryAfterSeconds?: number;
  /**
   * True when this error is a normal, expected outcome (a validation failure, a
   * denied permission). Unexpected errors are logged at `error`, expected ones
   * at `info`, so genuine incidents stay visible.
   */
  expected?: boolean;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: ErrorCode;
  readonly details: ErrorDetail[] | undefined;
  readonly meta: Record<string, unknown> | undefined;
  readonly retryAfterSeconds: number | undefined;
  readonly expected: boolean;

  constructor(statusCode: number, code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.meta = options.meta;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.expected = options.expected ?? statusCode < 500;
    Error.captureStackTrace?.(this, AppError);
  }

  toEnvelope(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details?.length ? { details: this.details } : {}),
        requestId,
      },
    };
  }
}

/* ------------------------------------------------------------------ */
/* Constructors                                                        */
/* ------------------------------------------------------------------ */

export const badRequest = (message: string, details?: ErrorDetail[], meta?: Record<string, unknown>) =>
  new AppError(400, ERROR_CODES.VALIDATION_FAILED, message, { details, meta });

export const validationFailed = (details: ErrorDetail[]) =>
  new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'The request could not be validated.', {
    details,
  });

/**
 * Authentication failures always use the same message and the same code, so a
 * caller cannot distinguish "no such account" from "wrong password" and use the
 * endpoint to enumerate employees.
 */
export const invalidCredentials = (meta?: Record<string, unknown>) =>
  new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'Email or password is incorrect.', { meta });

export const authenticationRequired = (message = 'Sign in to continue.') =>
  new AppError(401, ERROR_CODES.AUTHENTICATION_REQUIRED, message);

export const sessionExpired = () =>
  new AppError(401, ERROR_CODES.SESSION_EXPIRED, 'Your session has expired. Sign in again.');

export const mfaRequired = (challengeId: string) =>
  new AppError(401, ERROR_CODES.MFA_REQUIRED, 'Enter the code from your authenticator app.', {
    details: [{ path: 'mfaChallengeId', message: challengeId }],
  });

/**
 * Authorization failures are deliberately uniform: a caller who may not see a
 * resource cannot tell whether it exists. Use `notFound` instead when the
 * caller may know of the resource's existence.
 */
export const forbidden = (message = 'You do not have access to this.', meta?: Record<string, unknown>) =>
  new AppError(403, ERROR_CODES.FORBIDDEN, message, { meta });

export const outOfScope = (meta?: Record<string, unknown>) =>
  new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'This record is outside the people you manage.', {
    meta,
  });

export const accountLocked = (retryAfterSeconds: number) =>
  new AppError(
    403,
    ERROR_CODES.ACCOUNT_LOCKED,
    'Too many failed sign-in attempts. Try again later or reset your password.',
    { retryAfterSeconds },
  );

export const notFound = (what = 'The requested record', meta?: Record<string, unknown>) =>
  new AppError(404, ERROR_CODES.NOT_FOUND, `${what} could not be found.`, { meta });

export const conflict = (message: string, code: ErrorCode = ERROR_CODES.CONFLICT, meta?: Record<string, unknown>) =>
  new AppError(409, code, message, { meta });

export const invalidTransition = (from: string, to: string, meta?: Record<string, unknown>) =>
  new AppError(
    409,
    ERROR_CODES.INVALID_STATE_TRANSITION,
    `This cannot move from ${from} to ${to}.`,
    { meta: { ...meta, from, to } },
  );

export const concurrentModification = () =>
  new AppError(
    409,
    ERROR_CODES.CONCURRENT_MODIFICATION,
    'Someone else changed this while you were working. Reload and try again.',
  );

export const businessRule = (
  code: ErrorCode,
  message: string,
  details?: ErrorDetail[],
  meta?: Record<string, unknown>,
) => new AppError(422, code, message, { details, meta });

export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests. Slow down and try again.', {
    retryAfterSeconds,
  });

export const internal = (cause?: unknown, meta?: Record<string, unknown>) =>
  new AppError(500, ERROR_CODES.INTERNAL_ERROR, 'Something went wrong on our side.', {
    cause,
    meta,
    expected: false,
  });

export const dependencyFailure = (dependency: string, cause?: unknown) =>
  new AppError(503, ERROR_CODES.DEPENDENCY_FAILURE, 'A required service is unavailable. Try again shortly.', {
    cause,
    meta: { dependency },
    retryAfterSeconds: 30,
    expected: false,
  });

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
