import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import {
  assertEmployeeInScope,
  assertPermission,
  assertSameOrganization,
  can,
  employeeScopeFor,
  employeeWhere,
  rebuildReportingClosure,
  type Principal,
} from './authorization.js';

const db = testDb();

/**
 * A small organisation with a real reporting line:
 *
 *   Sameer (CTO)
 *     └── Arjun (Engineering Manager)
 *           └── Priya (Senior Engineer)
 *                 ├── Neha
 *                 └── Rahul
 *     └── Vikram (Head of People)
 *           └── Ananya (HR Business Partner)
 *
 * Karan (Finance) sits outside everyone's chain except Sameer's.
 */
const people = {} as Record<string, string>;
let organizationId: string;
let otherOrganizationId: string;
let otherOrgEmployeeId: string;

beforeAll(async () => {
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

  const other = await db.organization.create({
    data: {
      legalName: 'Another Company',
      displayName: 'Another',
      domain: 'another.test',
      helpdeskEmail: 'helpdesk@another.test',
    },
  });
  otherOrganizationId = other.id;

  const create = async (orgId: string, code: string, first: string, last: string) => {
    const employee = await db.employee.create({
      data: {
        organizationId: orgId,
        employeeNumber: code,
        firstName: first,
        lastName: last,
        workEmail: `${first.toLowerCase()}.${last.toLowerCase()}@${orgId === organizationId ? 'widedrop' : 'another'}.test`,
        dateOfJoining: new Date('2022-01-03'),
        employmentStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    return employee.id;
  };

  people.sameer = await create(organizationId, 'WDT-00001', 'Sameer', 'Joshi');
  people.arjun = await create(organizationId, 'WDT-00002', 'Arjun', 'Malhotra');
  people.priya = await create(organizationId, 'WDT-00003', 'Priya', 'Raghavan');
  people.neha = await create(organizationId, 'WDT-00004', 'Neha', 'Kulkarni');
  people.rahul = await create(organizationId, 'WDT-00005', 'Rahul', 'Verma');
  people.vikram = await create(organizationId, 'WDT-00006', 'Vikram', 'Shetty');
  people.ananya = await create(organizationId, 'WDT-00007', 'Ananya', 'Bose');
  people.karan = await create(organizationId, 'WDT-00008', 'Karan', 'Gill');

  otherOrgEmployeeId = await create(otherOrganizationId, 'OTH-00001', 'Someone', 'Else');

  const reportsTo = async (employeeId: string, managerEmployeeId: string) => {
    await db.employeeManager.create({
      data: {
        organizationId,
        employeeId,
        managerEmployeeId,
        isPrimary: true,
        effectiveFrom: new Date('2022-01-03'),
      },
    });
  };

  await reportsTo(people.arjun!, people.sameer!);
  await reportsTo(people.priya!, people.arjun!);
  await reportsTo(people.neha!, people.priya!);
  await reportsTo(people.rahul!, people.priya!);
  await reportsTo(people.vikram!, people.sameer!);
  await reportsTo(people.ananya!, people.vikram!);
  await reportsTo(people.karan!, people.sameer!);

  await rebuildReportingClosure(db, organizationId);
});

afterAll(async () => {
  await closeTestDb();
});

const principal = (employeeKey: string, personas: Principal['personas']): Principal => ({
  userId: `user_${employeeKey}`,
  organizationId,
  employeeId: people[employeeKey],
  personas,
  sessionId: 'session_1',
  mfaSatisfied: true,
});

describe('reporting closure', () => {
  it('resolves the whole chain, not just direct reports', async () => {
    const descendants = await db.employeeReportingClosure.findMany({
      where: { ancestorEmployeeId: people.arjun },
      select: { descendantEmployeeId: true, depth: true },
      orderBy: { depth: 'asc' },
    });
    const byDepth = new Map(descendants.map((d) => [d.descendantEmployeeId, d.depth]));

    expect(byDepth.get(people.arjun!)).toBe(0);
    expect(byDepth.get(people.priya!)).toBe(1);
    expect(byDepth.get(people.neha!)).toBe(2);
    expect(byDepth.get(people.rahul!)).toBe(2);
    // Arjun does not manage People Ops or Finance.
    expect(byDepth.has(people.ananya!)).toBe(false);
    expect(byDepth.has(people.karan!)).toBe(false);
  });

  it('puts the whole organisation under the CTO', async () => {
    const count = await db.employeeReportingClosure.count({
      where: { ancestorEmployeeId: people.sameer },
    });
    expect(count).toBe(8);
  });

  it('is rebuilt idempotently', async () => {
    const before = await db.employeeReportingClosure.count();
    await rebuildReportingClosure(db, organizationId);
    expect(await db.employeeReportingClosure.count()).toBe(before);
  });
});

describe('permission gate', () => {
  it('lets a role through for a permission it holds', () => {
    expect(() => assertPermission(principal('priya', ['EMPLOYEE']), 'leave:request')).not.toThrow();
  });

  it('refuses a permission the role does not hold', () => {
    expect(() =>
      assertPermission(principal('priya', ['EMPLOYEE']), 'payroll-cycle:publish'),
    ).toThrow(AppError);
  });

  it('refuses a held permission at too wide a scope', () => {
    const manager = principal('arjun', ['MANAGER']);
    expect(() => assertPermission(manager, 'leave:decide', 'DIRECT_REPORTS')).not.toThrow();
    expect(() => assertPermission(manager, 'leave:decide', 'ORG')).toThrow(AppError);
  });

  it('gives the same uniform message whatever was denied', () => {
    try {
      assertPermission(principal('priya', ['EMPLOYEE']), 'payroll-cycle:generate');
      expect.unreachable();
    } catch (error) {
      expect((error as AppError).message).toBe('You do not have access to this.');
      expect((error as AppError).statusCode).toBe(403);
    }
  });
});

describe('employee scope', () => {
  it('confines an employee to themselves', async () => {
    const scope = await employeeScopeFor(db, principal('priya', ['EMPLOYEE']), 'leave:read');
    expect(scope).toEqual({ kind: 'self', employeeId: people.priya });
  });

  it('gives a manager their reporting chain for reads', async () => {
    const scope = await employeeScopeFor(db, principal('arjun', ['MANAGER']), 'leave:read');
    expect(scope).toMatchObject({ kind: 'chain', ancestorEmployeeId: people.arjun, includeSelf: true });
  });

  it('confines a manager to direct reports for decisions', async () => {
    const scope = await employeeScopeFor(db, principal('arjun', ['MANAGER']), 'leave:decide');
    expect(scope).toMatchObject({ kind: 'chain', maxDepth: 1, includeSelf: false });
  });

  it('gives HR the organisation', async () => {
    const scope = await employeeScopeFor(db, principal('ananya', ['HR']), 'leave:read');
    expect(scope).toEqual({ kind: 'organization', organizationId });
  });

  it('gives nothing for a permission the role does not hold', async () => {
    const scope = await employeeScopeFor(db, principal('priya', ['EMPLOYEE']), 'payslip:read-any');
    expect(scope).toEqual({ kind: 'none' });
  });

  it('turns an empty scope into a filter that matches nothing, not an error', () => {
    expect(employeeWhere({ kind: 'none' })).toEqual({ employeeId: { in: [] } });
  });
});

describe('scope enforcement on a named employee', () => {
  it('lets an employee reach their own record', async () => {
    await expect(
      assertEmployeeInScope(db, principal('priya', ['EMPLOYEE']), 'leave:read', people.priya!),
    ).resolves.toBeUndefined();
  });

  it('stops an employee reaching a colleague', async () => {
    await expect(
      assertEmployeeInScope(db, principal('priya', ['EMPLOYEE']), 'leave:read', people.neha!),
    ).rejects.toThrow(AppError);
  });

  it('lets a manager reach anyone in their chain', async () => {
    const arjun = principal('arjun', ['MANAGER']);
    for (const key of ['priya', 'neha', 'rahul']) {
      await expect(
        assertEmployeeInScope(db, arjun, 'leave:read', people[key]!),
      ).resolves.toBeUndefined();
    }
  });

  it('stops a manager reaching outside their chain', async () => {
    const arjun = principal('arjun', ['MANAGER']);
    for (const key of ['ananya', 'karan', 'vikram', 'sameer']) {
      await expect(
        assertEmployeeInScope(db, arjun, 'leave:read', people[key]!),
        key,
      ).rejects.toThrow(AppError);
    }
  });

  it('stops a manager deciding for a skip-level report', async () => {
    const priya = principal('priya', ['MANAGER']);
    // Neha reports directly to Priya: allowed.
    await expect(
      assertEmployeeInScope(db, priya, 'leave:decide', people.neha!),
    ).resolves.toBeUndefined();

    // Arjun manages Priya, so Neha is two levels below him: read yes, decide no.
    const arjun = principal('arjun', ['MANAGER']);
    await expect(
      assertEmployeeInScope(db, arjun, 'leave:read', people.neha!),
    ).resolves.toBeUndefined();
    await expect(
      assertEmployeeInScope(db, arjun, 'leave:decide', people.neha!),
    ).rejects.toThrow(AppError);
  });

  it('lets HR reach anyone in the organisation', async () => {
    const hr = principal('ananya', ['HR']);
    for (const key of Object.keys(people)) {
      await expect(assertEmployeeInScope(db, hr, 'employee:read', people[key]!), key)
        .resolves.toBeUndefined();
    }
  });

  it('stops HR reaching into another organisation', async () => {
    await expect(
      assertEmployeeInScope(db, principal('ananya', ['HR']), 'employee:read', otherOrgEmployeeId),
    ).rejects.toThrow(AppError);
  });

  it('stops Accounts reading profiles across the organisation', async () => {
    // Accounts needs bank and statutory data for payroll, which reaches them
    // through the payroll surfaces — not through everyone's profile.
    const accounts = principal('karan', ['ACCOUNTS']);
    expect(can(accounts, 'profile:read', 'ORG')).toBe(false);
    await expect(
      assertEmployeeInScope(db, accounts, 'profile:read', people.priya!),
    ).rejects.toThrow(AppError);
  });

  it('never lets anyone read another employee’s payslip', async () => {
    for (const personas of [['EMPLOYEE'], ['MANAGER'], ['HR']] as const) {
      const p = principal('arjun', [...personas]);
      await expect(
        assertEmployeeInScope(db, p, 'payslip:read', people.neha!),
        personas.join(),
      ).rejects.toThrow(AppError);
    }
  });
});

describe('cross-tenant access', () => {
  it('reports a record from another organisation as not found', () => {
    expect(() =>
      assertSameOrganization(principal('priya', ['EMPLOYEE']), {
        organizationId: otherOrganizationId,
      }),
    ).toThrow(/could not be found/);
  });

  it('reports a missing record the same way, revealing nothing', () => {
    let missingMessage = '';
    let foreignMessage = '';
    try {
      assertSameOrganization(principal('priya', ['EMPLOYEE']), null);
    } catch (error) {
      missingMessage = (error as AppError).message;
    }
    try {
      assertSameOrganization(principal('priya', ['EMPLOYEE']), {
        organizationId: otherOrganizationId,
      });
    } catch (error) {
      foreignMessage = (error as AppError).message;
    }
    expect(missingMessage).toBe(foreignMessage);
  });

  it('allows a record from the principal’s own organisation', () => {
    expect(() =>
      assertSameOrganization(principal('priya', ['EMPLOYEE']), { organizationId }),
    ).not.toThrow();
  });
});

describe('a user holding several roles', () => {
  it('takes the widest scope per permission, independently', async () => {
    const both = principal('ananya', ['MANAGER', 'HR']);
    // HR widens the read to the whole organisation...
    expect(await employeeScopeFor(db, both, 'leave:read')).toEqual({
      kind: 'organization',
      organizationId,
    });
    // ...but the decision stays with the manager's direct reports.
    expect(await employeeScopeFor(db, both, 'leave:decide')).toMatchObject({
      kind: 'chain',
      maxDepth: 1,
    });
  });

  it('does not let two roles combine into a permission neither holds', () => {
    const both = principal('karan', ['HR', 'ACCOUNTS']);
    expect(can(both, 'payslip:read-any', 'ORG')).toBe(true); // Accounts holds it.
    expect(can(both, 'attendance:approve')).toBe(false); // Neither does.
  });
});
