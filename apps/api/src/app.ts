import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import sensible from '@fastify/sensible';
import underPressure from '@fastify/under-pressure';
import { FILE_LIMITS } from '@widedrop/shared';
import type { Env } from './config/env.js';
import { createLogger, type Logger } from './lib/logger.js';
import { jsonReplacer } from './lib/serialize.js';
import { AppError, ERROR_CODES } from './lib/errors.js';
import { corsPlugin } from './plugins/cors.js';
import { csrfPlugin } from './plugins/csrf.js';
import { errorHandlerPlugin } from './plugins/error-handler.js';
import { rateLimitPlugin } from './plugins/rate-limit.js';
import { requestContextPlugin } from './plugins/request-context.js';
import { securityHeadersPlugin } from './plugins/security-headers.js';
import type { PrismaClient } from './generated/prisma/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    env: Env;
    db: PrismaClient;
  }
}

export interface AppDependencies {
  env: Env;
  db: PrismaClient;
  logger?: Logger;
}

/**
 * Build the Fastify instance.
 *
 * Plugin order is load-bearing and deliberate:
 *   1. request context — everything after it can log and audit with a request id
 *   2. security headers — set even on a response that fails later
 *   3. CORS — must answer preflight before anything rejects the request
 *   4. cookies — the CSRF check reads one
 *   5. rate limit — bounds the work an unauthenticated caller can cause
 *   6. CSRF — the last gate before a route runs
 */
/**
 * The concrete instance type, inferred from the Fastify call. Declaring it as
 * the generic `FastifyInstance` would widen the logger back to
 * `FastifyBaseLogger` and lose the pino types the plugins rely on.
 */
export type App = Awaited<ReturnType<typeof buildApp>>;

export async function buildApp({ env, db, logger }: AppDependencies) {
  const log = logger ?? createLogger(env);
  const isProduction = env.NODE_ENV === 'production';

  const app = Fastify({
    loggerInstance: log,
    // One id per request, minted here and reused by the context and the
    // response header — never taken from the client, who could otherwise
    // collide or poison log correlation.
    genReqId: () => randomUUID(),
    trustProxy: env.TRUST_PROXY,
    // A body larger than this is refused before it is buffered.
    bodyLimit: 1 * 1024 * 1024,
    // Slowloris: a client that dribbles headers holds a socket open for free.
    requestTimeout: 30_000,
    connectionTimeout: 30_000,
    keepAliveTimeout: 72_000,
    routerOptions: {
      // An unrecognised path should 404, not quietly match something adjacent.
      ignoreTrailingSlash: false,
      caseSensitive: true,
    },
    // Never echo the client's own URL back in an error body.
    onProtoPoisoning: 'remove',
    onConstructorPoisoning: 'remove',
  });

  app.decorate('env', env);
  app.decorate('db', db);

  // Money is bigint paise and must leave as a string of minor units, never as a
  // JavaScript number that could lose precision above 2^53.
  app.setSerializerCompiler(() => (data) => JSON.stringify(data, jsonReplacer));

  await app.register(requestContextPlugin, { trustProxy: env.TRUST_PROXY });
  await app.register(errorHandlerPlugin, { exposeStackTraces: !isProduction });
  await app.register(securityHeadersPlugin, { isProduction });
  await app.register(sensible);
  await app.register(corsPlugin, { allowedOrigins: env.CORS_ORIGINS });

  await app.register(cookie, {
    // Cookie values are opaque tokens; signing them adds nothing and would put
    // another secret in play.
    parseOptions: {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: env.COOKIE_SAMESITE,
      path: '/',
      ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
    },
  });

  await app.register(rateLimitPlugin, {
    redisUrl: env.REDIS_URL,
    // The fallback when there is no Redis: the database is already shared and
    // already on the path of every request, which beats a per-instance counter
    // that makes a sign-in lockout hold on one instance out of however many.
    ...(env.RATE_LIMIT_ALLOW_IN_PROCESS ? {} : { db }),
    // So the store holds a hash of an email rather than the email. Reused
    // rather than given its own variable — it is a keying secret here, not a
    // signature, and one fewer secret is one fewer to rotate and lose.
    keyingSecret: env.AUDIT_HMAC_KEY,
  });

  await app.register(csrfPlugin, {
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    allowedOrigins: env.CORS_ORIGINS,
    maxAgeSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  });

  await app.register(multipart, {
    limits: {
      fileSize: FILE_LIMITS.maxBytes,
      files: FILE_LIMITS.maxFilesPerRequest,
      // A multipart body with thousands of tiny fields is a cheap denial of
      // service; bound every dimension, not just the total size.
      fields: 20,
      fieldSize: 64 * 1024,
      fieldNameSize: 200,
      headerPairs: 200,
      parts: 30,
    },
    // Files are streamed to storage, never buffered whole in memory.
    attachFieldsToBody: false,
  });

  // Shed load rather than falling over: a saturated process returns 503 with a
  // Retry-After instead of timing every request out.
  await app.register(underPressure, {
    maxEventLoopDelay: 1_000,
    maxHeapUsedBytes: 0,
    maxRssBytes: 0,
    maxEventLoopUtilization: 0.98,
    retryAfter: 15,
    healthCheck: async () => {
      await db.$queryRaw`SELECT 1`;
      return true;
    },
    healthCheckInterval: 15_000,
    exposeStatusRoute: false,
    pressureHandler: () => {
      throw new AppError(
        503,
        ERROR_CODES.SERVICE_UNAVAILABLE,
        'The service is busy. Try again in a moment.',
        { retryAfterSeconds: 15, expected: false },
      );
    },
  });

  // A request that arrives with a body on a method that takes none is malformed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (typeof body !== 'string' || body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body) as unknown);
    } catch {
      done(
        new AppError(400, ERROR_CODES.MALFORMED_REQUEST, 'The request body is not valid JSON.'),
        undefined,
      );
    }
  });

  return app;
}
