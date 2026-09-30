import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWithContext } from '../../lib/request-context.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, HMAC_KEY, type Fixture } from '../../test/fixtures.js';
import { submitLeaveRequest, decideLeaveRequest } from '../leave/service.js';
import {
  decideAttendanceSlice,
  deriveAttendanceRecords,
  deriveCounts,
  openAttendancePeriod,
  submitAttendancePeriod,
} from './service.js';

const db = testDb();
let fixture: Fixture;

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  fixture = await buildFixture();
});

async function as<T>(
  principal: { userId: string; organizationId: string; employeeId?: string | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    {
      requestId: 'test',
      startedAt: Date.now(),
      userId: principal.userId,
      organizationId: principal.organizationId,
      employeeId: principal.employeeId,
      personas: ['HR'],
      ip: '127.0.0.1',
    },
    fn,
  );
}

describe('deriveCounts', () => {
  it('splits a full month into week-offs, holidays and present days', () => {
    // October 2026: 31 days, 9 weekend days, 2 October is a Friday holiday.
    const counts = deriveCounts({
      employeeId: 'e1',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      joinedOn: '2024-07-11',
      exitedOn: null,
      weekOffDays: [6, 7],
      holidays: new Set(['2026-10-02']),
      leave: { paid: 0, unpaid: 0, dates: new Set() },
    });

    expect(counts.employedDays).toBe(31);
    expect(counts.weekOffDays).toBe(9);
    expect(counts.holidayDays).toBe(1);
    expect(counts.presentDays).toBe(21);
    // The identity payroll depends on.
    expect(
      counts.presentDays +
        counts.paidLeaveDays +
        counts.unpaidLeaveDays +
        counts.holidayDays +
        counts.weekOffDays,
    ).toBe(counts.employedDays);
  });

  it('does not count a holiday that falls on a week-off twice', () => {
    // 15 August 2026 is a Saturday.
    const counts = deriveCounts({
      employeeId: 'e1',
      periodStart: '2026-08-01',
      periodEnd: '2026-08-31',
      joinedOn: '2024-07-11',
      exitedOn: null,
      weekOffDays: [6, 7],
      holidays: new Set(['2026-08-15']),
      leave: { paid: 0, unpaid: 0, dates: new Set() },
    });

    expect(counts.holidayDays).toBe(0);
    expect(counts.weekOffDays + counts.presentDays).toBe(31);
  });

  it('prorates a mid-month joiner to the days they were employed', () => {
    const counts = deriveCounts({
      employeeId: 'e1',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      joinedOn: '2026-10-19',
      exitedOn: null,
      weekOffDays: [6, 7],
      holidays: new Set(['2026-10-02']),
      leave: { paid: 0, unpaid: 0, dates: new Set() },
    });

    // 19–31 October is 13 days.
    expect(counts.employedDays).toBe(13);
    // The 2 October holiday is before they joined, so it is not theirs.
    expect(counts.holidayDays).toBe(0);
  });

  it('gives nothing for someone who left before the period began', () => {
    const counts = deriveCounts({
      employeeId: 'e1',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      joinedOn: '2024-07-11',
      exitedOn: '2026-09-30',
      weekOffDays: [6, 7],
      holidays: new Set(),
      leave: { paid: 0, unpaid: 0, dates: new Set() },
    });

    expect(counts).toMatchObject({ employedDays: 0, presentDays: 0, weekOffDays: 0 });
  });

  it('never reports negative present days when the leave data is wrong', () => {
    const counts = deriveCounts({
      employeeId: 'e1',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-05',
      joinedOn: '2024-07-11',
      exitedOn: null,
      weekOffDays: [6, 7],
      holidays: new Set(),
      leave: { paid: 40, unpaid: 0, dates: new Set(['2026-10-01']) },
    });

    expect(counts.presentDays).toBe(0);
  });
});

