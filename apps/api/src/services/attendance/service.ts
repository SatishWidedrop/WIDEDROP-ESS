import {
  attendancePeriodMachine,
  daysInMonth,
  eachDay,
  formatMonth,
  toIsoDate,
  type AttendancePeriodEvent,
  type AttendancePeriodState,
  type IsoDate,
} from '@widedrop/shared';
import { Prisma } from '../../generated/prisma/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import { notify, notifyEmployee } from '../notifications.js';

/**
 * Attendance.
 *
 * The middle of the payroll pipeline, and the step that turns leave into
 * money. Three properties matter:
 *
 *  1. **Derived, then confirmed.** Day counts are computed from the holiday
 *     calendar, the employee's joining and exit dates and their approved
 *     leave. HR may correct a record; HR does not type one from nothing, and
 *     nothing here invents a day.
 *
 *  2. **Every manager approves their own slice.** One `attendance_approval`
 *     row per manager per period. The period reaches APPROVED only when no
 *     PENDING row remains, so "who still owes an approval" is a query.
 *
 *  3. **The arithmetic is checked.** payable + loss of pay must equal the days
 *     the person was employed. A record that does not balance is refused
 *     before it can reach payroll.
 */

export interface DerivedCounts {
  employeeId: string;
  employedDays: number;
  presentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  holidayDays: number;
  weekOffDays: number;
}

/* ------------------------------------------------------------------ */
/* Period lifecycle                                                    */
/* ------------------------------------------------------------------ */

export async function openAttendancePeriod(
  tx: Tx,
  principal: Principal,
  input: { year: number; month: number },
  hmacKey: string,
): Promise<{ id: string; created: boolean }> {
  const existing = await tx.attendancePeriod.findUnique({
    where: {
      organizationId_year_month: {
        organizationId: principal.organizationId,
        year: input.year,
        month: input.month,
      },
    },
    select: { id: true },
  });
  if (existing) return { id: existing.id, created: false };

  const total = daysInMonth(input.year, input.month);

  const period = await tx.attendancePeriod.create({
    data: {
      organizationId: principal.organizationId,
      year: input.year,
      month: input.month,
      startDate: new Date(Date.UTC(input.year, input.month - 1, 1)),
      endDate: new Date(Date.UTC(input.year, input.month - 1, total)),
      totalDays: total,
      status: 'OPEN',
    },
    select: { id: true },
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'CREATE',
      entityType: 'attendance_period',
      entityId: period.id,
      toState: 'OPEN',
      summary: `Opened attendance for ${formatMonth(input.year, input.month)}`,
    },
    hmacKey,
  );

  return { id: period.id, created: true };
}

/**
 * Build or refresh the draft records for a period.
 *
 * Idempotent, and it never overwrites a record HR has already corrected by
 * hand: a record whose source is `HR_MANUAL` keeps its numbers. Anything the
 * system derived is recomputed, because leave approved since the last run has
 * to land somewhere.
 */
