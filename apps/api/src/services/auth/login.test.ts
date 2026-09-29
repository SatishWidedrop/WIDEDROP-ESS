import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { hashPassword } from '../../lib/password.js';
import { LOCKOUT_THRESHOLD, attemptLogin, lockoutDurationSeconds } from './login.js';

const db = testDb();
const PEPPER = 'a-server-side-pepper-of-sufficient-length-1234';
const HMAC = Buffer.alloc(32, 31).toString('base64');
const PASSWORD = 'the quiet mountain sings';

let organizationId: string;
let employeeRoleId: string;
let managerRoleId: string;

async function makeUser(input: {
  email: string;
  password?: string;
  status?: 'ACTIVE' | 'INVITED' | 'LOCKED' | 'DISABLED';
  employmentStatus?: 'ACTIVE' | 'SUSPENDED' | 'EXITED' | 'NOTICE_PERIOD';
  roleId?: string;
  withMfa?: boolean;
  code: string;
}) {
  const user = await db.appUser.create({
    data: {
      organizationId,
      email: input.email,
      status: input.status ?? 'ACTIVE',
      passwordHash:
        input.status === 'INVITED' ? null : await hashPassword(input.password ?? PASSWORD, PEPPER),
      passwordUpdatedAt: new Date(),
    },
    select: { id: true },
  });

  await db.employee.create({
    data: {
      organizationId,
      appUserId: user.id,
      employeeNumber: input.code,
      firstName: 'Test',
      lastName: input.code,
      workEmail: input.email,
      dateOfJoining: new Date('2022-07-11'),
      employmentStatus: input.employmentStatus ?? 'ACTIVE',
      // The schema requires an exit date on an exited employee, so the record
      // can never claim someone left without saying when.
      ...(input.employmentStatus === 'EXITED' ? { dateOfExit: new Date('2026-08-31') } : {}),
    },
  });

  await db.userRole.create({
    data: { appUserId: user.id, roleId: input.roleId ?? employeeRoleId },
  });

  if (input.withMfa) {
    await db.mfaCredential.create({
      data: {
        organizationId,
        appUserId: user.id,
        secretCt: Buffer.from('ct'),
        secretIv: Buffer.from('iv'),
        secretTag: Buffer.from('tag'),
        confirmedAt: new Date(),
      },
    });
  }

  return user.id;
}

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  const org = await db.organization.create({
    data: {
      legalName: 'Widedrop Technologies Pvt Ltd',
      displayName: 'Widedrop',
      domain: 'widedrop.test',
      helpdeskEmail: 'helpdesk@widedroptech.com',
    },
  });
  organizationId = org.id;

  const employee = await db.role.create({
    data: { persona: 'EMPLOYEE', name: 'Employee', description: 'Their own records.' },
  });
  employeeRoleId = employee.id;
  const manager = await db.role.create({
    data: { persona: 'MANAGER', name: 'Manager', description: 'Approvals for their reports.' },
  });
  managerRoleId = manager.id;
});

const login = (email: string, password: string) =>
  attemptLogin(db, { organizationId, email, password, pepper: PEPPER, ip: '203.0.113.5' }, HMAC);

describe('successful sign-in', () => {
  it('authenticates a correct password', async () => {
    const userId = await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });
    const result = await login('priya@widedrop.test', PASSWORD);
    expect(result).toMatchObject({ kind: 'authenticated', userId, personas: ['EMPLOYEE'] });
  });

  it('accepts the email in any capitalisation', async () => {
    await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });
    const result = await login('  Priya@Widedrop.Test  ', PASSWORD);
    expect(result.kind).toBe('authenticated');
  });

  it('clears the failure counter on success', async () => {
    const userId = await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });
    await login('priya@widedrop.test', 'wrong');
    await login('priya@widedrop.test', 'wrong');
    expect((await db.appUser.findUniqueOrThrow({ where: { id: userId } })).failedLoginCount).toBe(
      2,
    );

    await login('priya@widedrop.test', PASSWORD);
    expect((await db.appUser.findUniqueOrThrow({ where: { id: userId } })).failedLoginCount).toBe(
      0,
    );
  });
});

describe('no enumeration', () => {
  it('returns a distinguishable outcome internally but never to the caller', async () => {
    await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });

    const unknown = await login('nobody@widedrop.test', PASSWORD);
    const wrongPassword = await login('priya@widedrop.test', 'wrong password entirely');

    // Internally the reasons differ, so the audit trail is useful...
    expect(unknown).toMatchObject({ kind: 'rejected', reason: 'UNKNOWN_USER' });
    expect(wrongPassword).toMatchObject({ kind: 'rejected', reason: 'BAD_CREDENTIALS' });

    // ...but both are 'rejected', and the route maps both to one message.
    expect(unknown.kind).toBe(wrongPassword.kind);
  });

  it('spends comparable time on a missing account and a wrong password', async () => {
    await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });

    const time = async (fn: () => Promise<unknown>) => {
      const start = process.hrtime.bigint();
      await fn();
      return Number(process.hrtime.bigint() - start) / 1e6;
    };

    const missing = await time(() => login('nobody@widedrop.test', PASSWORD));
    const wrong = await time(() => login('priya@widedrop.test', 'wrong password entirely'));

    // Both verify against a real argon2 hash, so neither is an order of
    // magnitude faster. The ratio is loose because CI timing is noisy; what it
    // rules out is the 100x gap of skipping the hash entirely.
    const ratio = Math.max(missing, wrong) / Math.max(1, Math.min(missing, wrong));
    expect(ratio).toBeLessThan(5);
  });

  it('records an attempt against an address that matches no account', async () => {
    await login('nobody@widedrop.test', PASSWORD);
    const attempt = await db.loginAttempt.findFirstOrThrow();
    expect(attempt.outcome).toBe('UNKNOWN_USER');
    expect(attempt.emailAttempted).toBe('nobody@widedrop.test');
    expect(attempt.appUserId).toBeNull();
  });
});

