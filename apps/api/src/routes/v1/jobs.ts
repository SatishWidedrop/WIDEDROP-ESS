import { timingSafeEqual } from 'node:crypto';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, notFound } from '../../lib/errors.js';
import { JOBS, isJobName, runJob, type JobName } from '../../services/jobs/registry.js';

/**
 * Running background work on demand.
 *
 * A container runs `worker.ts` and never needs this. A serverless deployment
 * has no process to loop in, so a scheduler calls here instead — on Supabase
 * that is `pg_cron` posting through `pg_net`, once a minute. The SQL is in
 * `infra/supabase/cron.sql`.
 *
 * ── It is not registered unless it is configured ─────────────────────
 * Without `JOB_RUNNER_TOKEN` the route does not exist. That is deliberate:
 * an endpoint that drains the outbox and writes files is not something to
 * leave reachable by default on a deployment that does not use it, and
 * "unregistered" is a stronger guarantee than "registered but it checks".
 *
 * ── Why a token and not a session ────────────────────────────────────
 * The caller is a database, not a person. It holds no cookie, completes no
 * MFA, and has no employee record to authorise against — the RBAC matrix has
 * nothing to say about it. A single secret compared in constant time is the
 * honest mechanism, and it is scoped to exactly this: the token grants the
 * three jobs below and nothing else in the system.
 */

/**
 * How long a run may take before it stops starting new work.
 *
 * Under the ten seconds a serverless function is given, with enough left to
 * finish what is in flight and answer. A job that runs out simply returns
 * `more: true` and the next call continues — everything here is resumable.
 */
const BUDGET_MS = 7_000;

export async function jobRoutes(app: App): Promise<void> {
  const token = app.env.JOB_RUNNER_TOKEN;
  if (!token) {
    app.log.info(
      'JOB_RUNNER_TOKEN is not set: the job endpoint is not registered. Background work ' +
        'runs in the worker process instead.',
    );
    return;
  }

  const expected = Buffer.from(token, 'utf8');

  /**
   * Whether the caller holds the token.
   *
   * Constant time, because a comparison that returns early on the first wrong
   * byte tells an attacker how much of the token they have guessed. The length
   * is checked first because `timingSafeEqual` throws on a mismatch, and the
   * length of a secret is not itself a secret worth protecting.
   */
  const authorised = (header: string | undefined): boolean => {
    if (typeof header !== 'string') return false;
    const offered = header.startsWith('Bearer ') ? header.slice(7) : header;
    const candidate = Buffer.from(offered, 'utf8');
    if (candidate.length !== expected.length) return false;
    return timingSafeEqual(candidate, expected);
  };

  app.post<{ Params: { name: string } }>(
    '/api/v1/jobs/:name',
    {
      config: {
        // No session: the caller is a scheduler. The token below is the
        // authentication, and the route is not registered without one.
        public: true,
        // Its own budget, sized for a scheduler calling three jobs a minute.
        // `payroll:mutate` would have been the obvious choice and is 30 an
        // hour, which would refuse two runs in every three — and look like
        // mail that arrives eventually rather than like anything failing.
        rateLimitName: 'job:run',
      },
    },
    async (request, reply) => {
      // Authorisation first, and only then the name. Checking the name first
      // would let an unauthenticated caller discover which jobs exist by
      // comparing a 404 against a 401.
      if (!authorised(request.headers.authorization)) {
        throw new AppError(401, ERROR_CODES.AUTHENTICATION_REQUIRED, 'Not authorised.');
      }

      const { name } = request.params;
      if (!isJobName(name)) throw notFound('That job');

      const result = await runJob(name as JobName, {
        db: app.db,
        env: app.env,
        logger: request.log,
        budgetMs: BUDGET_MS,
      });

      return reply.status(200).send({
        job: name,
        ...result.detail,
        // The scheduler does not act on this — it calls again on its own
        // cadence regardless — but it is the honest answer to "did that
        // finish?", and it is what an operator running the job by hand needs.
        more: result.more,
      });
    },
  );

  /**
   * What can be run, and how often it is meant to be.
   *
   * For whoever is setting up or auditing the schedule. Behind the same token:
   * the list of jobs is not a secret, but an unauthenticated endpoint that
   * enumerates a system's background work is a courtesy to somebody probing
   * it, for no benefit to anybody else.
   */
  app.get('/api/v1/jobs', { config: { public: true } }, async (request) => {
    if (!authorised(request.headers.authorization)) {
      throw new AppError(401, ERROR_CODES.AUTHENTICATION_REQUIRED, 'Not authorised.');
    }

    return {
      items: Object.entries(JOBS).map(([name, job]) => ({
        name,
        summary: job.summary,
        cadence: job.cadence,
      })),
    };
  });
}
