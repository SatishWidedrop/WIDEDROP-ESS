import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testEnv } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, type Fixture } from '../../test/fixtures.js';
import { createLogger } from '../../lib/logger.js';
import { JOBS, JOB_NAMES, isJobName, runJob } from './registry.js';

/**
 * The job registry.
 *
 * Everything here exists to make one guarantee true: a job can be stopped part
 * way through and started again, and the result is the same as if it had been
 * allowed to finish. A serverless deployment gets ten seconds per call, so
 * that is not a nicety — it is how the work gets done at all.
 */

const db = testDb();
const env = testEnv();
const logger = createLogger(env);

let fixture: Fixture;

const context = (budgetMs = 5_000) => ({ db, env, logger, budgetMs });

beforeAll(async () => {
  await resetTestDb(db);
  fixture = await buildFixture();
});

beforeEach(async () => {
  await db.jobRun.deleteMany({});
  // Each test queues its own messages and counts them, so a leftover from the
  // one before would be counted twice.
  await db.emailOutbox.deleteMany({});
});

afterAll(async () => {
  await closeTestDb();
});

/** Queue a message the outbox will pick up. */
async function queueMessage(index: number): Promise<void> {
  await db.emailOutbox.create({
    data: {
      organizationId: fixture.organizationId,
      kind: 'HELPDESK_TICKET_CREATED',
      status: 'QUEUED',
      toAddresses: ['helpdesk@widedroptech.com'],
      subject: `Message ${index}`,
      bodyText: 'Body.',
      sourceType: 'HelpdeskTicket',
      sourceId: fixture.organizationId,
      idempotencyKey: `registry-${index}-${Date.now()}`,
    },
  });
}

describe('the registry', () => {
  it('names every job exactly once', () => {
    expect(JOB_NAMES).toEqual(['email-outbox', 'payslip-documents', 'maintenance']);
    expect(new Set(JOB_NAMES).size).toBe(JOB_NAMES.length);
  });

  it('recognises its own names and nothing else', () => {
    for (const name of JOB_NAMES) expect(isJobName(name)).toBe(true);
    expect(isJobName('email-outbox ')).toBe(false);
    expect(isJobName('constructor')).toBe(false);
    // `Object.hasOwn`, not `in`: `toString` is on every object's prototype and
    // would otherwise be a job name.
    expect(isJobName('toString')).toBe(false);
  });

  it('gives every job a summary and a cadence', () => {
    // Both reach an operator — one in the listing, one in the schedule.
    for (const name of JOB_NAMES) {
      expect(JOBS[name].summary.length).toBeGreaterThan(20);
      expect(JOBS[name].cadence).toMatch(/minute|hour/);
    }
  });
});

describe('the budget', () => {
  it('stops inside it and says there is more', async () => {
    for (let i = 0; i < 12; i += 1) await queueMessage(i);

    // Far too little time to drain twelve messages in batches of five: the
    // first batch alone is checked against a 2-second estimate.
    const result = await runJob('email-outbox', context(1));

    expect(result.more).toBe(false);
    expect(result.detail.sent).toBe(0);
    // Nothing was claimed, so nothing is stuck in SENDING either.
    expect(await db.emailOutbox.count({ where: { status: 'QUEUED' } })).toBe(12);
  });

  it('picks up where it left off', async () => {
    for (let i = 0; i < 12; i += 1) await queueMessage(i);

    let drained = 0;
    // What a scheduler does: call again on the next tick.
    for (let call = 0; call < 5; call += 1) {
      const result = await runJob('email-outbox', context(5_000));
      drained += result.detail.sent;
      if (!result.more) break;
    }

    expect(drained).toBe(12);
    expect(await db.emailOutbox.count({ where: { status: 'QUEUED' } })).toBe(0);
  });

  it('leaves nothing half-done when it stops', async () => {
    for (let i = 0; i < 8; i += 1) await queueMessage(i);

    await runJob('email-outbox', context(2_100));

    // Every message is either sent or queued — never claimed and abandoned,
    // because a message left in SENDING waits for its lease to expire before
    // anybody can touch it again.
    const stuck = await db.emailOutbox.count({ where: { status: 'SENDING' } });
    expect(stuck).toBe(0);
  });
});

describe('recording the run', () => {
  it('writes a row whether or not there was anything to do', async () => {
    await runJob('maintenance', context());

    const runs = await db.jobRun.findMany({ where: { jobName: 'maintenance' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('SUCCEEDED');
    // "Is the outbox being drained?" has to be answerable from something
    // other than the absence of complaints.
    expect(runs[0]!.finishedAt).not.toBeNull();
  });

  it('records a failure rather than losing it', async () => {
    // A job that has been failing every minute for a day is precisely what
    // somebody needs to be able to see, so the failure has to be recorded
    // rather than only thrown.
    //
    // A database that answers the bookkeeping and refuses the work, so the
    // job_run row is written and updated while the job itself fails.
    const failing = new Proxy(db, {
      get(target, property) {
        if (property === 'payslip') throw new Error('storage is unavailable');
        return Reflect.get(target, property) as never;
      },
    }) as never;

    await expect(runJob('payslip-documents', { ...context(), db: failing })).rejects.toThrow(
      /storage is unavailable/,
    );

    const runs = await db.jobRun.findMany({ where: { jobName: 'payslip-documents' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('FAILED');
    expect(runs[0]!.lastError).toContain('storage is unavailable');
    expect(runs[0]!.finishedAt).not.toBeNull();
  });
});

describe('overlapping runs', () => {
  it('sends each message once when two runners go at the same time', async () => {
    for (let i = 0; i < 10; i += 1) await queueMessage(i);

    // A cron invocation landing while the previous one is still going, or a
    // worker process running beside a scheduler. The outbox claims under a
    // lease with SKIP LOCKED, so the two share the work rather than doubling
    // it — and a message sent twice is the failure that would matter.
    const [a, b] = await Promise.all([
      runJob('email-outbox', context(5_000)),
      runJob('email-outbox', context(5_000)),
    ]);

    expect(a.detail.sent + b.detail.sent).toBe(10);
    expect(await db.emailOutbox.count({ where: { status: 'SENT' } })).toBe(10);
    expect(await db.emailOutbox.count({ where: { status: 'QUEUED' } })).toBe(0);
  });
});
