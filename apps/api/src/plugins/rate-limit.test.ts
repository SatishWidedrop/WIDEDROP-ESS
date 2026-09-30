import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../app.js';
import { buildTestApp } from '../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../test/db.js';
import { CSRF_COOKIE, CSRF_HEADER } from './csrf.js';

/**
 * Rate limiting, over HTTP.
 *
 * The property that matters is the one an in-process counter does not have:
 * the budget is the same budget whichever instance a request reaches. So two
 * apps are built here, sharing nothing but the database, and the limit is
 * spent across both.
 */

const db = testDb();
const ORIGIN = 'http://127.0.0.1:5173';

let one: App;
let two: App;

beforeAll(async () => {
  await resetTestDb(db);
  // Two instances, as a deployment would have. They share a database and
  // nothing else — no memory, no cache, no coordination.
  one = await buildTestApp();
  two = await buildTestApp();
});

beforeEach(async () => {
  await db.$executeRaw`DELETE FROM ess_ops.rate_limit_counter`;
});

afterAll(async () => {
  await one.close();
  await two.close();
  await closeTestDb();
});

/** A sign-in attempt that will fail, which is the case the limit exists for. */
const attempt = (app: App, email: string) =>
  app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
    payload: { email, password: 'not the password' },
  });

describe('the sign-in limit', () => {
  it('spends one budget across two instances', async () => {
    const email = 'target@widedrop.test';

    // auth:login allows ten attempts in fifteen minutes. Alternate between
    // instances: with a per-process counter each would allow ten, and twenty
    // guesses would go through without a single 429.
    const codes: number[] = [];
    for (let i = 0; i < 12; i += 1) {
      const response = await attempt(i % 2 === 0 ? one : two, email);
      codes.push(response.statusCode);
    }

    const limited = codes.filter((c) => c === 429).length;
    expect(limited).toBeGreaterThan(0);
    // The eleventh attempt overall is the first to be refused, whichever
    // instance it lands on.
    expect(codes.slice(0, 10).every((c) => c !== 429)).toBe(true);
    expect(codes.slice(10).every((c) => c === 429)).toBe(true);
  });

  it('keys the limit on the email being attempted, not the caller', async () => {
    // Otherwise one person's failed sign-ins would spend everybody's budget,
    // and an attacker could lock a whole office out by guessing at one address.
    for (let i = 0; i < 11; i += 1) await attempt(one, 'first@widedrop.test');

    expect((await attempt(one, 'first@widedrop.test')).statusCode).toBe(429);
    expect((await attempt(one, 'second@widedrop.test')).statusCode).not.toBe(429);
  });

  it('tells a refused caller how long to wait', async () => {
    for (let i = 0; i < 11; i += 1) await attempt(one, 'waiting@widedrop.test');
    const refused = await attempt(one, 'waiting@widedrop.test');

    expect(refused.statusCode).toBe(429);
    expect(refused.json().error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(refused.json().error.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('never writes the email into the store', async () => {
    await attempt(one, 'private.person@widedrop.test');

    const keys = await db.$queryRaw<{ key: string }[]>`
      SELECT key FROM ess_ops.rate_limit_counter`;

    expect(keys.length).toBeGreaterThan(0);
    // The key is a hash under a server-side secret, so a leaked table is not a
    // list of who has been trying to sign in.
    for (const { key } of keys) {
      expect(key).not.toContain('private.person');
      expect(key).not.toContain('widedrop.test');
    }
  });
});

describe('the store', () => {
  it('opens a window per key rather than one for everything', async () => {
    await attempt(one, 'a@widedrop.test');
    await attempt(one, 'b@widedrop.test');

    const rows = await db.$queryRaw<{ key: string; count: number }[]>`
      SELECT key, count FROM ess_ops.rate_limit_counter ORDER BY key`;

    // Two addresses, two windows, one attempt counted against each.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.count === 1)).toBe(true);
  });

  it('is what both instances are using', async () => {
    // If either had quietly fallen back to its in-process store, the counts
    // below would not add up across them.
    await attempt(one, 'shared@widedrop.test');
    await attempt(two, 'shared@widedrop.test');

    const rows = await db.$queryRaw<{ count: number }[]>`
      SELECT count FROM ess_ops.rate_limit_counter`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(2);
  });
});

describe('an ordinary request', () => {
  it('is limited too, but generously', async () => {
    // The default budget is 300 a minute; a handful of requests must not come
    // anywhere near it.
    for (let i = 0; i < 5; i += 1) {
      const response = await one.inject({ method: 'GET', url: '/health' });
      expect(response.statusCode).toBe(200);
    }
  });

  it('reports the budget it has left', async () => {
    const response = await one.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        origin: ORIGIN,
        'sec-fetch-site': 'same-site',
        cookie: `${CSRF_COOKIE}=x`,
        [CSRF_HEADER]: 'x',
      },
      payload: { email: 'budget@widedrop.test', password: 'wrong' },
    });

    expect(Number(response.headers['x-ratelimit-limit'])).toBe(10);
    expect(Number(response.headers['x-ratelimit-remaining'])).toBe(9);
  });
});
