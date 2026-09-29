import { afterEach, describe, expect, it, vi } from 'vitest';
import * as OTPAuth from 'otpauth';
import {
  MFA_MAX_ATTEMPTS,
  RECOVERY_CODE_COUNT,
  TOTP_CONFIG,
  TOTP_WINDOW,
  challengeMatches,
  createTotpEnrolment,
  generateChallengeId,
  generateRecoveryCodes,
  isWellFormedRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp,
} from './mfa.js';

const LABEL = 'priya.raghavan@widedrop.com';

const codeFor = (secret: string, at?: number) =>
  new OTPAuth.TOTP({
    issuer: TOTP_CONFIG.issuer,
    label: LABEL,
    algorithm: TOTP_CONFIG.algorithm,
    digits: TOTP_CONFIG.digits,
    period: TOTP_CONFIG.period,
    secret: OTPAuth.Secret.fromBase32(secret),
  }).generate(at === undefined ? undefined : { timestamp: at });

afterEach(() => vi.useRealTimers());

describe('enrolment', () => {
  it('produces a 160-bit secret and a scannable URI', () => {
    const { secret, uri } = createTotpEnrolment(LABEL);
    expect(OTPAuth.Secret.fromBase32(secret).bytes.length).toBe(20);
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('issuer=Widedrop%20ESS');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('produces a different secret every time', () => {
    const secrets = new Set(Array.from({ length: 50 }, () => createTotpEnrolment(LABEL).secret));
    expect(secrets.size).toBe(50);
  });
});

describe('verification', () => {
  it('accepts the current code', () => {
    const { secret } = createTotpEnrolment(LABEL);
    const result = verifyTotp(codeFor(secret), secret, LABEL);
    expect(result.valid).toBe(true);
    expect(result.timeStep).toBeTypeOf('number');
  });

  it('tolerates a clock one step out', () => {
    const { secret } = createTotpEnrolment(LABEL);
    const now = Date.now();
    for (const offset of [-TOTP_CONFIG.period * 1000, TOTP_CONFIG.period * 1000]) {
      expect(verifyTotp(codeFor(secret, now + offset), secret, LABEL).valid).toBe(true);
    }
  });

  it('rejects a code from outside the drift window', () => {
    const { secret } = createTotpEnrolment(LABEL);
    const far = Date.now() + TOTP_CONFIG.period * 1000 * (TOTP_WINDOW + 2);
    expect(verifyTotp(codeFor(secret, far), secret, LABEL).valid).toBe(false);
  });

  it('returns a distinct time step per period, so a code cannot be replayed', () => {
    const { secret } = createTotpEnrolment(LABEL);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
    const first = verifyTotp(codeFor(secret), secret, LABEL);
    vi.setSystemTime(new Date('2026-09-29T10:01:00Z'));
    const second = verifyTotp(codeFor(secret), secret, LABEL);
    expect(first.timeStep).not.toBe(second.timeStep);
  });

  it('rejects anything that is not six digits', () => {
    const { secret } = createTotpEnrolment(LABEL);
    for (const bad of ['12345', '1234567', 'abcdef', '', '12 34 56 78']) {
      expect(verifyTotp(bad, secret, LABEL).valid, bad).toBe(false);
    }
  });

  it('accepts a code the user typed with spaces', () => {
    const { secret } = createTotpEnrolment(LABEL);
    const code = codeFor(secret);
    expect(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, secret, LABEL).valid).toBe(true);
  });

  it('rejects a code for a different secret', () => {
    const a = createTotpEnrolment(LABEL);
    const b = createTotpEnrolment(LABEL);
    expect(verifyTotp(codeFor(b.secret), a.secret, LABEL).valid).toBe(false);
  });

  it('returns invalid rather than throwing on a corrupted secret', () => {
    expect(verifyTotp('123456', 'not-base32!!', LABEL).valid).toBe(false);
  });
});

describe('recovery codes', () => {
  it('generates the configured number of distinct codes', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    expect(new Set(codes).size).toBe(RECOVERY_CODE_COUNT);
  });

  it('avoids characters people mistype', () => {
    const codes = generateRecoveryCodes(200).join('');
    for (const ambiguous of ['0', 'O', '1', 'I', 'L']) {
      expect(codes).not.toContain(ambiguous);
    }
  });

  it('accepts a code however the user spaces it', () => {
    const [code] = generateRecoveryCodes(1);
    expect(normalizeRecoveryCode(code!)).toBe(code!.replace('-', ''));
    expect(isWellFormedRecoveryCode(code!)).toBe(true);
    expect(isWellFormedRecoveryCode(code!.toLowerCase())).toBe(true);
    expect(isWellFormedRecoveryCode(` ${code!.replace('-', ' ')} `)).toBe(true);
  });

  it('rejects a malformed code before it reaches the database', () => {
    expect(isWellFormedRecoveryCode('TOO-SHORT')).toBe(false);
    expect(isWellFormedRecoveryCode('ABCDE-0000I')).toBe(false);
  });
});

describe('challenges', () => {
  it('generates unguessable, distinct identifiers', () => {
    const ids = new Set(Array.from({ length: 200 }, () => generateChallengeId()));
    expect(ids.size).toBe(200);
    expect([...ids][0]!.length).toBeGreaterThanOrEqual(43);
  });

  it('compares in constant time and handles a length mismatch', () => {
    const id = generateChallengeId();
    expect(challengeMatches(id, id)).toBe(true);
    expect(challengeMatches(id, generateChallengeId())).toBe(false);
    expect(challengeMatches(id, 'short')).toBe(false);
  });

  it('bounds second-factor attempts', () => {
    expect(MFA_MAX_ATTEMPTS).toBeLessThanOrEqual(6);
    expect(MFA_MAX_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });
});
