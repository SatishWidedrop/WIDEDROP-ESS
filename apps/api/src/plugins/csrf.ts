import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
// Registered in app.ts; imported here for the reply.setCookie type augmentation.
import '@fastify/cookie';
import { AppError, ERROR_CODES } from '../lib/errors.js';

/**
 * Cross-site request forgery defence.
 *
 * The refresh token lives in a `SameSite=Lax` cookie, which already stops a
 * cross-site form or image from carrying it on a POST. This adds the second
 * layer, because `SameSite` is a browser behaviour rather than a guarantee and
 * because a same-site subdomain compromise would otherwise be enough:
 *
 *  1. Origin / Sec-Fetch-Site are checked on every state-changing request.
 *  2. A double-submit token must appear in both a cookie and a header, so a
 *     cross-site caller — which can send the cookie but cannot read it — fails.
 */

export const CSRF_COOKIE = 'ess_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes exempt from the double-submit token.
 *
 * They still go through the Origin and Sec-Fetch-Site checks — the exemption is
 * from the token only, because these run before a session exists and so before
 * a token could have been issued.
 *
 * `/auth/refresh` is here for a different reason worth stating. It reads a
 * cookie and issues a session, so it looks like exactly what a double-submit
 * token is for. But the SPA calls it on a cold start, when it may hold no token
 * at all, and refusing would sign the user out for no security gain: the
 * refresh cookie is SameSite=Lax, which a browser does not send on a
 * cross-site POST, and the Sec-Fetch-Site check rejects one that somehow
 * arrives. The token would add nothing and cost a spurious sign-out.
 */
const EXEMPT_PATHS = new Set([
  '/api/v1/auth/login',
  '/api/v1/auth/refresh',
  '/api/v1/auth/mfa/enrol',
  '/api/v1/auth/mfa/verify',
  '/api/v1/auth/password/reset/request',
  '/api/v1/auth/password/reset/confirm',
  '/api/v1/auth/invitation/accept',
  '/health',
  '/health/ready',
  '/version',
]);

export function issueCsrfToken(reply: FastifyReply, options: CsrfOptions): string {
  const token = randomBytes(32).toString('base64url');
  void reply.setCookie(CSRF_COOKIE, token, {
    // Readable by the SPA: the point of the double-submit pattern is that
    // same-origin script can echo it into a header and cross-site script cannot.
    httpOnly: false,
    secure: options.secure,
    sameSite: options.sameSite,
    path: '/',
    ...(options.domain ? { domain: options.domain } : {}),
    // Matched to the refresh token's lifetime. A shorter one would expire
    // mid-session and refuse writes from a browser whose session is still
    // perfectly valid.
    maxAge: options.maxAgeSeconds,
  });
  return token;
}

export function clearCsrfToken(reply: FastifyReply, options: CsrfOptions): void {
  void reply.clearCookie(CSRF_COOKIE, {
    path: '/',
    ...(options.domain ? { domain: options.domain } : {}),
  });
}

export interface CsrfOptions {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  domain?: string | undefined;
  allowedOrigins: string[];
  /** Matched to the refresh token's lifetime; see `issueCsrfToken`. */
  maxAgeSeconds: number;
}

export const csrfPlugin = fp(
  async (app: FastifyInstance, options: CsrfOptions) => {
    const allowedOrigins = new Set(options.allowedOrigins);

    app.addHook('onRequest', async (request: FastifyRequest) => {
      if (SAFE_METHODS.has(request.method)) return;

      const path = request.url.split('?')[0] ?? '';
      if (EXEMPT_PATHS.has(path)) {
        assertOrigin(request, allowedOrigins);
        return;
      }

      assertOrigin(request, allowedOrigins);

      const cookieToken = request.cookies?.[CSRF_COOKIE];
      const headerToken = request.headers[CSRF_HEADER];

      if (
        typeof cookieToken !== 'string' ||
        typeof headerToken !== 'string' ||
        cookieToken.length === 0 ||
        !constantTimeEqual(cookieToken, headerToken)
      ) {
        throw new AppError(
          403,
          ERROR_CODES.CSRF_CHECK_FAILED,
          'This request could not be verified. Reload the page and try again.',
          {
            meta: {
              hasCookie: typeof cookieToken === 'string',
              hasHeader: typeof headerToken === 'string',
            },
          },
        );
      }
    });
  },
  { name: 'csrf' },
);

/**
 * Reject a state-changing request whose origin is not one we serve.
 *
 * `Sec-Fetch-Site` is checked first because a browser sets it and script cannot
 * forge it. Where it is absent (an older browser, a non-browser client), the
 * Origin header is the fallback.
 */
function assertOrigin(request: FastifyRequest, allowedOrigins: Set<string>): void {
  const fetchSite = request.headers['sec-fetch-site'];
  if (typeof fetchSite === 'string') {
    if (fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchSite === 'none') return;
    throw new AppError(403, ERROR_CODES.CSRF_CHECK_FAILED, 'This request could not be verified.', {
      meta: { fetchSite },
    });
  }

  const origin = request.headers.origin;
  if (typeof origin === 'string') {
    if (allowedOrigins.has(origin)) return;
    throw new AppError(403, ERROR_CODES.CSRF_CHECK_FAILED, 'This request could not be verified.', {
      meta: { origin },
    });
  }

  // No Origin and no Sec-Fetch-Site: a non-browser caller. The double-submit
  // token still has to match, which a forged browser request cannot produce.
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