export async function deriveAttendanceRecords(
  tx: Tx,
  principal: Principal,
  input: { periodId: string },
  hmacKey: string,
): Promise<{ created: number; updated: number; skipped: number }> {
  const period = await readPeriod(tx, principal.organizationId, input.periodId);

  if (!['OPEN', 'REOPENED'].includes(period.status)) {
    throw conflict('Attendance for this period has already been submitted.');
  }

  const start = toIsoDate(period.startDate);
  const end = toIsoDate(period.endDate);

  const employees = await tx.employee.findMany({
    where: {
      organizationId: principal.organizationId,
      employmentStatus: { in: ['ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD', 'EXITED'] },
      dateOfJoining: { lte: period.endDate },
      OR: [{ dateOfExit: null }, { dateOfExit: { gte: period.startDate } }],
    },
    select: {
      id: true,
      dateOfJoining: true,
      dateOfExit: true,
      employments: {
        where: { effectiveTo: null },
        select: { location: { select: { holidayCalendarId: true } } },
        take: 1,
      },
    },
  });

  // Calendars are shared by many employees, so they are read once rather than
  // once per person.
  const calendarIds = [
    ...new Set(
      employees
        .map((employee) => employee.employments[0]?.location.holidayCalendarId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  ];

  const calendars = new Map<string, { weekOffDays: number[]; holidays: Set<IsoDate> }>();
  for (const calendarId of calendarIds) {
    const [calendar, holidays] = await Promise.all([
      tx.holidayCalendar.findUnique({
        where: { id: calendarId },
        select: { weekOffDays: true },
      }),
      tx.holiday.findMany({
        where: {
          holidayCalendarId: calendarId,
          date: { gte: period.startDate, lte: period.endDate },
          kind: { in: ['PUBLIC', 'WEEKEND_COMPENSATORY'] },
        },
        select: { date: true },
      }),
    ]);
    calendars.set(calendarId, {
      weekOffDays: calendar?.weekOffDays ?? [6, 7],
      holidays: new Set(holidays.map((holiday) => toIsoDate(holiday.date))),
    });
  }

  // Approved leave in the window, by employee and by whether it is paid.
  const leaveDays = await tx.leaveRequestDay.findMany({
    where: {
      organizationId: principal.organizationId,
      date: { gte: period.startDate, lte: period.endDate },
      request: { status: 'APPROVED' },
    },
    select: {
      date: true,
      dayFraction: true,
      request: { select: { employeeId: true, leaveType: { select: { isPaid: true } } } },
    },
  });

  const leaveByEmployee = new Map<string, { paid: number; unpaid: number; dates: Set<IsoDate> }>();
  for (const day of leaveDays) {
    const entry = leaveByEmployee.get(day.request.employeeId) ?? {
      paid: 0,
      unpaid: 0,
      dates: new Set<IsoDate>(),
    };
    const fraction = Number(day.dayFraction);
    if (day.request.leaveType.isPaid) entry.paid += fraction;
    else entry.unpaid += fraction;
    entry.dates.add(toIsoDate(day.date));
    leaveByEmployee.set(day.request.employeeId, entry);
  }

  const existing = await tx.attendanceRecord.findMany({
    where: { attendancePeriodId: period.id },
    select: { id: true, employeeId: true, source: true },
  });
  const existingByEmployee = new Map(existing.map((record) => [record.employeeId, record]));

  let created = 0;
  let updated = 0;
  let skipped = 0;

  for (const employee of employees) {
    const record = existingByEmployee.get(employee.id);

    // A number a person entered is not overwritten by a number a job derived.
    if (record && record.source === 'HR_MANUAL') {
      skipped += 1;
      continue;
    }

    const calendarId = employee.employments[0]?.location.holidayCalendarId;
    const calendar = calendarId ? calendars.get(calendarId) : undefined;

    const counts = deriveCounts({
      employeeId: employee.id,
      periodStart: start,
      periodEnd: end,
      joinedOn: toIsoDate(employee.dateOfJoining),
      exitedOn: employee.dateOfExit ? toIsoDate(employee.dateOfExit) : null,
      weekOffDays: calendar?.weekOffDays ?? [6, 7],
      holidays: calendar?.holidays ?? new Set(),
      leave: leaveByEmployee.get(employee.id) ?? { paid: 0, unpaid: 0, dates: new Set() },
    });

    const managerEmployeeId = await currentManagerId(
      tx,
      principal.organizationId,
      employee.id,
      end,
    );

    const data = {
      managerEmployeeId,
      source: 'SYSTEM_DERIVED' as const,
      presentDays: new Prisma.Decimal(counts.presentDays),
      paidLeaveDays: new Prisma.Decimal(counts.paidLeaveDays),
      unpaidLeaveDays: new Prisma.Decimal(counts.unpaidLeaveDays),
      holidayDays: new Prisma.Decimal(counts.holidayDays),
      weekOffDays: new Prisma.Decimal(counts.weekOffDays),
      absentDays: new Prisma.Decimal(0),
      employedDays: counts.employedDays,
    };

    if (record) {
      await tx.attendanceRecord.update({
        where: { id: record.id },
        data: { ...data, rowVersion: { increment: 1 } },
      });
      updated += 1;
    } else {
      await tx.attendanceRecord.create({
        data: {
          organizationId: principal.organizationId,
          attendancePeriodId: period.id,
          employeeId: employee.id,
          status: 'DRAFT',
          ...data,
        },
      });
      created += 1;
    }
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'UPDATE',
      entityType: 'attendance_period',
      entityId: period.id,
      after: { created, updated, skipped },
      summary: `Derived attendance for ${formatMonth(period.year, period.month)}: ${created} created, ${updated} refreshed`,
    },
    hmacKey,
  );

  return { created, updated, skipped };
}

/** The arithmetic behind one record. Pure, so it is testable on its own. */
export function deriveCounts(input: {
  employeeId: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  joinedOn: IsoDate;
  exitedOn: IsoDate | null;
  weekOffDays: readonly number[];
  holidays: ReadonlySet<IsoDate>;
  leave: { paid: number; unpaid: number; dates: ReadonlySet<IsoDate> };
}): DerivedCounts {
  const from = input.joinedOn > input.periodStart ? input.joinedOn : input.periodStart;
  const to = input.exitedOn && input.exitedOn < input.periodEnd ? input.exitedOn : input.periodEnd;

  // Someone who left before the period began, or joins after it ends, was
  // employed for none of it. `eachDay` would otherwise count backwards.
  if (to < from) {
    return {
      employeeId: input.employeeId,
      employedDays: 0,
      presentDays: 0,
      paidLeaveDays: 0,
      unpaidLeaveDays: 0,
      holidayDays: 0,
      weekOffDays: 0,
    };
  }

  const weekOff = new Set(input.weekOffDays);
  const days = eachDay(from, to);

  let weekOffDays = 0;
  let holidayDays = 0;

  for (const date of days) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const iso = weekday === 0 ? 7 : weekday;
    if (weekOff.has(iso)) {
      weekOffDays += 1;
      continue;
    }
    // A holiday on a week-off is already counted as a week-off; counting it
    // twice would push the total past the days in the month.
    if (input.holidays.has(date)) holidayDays += 1;
  }

  // Only leave falling inside the employed window counts here.
  const leaveInWindow = [...input.leave.dates].filter((date) => date >= from && date <= to);
  const paidRatio =
    input.leave.dates.size === 0 ? 0 : leaveInWindow.length / input.leave.dates.size;
  const paidLeaveDays = round2(input.leave.paid * paidRatio);
  const unpaidLeaveDays = round2(input.leave.unpaid * paidRatio);

  const employedDays = days.length;
  const presentDays = round2(
    employedDays - weekOffDays - holidayDays - paidLeaveDays - unpaidLeaveDays,
  );

  return {
    employeeId: input.employeeId,
    employedDays,
    // Never negative: more leave than working days means the leave data is
    // wrong, and a negative present count would silently corrupt payroll.
    presentDays: Math.max(presentDays, 0),
    paidLeaveDays,
    unpaidLeaveDays,
    holidayDays,
    weekOffDays,
  };
}

