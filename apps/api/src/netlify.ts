import awsLambdaFastify, { type PromiseHandler } from '@fastify/aws-lambda';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';
import { registerRoutes } from './routes/index.js';

/**
 * The API as a serverless function.
 *
 * The same Fastify application `server.ts` listens with, handed to the
 * platform as a handler instead. Not a second implementation and not a
 * reduced one: every plugin still runs in the same order — request context,
 * security headers, CORS, rate limiting, CSRF, authentication, authorization —
 * so a route cannot behave one way here and another way under `node
 * dist/server.js`.
 *
 * ── Built once, not once per request ─────────────────────────────────
 * Everything below the fold is expensive: validating configuration, loading
 * and importing the signing keys, registering twenty route modules, opening a
 * database connection. A container serves many requests, so all of it happens
 * on the first one and is reused by the rest. Done per request it would add a
 * second to every call and open a connection per invocation, which is how a
 * pooler runs out of them.
 *
 * The promise, not the result, is what is cached: two requests arriving
 * together on a cold container must wait on one initialisation rather than
 * start two.
 */

/**
 * The promise-returning form.
 *
 * The adapter declares two overloads, promise and callback, and picks the
 * callback one when the return type is inferred — which then wants a third
 * argument that nothing here has. Naming the type selects the other.
 */
type Handler = PromiseHandler;

let handlerPromise: Promise<Handler> | undefined;

async function initialise(): Promise<Handler> {
  const env = loadEnv();
  const logger = createLogger(env);
  const db = createPrismaClient(env, logger);

  const app = await buildApp({ env, db, logger, serverless: true });
  await registerRoutes(app);
  // Fastify defers plugin registration until this resolves; without it the
  // first request races the plugins it depends on.
  await app.ready();

  // The Fastify instance is generic over its logger, which the adapter's
  // signature is not; the cast is about those generics and nothing else.
  return awsLambdaFastify(app as never, {
    // Types the adapter must base64-encode on the way out rather than treat as
    // text. A payslip PDF sent as text arrives corrupt.
    binaryMimeTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
    // The event and context are not needed on the request, and not copying
    // them saves the work on every call.
    decorateRequest: false,
    // The platform's own request id stays in the platform's logs. Fastify
    // mints the one the application logs and the error envelope carry, and
    // reconciling them here would suggest a client could supply it.
    serializeLambdaArguments: false,
  }) as Handler;
}

/**
 * The entry point the platform calls.
 *
 * Deliberately thin: everything it needs was built on the first invocation,
 * and anything that throws here would be an initialisation failure — a missing
 * secret, an unreachable database — which must fail the request rather than be
 * swallowed into a 200.
 */
export const handler = async (event: unknown, context: unknown) => {
  handlerPromise ??= initialise().catch((error: unknown) => {
    // Clear the cache so the next invocation retries rather than serving the
    // same failure from a container that will never recover. A database that
    // was briefly unreachable at cold start should not poison the container
    // for its lifetime.
    handlerPromise = undefined;
    throw error;
  });

  const ready = await handlerPromise;
  return ready(event as never, context as never);
};
