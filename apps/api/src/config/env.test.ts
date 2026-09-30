import { describe, expect, it } from 'vitest';
import { loadEnv } from './env.js';

/**
 * The environment validator, on the cases that only bite in production.
 *
 * Every rule here exists because getting it wrong produces a failure that
 * looks like something else: a pooled connection without `pgbouncer=true`
 * starts fine and then fails intermittently under load; a missing direct
 * connection fails at the migration step of a deploy, after the old instances
 * are already going away.
 */

/** A production environment that passes, which each test then breaks one way. */
const production = (overrides: Record<string, string | undefined> = {}) => ({
  NODE_ENV: 'production',
  API_PUBLIC_URL: 'https://api-ess.widedrop.com',
  WEB_PUBLIC_URL: 'https://ess.widedrop.com',
  CORS_ORIGINS: 'https://ess.widedrop.com',
  DATABASE_URL: 'postgresql://u:p@db.example.com:5432/ess?sslmode=require',
  JWT_PRIVATE_KEY: 'x',
  JWT_PUBLIC_KEY: 'y',
  JWT_KEY_ID: 'k1',
  PASSWORD_PEPPER: 'qW3eR7tY1uI9oP2aS5dF8gH4jK6lZ0xC',
  ENCRYPTION_KEK: Buffer.alloc(32, 7).toString('base64'),
  AUDIT_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
  REDIS_URL: 'redis://cache.example.com:6379',
  STORAGE_DRIVER: 's3',
  S3_REGION: 'ap-south-1',
  S3_BUCKET: 'ess-documents',
  S3_ACCESS_KEY_ID: 'id',
  S3_SECRET_ACCESS_KEY: 'secret',
  MAIL_DRIVER: 'smtp',
  SMTP_HOST: 'smtp.resend.com',
  SMTP_PORT: '587',
  COOKIE_SECURE: 'true',
  ...overrides,
});

/** The message for a given variable, or undefined when it did not complain. */
function complaint(env: Record<string, string | undefined>, key: string): string | undefined {
  try {
    loadEnv(env as NodeJS.ProcessEnv);
    return undefined;
  } catch (error) {
    const message = (error as Error).message;
    const line = message.split('\n').find((l) => l.trim().startsWith(`- ${key}:`));
    return line?.trim();
  }
}

describe('the pooled connection', () => {
  const POOLED =
    'postgresql://postgres.abcdef:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require';

  it('insists on pgbouncer=true, because the pooler cannot hold a prepared statement', () => {
    const message = complaint(
      production({ DATABASE_URL: POOLED, DIRECT_DATABASE_URL: production().DATABASE_URL }),
      'DATABASE_URL',
    );
    expect(message).toContain('pgbouncer=true');
  });

  it('insists on a direct connection for migrations', () => {
    const message = complaint(
      production({ DATABASE_URL: `${POOLED}&pgbouncer=true` }),
      'DIRECT_DATABASE_URL',
    );
    // DDL and `prisma migrate`'s advisory lock do not survive a pooler that is
    // free to hand the connection to somebody else between statements.
    expect(message).toContain('direct connection');
  });

  it('accepts the pair', () => {
    expect(() =>
      loadEnv(
        production({
          DATABASE_URL: `${POOLED}&pgbouncer=true`,
          DIRECT_DATABASE_URL:
            'postgresql://postgres:pw@db.abcdef.supabase.co:5432/postgres?sslmode=require',
        }) as NodeJS.ProcessEnv,
      ),
    ).not.toThrow();
  });

  it('refuses a direct URL that is really the pooler', () => {
    const message = complaint(
      production({
        DATABASE_URL: `${POOLED}&pgbouncer=true`,
        DIRECT_DATABASE_URL: `${POOLED}&pgbouncer=true`,
      }),
      'DIRECT_DATABASE_URL',
    );
    expect(message).toContain('not the pooler');
  });

  it('leaves a plain direct connection alone', () => {
    // No pooler in front, nothing to configure around.
    expect(() => loadEnv(production() as NodeJS.ProcessEnv)).not.toThrow();
  });
});

describe('production hardening', () => {
  it('refuses the filesystem storage driver', () => {
    expect(complaint(production({ STORAGE_DRIVER: 'filesystem' }), 'STORAGE_DRIVER')).toContain(
      's3',
    );
  });

  it('refuses a mail driver that does not send mail', () => {
    // A help-desk ticket that is persisted and never delivered is the failure
    // this one exists to prevent.
    expect(complaint(production({ MAIL_DRIVER: 'file' }), 'MAIL_DRIVER')).toContain('smtp');
  });

  it('refuses an in-process rate limiter', () => {
    // Two instances with their own counters means a lockout that holds on
    // whichever one the next attempt happens to reach.
    expect(complaint(production({ REDIS_URL: undefined }), 'REDIS_URL')).toContain('required');
  });

  it('refuses a wildcard or plaintext CORS origin', () => {
    expect(complaint(production({ CORS_ORIGINS: '*' }), 'CORS_ORIGINS')).toContain('explicit');
    expect(complaint(production({ CORS_ORIGINS: 'http://ess.widedrop.com' }), 'CORS_ORIGINS')).toBe(
      complaint(production({ CORS_ORIGINS: '*' }), 'CORS_ORIGINS'),
    );
  });

  it('refuses a database connection with no TLS', () => {
    expect(
      complaint(
        production({ DATABASE_URL: 'postgresql://u:p@db.example.com:5432/ess' }),
        'DATABASE_URL',
      ),
    ).toContain('sslmode');
  });

  it('refuses a cookie that is not Secure', () => {
    expect(complaint(production({ COOKIE_SECURE: 'false' }), 'COOKIE_SECURE')).toContain('true');
  });

  it('refuses a placeholder pepper', () => {
    expect(
      complaint(
        production({ PASSWORD_PEPPER: 'changeme-changeme-changeme-abc' }),
        'PASSWORD_PEPPER',
      ),
    ).toBeDefined();
  });

  it('relaxes none of it outside production', () => {
    // Development is allowed the filesystem driver and no Redis; it is not
    // allowed a weak pepper, because the same value ends up copied forward.
    expect(() =>
      loadEnv({
        NODE_ENV: 'development',
        API_PUBLIC_URL: 'http://127.0.0.1:4000',
        WEB_PUBLIC_URL: 'http://127.0.0.1:5173',
        CORS_ORIGINS: 'http://127.0.0.1:5173',
        DATABASE_URL: 'postgresql://u:p@127.0.0.1:5433/ess',
        JWT_PRIVATE_KEY: 'x',
        JWT_PUBLIC_KEY: 'y',
        JWT_KEY_ID: 'k1',
        PASSWORD_PEPPER: 'short',
        ENCRYPTION_KEK: Buffer.alloc(32, 7).toString('base64'),
        AUDIT_HMAC_KEY: Buffer.alloc(32, 9).toString('base64'),
      } as NodeJS.ProcessEnv),
    ).toThrow(/PASSWORD_PEPPER/);
  });
});
