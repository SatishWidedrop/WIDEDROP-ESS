import { pino, type Logger, type LoggerOptions } from 'pino';
import type { Env } from '../config/env.js';

/**
 * Structured logging with PII redaction.
 *
 * Logs are operational telemetry, not a second copy of the database. Nothing
 * that identifies a person beyond their user id, and nothing that could be
 * replayed as a credential, may reach a log line. The redaction list below is
 * enforced by pino at serialisation time, so a careless `log.info({ body })`
 * cannot leak a password.
 */

/**
 * Exact paths pino replaces with `[redacted]`. Wildcards cover the nesting
 * depths we actually log at; `redactValue` below is the belt-and-braces pass for
 * anything assembled by hand.
 */
const REDACT_PATHS = [
  // Credentials and tokens
  'password', '*.password', '*.*.password',
  'currentPassword', '*.currentPassword',
  'newPassword', '*.newPassword',
  'passwordHash', '*.passwordHash',
  'token', '*.token', '*.*.token',
  'refreshToken', '*.refreshToken',
  'accessToken', '*.accessToken',
  'mfaCode', '*.mfaCode',
  'mfaSecret', '*.mfaSecret',
  'totp', '*.totp',
  'recoveryCode', '*.recoveryCode',
  'authorization', '*.authorization',
  'cookie', '*.cookie',
  'set-cookie', '*.set-cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  // Statutory and financial identifiers
  'pan', '*.pan', 'aadhaar', '*.aadhaar', 'uan', '*.uan',
  'accountNumber', '*.accountNumber',
  'bankAccountNumber', '*.bankAccountNumber',
  'ifsc', '*.ifsc',
  // Direct personal data
  'dateOfBirth', '*.dateOfBirth',
  'personalEmail', '*.personalEmail',
  'mobile', '*.mobile',
  'currentAddress', '*.currentAddress',
  'permanentAddress', '*.permanentAddress',
  // Encrypted blobs — logging one is pointless and invites offline analysis
  'sealed', '*.sealed', 'ciphertext', '*.ciphertext',
];

/** Key names that are always stripped, wherever they appear. */
const SENSITIVE_KEYS = new Set(
  [
    'password', 'currentpassword', 'newpassword', 'passwordhash', 'pepper',
    'token', 'refreshtoken', 'accesstoken', 'idtoken', 'apikey', 'secret',
    'authorization', 'cookie', 'setcookie', 'set-cookie',
    'mfacode', 'mfasecret', 'totp', 'otp', 'recoverycode', 'recoverycodes',
    'pan', 'aadhaar', 'uan', 'accountnumber', 'bankaccountnumber', 'ifsc',
    'dateofbirth', 'personalemail', 'mobile', 'phone', 'currentaddress',
    'permanentaddress', 'sealed', 'ciphertext', 'kek', 'privatekey',
  ].map((k) => k.toLowerCase()),
);

export const REDACTED = '[redacted]';

/**
 * Recursively strip sensitive keys from a value before it is attached to a log
 * line. Use this for anything hand-assembled — audit payloads, error metadata,
 * validation details echoed back from a request body.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))
      ? REDACTED
      : redactValue(inner, depth + 1);
  }
  return out;
}

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    base: { service: 'widedrop-ess-api', env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    serializers: {
      // Deliberately narrow: never serialise a whole request or response.
      req: (req: { id?: string; method?: string; url?: string; ip?: string }) => ({
        id: req.id,
        method: req.method,
        // Strip the query string — it can carry search terms and identifiers.
        url: typeof req.url === 'string' ? req.url.split('?')[0] : undefined,
        ip: req.ip,
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
      err: pino.stdSerializers.err,
    },
  };

  // Human-readable output in development only; production emits one JSON object
  // per line for the log pipeline.
  if (env.NODE_ENV === 'development') {
    return pino({
      ...options,
      transport: {
        target: 'pino/file',
        options: { destination: 1 },
      },
    });
  }

  if (env.NODE_ENV === 'test') {
    return pino({ ...options, level: 'silent' });
  }

  return pino(options);
}

export type { Logger };
