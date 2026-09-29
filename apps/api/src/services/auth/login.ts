import {
  normalizeRoles,
  requiresMfa,
  STATES_ALLOWING_SIGN_IN,
  type Persona,
} from '@widedrop/shared';
import type { LoginOutcome } from '../../generated/prisma/index.js';
import { hashToken } from '../../lib/crypto.js';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { hashPassword, needsRehash, verifyPassword } from '../../lib/password.js';
import { recordAudit } from '../audit.js';

/**
 * Sign-in.
 *
 * Three properties the implementation is built around:
 *
 *  1. **No enumeration.** Every failure takes the same path, costs the same
 *     time and returns the same message. A caller cannot learn whether an email
 *     belongs to an employee — which, for a company directory, matters.
 *
 *  2. **Progressive lockout.** Failures cost increasingly more, up to a hard
 *     lock. This is the control that actually stops credential stuffing; rate
 *     limiting only slows it down.
 *
 *  3. **Every attempt is recorded**, successful or not, including attempts
 *     against addresses that match no account — that pattern is what an
 *     enumeration attempt looks like from the inside.
 */

/** Failures before the account locks. */
export const LOCKOUT_THRESHOLD = 8;

/**
 * How long a lock lasts, by how many times the account has already locked.
 * A first lock is a nuisance; a fourth is almost certainly an attack.
 */
export function lockoutDurationSeconds(failedCount: number): number {
  const over = Math.max(0, failedCount - LOCKOUT_THRESHOLD);
  const steps = [60, 300, 900, 3_600, 21_600];
  return steps[Math.min(over, steps.length - 1)] ?? 60;
}

/**
 * Work done on a failed lookup so that a missing account costs roughly what a
 * wrong password costs. Without it, response time answers the question the
 * error message refuses to.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=1$YWJjZGVmZ2hpamtsbW5vcA$k0kBxOtKUMVQDFtXCXCdmQ6dkkmXnTCcJXcZ9K7dLKY';

export interface LoginAttemptInput {
  organizationId: string;
  email: string;
  password: string;
  pepper: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type LoginResult =
  | {
      kind: 'authenticated';
      userId: string;
      employeeId?: string | undefined;
      personas: Persona[];
      mustChangePassword: boolean;
    }
  | { kind: 'mfa-required'; userId: string; employeeId?: string | undefined; personas: Persona[] }
  | { kind: 'mfa-enrolment-required'; userId: string; personas: Persona[] }
  | { kind: 'rejected'; reason: LoginOutcome };

export async function attemptLogin(
  tx: Tx,
  input: LoginAttemptInput,
  hmacKey: string,
): Promise<LoginResult> {
  const email = input.email.trim().toLowerCase();

  const user = await tx.appUser.findFirst({
    where: { organizationId: input.organizationId, email },
    select: {
      id: true,
      organizationId: true,
      passwordHash: true,
      status: true,
      failedLoginCount: true,
      lockedUntil: true,
      passwordMustChange: true,
      isServiceAccount: true,
      employee: { select: { id: true, employmentStatus: true } },
      roles: {
        where: { revokedAt: null },
        select: { role: { select: { persona: true } }, expiresAt: true },
      },
      mfaCredentials: {
        where: { disabledAt: null, confirmedAt: { not: null } },
        select: { id: true },
      },
    },
  });

  // No account: still verify against a dummy hash so the timing matches.
  if (!user || user.isServiceAccount) {
    await verifyPassword(input.password, DUMMY_HASH, input.pepper);
    await recordAttempt(tx, { ...input, email, outcome: 'UNKNOWN_USER' });
    return { kind: 'rejected', reason: 'UNKNOWN_USER' };
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    await verifyPassword(input.password, DUMMY_HASH, input.pepper);
    await recordAttempt(tx, { ...input, email, outcome: 'LOCKED', appUserId: user.id });
    return { kind: 'rejected', reason: 'LOCKED' };
  }

  if (user.status !== 'ACTIVE' || !user.passwordHash) {
    await verifyPassword(input.password, DUMMY_HASH, input.pepper);
    await recordAttempt(tx, { ...input, email, outcome: 'DISABLED', appUserId: user.id });
    return { kind: 'rejected', reason: 'DISABLED' };
  }

  const correct = await verifyPassword(input.password, user.passwordHash, input.pepper);

  if (!correct) {
    const failedLoginCount = user.failedLoginCount + 1;
    const shouldLock = failedLoginCount >= LOCKOUT_THRESHOLD;

    await tx.appUser.update({
      where: { id: user.id },
      data: {
        failedLoginCount,
        ...(shouldLock
          ? {
              lockedUntil: new Date(Date.now() + lockoutDurationSeconds(failedLoginCount) * 1000),
            }
          : {}),
      },
    });

    await recordAttempt(tx, { ...input, email, outcome: 'BAD_CREDENTIALS', appUserId: user.id });

    if (shouldLock) {
      await recordAudit(
        tx,
        {
          organizationId: user.organizationId,
          action: 'LOGIN',
          entityType: 'app_user',
          entityId: user.id,
          summary: `Account locked after ${failedLoginCount} failed sign-in attempts`,
          actor: { kind: 'SYSTEM' },
        },
        hmacKey,
      );
    }

    return { kind: 'rejected', reason: shouldLock ? 'LOCKED' : 'BAD_CREDENTIALS' };
  }

  // An employee who has left, or is suspended, keeps their record but loses
  // access. Their payslips remain; the portal does not.
  if (
    !user.employee ||
    !STATES_ALLOWING_SIGN_IN.includes(user.employee.employmentStatus as never)
  ) {
    await recordAttempt(tx, { ...input, email, outcome: 'DISABLED', appUserId: user.id });
    return { kind: 'rejected', reason: 'DISABLED' };
  }

  // The password was right: clear the failure counter and rehash if the cost
  // parameters have since been raised.
  const now = Date.now();
  await tx.appUser.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      ...(needsRehash(user.passwordHash)
        ? { passwordHash: await hashPassword(input.password, input.pepper) }
        : {}),
    },
  });

  const personas = normalizeRoles(
    user.roles
      .filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now)
      .map((grant) => grant.role.persona as Persona),
  );

  const hasMfa = user.mfaCredentials.length > 0;

  if (hasMfa) {
    await recordAttempt(tx, { ...input, email, outcome: 'MFA_REQUIRED', appUserId: user.id });
    return {
      kind: 'mfa-required',
      userId: user.id,
      employeeId: user.employee.id,
      personas,
    };
  }

  // Manager, HR and Accounts can read or move other people's money and records.
  // They finish enrolment before they get a session, not at their convenience.
  if (requiresMfa(personas)) {
    await recordAttempt(tx, { ...input, email, outcome: 'MFA_REQUIRED', appUserId: user.id });
    return { kind: 'mfa-enrolment-required', userId: user.id, personas };
  }

  await recordAttempt(tx, { ...input, email, outcome: 'SUCCESS', appUserId: user.id });

  return {
    kind: 'authenticated',
    userId: user.id,
    employeeId: user.employee.id,
    personas,
    mustChangePassword: user.passwordMustChange,
  };
}

/**
 * Mark a sign-in complete: stamp the last-login fields and write the audit row.
 * Separate from `attemptLogin` because it runs after the second factor, if any.
 */
