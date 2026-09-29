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

  DATABASE_URL: z
    .string()
    .url()
    .refine((v) => v.startsWith('postgres'), {
      message: 'DATABASE_URL must be a PostgreSQL connection string',
    }),

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

  /** Shared counter store. Falls back to an in-process store when unset, which
   *  is correct only for a single instance — production must set this. */
  REDIS_URL: z.string().url().optional(),

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
  TRUST_PROXY: boolish.default('false'),
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
  if (!env.REDIS_URL) {
    fail(
      'REDIS_URL',
      'is required in production — an in-process rate-limit store does not hold across instances',
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
});

export type Env = z.infer<typeof baseSchema>;

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