/* ------------------------------------------------------------------ */
/* HR submission                                                       */
/* ------------------------------------------------------------------ */

export async function submitAttendancePeriod(
  tx: Tx,
  principal: Principal,
  input: { periodId: string; note?: string | null },
  hmacKey: string,
): Promise<{ managerCount: number; recordCount: number }> {
  const period = await lockPeriod(tx, principal.organizationId, input.periodId);
  // Two transitions applied together: SUBMIT is HR's act, ROUTE_TO_MANAGERS is
  // what the system does with it. HR_SUBMITTED is a moment, not a queue.
  assertPeriodTransition(period.status, 'SUBMIT');
  assertPeriodTransition('HR_SUBMITTED', 'ROUTE_TO_MANAGERS');

  const records = await tx.attendanceRecord.findMany({
    where: { attendancePeriodId: period.id },
    select: {
      id: true,
      employeeId: true,
      managerEmployeeId: true,
      employedDays: true,
      payableDays: true,
      lopDays: true,
      employee: { select: { fullName: true } },
    },
  });

  if (records.length === 0) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'There are no attendance records to submit. Derive them first.',
    );
  }

  // The balance check. Payroll prorates on payable days, so a record whose
  // parts do not add up to the days employed would quietly pay the wrong
  // amount. Refusing here is cheaper than finding it in a payslip.
  const unbalanced = records.filter(
    (record) =>
      Math.abs(Number(record.payableDays) + Number(record.lopDays) - record.employedDays) > 0.001,
  );
  if (unbalanced.length > 0) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      `${unbalanced.length} ${unbalanced.length === 1 ? 'record does' : 'records do'} not add up to the days employed — starting with ${unbalanced[0]?.employee.fullName}. Correct them before submitting.`,
      {
        details: unbalanced.slice(0, 10).map((record) => ({
          path: record.employeeId,
          message: `${record.employee.fullName}: ${Number(record.payableDays)} payable + ${Number(record.lopDays)} loss of pay ≠ ${record.employedDays} employed`,
        })),
      },
    );
  }

  const withoutManager = records.filter((record) => record.managerEmployeeId === null);
  if (withoutManager.length > 0) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      `${withoutManager.length} ${withoutManager.length === 1 ? 'person has' : 'people have'} no manager, so their attendance has nobody to approve it — starting with ${withoutManager[0]?.employee.fullName}.`,
    );
  }

  const submittedAt = new Date();

  await tx.attendanceRecord.updateMany({
    where: { attendancePeriodId: period.id },
    data: { status: 'SUBMITTED' },
  });

  // One approval row per manager, sized by their slice.
  const byManager = new Map<string, number>();
  for (const record of records) {
    if (!record.managerEmployeeId) continue;
    byManager.set(record.managerEmployeeId, (byManager.get(record.managerEmployeeId) ?? 0) + 1);
  }

  for (const [managerEmployeeId, recordCount] of byManager) {
    await tx.attendanceApproval.upsert({
      where: {
        attendancePeriodId_managerEmployeeId: {
          attendancePeriodId: period.id,
          managerEmployeeId,
        },
      },
      update: {
        status: 'PENDING',
        recordCount,
        decidedAt: null,
        decidedByUserId: null,
        returnReason: null,
        rowVersion: { increment: 1 },
      },
      create: {
        organizationId: principal.organizationId,
        attendancePeriodId: period.id,
        managerEmployeeId,
        status: 'PENDING',
        recordCount,
      },
    });

    await notifyEmployee(tx, {
      organizationId: principal.organizationId,
      employeeId: managerEmployeeId,
      kind: 'ATTENDANCE_APPROVAL_PENDING',
      tone: 'AMBER',
      title: `Attendance for ${formatMonth(period.year, period.month)} needs your approval`,
      body: `${recordCount} ${recordCount === 1 ? 'person' : 'people'} in your team`,
      targetModule: 'team-attendance',
      targetId: period.id,
      sourceType: 'attendance_submission',
      sourceId: period.id,
    });
  }

  const attempt = await tx.attendanceSubmission.count({
    where: { attendancePeriodId: period.id },
  });

  await tx.attendanceSubmission.create({
    data: {
      organizationId: principal.organizationId,
      attendancePeriodId: period.id,
      submittedByUserId: principal.userId,
      recordCount: records.length,
      attempt: attempt + 1,
      note: input.note ?? null,
    },
  });

  await tx.attendancePeriod.update({
    where: { id: period.id },
    data: {
      status: 'MANAGER_APPROVAL_PENDING',
      submittedAt,
      submittedByUserId: principal.userId,
      rowVersion: { increment: 1 },
    },
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'attendance_period',
      entityId: period.id,
      fromState: period.status,
      toState: 'MANAGER_APPROVAL_PENDING',
      after: { recordCount: records.length, managerCount: byManager.size },
      summary: `Submitted ${formatMonth(period.year, period.month)} attendance for ${byManager.size} ${byManager.size === 1 ? 'manager' : 'managers'} to approve`,
    },
    hmacKey,
  );

  return { managerCount: byManager.size, recordCount: records.length };
}

