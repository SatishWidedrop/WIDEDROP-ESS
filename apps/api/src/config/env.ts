import { z } from 'zod';

/**
 * Environment configuration.
 *
 * Parsed and validated once at boot. The process REFUSES TO START if anything
 * required is missing or a secret is too weak — a misconfigured deployment must
 * fail loudly rather than run with an insecure default.
 *
 * No secret ever has a default value. `.env.example` documents every variable.
 */

const NODE_ENVS = ['development', 'test', 'production'] as const;

/** Minimum entropy we accept for a secret, in characters of a random string. */
const MIN_SECRET_LENGTH = 32;

const secret = (name: string) =>
  z
    .string()
    .min(MIN_SECRET_LENGTH, `${name} must be at least ${MIN_SECRET_LENGTH} characters`)
    .refine(
      (v) => new Set(v).size >= 12,
      `${name} looks low-entropy (too few distinct characters) — generate it with \`openssl rand -base64 48\``,
    )
    .refine(
      (v) => !/^(changeme|secret|password|test|dev|example|placeholder)/i.test(v),
      `${name} still holds a placeholder value`,
    );

/** A 32-byte key, base64-encoded (44 characters with padding). */
const base64Key32 = (name: string) =>
  z.string().refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, `${name} must be 32 bytes base64-encoded — generate it with \`openssl rand -base64 32\``);

const csv = z
  .string()
  .transform((v) =>
    v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().min(1)));

const boolish = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65_535);

const baseSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: port.default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Public origin of the API itself, used to build absolute URLs. */
  API_PUBLIC_URL: z.string().url(),
  /** Public origin of the SPA, used for links in outbound email. */
  WEB_PUBLIC_URL: z.string().url(),
  /** Exact browser origins allowed to call the API with credentials. */
  CORS_ORIGINS: csv,

  /**
   * The connection the application uses.
   *
   * Pooled, wherever the platform offers one: the API scales out and a direct
   * connection per instance exhausts Postgres's connection slots long before
   * traffic does. On Supabase that is Supavisor in transaction mode, port
   * 6543, with `?pgbouncer=true`.
   */
  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('postgres'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string',
    }),

  /**
   * The connection migrations use, when it differs from the one above.
   *
   * DDL and the advisory locks `prisma migrate` takes do not survive a
   * transaction-mode pooler, which is free to hand the connection to somebody
   * else between statements. Unset where there is no pooler in front.
   */
  DIRECT_DATABASE_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('postgres'), {
      message: 'DIRECT_DATABASE_URL must be a PostgreSQL connection string',
    })
    .optional(),

  /* ---------------- Authentication & sessions ---------------- */

  /** Ed25519 private key (PKCS#8 PEM, base64-encoded) that signs access tokens. */
  JWT_PRIVATE_KEY: z.string().min(1),
  /** Matching Ed25519 public key (SPKI PEM, base64-encoded). */
  JWT_PUBLIC_KEY: z.string().min(1),
  /** Key id published with each token so keys can be rotated without downtime. */
  JWT_KEY_ID: z.string().min(1),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .min(3_600)
    .max(60 * 60 * 24 * 90)
    .default(60 * 60 * 24 * 14),

  /** Server-side pepper mixed into every password hash. */
  PASSWORD_PEPPER: secret('PASSWORD_PEPPER'),
  /** Domain the refresh cookie is scoped to, e.g. `.widedrop.com`. */
  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: boolish.default('true'),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),

  /* ---------------- Encryption ---------------- */

  /** Key-encrypting key for the AES-256-GCM envelope over sensitive columns. */
  ENCRYPTION_KEK: base64Key32('ENCRYPTION_KEK'),
  /** Version label of the active KEK, stored alongside every ciphertext. */
  ENCRYPTION_KEY_VERSION: z.string().min(1).default('v1'),
  /** HMAC key that seals each audit-log row into the tamper-evident chain. */
  AUDIT_HMAC_KEY: base64Key32('AUDIT_HMAC_KEY'),

  /* ---------------- Rate limiting ---------------- */

  /**
   * Redis, for the rate limiter's counters.
   *
   * Optional. Without it the limiter uses the database, which is shared for
   * the same reason Redis is and costs one upsert per limited request. Set
   * this when that cost starts to matter; nothing else changes.
   */
  REDIS_URL: z.string().url().optional(),

  /**
   * Allow the in-process rate limiter in production.
   *
   * There is exactly one situation where this is not a mistake: a single
   * instance that will never be scaled out. With two, each gets its own
   * counters, and an account lockout holds only on whichever one the next
   * attempt reaches — which is not a lockout, and is the control that stops
   * credential stuffing.
   *
   * It has to be said out loud because the failure is silent: nothing looks
   * wrong, the limiter simply stops limiting at the rate it claims.
   */
  RATE_LIMIT_ALLOW_IN_PROCESS: boolish.default('false'),

  /* ---------------- Object storage ---------------- */

  STORAGE_DRIVER: z.enum(['filesystem', 's3']).default('filesystem'),
  STORAGE_LOCAL_PATH: z.string().default('./.storage'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** How long a generated download URL stays valid. */
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),

  /* ---------------- Email ---------------- */

  MAIL_DRIVER: z.enum(['smtp', 'file', 'noop']).default('file'),
  MAIL_FROM: z.string().email().default('no-reply@widedroptech.com'),
  /** Where portal help-desk tickets are dispatched. */
  HELPDESK_EMAIL: z.string().email().default('helpdesk@widedroptech.com'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: port.optional(),
  SMTP_SECURE: boolish.optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  /** Directory the `file` mail driver writes .eml files to, for development. */
  MAIL_FILE_PATH: z.string().default('./.mail'),

  /* ---------------- Outbound integrations ---------------- */

  /** Check new passwords against Have I Been Pwned's k-anonymity range API. */
  HIBP_ENABLED: boolish.default('true'),
  HIBP_TIMEOUT_MS: z.coerce.number().int().min(200).max(10_000).default(2_000),

  /* ---------------- Behaviour ---------------- */

  /** Worker loop interval for the email outbox and scheduled jobs. */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(15_000),

  /**
   * Whether a proxy sits in front of this process.
   *
   * With no proxy the client's address is the socket's, full stop. With one,
   * it has to be read out of a forwarded header — and that header is
   * attacker-influenced, hence the two settings below.
   */
  TRUST_PROXY: boolish.default('false'),

  /**
   * How many proxies append to `X-Forwarded-For` between the client and here.
   *
   * One for a single load balancer; two behind a CDN in front of one. Too low
   * and the address read is one the client supplied; too high and everyone
   * behind the same proxy shares a rate-limit bucket. Ignored when
   * `CLIENT_IP_HEADER` is set, which is better than counting.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(1).max(8).default(1),

  /**
   * A single-value header the platform sets for the client's address.
   *
   * `x-nf-client-connection-ip` on Netlify, `cf-connecting-ip` behind
   * Cloudflare, `true-client-ip` on some others. Preferred over counting the
   * `X-Forwarded-For` trail, because the platform overwrites these rather than
   * appending, so nothing a client sends can reach them.
   *
   * Only ever set to a header the platform in front is known to overwrite: one
   * it merely passes through would be worse than counting.
   */
  CLIENT_IP_HEADER: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'must be a lowercase header name')
    .optional(),
});

/**
 * Production hardening: settings that may be relaxed locally are mandatory in
 * production, and anything that would silently weaken security is rejected.
 */
