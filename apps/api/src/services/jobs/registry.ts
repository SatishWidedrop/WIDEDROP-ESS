import { randomUUID } from 'node:crypto';
import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import type { Logger } from '../../lib/logger.js';
import { runAsSystem } from '../../lib/request-context.js';
import { drainOutbox, reclaimStalled } from '../email/worker.js';
import { renderPendingPayslips } from '../payroll/render.js';
import { markOverdueAcknowledgements } from '../policies/service.js';
import { sweepExpiredRateLimits } from '../../plugins/rate-limit-store.js';

/**
 * The background work, and the one place it is defined.
 *
 * Two deployments drive the same jobs from different directions. A container
 * runs `worker.ts`, which loops on a timer. A serverless deployment has no
 * process to loop in, so a scheduler calls an HTTP endpoint instead — on
 * Supabase that is `pg_cron` posting through `pg_net`.
 *
 * Both call the functions below. That matters more than it looks: a second
 * implementation of "drain the outbox" is a second set of assumptions about
 * leases, retries and idempotency, and the first time they disagree is the
 * first time a message is sent twice.
 *
 * ── Every job is bounded ─────────────────────────────────────────────
 * A serverless function has ten seconds. So a job is given a budget, does as
 * much as it can inside it, and says whether more is waiting. Nothing here
 * assumes it will be allowed to finish, and nothing here needs to be: every
 * job is idempotent and resumable, because the outbox claims under a lease,
 * rendering claims a payslip conditionally, and the sweeps are set-based
 * updates that converge.
 *
 * That also makes two runners overlapping safe, which they will: a cron
 * invocation can land while the previous one is still going.
 */

export interface JobContext {
  db: Database;
  env: Env;
  logger: Logger;
  /** Stop starting new work once this much time has passed. */
  budgetMs: number;
}

export interface JobResult {
  /** Counts worth putting in a log line and handing back to the caller. */
  detail: Record<string, number>;
  /** True when the budget ran out with work still waiting. */
  more: boolean;
}

interface Job {
  /** What it does, in a line — this reaches the operator running it by hand. */
  summary: string;
  /** How often a scheduler should call it. Documentation, not enforcement. */
  cadence: string;
  run(context: JobContext, deadline: Deadline): Promise<JobResult>;
}

/** Whether there is still time to start another unit of work. */
class Deadline {
  private readonly endsAt: number;

  constructor(budgetMs: number) {
    this.endsAt = Date.now() + budgetMs;
  }

  /**
   * Time enough for another unit of work of roughly this size.
   *
   * Asked *before* starting one rather than after, so a job stops while it
   * still has time to return an answer instead of being killed mid-write.
   */
  hasTimeFor(estimatedMs: number): boolean {
    return Date.now() + estimatedMs < this.endsAt;
  }
}

