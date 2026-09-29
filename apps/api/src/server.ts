import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';

/**
 * Process entry point.
 *
 * Configuration is validated before anything else: a deployment missing a
 * secret fails here, loudly, rather than serving traffic with an insecure
 * default.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env);
  const db = createPrismaClient(env, logger);

  // Fail fast if the database is unreachable, rather than accepting traffic and
  // returning 500s to every caller.
  await db.$queryRaw`SELECT 1`;

  const app = await buildApp({ env, db, logger });
  const { registerRoutes } = await import('./routes/index.js');
  await registerRoutes(app);

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');

  /**
   * Graceful shutdown.
   *
   * The platform sends SIGTERM and then kills the process. Draining in-flight
   * requests first means a deploy does not abort somebody's payroll run
   * half-way through.
   */
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('shutdown timed out; exiting');
      process.exit(1);
    }, 25_000);
    force.unref();

    try {
      await app.close();
      await db.$disconnect();
      clearTimeout(force);
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // An unhandled rejection has left some invariant unknown. Exiting and letting
  // the platform restart is safer than continuing in an undefined state.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('SIGTERM');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet, so this is the one place console is correct.
  console.error('Failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