/* ------------------------------------------------------------------ */
/* Manager approval                                                    */
/* ------------------------------------------------------------------ */

export async function decideAttendanceSlice(
  tx: Tx,
  principal: Principal,
  input: { periodId: string; approve: boolean; returnReason?: string | null },
  hmacKey: string,
): Promise<{ periodStatus: AttendancePeriodState; remaining: number }> {
  const period = await lockPeriod(tx, principal.organizationId, input.periodId);

  const approval = await tx.attendanceApproval.findUnique({
    where: {
      attendancePeriodId_managerEmployeeId: {
        attendancePeriodId: period.id,
        managerEmployeeId: principal.employeeId ?? '',
      },
    },
    select: { id: true, status: true, recordCount: true },
  });

  if (!approval) {
    throw new AppError(
      403,
      ERROR_CODES.OUT_OF_SCOPE,
      'No part of this attendance period is yours to approve.',
    );
  }
  if (approval.status !== 'PENDING') {
    throw conflict('You have already decided on this period.');
  }

  if (!input.approve && !input.returnReason?.trim()) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'Say what needs correcting so People Ops can fix it.',
    );
  }

  const decidedAt = new Date();

  await tx.attendanceApproval.update({
    where: { id: approval.id },
    data: {
      status: input.approve ? 'APPROVED' : 'REJECTED',
      decidedAt,
      decidedByUserId: principal.userId,
      returnReason: input.approve ? null : (input.returnReason ?? null),
      rowVersion: { increment: 1 },
    },
  });

  await tx.attendanceRecord.updateMany({
    where: {
      attendancePeriodId: period.id,
      managerEmployeeId: principal.employeeId ?? '',
    },
    data: { status: input.approve ? 'APPROVED' : 'REJECTED' },
  });

  let periodStatus: AttendancePeriodState = period.status;

  if (!input.approve) {
    // One return sends the whole period back: payroll consumes the period, not
    // a manager's slice of it, so a partly-approved period is not a state
    // anything downstream could use.
    await tx.attendancePeriod.update({
      where: { id: period.id },
      data: { status: 'REOPENED', rowVersion: { increment: 1 } },
    });
    periodStatus = 'REOPENED';

    if (period.submittedByUserId) {
      const submitter = await tx.appUser.findUnique({
        where: { id: period.submittedByUserId },
        select: { id: true },
      });
      if (submitter) {
        await notify(tx, {
          organizationId: principal.organizationId,
          appUserId: submitter.id,
          kind: 'ATTENDANCE_APPROVAL_PENDING',
          tone: 'RED',
          title: `Attendance for ${formatMonth(period.year, period.month)} was returned`,
          body: input.returnReason ?? null,
          targetModule: 'hr-attendance',
          targetId: period.id,
          sourceType: 'attendance_return',
          sourceId: approval.id,
        });
      }
    }
  }

  const remaining = await tx.attendanceApproval.count({
    where: { attendancePeriodId: period.id, status: 'PENDING' },
  });

  if (input.approve && remaining === 0) {
    assertPeriodTransition(period.status, 'APPROVE_ALL');
    await tx.attendancePeriod.update({
      where: { id: period.id },
      data: { status: 'APPROVED', approvedAt: decidedAt, rowVersion: { increment: 1 } },
    });
    periodStatus = 'APPROVED';
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'attendance_approval',
      entityId: approval.id,
      fromState: 'PENDING',
      toState: input.approve ? 'APPROVED' : 'REJECTED',
      after: {
        periodId: period.id,
        recordCount: approval.recordCount,
        remainingApprovers: remaining,
        returnReason: input.approve ? null : (input.returnReason ?? null),
      },
      summary: `${input.approve ? 'Approved' : 'Returned'} ${approval.recordCount} attendance ${approval.recordCount === 1 ? 'record' : 'records'} for ${formatMonth(period.year, period.month)}`,
    },
    hmacKey,
  );

  return { periodStatus, remaining };
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

