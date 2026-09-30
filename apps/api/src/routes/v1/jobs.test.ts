import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { buildTestApp } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, type Fixture } from '../../test/fixtures.js';

/**
 * Running background work over HTTP.
 *
 * This endpoint drains the outbox, writes files to object storage and updates
 * rows nobody is watching. Its caller is a database rather than a person, so
 * the usual session, MFA and RBAC machinery has nothing to say about it and a
 * single token does the whole job — which makes how that token is handled the
 * interesting part.
 */

const db = testDb();
const TOKEN = 'a-job-runner-token-with-enough-entropy-4Kx';

let app: App;
let fixture: Fixture;

beforeAll(async () => {
  await resetTestDb(db);
  fixture = await buildFixture();
  app = await buildTestApp({ JOB_RUNNER_TOKEN: TOKEN });
});

beforeEach(async () => {
  await db.jobRun.deleteMany({});
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

const run = (name: string, authorization?: string) =>
  app.inject({
    method: 'POST',
    url: `/api/v1/jobs/${name}`,
    ...(authorization ? { headers: { authorization } } : {}),
  });

describe('authorisation', () => {
  it('runs the job when the token matches', async () => {
    const response = await run('email-outbox', `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(200);
    expect(response.json().job).toBe('email-outbox');
  });

  it('accepts the token with or without the Bearer prefix', async () => {
    // `pg_net` sends whatever header it was given; being strict about a
    // prefix would be a deployment failure that reads as an auth failure.
    expect((await run('email-outbox', TOKEN)).statusCode).toBe(200);
  });

  it('refuses a request with no token', async () => {
    const response = await run('email-outbox');
    expect(response.statusCode).toBe(401);
  });

  it('refuses a wrong token', async () => {
    expect((await run('email-outbox', `Bearer ${TOKEN}x`)).statusCode).toBe(401);
    expect((await run('email-outbox', 'Bearer nonsense')).statusCode).toBe(401);
    expect((await run('email-outbox', `Bearer ${TOKEN.slice(0, -1)}`)).statusCode).toBe(401);
  });

  it('does not reveal which jobs exist to an unauthorised caller', async () => {
    // Both 401, so a 404 against a 401 cannot be used to enumerate the jobs.
    const real = await run('email-outbox', 'Bearer wrong');
    const invented = await run('not-a-job-at-all', 'Bearer wrong');
    expect(real.statusCode).toBe(401);
    expect(invented.statusCode).toBe(401);
    expect(real.json().error.code).toBe(invented.json().error.code);
  });

  it('answers 404 for an unknown job once the caller is authorised', async () => {
    expect((await run('not-a-job-at-all', `Bearer ${TOKEN}`)).statusCode).toBe(404);
  });

  it('runs nothing when the token is wrong', async () => {
    await run('email-outbox', 'Bearer wrong');
    expect(await db.jobRun.count()).toBe(0);
  });
});

describe('the endpoint is not registered without a token', () => {
  it('does not exist at all', async () => {
    // Stronger than an endpoint that exists and checks: a deployment that does
    // not use a scheduler has no such surface to reach.
    const without = await buildTestApp({ JOB_RUNNER_TOKEN: undefined });
    const response = await without.inject({
      method: 'POST',
      url: '/api/v1/jobs/email-outbox',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
    await without.close();
  });
});

describe('running a job', () => {
  it('records what it did, so somebody can see the outbox is being drained', async () => {
    const response = await run('email-outbox', `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(200);

    const runs = await db.jobRun.findMany({ where: { jobName: 'email-outbox' } });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('SUCCEEDED');
    expect(runs[0]!.startedAt).not.toBeNull();
    expect(runs[0]!.finishedAt).not.toBeNull();
    // The counts, so "it ran" and "it did nothing" are distinguishable.
    expect(runs[0]!.payload).toMatchObject({ sent: 0, claimed: 0 });
  });

  it('actually sends what is queued', async () => {
    const queued = await db.emailOutbox.create({
      data: {
        organizationId: fixture.organizationId,
        kind: 'HELPDESK_TICKET_CREATED',
        status: 'QUEUED',
        toAddresses: ['helpdesk@widedroptech.com'],
        subject: 'A ticket',
        bodyText: 'Somebody needs help.',
        sourceType: 'HelpdeskTicket',
        sourceId: fixture.organizationId,
        idempotencyKey: `test-${Date.now()}`,
      },
      select: { id: true },
    });

    const response = await run('email-outbox', `Bearer ${TOKEN}`);

    expect(response.json().sent).toBe(1);
    // The test app uses the `noop` mail driver, so "sent" means the outbox
    // moved it rather than that anybody received it — which is the state this
    // job is responsible for.
    const after = await db.emailOutbox.findUniqueOrThrow({ where: { id: queued.id } });
    expect(after.status).toBe('SENT');
  });

  it('reports whether more is waiting', async () => {
    const response = await run('maintenance', `Bearer ${TOKEN}`);
    expect(response.json()).toHaveProperty('more');
    expect(typeof response.json().more).toBe('boolean');
  });

  it('runs the maintenance sweeps', async () => {
    const response = await run('maintenance', `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(200);
    // One organisation in the fixture, swept.
    expect(response.json().organizations).toBeGreaterThanOrEqual(1);
  });

  it('renders nothing when there is nothing to render', async () => {
    const response = await run('payslip-documents', `Bearer ${TOKEN}`);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ rendered: 0, failed: 0, more: false });
  });

  it('is safe to run twice at once', async () => {
    // A cron invocation can land while the previous one is still going, and a
    // worker process can be running beside it. Every job claims its work, so
    // overlapping costs a little duplicated looking and nothing else.
    const [first, second] = await Promise.all([
      run('email-outbox', `Bearer ${TOKEN}`),
      run('email-outbox', `Bearer ${TOKEN}`),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await db.jobRun.count({ where: { status: 'FAILED' } })).toBe(0);
  });
});

describe('listing the jobs', () => {
  it('says what can be run and how often it should be', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/jobs',
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    const names = response.json().items.map((item: { name: string }) => item.name);
    expect(names).toEqual(['email-outbox', 'payslip-documents', 'maintenance']);
    for (const item of response.json().items) {
      expect(item.summary).toBeTruthy();
      expect(item.cadence).toBeTruthy();
    }
  });

  it('is behind the same token', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/jobs' });
    expect(response.statusCode).toBe(401);
  });
});
