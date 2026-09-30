import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';
import { markOverdueAcknowledgements } from './services/policies/service.js';
import { startOutboxWorker } from './services/email/worker.js';

/**
 * The background worker.
 *
 * A separate process from the API on purpose. Draining mail and sweeping
 * overdue acknowledgements must not compete with a request for the API's event
 * loop, and the two scale differently: one API instance per traffic, exactly
 * one worker regardless.
 *
 *   npm run worker -w @widedrop/api
 *
 * It is safe to run more than one — the outbox is claimed with SKIP LOCKED —
 * but there is no reason to at this volume.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env).child({ process: 'worker' });
  const db = createPrismaClient(env, logger);

  await db.$queryRaw`SELECT 1`;

  const outbox = startOutboxWorker(db, env, logger);
  const sweeps = startPeriodicSweeps(db, logger, env.WORKER_POLL_INTERVAL_MS);

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');

    const force = setTimeout(() => {
      logger.error('worker shutdown timed out; exiting');
      process.exit(1);
    }, 25_000);
    force.unref();

    try {
      // Finishing the message in flight rather than abandoning it: a message
      // left in SENDING would wait for the stall reclaim to notice.
      await Promise.all([outbox.stop(), sweeps.stop()]);
      await db.$disconnect();
      clearTimeout(force);
      logger.info('worker shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'worker shutdown failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection in worker');
    void shutdown('SIGTERM');
  });
}

/**
 * The periodic sweeps.
 *
 * Only work that must happen without a request: marking an acknowledgement
 * overdue is a stored status rather than a render-time comparison, so what an
 * employee sees and what a compliance report counts cannot disagree.
 */
function startPeriodicSweeps(
  db: ReturnType<typeof createPrismaClient>,
  logger: ReturnType<typeof createLogger>,
  intervalMs: number,
): { stop: () => Promise<void> } {
  // An hour is the right cadence: "overdue" is measured in days, and sweeping
  // more often would be churn.
  const period = Math.max(intervalMs, 3_600_000);
  let running = true;
  let current: Promise<unknown> = Promise.resolve();

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const organizations = await db.organization.findMany({
          where: { isActive: true },
          select: { id: true, displayName: true },
        });

        for (const organization of organizations) {
          const overdue = await db.$transaction((tx) =>
            markOverdueAcknowledgements(tx, organization.id),
          );
          if (overdue > 0) {
            logger.info(
              { organizationId: organization.id, count: overdue },
              'policy acknowledgements marked overdue',
            );
          }
        }
      } catch (error) {
        logger.error({ err: error }, 'periodic sweep failed');
      }

      for (let waited = 0; waited < period && running; waited += 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  };

  current = loop();

  return {
    async stop() {
      running = false;
      await current;
    },
  };
}

main().catch((error: unknown) => {
  console.error('Worker failed to start:', error instanceof Error ? error.message : error);
  process.exit(1);
});