type PeriodRow = {
  id: string;
  year: number;
  month: number;
  startDate: Date;
  endDate: Date;
  totalDays: number;
  status: AttendancePeriodState;
  submittedByUserId: string | null;
};

async function readPeriod(tx: Tx, organizationId: string, periodId: string): Promise<PeriodRow> {
  const period = await tx.attendancePeriod.findFirst({
    where: { id: periodId, organizationId },
    select: {
      id: true,
      year: true,
      month: true,
      startDate: true,
      endDate: true,
      totalDays: true,
      status: true,
      submittedByUserId: true,
    },
  });
  if (!period) throw notFound('That attendance period');
  return period as PeriodRow;
}

async function lockPeriod(tx: Tx, organizationId: string, periodId: string): Promise<PeriodRow> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ess.attendance_period
    WHERE id = ${periodId}::uuid AND organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  if (locked.length === 0) throw notFound('That attendance period');
  return readPeriod(tx, organizationId, periodId);
}

function assertPeriodTransition(from: AttendancePeriodState, event: AttendancePeriodEvent): void {
  if (!attendancePeriodMachine.can(from, event)) {
    throw conflict(
      `Attendance that is ${from.toLowerCase().replace(/_/g, ' ')} cannot take that action.`,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { from, event },
    );
  }
}

/** The manager an attendance record routes to, as at the end of the period. */
async function currentManagerId(
  tx: Tx,
  organizationId: string,
  employeeId: string,
  on: IsoDate,
): Promise<string | null> {
  const relationship = await tx.employeeManager.findFirst({
    where: {
      organizationId,
      employeeId,
      isPrimary: true,
      effectiveFrom: { lte: new Date(on) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(on) } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { managerEmployeeId: true },
  });

  if (relationship && relationship.managerEmployeeId !== employeeId) {
    return relationship.managerEmployeeId;
  }
  return null;
}

/** Two decimal places, the precision the column stores. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
