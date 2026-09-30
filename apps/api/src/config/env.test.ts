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
    // free to hand the connection to somebody else between statements. The
    // message has to name Session mode, because the console's obvious answer —
    // the "Direct connection" tab — is the one that does not work from
    // Netlify.
    expect(message).toContain('Session pooler');
    expect(message).toContain('IPv4');
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
    expect(message).toContain('transaction-mode pooler');
  });

  it('leaves a plain direct connection alone', () => {
    // No pooler in front, nothing to configure around.
    expect(() => loadEnv(production() as NodeJS.ProcessEnv)).not.toThrow();
  });

  /**
   * Session mode is not transaction mode.
   *
   * Supabase serves both from the same `pooler.` host and tells them apart by
   * port. Session mode holds one connection per client for the length of the
   * session, so prepared statements, DDL and advisory locks all behave as they
   * would on a direct connection — and it is the only one of the two that is
   * reachable over IPv4 without the paid add-on, which is what Netlify and
   * GitHub Actions have.
   */
  const SESSION =
    'postgresql://postgres.abcdef:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=require';

  it('accepts the session pooler for migrations, where direct is IPv6-only', () => {
    expect(() =>
      loadEnv(
        production({
          DATABASE_URL: `${POOLED}&pgbouncer=true`,
          DIRECT_DATABASE_URL: SESSION,
        }) as NodeJS.ProcessEnv,
      ),
    ).not.toThrow();
  });

  it('does not demand pgbouncer=true of a session-mode DATABASE_URL', () => {
    // Port 5432 on the pooler host is session mode, which can hold a prepared
    // statement. Demanding the flag there would turn them off for nothing.
    expect(complaint(production({ DATABASE_URL: SESSION }), 'DATABASE_URL')).toBeUndefined();
  });

  it('catches options appended with & when there was no ? yet', () => {
    // The tail becomes part of the database name, and pgbouncer=true is then
    // silently not set — which is the failure the flag exists to prevent.
    const message = complaint(
      production({
        DATABASE_URL:
          'postgresql://postgres.abcdef:pw@aws-0-ap-south-1.pooler.supabase.com:6543/postgres&sslmode=require&pgbouncer=true',
      }),
      'DATABASE_URL',
    );
    expect(message).toContain('options were never parsed');
  });

  it('catches a pooler username that lost its project ref', () => {
    // Supavisor reads the tenant from the username. Plain `postgres` against a
    // pooler host fails with "Tenant or user not found", which names neither
    // the tenant nor the user nor the fix.
    const message = complaint(
      production({
        DATABASE_URL: POOLED.replace('postgres.abcdef:', 'postgres:') + '&pgbouncer=true',
      }),
      'DATABASE_URL',
    );
    expect(message).toContain('postgres.<project-ref>');
  });

  it('refuses a transaction-mode URL for migrations even without the flag', () => {
    // The `pgbouncer=true` check catches the obvious copy-paste. This catches
    // the one where somebody strips the flag to get past it: port 6543 cannot
    // hold a migration's advisory lock whatever the query string says.
    const message = complaint(
      production({
        DATABASE_URL: `${POOLED}&pgbouncer=true`,
        DIRECT_DATABASE_URL: POOLED,
      }),
      'DIRECT_DATABASE_URL',
    );
    expect(message).toContain('transaction mode');
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

  it('accepts no Redis, because the database is a shared store too', () => {
    // The limiter falls back to Postgres, which every instance can see. What
    // it must never fall back to silently is the in-process counter.
    expect(() => loadEnv(production({ REDIS_URL: undefined }) as NodeJS.ProcessEnv)).not.toThrow();
  });

  it('refuses the in-process limiter and a shared one at the same time', () => {
    // One of the two is a mistake, and it is not obvious which from the
    // outside — so it is refused rather than silently resolved.
    expect(
      complaint(production({ RATE_LIMIT_ALLOW_IN_PROCESS: 'true' }), 'RATE_LIMIT_ALLOW_IN_PROCESS'),
    ).toContain('mistake');
  });

  it('allows the in-process limiter when it is asked for on its own', () => {
    // One instance that will never be scaled out is the one case where this is
    // not a mistake. It has to be said out loud because the failure is silent.
    expect(() =>
      loadEnv(
        production({
          REDIS_URL: undefined,
          RATE_LIMIT_ALLOW_IN_PROCESS: 'true',
        }) as NodeJS.ProcessEnv,
      ),
    ).not.toThrow();
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
