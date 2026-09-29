import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from './app.js';
import { buildTestApp } from './test/app.js';
import { closeTestDb } from './test/db.js';
import { CSRF_COOKIE, CSRF_HEADER } from './plugins/csrf.js';

let app: App;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

describe('health endpoints', () => {
  it('reports liveness without touching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness after reaching the database', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('names the build without describing the stack', async () => {
    const response = await app.inject({ method: 'GET', url: '/version' });
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(['build', 'builtAt']);
  });
});

describe('security headers', () => {
  it('denies everything in its own content security policy', async () => {
    const { headers } = await app.inject({ method: 'GET', url: '/health' });
    const csp = headers['content-security-policy'];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
  });

  it('forbids framing, sniffing and referrer leakage', async () => {
    const { headers } = await app.inject({ method: 'GET', url: '/health' });
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['permissions-policy']).toContain('geolocation=()');
  });

  it('marks every response uncacheable, because they carry personal data', async () => {
    const { headers } = await app.inject({ method: 'GET', url: '/health' });
    expect(headers['cache-control']).toContain('no-store');
    expect(headers['cache-control']).toContain('private');
  });

  it('does not advertise the framework', async () => {
    const { headers } = await app.inject({ method: 'GET', url: '/health' });
    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers.server).toBeUndefined();
  });

  it('returns a request id on every response', async () => {
    const { headers } = await app.inject({ method: 'GET', url: '/health' });
    expect(headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('mints its own request id rather than trusting the client', async () => {
    const { headers } = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'attacker-chosen-id' },
    });
    expect(headers['x-request-id']).not.toBe('attacker-chosen-id');
  });
});

describe('CORS', () => {
  it('allows a configured origin with credentials', async () => {
    const { headers, statusCode } = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'access-control-request-method': 'GET',
      },
    });
    expect(statusCode).toBe(204);
    expect(headers['access-control-allow-origin']).toBe('http://127.0.0.1:5173');
    expect(headers['access-control-allow-credentials']).toBe('true');
  });

  it('never reflects an unknown origin', async () => {
    const { headers } = await app.inject({
      method: 'OPTIONS',
      url: '/health',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  it('never answers with a wildcard, because it serves credentials', async () => {
    const { headers } = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://127.0.0.1:5173' },
    });
    expect(headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('CSRF', () => {
  it('lets a safe method through without a token', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
  });

  it('rejects a state-changing request with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/requests',
      headers: { origin: 'http://127.0.0.1:5173' },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('rejects a cross-site request even when it carries a matching token', async () => {
    // The cookie would ride along on a cross-site POST; Sec-Fetch-Site is what
    // a browser sets and script cannot forge.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/requests',
      headers: {
        origin: 'https://evil.example',
        'sec-fetch-site': 'cross-site',
        cookie: `${CSRF_COOKIE}=token-value`,
        [CSRF_HEADER]: 'token-value',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CSRF_CHECK_FAILED');
  });

  it('rejects a mismatched double-submit token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/leave/requests',
      headers: {
        origin: 'http://127.0.0.1:5173',
        'sec-fetch-site': 'same-site',
        cookie: `${CSRF_COOKIE}=cookie-value`,
        [CSRF_HEADER]: 'different-value',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('lets the login route through, since no session exists yet', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-site' },
      payload: { email: 'nobody@widedrop.test', password: 'x' },
    });
    // The route does not exist yet, so a 404 proves CSRF did not block it.
    expect(response.statusCode).not.toBe(403);
  });
});

describe('error envelope', () => {
  it('uses one shape for an unknown route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    expect(response.statusCode).toBe(404);
    const body = response.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('rejects malformed JSON without echoing it back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      payload: '{"email": broken',
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('MALFORMED_REQUEST');
    expect(response.body).not.toContain('broken');
  });

  it('never leaks a stack trace or a file path', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nothing-here' });
    expect(response.body).not.toContain('/home/');
    expect(response.body).not.toContain('node_modules');
    expect(response.body).not.toContain('at Object');
  });
});

describe('request limits', () => {
  it('refuses a body larger than the limit', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
      payload: JSON.stringify({ email: 'a@b.test', password: 'x'.repeat(2 * 1024 * 1024) }),
    });
    expect([400, 413]).toContain(response.statusCode);
  });
});
