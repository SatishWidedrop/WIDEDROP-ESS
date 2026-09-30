import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../generated/prisma/index.js';
import { closeTestDb, testDb } from '../test/db.js';
import { PostgresRateLimitStore, sweepExpiredRateLimits } from './rate-limit-store.js';

/**
 * The shared rate-limit store.
 *
 * What this has to get right is the thing an in-process counter gets wrong:
 * two requests arriving at the same moment must be counted twice, and they
 * must be counted twice regardless of which instance they arrived at. So the
 * tests below run requests concurrently on purpose.
 */

const db = testDb();
const store = new PostgresRateLimitStore(db);

/** The callback-shaped `incr` as a promise, which is how it reads. */
const incr = (key: string, windowMs: number, max = 10) =>
  new Promise<{ current: number; ttl: number }>((resolve, reject) => {
    store.incr(key, (error, result) => (error ? reject(error) : resolve(result!)), windowMs, max);
  });

/** A key nobody else in this file is using. */
const key = () => `test:${randomUUID()}`;

beforeAll(async () => {
  await db.$executeRaw`DELETE FROM ess_ops.rate_limit_counter WHERE key LIKE 'test:%'`;
});

afterAll(async () => {
  await db.$executeRaw`DELETE FROM ess_ops.rate_limit_counter WHERE key LIKE 'test:%'`;
  await closeTestDb();
});

describe('counting', () => {
  it('starts at one and climbs', async () => {
    const k = key();
    expect((await incr(k, 60_000)).current).toBe(1);
    expect((await incr(k, 60_000)).current).toBe(2);
    expect((await incr(k, 60_000)).current).toBe(3);
  });

  it('counts concurrent requests once each', async () => {
    const k = key();

    // The reason this store exists. Twenty requests at once, read-then-write,
    // would land on the same count and write back the same increment — and the
    // budget would silently be a multiple of what it says.
    const results = await Promise.all(Array.from({ length: 20 }, () => incr(k, 60_000)));

    expect(results).toHaveLength(20);
    // Every count from 1 to 20 appears exactly once: none lost, none repeated.
    expect(results.map((r) => r.current).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
  });

  it('keeps separate keys separate', async () => {
    const [a, b] = [key(), key()];
    await incr(a, 60_000);
    await incr(a, 60_000);
    expect((await incr(b, 60_000)).current).toBe(1);
    expect((await incr(a, 60_000)).current).toBe(3);
  });

  it('reports the time left in the window, not the window', async () => {
    const k = key();
    const first = await incr(k, 60_000);
    expect(first.ttl).toBeGreaterThan(55_000);
    expect(first.ttl).toBeLessThanOrEqual(60_000);

    await new Promise((resolve) => setTimeout(resolve, 1_100));

    // The window does not restart on each request; it closes when it closes.
    const second = await incr(k, 60_000);
    expect(second.ttl).toBeLessThan(first.ttl);
    expect(second.current).toBe(2);
  });
});

describe('the window closing', () => {
  it('starts a fresh count once the window has passed', async () => {
    const k = key();

    expect((await incr(k, 1_000)).current).toBe(1);
    expect((await incr(k, 1_000)).current).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 1_200));

    // Reset in place rather than deleted and re-inserted: a DELETE would race
    // the next request and lose its increment.
    const after = await incr(k, 1_000);
    expect(after.current).toBe(1);
    expect(after.ttl).toBeGreaterThan(500);
  });

  it('does not reset a window that is merely long', async () => {
    const k = key();
    await incr(k, 60 * 60_000);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await incr(k, 60 * 60_000)).current).toBe(2);
  });
});

describe('the sweep', () => {
  it('removes windows that closed over an hour ago and keeps the rest', async () => {
    const stale = key();
    const recent = key();
    const open = key();

    await incr(stale, 60_000);
    await incr(recent, 60_000);
    await incr(open, 60 * 60_000);

    // Age two of them by hand: one well past the grace period, one inside it.
    await db.$executeRaw`
      UPDATE ess_ops.rate_limit_counter SET expires_at = now() - interval '2 hours'
       WHERE key = ${stale}`;
    await db.$executeRaw`
      UPDATE ess_ops.rate_limit_counter SET expires_at = now() - interval '5 minutes'
       WHERE key = ${recent}`;

    await sweepExpiredRateLimits(db);

    const remaining = await db.$queryRaw<{ key: string }[]>`
      SELECT key FROM ess_ops.rate_limit_counter WHERE key IN (${stale}, ${recent}, ${open})`;
    const keys = remaining.map((r) => r.key);

    expect(keys).not.toContain(stale);
    // Inside the grace period, because a row must never be removed while a
    // request that just reset it is still in flight.
    expect(keys).toContain(recent);
    expect(keys).toContain(open);
  });
});

describe('the contract with @fastify/rate-limit', () => {
  it('reads timeWindow from the third argument, not the fourth', async () => {
    // The package passes `(key, cb, timeWindow, max)`. Its shipped type
    // declaration says `(key, cb)` and most examples online say
    // `(key, cb, max, timeWindow)` — get it backwards and the window becomes a
    // request count, the budget becomes milliseconds, and nothing complains:
    // the limiter just stops limiting. The reference LocalStore is the
    // authority, and this asserts we agree with it.
    const k = key();
    const result = await incr(k, 5_000, 999);
    expect(result.ttl).toBeGreaterThan(4_000);
    expect(result.ttl).toBeLessThanOrEqual(5_000);
  });

  it('hands a database failure to the callback rather than throwing', async () => {
    // `skipOnError: false` means a failure here fails the request rather than
    // letting it past an unenforced limit — but only if the failure arrives
    // the way the plugin expects, as the callback's first argument. Thrown or
    // left as an unhandled rejection, the limiter would hang or crash instead.
    //
    // A disconnected client stands in for the real case, which is the database
    // being unreachable.
    const dead = new PrismaClient({
      datasources: { db: { url: 'postgresql://nobody:nobody@127.0.0.1:1/nothing' } },
    });
    const broken = new PostgresRateLimitStore(dead);

    const error = await new Promise<Error | null>((resolve) => {
      broken.incr('test:unreachable', (err) => resolve(err), 60_000, 10);
    });

    expect(error).toBeInstanceOf(Error);
    await dead.$disconnect();
  });

  it('clamps an absurd window rather than accepting it', async () => {
    const k = key();
    const result = await incr(k, 400 * 24 * 60 * 60_000);
    // A year-long window is a mistake, not a policy.
    expect(result.ttl).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
