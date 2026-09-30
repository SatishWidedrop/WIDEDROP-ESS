import { randomUUID } from 'node:crypto';
import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';
import { markOverdueAcknowledgements } from './services/policies/service.js';
import { startOutboxWorker } from './services/email/worker.js';
import { renderPendingPayslips } from './services/payroll/render.js';
import { sweepExpiredRateLimits } from './plugins/rate-limit-store.js';
import { runAsSystem } from './lib/request-context.js';

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
  const renders = startRenderSweep(db, env, logger, env.WORKER_POLL_INTERVAL_MS);

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
      await Promise.all([outbox.stop(), sweeps.stop(), renders.stop()]);
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
 * Payslip documents that were not rendered.
 *
 * Calculating a cycle renders them, so this normally finds nothing. It exists
 * for the run where storage was unavailable for a minute: the publish guard
 * refuses a cycle whose payslips have no document, and without this somebody
 * has to notice and retry by hand.
 *
 * Kept separate from the hourly sweeps because the cadence is different — this
 * is unblocking a person who is waiting to publish, not maintaining a status
 * measured in days.
 */
function startRenderSweep(
  db: ReturnType<typeof createPrismaClient>,
  env: ReturnType<typeof loadEnv>,
  logger: ReturnType<typeof createLogger>,
  intervalMs: number,
): { stop: () => Promise<void> } {
  let running = true;

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        // Cycles with at least one payslip missing its document. Grouped so
        // one query finds the work rather than one per cycle.
        const pending = await db.payslip.groupBy({
          by: ['organizationId', 'payrollCycleId'],
          where: { pdfFileObjectId: null, status: { in: ['GENERATED', 'PUBLISHED'] } },
          _count: { _all: true },
        });

        for (const group of pending) {
          if (!running) break;
          // Under a job context, so the audit rows this writes carry a request
          // id and a route naming the job. An audit row whose origin is "some
          // background process" is a row somebody has to guess about.
          const summary = await runAsSystem(
            {
              requestId: randomUUID(),
              organizationId: group.organizationId,
              job: 'payslip-render',
            },
            () =>
              renderPendingPayslips(db, env, {
                organizationId: group.organizationId,
                cycleId: group.payrollCycleId,
              }),
          );
          if (summary.rendered > 0 || summary.failed.length > 0) {
            logger.info(
              {
                cycleId: group.payrollCycleId,
                rendered: summary.rendered,
                failed: summary.failed.length,
              },
              'swept payslip documents',
            );
          }
          // A cycle whose renders keep failing must not be retried in a tight
          // loop for the rest of the hour; the next pass will reach it.
          if (summary.failed.length > 0) break;
        }
      } catch (error) {
        logger.error({ err: error }, 'payslip render sweep failed');
      }

      for (let waited = 0; waited < intervalMs && running; waited += 1_000) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  };

  const current = loop();

  return {
    async stop() {
      running = false;
      await current;
    },
  };
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

        // Windows that closed over an hour ago. Nothing depends on this for
        // correctness — an expired row is reset in place by the next request
        // that touches its key — but a key seen once and never again would
        // otherwise sit in the table forever.
        const sweptLimits = await sweepExpiredRateLimits(db);
        if (sweptLimits > 0) {
          logger.info({ count: sweptLimits }, 'swept expired rate-limit windows');
        }

        for (const organization of organizations) {
          const overdue = await runAsSystem(
            {
              requestId: randomUUID(),
              organizationId: organization.id,
              job: 'policy-acknowledgement-sweep',
            },
            () => db.$transaction((tx) => markOverdueAcknowledgements(tx, organization.id)),
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
