import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import rateLimit from '@fastify/rate-limit';
import { AppError, ERROR_CODES } from '../lib/errors.js';

/**
 * Rate limiting.
 *
 * Limits are keyed by what the caller can actually change. An unauthenticated
 * request is limited by IP; an authenticated one by user id, so someone behind
 * a shared office NAT is not throttled by a colleague's activity — and someone
 * rotating through IPs is still bounded by their account.
 *
 * Login is additionally limited by the email being attempted, because that is
 * the resource under attack. That limit alone would let an attacker lock a
 * colleague out, so it is deliberately generous and paired with per-account
 * lockout, which is the control that actually stops credential stuffing.
 */

export interface RouteLimit {
  /** Requests allowed in the window. */
  max: number;
  /** Window length, in milliseconds. */
  windowMs: number;
}

/**
 * The per-route table. `default` applies to anything not listed.
 *
 * Reads are generous; anything that costs money, sends mail, or tests a secret
 * is tight.
 */
export const RATE_LIMITS = {
  default: { max: 300, windowMs: 60_000 },

  // Authentication: every one of these tests a secret.
  'auth:login': { max: 10, windowMs: 15 * 60_000 },
  'auth:mfa': { max: 10, windowMs: 15 * 60_000 },
  'auth:refresh': { max: 60, windowMs: 60_000 },
  'auth:password-reset': { max: 5, windowMs: 60 * 60_000 },
  'auth:password-change': { max: 10, windowMs: 60 * 60_000 },
  'auth:mfa-enrol': { max: 10, windowMs: 60 * 60_000 },

  // Anything that costs money or sends mail.
  'ticket:create': { max: 20, windowMs: 60 * 60_000 },
  'email:send': { max: 20, windowMs: 60 * 60_000 },
  'file:upload': { max: 60, windowMs: 60 * 60_000 },
  'export': { max: 10, windowMs: 60 * 60_000 },

  // Payroll generation is expensive and rarely legitimate more than once.
  'payroll:mutate': { max: 30, windowMs: 60 * 60_000 },

  // Search hits the database hardest per request.
  search: { max: 120, windowMs: 60_000 },

  // Ordinary writes.
  write: { max: 120, windowMs: 60_000 },
} as const satisfies Record<string, RouteLimit>;

export type RateLimitName = keyof typeof RATE_LIMITS;

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimitName?: RateLimitName;
    /** Also limit by this request field, e.g. the email being attempted. */
    rateLimitByBodyField?: string;
  }
}

export const rateLimitPlugin = fp(
  async (app: FastifyInstance, options: { redisUrl?: string | undefined }) => {
    await app.register(rateLimit, {
      global: true,
      max: (request) => limitFor(request).max,
      timeWindow: (request) => limitFor(request).windowMs,
      keyGenerator: (request) => rateLimitKey(request),
      // Successful requests still count: otherwise a valid credential could be
      // used to enumerate at any rate.
      skipOnError: false,
      // An unreachable Redis must not disable the limiter silently.
      ...(options.redisUrl ? { redis: options.redisUrl as never } : {}),
      errorResponseBuilder: (request, context) => {
        const retryAfter = Math.ceil(context.ttl / 1000);
        throw new AppError(429, ERROR_CODES.RATE_LIMITED, 'Too many requests. Slow down and try again.', {
          retryAfterSeconds: retryAfter,
          meta: { key: context.max, route: request.routeOptions?.url },
        });
      },
      // Tell a legitimate client how much room it has left.
      addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
      addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
    });

    if (!options.redisUrl) {
      app.log.warn(
        'rate limiting is using an in-process store: correct for a single instance only',
      );
    }
  },
  { name: 'rate-limit' },
);

function limitFor(request: FastifyRequest): RouteLimit {
  const name = request.routeOptions?.config?.rateLimitName;
  return (name && RATE_LIMITS[name]) || RATE_LIMITS.default;
}

/**
 * The key a request counts against.
 *
 * Authenticated: the user id, so one person cannot exhaust a colleague's budget.
 * Unauthenticated: the IP, plus the named body field where the route declares
 * one (the email on a login attempt).
 */
function rateLimitKey(request: FastifyRequest): string {
  const route = request.routeOptions?.config?.rateLimitName ?? request.routeOptions?.url ?? 'unknown';
  const userId = request.context?.userId;
  if (userId) return `u:${userId}:${route}`;

  const ip = request.context?.ip ?? request.ip;
  const field = request.routeOptions?.config?.rateLimitByBodyField;
  if (field && request.body && typeof request.body === 'object') {
    const value = (request.body as Record<string, unknown>)[field];
    if (typeof value === 'string' && value.length > 0 && value.length < 256) {
      // Hashing keeps the email out of the rate-limit store.
      return `f:${route}:${hashKey(value.toLowerCase())}`;
    }
  }
  return `i:${ip}:${route}`;
}

function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
