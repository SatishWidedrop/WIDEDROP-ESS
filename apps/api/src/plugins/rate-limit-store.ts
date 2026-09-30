import type { FastifyRateLimitStore } from '@fastify/rate-limit';
import type { Database } from '../lib/prisma.js';

/**
 * A rate-limit store backed by Postgres.
 *
 * `@fastify/rate-limit` ships two: an in-process LRU and a Redis client. The
 * first gives every instance its own budget, which for a sign-in limit means a
 * lockout that holds only on whichever instance the next attempt happens to
 * reach — not a lockout. The second is correct and remains supported here
 * through `REDIS_URL`, and is still what you want at real volume.
 *
 * This third one exists because the deployment target (serverless functions in
 * front of Supabase) has no Redis, and the alternative was to let a
 * load-bearing control quietly degrade to per-instance for want of one. The
 * database is already shared, already transactional, and already on the path
 * of every request.
 *
 * ── The cost ─────────────────────────────────────────────────────────
 * One upsert per limited request, so roughly one extra round trip. That is a
 * real cost and the reason this is not the default: at a few hundred users it
 * disappears into the request, and at a few hundred *per second* it would not.
 * When that day comes, set `REDIS_URL` and nothing else changes.
 */

/**
 * The constructor `@fastify/rate-limit` expects, bound to a database.
 *
 * The plugin builds its store itself — `new Store(options)` — and gives it no
 * way to pass anything else in, so the connection has to be closed over rather
 * than handed over.
 */
export function postgresRateLimitStore(db: Database): new () => FastifyRateLimitStore {
  return class extends PostgresRateLimitStore {
    constructor() {
      super(db);
    }
  };
}

/** Long enough that a sensible window fits, short enough to catch a mistake. */
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

interface CounterRow {
  count: number;
  ttl_ms: number;
}

export class PostgresRateLimitStore implements FastifyRateLimitStore {
  constructor(private readonly db: Database) {}

  /**
   * Count this request, and say how many have been counted in this window.
   *
   * The signature is `@fastify/rate-limit`'s own, and the argument order is
   * worth pausing on: **timeWindow comes before max**, which is the reverse of
   * what the shipped type declaration suggests. Getting it the wrong way round
   * produces windows measured in requests and budgets measured in
   * milliseconds, and nothing complains — the limiter simply stops limiting.
   * The reference LocalStore in the package is the authority.
   */
  incr(
    key: string,
    callback: (error: Error | null, result?: { current: number; ttl: number }) => void,
    timeWindowMs?: number,
    _max?: number,
  ): void {
    const windowMs = Math.min(Math.max(Math.trunc(timeWindowMs ?? 60_000), 1_000), MAX_WINDOW_MS);

    // One statement, not read-then-write.
    //
    // Two requests arriving together would otherwise both read the same count
    // and both write back the same increment, and the budget would be twice
    // what it says. `ON CONFLICT DO UPDATE` takes a row lock, so the second
    // waits for the first and sees its result — which is the whole reason to
    // put this in the database rather than in a variable.
    //
    // Expiry is handled in the same statement: a window whose `expires_at` has
    // passed is not deleted and re-inserted, it is reset in place. A separate
    // DELETE would race the next request and lose an increment.
    this.db.$queryRaw<CounterRow[]>`
        INSERT INTO ess_ops.rate_limit_counter AS c (key, count, expires_at)
        VALUES (${key}, 1, now() + make_interval(secs => ${windowMs / 1000}::double precision))
        ON CONFLICT (key) DO UPDATE SET
          count = CASE WHEN c.expires_at <= now() THEN 1 ELSE c.count + 1 END,
          expires_at = CASE
            WHEN c.expires_at <= now()
              THEN now() + make_interval(secs => ${windowMs / 1000}::double precision)
            ELSE c.expires_at
          END
        RETURNING
          c.count AS count,
          GREATEST(0, EXTRACT(EPOCH FROM (c.expires_at - now())) * 1000)::int AS ttl_ms
      `
      .then((rows) => {
        const row = rows[0];
        if (!row) {
          // RETURNING on an upsert always produces a row. If it ever does not,
          // that is a broken assumption rather than a rate-limit decision, and
          // `skipOnError: false` means the request fails rather than sailing
          // past an unenforced limit.
          callback(new Error('rate limit counter returned no row'));
          return;
        }
        callback(null, { current: row.count, ttl: row.ttl_ms });
      })
      .catch((error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      });
  }

  /**
   * The per-route store.
   *
   * Routes here select their budget through `config.rateLimitName` and the
   * `max`/`timeWindow` functions, not through `config.rateLimit`, so the
   * plugin never calls this. Returning `this` is correct either way: the key
   * is already route-scoped by `rateLimitKey`, so one table serves every
   * route without them colliding.
   */
  child(): FastifyRateLimitStore {
    return this;
  }
}

/**
 * Drop windows that have closed.
 *
 * Nothing depends on this for correctness — an expired row is reset in place
 * by the next request that touches its key, and one nobody touches again is
 * simply inert. It is here so a table that gains a row per distinct key does
 * not grow without bound; a key that appears once and never again would
 * otherwise sit there forever.
 */
export async function sweepExpiredRateLimits(db: Database): Promise<number> {
  // A grace period, so a row is never removed while a request that just reset
  // it is still in flight.
  const result = await db.$executeRaw`
    DELETE FROM ess_ops.rate_limit_counter
     WHERE expires_at < now() - interval '1 hour'
  `;
  return result;
}