export async function completeLogin(
  tx: Tx,
  input: {
    userId: string;
    organizationId: string;
    ip?: string | undefined;
    mfaUsed: boolean;
  },
  hmacKey: string,
): Promise<void> {
  await tx.appUser.update({
    where: { id: input.userId },
    data: { lastLoginAt: new Date(), lastLoginIp: input.ip ?? null },
  });

  await recordAudit(
    tx,
    {
      organizationId: input.organizationId,
      action: 'LOGIN',
      entityType: 'app_user',
      entityId: input.userId,
      summary: input.mfaUsed ? 'Signed in with two-factor authentication' : 'Signed in',
      actor: { kind: 'USER', userId: input.userId },
    },
    hmacKey,
  );
}

async function recordAttempt(
  tx: Tx,
  input: {
    organizationId: string;
    email: string;
    outcome: LoginOutcome;
    appUserId?: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
  },
): Promise<void> {
  await tx.loginAttempt.create({
    data: {
      organizationId: input.organizationId,
      appUserId: input.appUserId ?? null,
      emailAttempted: input.email,
      outcome: input.outcome,
      ip: input.ip ?? null,
      userAgent: input.userAgent?.slice(0, 300) ?? null,
    },
  });
}

/**
 * The single error every rejected sign-in produces.
 *
 * A locked account is told so, because the user needs to know to wait or reset;
 * everything else is indistinguishable.
 */
export function loginRejection(reason: LoginOutcome, retryAfterSeconds?: number): AppError {
  if (reason === 'LOCKED') {
    return new AppError(
      403,
      ERROR_CODES.ACCOUNT_LOCKED,
      'Too many failed sign-in attempts. Try again later, or reset your password.',
      { retryAfterSeconds: retryAfterSeconds ?? 900 },
    );
  }
  return new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, 'Email or password is incorrect.');
}

/** A deterministic hash of an email, for correlating attempts without storing it twice. */
export function emailFingerprint(email: string): string {
  return hashToken(email.trim().toLowerCase());
}