describe('the attendance period', () => {
  async function openAndDerive() {
    const period = await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        openAttendancePeriod(tx, fixture.principals.hr, { year: 2026, month: 10 }, HMAC_KEY),
      ),
    );
    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        deriveAttendanceRecords(tx, fixture.principals.hr, { periodId: period.id }, HMAC_KEY),
      ),
    );
    return period.id;
  }

  it('derives one record per employee, with the manager it routes to', async () => {
    const periodId = await openAndDerive();

    const records = await db.attendanceRecord.findMany({
      where: { attendancePeriodId: periodId },
      select: {
        employeeId: true,
        managerEmployeeId: true,
        status: true,
        payableDays: true,
        lopDays: true,
        employedDays: true,
      },
    });

    expect(records).toHaveLength(4);
    expect(records.every((record) => record.status === 'DRAFT')).toBe(true);

    const priya = records.find((record) => record.employeeId === fixture.people.priya);
    expect(priya?.managerEmployeeId).toBe(fixture.people.arjun);
    expect(Number(priya?.payableDays) + Number(priya?.lopDays)).toBe(priya?.employedDays);
  });

  it('turns approved unpaid leave into loss of pay', async () => {
    const leave = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.unpaid,
            startDate: '2026-10-06',
            endDate: '2026-10-06',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );
    await as(fixture.principals.manager, () =>
      db.$transaction((tx) =>
        decideLeaveRequest(
          tx,
          fixture.principals.manager,
          { requestId: leave.id, event: 'APPROVE' },
          HMAC_KEY,
        ),
      ),
    );

    const periodId = await openAndDerive();

    const record = await db.attendanceRecord.findFirstOrThrow({
      where: { attendancePeriodId: periodId, employeeId: fixture.people.priya },
      select: { unpaidLeaveDays: true, lopDays: true, payableDays: true, employedDays: true },
    });

    expect(Number(record.unpaidLeaveDays)).toBe(1);
    expect(Number(record.lopDays)).toBe(1);
    expect(Number(record.payableDays)).toBe(record.employedDays - 1);
  });

  it('will not submit a period whose records do not add up', async () => {
    const periodId = await openAndDerive();

    // Corrupt one record the way a bad manual correction would.
    const record = await db.attendanceRecord.findFirstOrThrow({
      where: { attendancePeriodId: periodId },
      select: { id: true },
    });
    await db.attendanceRecord.update({
      where: { id: record.id },
      data: { presentDays: 2 },
    });

    await expect(
      as(fixture.principals.hr, () =>
        db.$transaction((tx) =>
          submitAttendancePeriod(tx, fixture.principals.hr, { periodId }, HMAC_KEY),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('will not submit while someone has no manager to approve them', async () => {
    const periodId = await openAndDerive();

    // Arjun manages the others but reports to nobody.
    await expect(
      as(fixture.principals.hr, () =>
        db.$transaction((tx) =>
          submitAttendancePeriod(tx, fixture.principals.hr, { periodId }, HMAC_KEY),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
  });

  it('raises one approval per manager and reaches APPROVED only when the last one decides', async () => {
    // Give everyone a manager so the period can be submitted: Arjun and Ananya
    // report to Divya, who reports to Arjun.
    await db.employeeManager.createMany({
      data: [
        {
          organizationId: fixture.organizationId,
          employeeId: fixture.people.arjun,
          managerEmployeeId: fixture.people.divya,
          isPrimary: true,
          effectiveFrom: new Date('2024-07-11'),
        },
      ],
    });
    const ananya = await db.employee.findFirstOrThrow({
      where: { employeeNumber: 'WDT-01120' },
      select: { id: true },
    });
    await db.employeeManager.create({
      data: {
        organizationId: fixture.organizationId,
        employeeId: ananya.id,
        managerEmployeeId: fixture.people.divya,
        isPrimary: true,
        effectiveFrom: new Date('2024-07-11'),
      },
    });

    const periodId = await openAndDerive();

    const submitted = await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        submitAttendancePeriod(tx, fixture.principals.hr, { periodId }, HMAC_KEY),
      ),
    );

    // Arjun holds Priya and Divya; Divya holds Arjun and Ananya.
    expect(submitted.managerCount).toBe(2);
    expect(submitted.recordCount).toBe(4);

    const period = await db.attendancePeriod.findUniqueOrThrow({
      where: { id: periodId },
      select: { status: true },
    });
    expect(period.status).toBe('MANAGER_APPROVAL_PENDING');

    const first = await as(fixture.principals.manager, () =>
      db.$transaction((tx) =>
        decideAttendanceSlice(
          tx,
          fixture.principals.manager,
          { periodId, approve: true },
          HMAC_KEY,
        ),
      ),
    );
    expect(first.remaining).toBe(1);
    expect(first.periodStatus).toBe('MANAGER_APPROVAL_PENDING');

    const divyaUser = await db.employee.findUniqueOrThrow({
      where: { id: fixture.people.divya },
      select: { appUserId: true },
    });
    const divya = {
      userId: divyaUser.appUserId!,
      organizationId: fixture.organizationId,
      employeeId: fixture.people.divya,
      personas: ['EMPLOYEE', 'MANAGER'] as const,
      sessionId: '00000000-0000-4000-8000-0000000000ff',
      mfaSatisfied: true,
    };

    const second = await as(divya, () =>
      db.$transaction((tx) =>
        decideAttendanceSlice(
          tx,
          { ...divya, personas: [...divya.personas] },
          { periodId, approve: true },
          HMAC_KEY,
        ),
      ),
    );

    expect(second.remaining).toBe(0);
    expect(second.periodStatus).toBe('APPROVED');
  });

  it('refuses a decision from a manager with nobody in the period', async () => {
    const periodId = await openAndDerive();

    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          decideAttendanceSlice(
            tx,
            fixture.principals.employee,
            { periodId, approve: true },
            HMAC_KEY,
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'OUT_OF_SCOPE' });
  });
});
