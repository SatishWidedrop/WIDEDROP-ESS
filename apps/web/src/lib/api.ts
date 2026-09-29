import type { ErrorEnvelope } from '@widedrop/shared';

/**
 * The API client.
 *
 * Two things it is built around:
 *
 *  1. **The access token lives in memory only.** Not localStorage, not a
 *     cookie the browser attaches on its own. Script that manages to run on the
 *     page cannot read it from storage, and a cross-site request cannot spend
 *     it, because nothing sends it automatically.
 *
 *  2. **A 401 triggers exactly one refresh.** Concurrent requests that all get
 *     401 share a single refresh attempt and then retry, rather than starting a
 *     stampede of refreshes that would trip the server's reuse detection.
 */

const BASE_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
const CSRF_COOKIE = 'ess_csrf';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: { path?: string; message: string; rule?: string }[] | undefined;
  readonly requestId: string | undefined;

  constructor(status: number, envelope: ErrorEnvelope['error'] | undefined, fallback: string) {
    super(envelope?.message ?? fallback);
    this.name = 'ApiError';
    this.status = status;
    this.code = envelope?.code ?? 'UNKNOWN';
    this.details = envelope?.details;
    this.requestId = envelope?.requestId;
  }

  /** The message for a named field, for inline form errors. */
  fieldError(path: string): string | undefined {
    return this.details?.find((detail) => detail.path === path)?.message;
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isPermissionError(): boolean {
    return this.status === 403;
  }
}

/* ------------------------------------------------------------------ */
/* Token, held in a closure rather than in storage                     */
/* ------------------------------------------------------------------ */

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

/** Called when a refresh fails, so the app can return to the sign-in screen. */
export function setSessionLostHandler(handler: () => void): void {
  onSessionLost = handler;
}

/* ------------------------------------------------------------------ */
/* CSRF                                                                */
/* ------------------------------------------------------------------ */

/**
 * Read the double-submit token the server set.
 *
 * Deliberately readable by script: that is what proves the request came from a
 * page on our own origin, since a cross-site caller can cause the cookie to be
 * sent but cannot read it to echo it back in a header.
 */
function csrfToken(): string | undefined {
  const match = document.cookie.split('; ').find((entry) => entry.startsWith(`${CSRF_COOKIE}=`));
  return match?.slice(CSRF_COOKIE.length + 1);
}

/* ------------------------------------------------------------------ */
/* Refresh, shared across concurrent callers                           */
/* ------------------------------------------------------------------ */

let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  // One refresh at a time. Several parallel refreshes would each rotate the
  // token, and the server would read the second as a reuse — signing the user
  // out of every device for doing nothing wrong.
  refreshInFlight ??= (async () => {
    try {
      const response = await fetch(`${BASE_URL}/api/v1/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
      });

      if (!response.ok) {
        accessToken = null;
        return false;
      }

      const body = (await response.json()) as { accessToken: string };
      accessToken = body.accessToken;
      return true;
    } catch {
      accessToken = null;
      return false;
    } finally {
      // Cleared on the next tick so callers awaiting this promise all see the
      // same outcome before a new attempt can start.
      queueMicrotask(() => {
        refreshInFlight = null;
      });
    }
  })();

  return refreshInFlight;
}

/* ------------------------------------------------------------------ */
/* Request                                                             */
/* ------------------------------------------------------------------ */

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Query parameters. Undefined and null values are omitted. */
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /** Makes a retried mutation safe: the server returns the original response. */
  idempotencyKey?: string;
  /** Optimistic concurrency: the server rejects a stale write with 409. */
  ifMatch?: number;
  /** Skips the refresh-and-retry, for the auth endpoints themselves. */
  skipRefresh?: boolean;
}

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await send(path, options);

  // One refresh, then one retry. A second 401 means the session is genuinely
  // gone rather than merely expired.
  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      const retried = await send(path, options);
      return handle<T>(retried);
    }
    accessToken = null;
    onSessionLost?.();
  }

  return handle<T>(response);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const url = new URL(`${BASE_URL}${path}`, window.location.origin);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.ifMatch !== undefined) headers['if-match'] = String(options.ifMatch);

  // Every state-changing request carries the double-submit token. GET is the
  // only method this client issues that does not change state.
  if (method !== 'GET') {
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;
  }

  return fetch(url.toString(), {
    method,
    headers,
    // Sends the refresh and CSRF cookies. Required for the session to work at
    // all, and safe because the server allows an exact origin list, never a
    // reflected one.
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function handle<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const parsed: unknown = text.length > 0 ? safeParse(text) : undefined;

  if (!response.ok) {
    const envelope = (parsed as ErrorEnvelope | undefined)?.error;
    throw new ApiError(response.status, envelope, defaultMessage(response.status));
  }

  return parsed as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * What to say when the server did not say anything usable — a gateway timeout,
 * a proxy error page, a dropped connection.
 */
function defaultMessage(status: number): string {
  if (status === 0) return 'Could not reach the server. Check your connection.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status === 503) return 'The service is busy. Try again in a moment.';
  if (status >= 500) return 'Something went wrong on our side. Try again.';
  return 'That request could not be completed.';
}

/* ------------------------------------------------------------------ */
/* Convenience                                                         */
/* ------------------------------------------------------------------ */

export const api = {
  get: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'GET' }),

  post: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'POST', body }),

  patch: <T>(path: string, body?: unknown, options: Omit<RequestOptions, 'method'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'PATCH', body }),

  delete: <T>(path: string, options: Omit<RequestOptions, 'method' | 'body'> = {}) =>
    apiRequest<T>(path, { ...options, method: 'DELETE' }),
};

/** Restore a session on a cold start, using the refresh cookie alone. */
export async function restoreSession(): Promise<boolean> {
  return refreshSession();
}