export const JOBS = {
  /**
   * Send what is queued.
   *
   * A help-desk ticket and its mail are written in one transaction, so a
   * ticket can never exist without its message being owed — but only this
   * turns the message into a sent one, and an undrained outbox is silent.
   */
  'email-outbox': {
    summary: 'Send queued email, and requeue anything a stopped sender was holding',
    cadence: 'every minute',
    async run({ db, env, logger }, deadline): Promise<JobResult> {
      // Messages a sender claimed and then died holding. Their lease has
      // expired, so they are free to claim again; the attempt they consumed is
      // not refunded, because a message that kills its sender twice should not
      // get infinite tries.
      const reclaimed = await reclaimStalled(db, logger);

      const total = { reclaimed, claimed: 0, sent: 0, retrying: 0, failed: 0, suppressed: 0 };
      let more = false;

      // Small batches so the budget is checked often. A batch of twenty-five
      // against a slow mail host is most of a serverless function's lifetime.
      const BATCH = 5;
      const PER_BATCH_MS = 2_000;

      while (deadline.hasTimeFor(PER_BATCH_MS)) {
        const result = await drainOutbox(db, env, logger, { batchSize: BATCH });
        total.claimed += result.claimed;
        total.sent += result.sent;
        total.retrying += result.retrying;
        total.failed += result.failed;
        total.suppressed += result.suppressed;

        // Fewer than asked for means the queue is empty, for now.
        if (result.claimed < BATCH) break;
        more = true;
      }

      return { detail: total, more };
    },
  },

  /**
   * Render payslip documents that are missing one.
   *
   * Calculating a cycle renders them, so this normally finds nothing. It
   * exists for the run where object storage was unavailable for a minute: the
   * publish guard refuses a cycle whose payslips have no document, and without
   * this somebody has to notice and retry by hand.
   */
  'payslip-documents': {
    summary: 'Render payslip documents that are missing one, so a cycle can be published',
    cadence: 'every minute',
    async run({ db, env }, deadline): Promise<JobResult> {
      const pending = await db.payslip.groupBy({
        by: ['organizationId', 'payrollCycleId'],
        where: { pdfFileObjectId: null, status: { in: ['GENERATED', 'PUBLISHED'] } },
        _count: { _all: true },
      });

      const total = { cycles: 0, rendered: 0, failed: 0 };
      let more = false;

      // A slice at a time. Each payslip is a network round trip to object
      // storage — about 130 ms — and they run eight at a time, so sixteen is
      // roughly two seconds.
      const SLICE = 16;
      const PER_SLICE_MS = 3_000;

      for (const group of pending) {
        if (!deadline.hasTimeFor(PER_SLICE_MS)) {
          more = true;
          break;
        }

        const summary = await runAsSystem(
          {
            requestId: randomUUID(),
            organizationId: group.organizationId,
            job: 'payslip-documents',
          },
          () =>
            renderPendingPayslips(db, env, {
              organizationId: group.organizationId,
              cycleId: group.payrollCycleId,
              limit: SLICE,
            }),
        );

        total.cycles += 1;
        total.rendered += summary.rendered;
        total.failed += summary.failed.length;
        if (summary.more) more = true;

        // A cycle whose renders keep failing must not be retried in a tight
        // loop for the rest of the budget; the next run will reach it.
        if (summary.failed.length > 0) break;
      }

      return { detail: total, more };
    },
  },

  /**
   * Housekeeping, measured in days rather than seconds.
   *
   * An acknowledgement is overdue as a stored status rather than a comparison
   * made at render time, so what an employee sees and what a compliance report
   * counts cannot disagree. Something has to write that status.
   */
  maintenance: {
    summary: 'Mark overdue policy acknowledgements and drop closed rate-limit windows',
    cadence: 'hourly',
    async run({ db, logger }, deadline): Promise<JobResult> {
      const total = { organizations: 0, overdue: 0, rateLimitWindows: 0 };
      let more = false;

      total.rateLimitWindows = await sweepExpiredRateLimits(db);

      const organizations = await db.organization.findMany({
        where: { isActive: true },
        select: { id: true },
      });

      const PER_ORG_MS = 1_000;

      for (const organization of organizations) {
        if (!deadline.hasTimeFor(PER_ORG_MS)) {
          more = true;
          break;
        }

        const overdue = await runAsSystem(
          { requestId: randomUUID(), organizationId: organization.id, job: 'maintenance' },
          () => db.$transaction((tx) => markOverdueAcknowledgements(tx, organization.id)),
        );

        total.organizations += 1;
        total.overdue += overdue;
      }

      if (total.overdue > 0) {
        logger.info({ count: total.overdue }, 'policy acknowledgements marked overdue');
      }

      return { detail: total, more };
    },
  },
} as const satisfies Record<string, Job>;

export type JobName = keyof typeof JOBS;

export const JOB_NAMES = Object.keys(JOBS) as JobName[];

export function isJobName(value: string): value is JobName {
  return Object.hasOwn(JOBS, value);
}

/**
 * Run one job, and record that it ran.
 *
 * The `job_run` row is the operational answer to "is the outbox actually being
 * drained?" — a question that otherwise has to be inferred from the absence of
 * complaints. It is written whether the job succeeded or threw, because a job
 * that has been failing every minute for a day is exactly what you want to be
 * able to see.
 */
export async function runJob(name: JobName, context: JobContext): Promise<JobResult> {
  const job = JOBS[name];
  const logger = context.logger.child({ job: name });
  const startedAt = new Date();

  const run = await context.db.jobRun.create({
    data: { jobName: name, status: 'RUNNING', startedAt, scheduledFor: startedAt },
    select: { id: true },
  });

  try {
    const result = await job.run({ ...context, logger }, new Deadline(context.budgetMs));

    await context.db.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCEEDED',
        finishedAt: new Date(),
        payload: { ...result.detail, more: result.more },
      },
    });

    // Quiet when there was nothing to do. A job that logs every minute saying
    // it found nothing is a job whose logs nobody reads.
    if (Object.values(result.detail).some((value) => value > 0)) {
      logger.info({ ...result.detail, more: result.more }, 'job ran');
    }

    return result;
  } catch (error) {
    await context.db.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        lastError: error instanceof Error ? error.message.slice(0, 2_000) : 'unknown',
      },
    });

    logger.error({ err: error }, 'job failed');
    throw error;
  }
}
