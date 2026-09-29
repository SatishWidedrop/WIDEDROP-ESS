import { buildApp, type App } from '../app.js';
import { loadEnv, type Env } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { registerRoutes } from '../routes/index.js';
import { testDb, testDatabaseUrl } from './db.js';

/**
 * A fully wired app for integration tests.
 *
 * Built from the same factory as production, with the same plugins in the same
 * order — a test that skipped the security plugins would prove nothing about
 * the system that actually ships.
 */

/**
 * Test configuration. Secrets are fixed and obviously fake; they never leave
 * this file and the value validator still requires them to have real entropy,
 * so the boot path is exercised rather than bypassed.
 */
export function testEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): Env {
  return loadEnv({
    NODE_ENV: 'test',
    PORT: '4000',
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    API_PUBLIC_URL: 'http://127.0.0.1:4000',
    WEB_PUBLIC_URL: 'http://127.0.0.1:5173',
    CORS_ORIGINS: 'http://127.0.0.1:5173,http://localhost:5173',
    DATABASE_URL: testDatabaseUrl(),
    JWT_PRIVATE_KEY: 'test-private-key-placeholder',
    JWT_PUBLIC_KEY: 'test-public-key-placeholder',
    JWT_KEY_ID: 'test-key-1',
    PASSWORD_PEPPER: 'kQ7vR2mZ9xL4pB8nT6yH3wC5jF1sD0aG',
    ENCRYPTION_KEK: Buffer.alloc(32, 21).toString('base64'),
    ENCRYPTION_KEY_VERSION: 'v1',
    AUDIT_HMAC_KEY: Buffer.alloc(32, 22).toString('base64'),
    COOKIE_SECURE: 'false',
    COOKIE_SAMESITE: 'lax',
    STORAGE_DRIVER: 'filesystem',
    MAIL_DRIVER: 'noop',
    HIBP_ENABLED: 'false',
    TRUST_PROXY: 'false',
    ...overrides,
  });
}

export async function buildTestApp(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<App> {
  const env = testEnv(overrides);
  const app = await buildApp({ env, db: testDb(), logger: createLogger(env) });
  await registerRoutes(app);
  await app.ready();
  return app;
}