const schema = baseSchema.superRefine((env, ctx) => {
  const fail = (path: string, message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

  if (env.NODE_ENV !== 'production') return;

  if (!env.COOKIE_SECURE) {
    fail('COOKIE_SECURE', 'must be true in production — session cookies require HTTPS');
  }
  if (env.LOG_LEVEL === 'silent') {
    fail('LOG_LEVEL', 'cannot be silent in production — a security incident would leave no trace');
  }
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    fail('COOKIE_SAMESITE', 'SameSite=None requires Secure cookies');
  }
  // The limiter needs a store every instance can see. Redis is one; the
  // database is the other, and it is always present — so this only fails when
  // somebody has explicitly asked for the in-process store and then thought
  // better of naming the instance count.
  if (env.CLIENT_IP_HEADER && !env.TRUST_PROXY) {
    fail(
      'CLIENT_IP_HEADER',
      'is set but TRUST_PROXY is false — with no proxy in front, a forwarded header is whatever the client sent',
    );
  }

  if (env.RATE_LIMIT_ALLOW_IN_PROCESS && env.REDIS_URL) {
    fail(
      'RATE_LIMIT_ALLOW_IN_PROCESS',
      'is set alongside REDIS_URL — one of them is a mistake, and the shared store is the one worth keeping',
    );
  }
  if (env.STORAGE_DRIVER === 'filesystem') {
    fail('STORAGE_DRIVER', 'must be "s3" in production — container filesystems are ephemeral');
  }
  if (env.STORAGE_DRIVER === 's3') {
    for (const key of [
      'S3_REGION',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
    ] as const) {
      if (!env[key]) fail(key, 'is required when STORAGE_DRIVER is "s3"');
    }
  }
  if (env.MAIL_DRIVER !== 'smtp') {
    fail('MAIL_DRIVER', 'must be "smtp" in production — help-desk mail must actually be delivered');
  }
  if (env.MAIL_DRIVER === 'smtp') {
    for (const key of ['SMTP_HOST', 'SMTP_PORT'] as const) {
      if (!env[key]) fail(key, 'is required when MAIL_DRIVER is "smtp"');
    }
  }
  if (env.CORS_ORIGINS.some((o) => o === '*' || o.startsWith('http://'))) {
    fail(
      'CORS_ORIGINS',
      'must list explicit https:// origins in production — no wildcard, no http',
    );
  }
  if (!env.API_PUBLIC_URL.startsWith('https://') || !env.WEB_PUBLIC_URL.startsWith('https://')) {
    fail('API_PUBLIC_URL', 'public URLs must use https in production');
  }
  if (!env.DATABASE_URL.includes('sslmode=')) {
    fail('DATABASE_URL', 'must specify sslmode (require or verify-full) in production');
  }

  // Supavisor and PgBouncer in transaction mode do not support prepared
  // statements, which Prisma creates unless told not to. Without this the
  // application starts and then fails intermittently under load with
  // "prepared statement already exists" — which is a far worse way to find out.
  const pooled = /:6543\b/.test(env.DATABASE_URL) || /pooler\./.test(env.DATABASE_URL);
  if (pooled && !env.DATABASE_URL.includes('pgbouncer=true')) {
    fail(
      'DATABASE_URL',
      'looks like a transaction-mode pooler; append ?pgbouncer=true or Prisma will use prepared statements the pooler cannot hold',
    );
  }
  if (pooled && !env.DIRECT_DATABASE_URL) {
    fail(
      'DIRECT_DATABASE_URL',
      'is required alongside a pooled DATABASE_URL — migrations need a direct connection (port 5432) to hold DDL and advisory locks',
    );
  }
  if (env.DIRECT_DATABASE_URL?.includes('pgbouncer=true')) {
    fail('DIRECT_DATABASE_URL', 'must be the direct connection, not the pooler');
  }
});

export type Env = z.infer<typeof baseSchema>;

/**
 * Every variable this module reads, whether or not it happens to be set.
 *
 * `Object.keys(loadEnv(...))` is not the same list: zod drops an optional that
 * was not provided, so a variable would look unread simply because the
 * environment being checked did not set it. Anything comparing a reference
 * file or a deployment blueprint against "what the API reads" wants this.
 */
export const ENV_KEYS = Object.keys(baseSchema.shape) as (keyof Env)[];

let cached: Env | undefined;

/**
 * Parse and validate `process.env`. Throws a single readable error listing every
 * problem, so a deployment is fixed in one pass rather than one variable at a time.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(
      `Invalid environment configuration; refusing to start.\n${lines.join('\n')}\n\n` +
        'See .env.example and docs/DEPLOYMENT.md for the full variable reference.',
    );
  }
  return parsed.data;
}

export function env(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test helper: drop the memoised config so a new environment can be loaded. */
export function resetEnvCache(): void {
  cached = undefined;
}

export const isProduction = (e: Env = env()) => e.NODE_ENV === 'production';
export const isTest = (e: Env = env()) => e.NODE_ENV === 'test';
