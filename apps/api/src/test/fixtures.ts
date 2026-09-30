import { rebuildReportingClosure, type Principal } from '../services/auth/authorization.js';
import { testDb } from './db.js';

/**
 * A small organisation, built the way the application would build it.
 *
 * Shared by the self-service suites so each one tests its own behaviour rather
 * than re-establishing an employer. Everything here is created through Prisma
 * against the real database: the generated columns, exclusion constraints and
 * triggers are all in force, which is the point of testing against Postgres at
 * all.
 */

const db = testDb();

export const HMAC_KEY = Buffer.alloc(32, 41).toString('base64');
export const rupees = (amount: number): bigint => BigInt(Math.round(amount * 100));

export interface Fixture {
  organizationId: string;
  fiscalYearId: string;
  departmentId: string;
  locationId: string;
  holidayCalendarId: string;
  leavePeriodId: string;
  leaveTypes: { earned: string; sick: string; unpaid: string };
  ticketCategoryId: string;
  expenseCategoryId: string;
  /** Arjun manages Priya; Divya reports to nobody. */
  people: { arjun: string; priya: string; divya: string };
  users: { arjun: string; priya: string; ananya: string };
  principals: {
    employee: Principal;
    manager: Principal;
    hr: Principal;
    accounts: Principal;
  };
}

const SESSION = '00000000-0000-4000-8000-0000000000ff';