describe('lockout', () => {
  it('locks the account after the threshold and refuses the correct password', async () => {
    const userId = await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });

    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await login('priya@widedrop.test', 'wrong');
    }

    const user = await db.appUser.findUniqueOrThrow({ where: { id: userId } });
    expect(user.failedLoginCount).toBe(LOCKOUT_THRESHOLD);
    expect(user.lockedUntil).not.toBeNull();
    expect(user.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // Even the right password is refused while the lock holds.
    expect(await login('priya@widedrop.test', PASSWORD)).toMatchObject({
      kind: 'rejected',
      reason: 'LOCKED',
    });
  });

  it('lengthens the lock as failures continue', () => {
    const first = lockoutDurationSeconds(LOCKOUT_THRESHOLD);
    const later = lockoutDurationSeconds(LOCKOUT_THRESHOLD + 3);
    expect(later).toBeGreaterThan(first);
    expect(lockoutDurationSeconds(LOCKOUT_THRESHOLD + 50)).toBeLessThanOrEqual(24 * 3600);
  });

  it('writes an audit entry when an account locks', async () => {
    await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });
    for (let i = 0; i < LOCKOUT_THRESHOLD; i += 1) {
      await login('priya@widedrop.test', 'wrong');
    }
    const audit = await db.auditEvent.findFirst({ where: { action: 'LOGIN' } });
    expect(audit?.summary).toContain('locked');
    expect(audit?.actorKind).toBe('SYSTEM');
  });
});

describe('account and employment state', () => {
  it('refuses an account that has not been activated', async () => {
    await makeUser({ email: 'new@widedrop.test', code: 'WDT-2', status: 'INVITED' });
    expect(await login('new@widedrop.test', PASSWORD)).toMatchObject({ reason: 'DISABLED' });
  });

  it('refuses an employee who has left, though their records remain', async () => {
    await makeUser({
      email: 'gone@widedrop.test',
      code: 'WDT-3',
      employmentStatus: 'EXITED',
    });
    expect(await login('gone@widedrop.test', PASSWORD)).toMatchObject({ reason: 'DISABLED' });
    // The employee row is still there; only access ended.
    expect(await db.employee.count({ where: { employeeNumber: 'WDT-3' } })).toBe(1);
  });

  it('refuses a suspended employee', async () => {
    await makeUser({
      email: 'suspended@widedrop.test',
      code: 'WDT-4',
      employmentStatus: 'SUSPENDED',
    });
    expect(await login('suspended@widedrop.test', PASSWORD)).toMatchObject({ reason: 'DISABLED' });
  });

  it('allows an employee serving notice', async () => {
    await makeUser({
      email: 'notice@widedrop.test',
      code: 'WDT-5',
      employmentStatus: 'NOTICE_PERIOD',
    });
    expect((await login('notice@widedrop.test', PASSWORD)).kind).toBe('authenticated');
  });
});

describe('second factor', () => {
  it('stops at the challenge when the user has enrolled', async () => {
    await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1', withMfa: true });
    const result = await login('priya@widedrop.test', PASSWORD);
    expect(result.kind).toBe('mfa-required');
  });

  it('requires an elevated role to finish enrolment before getting a session', async () => {
    await makeUser({ email: 'arjun@widedrop.test', code: 'WDT-6', roleId: managerRoleId });
    const result = await login('arjun@widedrop.test', PASSWORD);
    expect(result.kind).toBe('mfa-enrolment-required');
  });

  it('does not require enrolment of a plain employee', async () => {
    await makeUser({ email: 'priya@widedrop.test', code: 'WDT-1' });
    expect((await login('priya@widedrop.test', PASSWORD)).kind).toBe('authenticated');
  });
});

describe('roles at sign-in', () => {
  it('ignores a revoked role', async () => {
    const userId = await makeUser({ email: 'arjun@widedrop.test', code: 'WDT-6' });
    await db.userRole.create({ data: { appUserId: userId, roleId: managerRoleId } });

    let result = await login('arjun@widedrop.test', PASSWORD);
    expect(result).toMatchObject({ kind: 'mfa-enrolment-required' });

    await db.userRole.updateMany({
      where: { appUserId: userId, roleId: managerRoleId },
      data: { revokedAt: new Date(), revokeReason: 'moved teams' },
    });

    result = await login('arjun@widedrop.test', PASSWORD);
    expect(result).toMatchObject({ kind: 'authenticated', personas: ['EMPLOYEE'] });
  });

  it('ignores a grant that has expired', async () => {
    const userId = await makeUser({ email: 'cover@widedrop.test', code: 'WDT-7' });
    await db.userRole.create({
      data: {
        appUserId: userId,
        roleId: managerRoleId,
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(await login('cover@widedrop.test', PASSWORD)).toMatchObject({
      kind: 'authenticated',
      personas: ['EMPLOYEE'],
    });
  });
});
