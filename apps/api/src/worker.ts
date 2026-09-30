import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { createPrismaClient } from './lib/prisma.js';
import { JOBS, runJob, type JobName } from './services/jobs/registry.js';

/**
 * The background worker.
 *
 * A separate process from the API on purpose. Draining mail and rendering
 * documents must not compete with a request for the API's event loop, and the
 * two scale differently: one API instance per traffic, exactly one worker
 * regardless.
 *
 *   npm run worker -w @widedrop/api
 *
 * ── It defines nothing ───────────────────────────────────────────────
 * Every job lives in `services/jobs/registry.ts`, because a serverless
 * deployment has no process to loop in and drives the same jobs through an
 * HTTP endpoint instead. This file is the timer; that file is the work. A
 * second implementation of "drain the outbox" would be a second set of
 * assumptions about leases and retries, and the first time they disagreed a
 * message would go out twice.
 *
 * It is safe to run more than one, and safe to run one alongside a scheduler
 * calling the endpoint: the outbox claims under a lease, rendering claims a
 * payslip conditionally, and the sweeps converge.
 */

/**
 * How often each job is attempted, in multiples of the poll interval.
 *
 * Maintenance is measured in days — an acknowledgement becomes overdue at
 * midnight — so running it every fifteen seconds would be a full scan per
 * organisation for nothing.
 */
const EVERY: Record<JobName, number> = {
  'email-outbox': 1,
  'payslip-documents': 1,
  maintenance: 240,
};

/**
 * How long a job may run before it stops starting new work.
 *
 * Generous here, because there is no request waiting and no platform about to
 * kill the process — the opposite of the serverless budget. A job that has
 * more to do still returns rather than looping forever, so the others get a
 * turn.
 */
const BUDGET_MS = 60_000;

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env).child({ process: 'worker' });
  const db = createPrismaClient(env, logger);

  // Fail fast if the database is unreachable, rather than looping and logging
  // the same error every fifteen seconds.
  await db.$queryRaw`SELECT 1`;

  const names = Object.keys(JOBS) as JobName[];
  logger.info({ jobs: names, pollMs: env.WORKER_POLL_INTERVAL_MS }, 'worker started');

  let running = true;
  let tick = 0;

  const loop = (async () => {
    while (running) {
      for (const name of names) {
        if (!running) break;
        if (tick % EVERY[name] !== 0) continue;

        try {
          const result = await runJob(name, { db, env, logger, budgetMs: BUDGET_MS });
          // More work than the budget allowed: go round again immediately
          // rather than sleeping on a queue that is backing up.
          if (result.more) tick -= 1;
        } catch {
          // Already logged, and recorded as a failed run. A job that throws is
          // the job's problem, not the worker's: it sleeps and tries again
          // rather than exiting, so a transient database blip does not stop
          // mail for the rest of the deployment's life.
        }
      }

      tick += 1;
      await sleep(env.WORKER_POLL_INTERVAL_MS, () => running);
    }
  })();

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
      // Finishing the job in flight rather than abandoning it: a message left
      // in SENDING would wait for its lease to expire before anybody else
      // could claim it.
      running = false;
      await loop;
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

  await loop;
}

/** Sleep, waking early if the caller says to stop. */
async function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (!stillRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}

main().catch((error: unknown) => {
  // No logger yet if configuration failed, which is the likeliest cause.
  console.error('worker failed to start:', error);
  process.exit(1);
});
