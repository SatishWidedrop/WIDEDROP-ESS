import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';

/**
 * Time-based one-time passwords (RFC 6238) and recovery codes.
 *
 * MFA is mandatory for Manager, HR and Accounts — every role that can read or
 * move another person's money or records. An employee may enable it voluntarily.
 */

export const TOTP_CONFIG = {
  algorithm: 'SHA1' as const, // What every authenticator app supports.
  digits: 6,
  period: 30,
  issuer: 'Widedrop ESS',
} as const;

/**
 * How many periods either side of now are accepted. One step (±30s) absorbs
 * ordinary clock drift; more than that meaningfully widens the window an
 * intercepted code stays usable in.
 */
export const TOTP_WINDOW = 1;

export interface TotpEnrolment {
  /** Base32 secret to store encrypted against the user. */
  secret: string;
  /** otpauth:// URI the authenticator app scans. */
  uri: string;
}

/** Generate a new TOTP secret and the provisioning URI for `accountLabel`. */
export function createTotpEnrolment(accountLabel: string): TotpEnrolment {
  const secret = new OTPAuth.Secret({ size: 20 }); // 160 bits, the RFC 4226 recommendation
  const totp = new OTPAuth.TOTP({
    issuer: TOTP_CONFIG.issuer,
    label: accountLabel,
    algorithm: TOTP_CONFIG.algorithm,
    digits: TOTP_CONFIG.digits,
    period: TOTP_CONFIG.period,
    secret,
  });
  return { secret: secret.base32, uri: totp.toString() };
}

/**
 * Verify a code. Returns the matched time step so the caller can persist it and
 * refuse to accept the same step twice — without that, an intercepted code is
 * replayable for the rest of its 30-second window.
 */
export function verifyTotp(
  code: string,
  secretBase32: string,
  accountLabel: string,
): { valid: boolean; timeStep?: number } {
  const normalized = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(normalized)) return { valid: false };

  let totp: OTPAuth.TOTP;
  try {
    totp = new OTPAuth.TOTP({
      issuer: TOTP_CONFIG.issuer,
      label: accountLabel,
      algorithm: TOTP_CONFIG.algorithm,
      digits: TOTP_CONFIG.digits,
      period: TOTP_CONFIG.period,
      secret: OTPAuth.Secret.fromBase32(secretBase32),
    });
  } catch {
    return { valid: false };
  }

  const delta = totp.validate({ token: normalized, window: TOTP_WINDOW });
  if (delta === null) return { valid: false };

  const currentStep = Math.floor(Date.now() / 1000 / TOTP_CONFIG.period);
  return { valid: true, timeStep: currentStep + delta };
}

/* ------------------------------------------------------------------ */
/* Recovery codes                                                      */
/* ------------------------------------------------------------------ */

export const RECOVERY_CODE_COUNT = 10;

/** Unambiguous alphabet: no 0/O, 1/I/L, which people mistype when reading aloud. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const RECOVERY_GROUP = 5;
const RECOVERY_GROUPS = 2;

/**
 * Generate single-use recovery codes. They are shown to the user exactly once,
 * at enrolment, and stored only as Argon2 hashes — the server cannot reveal them
 * afterwards, only check one.
 */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const groups = Array.from({ length: RECOVERY_GROUPS }, () =>
      Array.from(
        { length: RECOVERY_GROUP },
        () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]!,
      ).join(''),
    );
    return groups.join('-');
  });
}

/** Normalise a code a person typed: strip spaces and hyphens, upper-case. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function isWellFormedRecoveryCode(code: string): boolean {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length !== RECOVERY_GROUP * RECOVERY_GROUPS) return false;
  return [...normalized].every((c) => RECOVERY_ALPHABET.includes(c));
}

/* ------------------------------------------------------------------ */
/* MFA challenges                                                      */
/* ------------------------------------------------------------------ */

/**
 * How long a partially-authenticated session may wait for its second factor.
 * Long enough to open an authenticator app, short enough that a stolen
 * challenge id is not useful later.
 */
export const MFA_CHALLENGE_TTL_SECONDS = 300;

/** Failed second-factor attempts before the challenge is destroyed. */
export const MFA_MAX_ATTEMPTS = 5;

export function generateChallengeId(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison for challenge identifiers. */
export function challengeMatches(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