export async function buildFixture(): Promise<Fixture> {
  const organization = await db.organization.create({
    data: {
      legalName: 'Widedrop Technologies Pvt Ltd',
      displayName: 'Widedrop',
      domain: 'widedrop.test',
      helpdeskEmail: 'helpdesk@widedroptech.com',
      employeeNumberPrefix: 'WDT',
    },
    select: { id: true },
  });
  const organizationId = organization.id;

  const fiscalYear = await db.fiscalYear.create({
    data: {
      organizationId,
      startYear: 2026,
      label: 'FY 2026–27',
      startDate: new Date('2026-04-01'),
      endDate: new Date('2027-03-31'),
    },
    select: { id: true },
  });

  const calendar = await db.holidayCalendar.create({
    data: {
      organizationId,
      name: 'India 2026',
      year: 2026,
      // Saturday and Sunday, as ISO weekday numbers.
      weekOffDays: [6, 7],
    },
    select: { id: true },
  });

  // 15 August 2026 is a Saturday, so a holiday that lands on a week-off is
  // covered too. 2 October 2026 is a Friday — a working day removed.
  await db.holiday.createMany({
    data: [
      {
        organizationId,
        holidayCalendarId: calendar.id,
        date: new Date('2026-08-15'),
        name: 'Independence Day',
        kind: 'PUBLIC',
      },
      {
        organizationId,
        holidayCalendarId: calendar.id,
        date: new Date('2026-10-02'),
        name: 'Gandhi Jayanti',
        kind: 'PUBLIC',
      },
      {
        organizationId,
        holidayCalendarId: calendar.id,
        date: new Date('2026-10-20'),
        name: 'Deepavali (restricted)',
        kind: 'RESTRICTED',
      },
    ],
  });

  const department = await db.department.create({
    data: { organizationId, code: 'PLAT', name: 'Platform Engineering' },
    select: { id: true },
  });
  const designation = await db.designation.create({
    data: { organizationId, code: 'SSE', title: 'Senior Software Engineer', grade: 5 },
    select: { id: true },
  });
  const location = await db.location.create({
    data: {
      organizationId,
      code: 'BLR',
      name: 'Bengaluru',
      city: 'Bengaluru',
      stateCode: 'KA',
      holidayCalendarId: calendar.id,
    },
    select: { id: true },
  });

  async function makeEmployee(
    number: string,
    first: string,
    last: string,
    options: { withUser?: boolean } = {},
  ): Promise<{ employeeId: string; userId: string | null }> {
    const employee = await db.employee.create({
      data: {
        organizationId,
        employeeNumber: number,
        firstName: first,
        lastName: last,
        workEmail: `${first}.${last}@widedrop.test`.toLowerCase(),
        dateOfJoining: new Date('2024-07-11'),
        employmentStatus: 'ACTIVE',
      },
      select: { id: true },
    });

    await db.employeeEmployment.create({
      data: {
        organizationId,
        employeeId: employee.id,
        departmentId: department.id,
        designationId: designation.id,
        locationId: location.id,
        employmentType: 'FULL_TIME_PERMANENT',
        effectiveFrom: new Date('2024-07-11'),
      },
    });

    let userId: string | null = null;
    if (options.withUser !== false) {
      const user = await db.appUser.create({
        data: {
          organizationId,
          email: `${first}.${last}@widedrop.test`.toLowerCase(),
          status: 'ACTIVE',
          passwordHash: 'not-used-in-these-tests',
        },
        select: { id: true },
      });
      await db.employee.update({
        where: { id: employee.id },
        data: { appUserId: user.id },
      });
      userId = user.id;
    }

    return { employeeId: employee.id, userId };
  }

  const arjun = await makeEmployee('WDT-01001', 'Arjun', 'Malhotra');
  const priya = await makeEmployee('WDT-01847', 'Priya', 'Raghavan');
  const divya = await makeEmployee('WDT-02210', 'Divya', 'Menon');
  const ananya = await makeEmployee('WDT-01120', 'Ananya', 'Bose');

  await db.employeeManager.create({
    data: {
      organizationId,
      employeeId: priya.employeeId,
      managerEmployeeId: arjun.employeeId,
      isPrimary: true,
      effectiveFrom: new Date('2024-07-11'),
    },
  });
  await db.employeeManager.create({
    data: {
      organizationId,
      employeeId: divya.employeeId,
      managerEmployeeId: arjun.employeeId,
      isPrimary: true,
      effectiveFrom: new Date('2024-07-11'),
    },
  });
  await rebuildReportingClosure(db, organizationId);

  /* Leave configuration. */
  const leavePeriod = await db.leavePeriod.create({
    data: {
      organizationId,
      name: 'Leave year 2026',
      startDate: new Date('2026-01-01'),
      endDate: new Date('2026-12-31'),
    },
    select: { id: true },
  });

  const earned = await db.leaveType.create({
    data: {
      organizationId,
      code: 'EL',
      name: 'Earned leave',
      accrualDays: 1.5,
      isPaid: true,
      allowsHalfDay: true,
      displayOrder: 1,
    },
    select: { id: true },
  });
  const sick = await db.leaveType.create({
    data: {
      organizationId,
      code: 'SL',
      name: 'Sick leave',
      isPaid: true,
      allowsHalfDay: false,
      displayOrder: 2,
    },
    select: { id: true },
  });
  const unpaid = await db.leaveType.create({
    data: {
      organizationId,
      code: 'LOP',
      name: 'Loss of pay',
      isPaid: false,
      allowsHalfDay: true,
      displayOrder: 9,
    },
    select: { id: true },
  });

  // Balances, opened the way the leave year opening job would: a ledger row
  // and the projection it justifies.
  for (const employeeId of [arjun.employeeId, priya.employeeId, divya.employeeId]) {
    for (const [leaveTypeId, days] of [
      [earned.id, 18],
      [sick.id, 8],
    ] as const) {
      await db.leaveBalanceLedger.create({
        data: {
          organizationId,
          employeeId,
          leaveTypeId,
          leavePeriodId: leavePeriod.id,
          kind: 'OPENING',
          deltaDays: days,
          effectiveOn: new Date('2026-01-01'),
        },
      });
      await db.leaveBalance.create({
        data: {
          organizationId,
          employeeId,
          leaveTypeId,
          leavePeriodId: leavePeriod.id,
          openingDays: days,
          entitlementDays: days,
        },
      });
    }
  }

  const ticketCategory = await db.ticketCategory.create({
    data: {
      organizationId,
      code: 'PAYROLL',
      name: 'Payroll and salary',
      routingEmail: 'payroll@widedroptech.com',
      firstResponseHours: 8,
      resolutionHours: 48,
      displayOrder: 1,
    },
    select: { id: true },
  });

  const expenseCategory = await db.expenseCategory.create({
    data: {
      organizationId,
      code: 'TRAVEL',
      name: 'Travel',
      requiresReceipt: false,
      submissionWindowDays: 30,
      displayOrder: 1,
    },
    select: { id: true },
  });

  const principal = (
    userId: string,
    employeeId: string,
    personas: Principal['personas'],
  ): Principal => ({
    userId,
    organizationId,
    employeeId,
    personas,
    sessionId: SESSION,
    mfaSatisfied: true,
  });

  return {
    organizationId,
    fiscalYearId: fiscalYear.id,
    departmentId: department.id,
    locationId: location.id,
    holidayCalendarId: calendar.id,
    leavePeriodId: leavePeriod.id,
    leaveTypes: { earned: earned.id, sick: sick.id, unpaid: unpaid.id },
    ticketCategoryId: ticketCategory.id,
    expenseCategoryId: expenseCategory.id,
    people: { arjun: arjun.employeeId, priya: priya.employeeId, divya: divya.employeeId },
    users: { arjun: arjun.userId!, priya: priya.userId!, ananya: ananya.userId! },
    principals: {
      employee: principal(priya.userId!, priya.employeeId, ['EMPLOYEE']),
      manager: principal(arjun.userId!, arjun.employeeId, ['EMPLOYEE', 'MANAGER']),
      hr: principal(ananya.userId!, ananya.employeeId, ['EMPLOYEE', 'HR']),
      accounts: principal(ananya.userId!, ananya.employeeId, ['EMPLOYEE', 'ACCOUNTS']),
    },
  };
}
