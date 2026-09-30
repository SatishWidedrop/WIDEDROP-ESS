import {
  attendanceDecision,
  attendanceRecordCorrection,
  formatMonth,
  toIsoDate,
} from '@widedrop/shared';
import { Prisma } from '../../generated/prisma/index.js';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import {
  assertPermission,
  can,
  employeeScopeFor,
  employeeWhere,
} from '../../services/auth/authorization.js';
import {
  decideAttendanceSlice,
  deriveAttendanceRecords,
  openAttendancePeriod,
  submitAttendancePeriod,
} from '../../services/attendance/service.js';

/**
 * Attendance, across the three surfaces that touch it.
 *
 *   - an employee sees their own months
 *   - a manager sees and approves their slice of a submitted period
 *   - HR opens a period, derives and corrects records, and submits it
 *
 * The same rows underlie all three. A manager's list is the employee list
 * with a wider scope filter, not a separate query that could drift.
 */
export async function attendanceRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /attendance — my months, or my team's, or the organisation's  */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/attendance', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'attendance:read', 'SELF');

    const { periodId } = request.query as { periodId?: string };
    const scope = await employeeScopeFor(db, principal, 'attendance:read');

    const periods = await db.attendancePeriod.findMany({
      where: { organizationId: principal.organizationId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 24,
      select: {
        id: true,
        year: true,
        month: true,
        startDate: true,
        endDate: true,
        totalDays: true,
        status: true,
        submittedAt: true,
        approvedAt: true,
      },
    });

    const selected = periodId ?? periods[0]?.id;
    if (!selected) return { periods: [], period: null, records: [], myApproval: null };

    const records = await db.attendanceRecord.findMany({
      where: {
        organizationId: principal.organizationId,
        attendancePeriodId: selected,
        ...employeeWhere(scope),
      },
      orderBy: { employee: { fullName: 'asc' } },
      select: {
        id: true,
        status: true,
        source: true,
        presentDays: true,
        paidLeaveDays: true,
        unpaidLeaveDays: true,
        holidayDays: true,
        weekOffDays: true,
        absentDays: true,
        payableDays: true,
        lopDays: true,
        employedDays: true,
        note: true,
        managerEmployeeId: true,
        employee: { select: { id: true, fullName: true, initials: true, employeeNumber: true } },
      },
    });

    // The manager's own slice of this period, when they have one.
    const myApproval = principal.employeeId
      ? await db.attendanceApproval.findUnique({
          where: {
            attendancePeriodId_managerEmployeeId: {
              attendancePeriodId: selected,
              managerEmployeeId: principal.employeeId,
            },
          },
          select: {
            id: true,
            status: true,
            recordCount: true,
            decidedAt: true,
            returnReason: true,
          },
        })
      : null;

    const period = periods.find((row) => row.id === selected) ?? null;

    return {
      periods: periods.map((row) => ({
        id: row.id,
        label: formatMonth(row.year, row.month),
        year: row.year,
        month: row.month,
        status: row.status,
      })),

      period: period
        ? {
            id: period.id,
            label: formatMonth(period.year, period.month),
            startDate: toIsoDate(period.startDate),
            endDate: toIsoDate(period.endDate),
            totalDays: period.totalDays,
            status: period.status,
            submittedAt: period.submittedAt?.toISOString() ?? null,
            approvedAt: period.approvedAt?.toISOString() ?? null,
          }
        : null,

      records: records.map((record) => ({
        id: record.id,
        status: record.status,
        source: record.source,
        employee: record.employee,
        managerEmployeeId: record.managerEmployeeId,
        presentDays: Number(record.presentDays),
        paidLeaveDays: Number(record.paidLeaveDays),
        unpaidLeaveDays: Number(record.unpaidLeaveDays),
        holidayDays: Number(record.holidayDays),
        weekOffDays: Number(record.weekOffDays),
        absentDays: Number(record.absentDays),
        payableDays: Number(record.payableDays),
        lopDays: Number(record.lopDays),
        employedDays: record.employedDays,
        note: record.note,
      })),

      myApproval,
      canCorrect: can(principal, 'attendance:record', 'ORG'),
      canSubmit: can(principal, 'attendance:submit', 'ORG'),
    };
  });

  /* ---------------------------------------------------------------- */
  /* HR: open a period                                                 */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/hr/attendance/periods',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'attendance:record', 'ORG');

      const { year, month } = request.body as { year?: number; month?: number };
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        (month as number) < 1 ||
        (month as number) > 12
      ) {
        throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'Give a year and a month.');
      }

      const result = await db.$transaction((tx) =>
        openAttendancePeriod(
          tx,
          principal,
          { year: year as number, month: month as number },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  /* ---------------------------------------------------------------- */
  /* HR: derive the records for a period                               */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/hr/attendance/periods/:id/derive',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'attendance:record', 'ORG');

      return db.$transaction(
        (tx) =>
          deriveAttendanceRecords(
            tx,
            principal,
            { periodId: request.params.id },
            env.AUDIT_HMAC_KEY,
          ),
        // Deriving touches every employee, so it gets longer than the default.
        { timeout: 60_000 },
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* HR: correct one record                                            */
  /* ---------------------------------------------------------------- */

  app.patch<{ Params: { id: string } }>(
    '/api/v1/hr/attendance/records/:id',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'attendance:record', 'ORG');

      const body = attendanceRecordCorrection.parse(request.body);

      const record = await db.attendanceRecord.findFirst({
        where: { id: request.params.id, organizationId: principal.organizationId },
        select: {
          id: true,
          employedDays: true,
          presentDays: true,
          paidLeaveDays: true,
          unpaidLeaveDays: true,
          holidayDays: true,
          weekOffDays: true,
          absentDays: true,
          period: { select: { status: true, year: true, month: true } },
          employee: { select: { fullName: true } },
        },
      });
      if (!record) throw notFound('That attendance record');

      if (!['OPEN', 'REOPENED'].includes(record.period.status)) {
        throw conflict(
          'This period has been submitted. Ask the managers to return it before correcting records.',
        );
      }

      // The same balance rule the submission enforces, applied at the point of
      // editing so the error names the record rather than the period.
      const total =
        body.presentDays +
        body.paidLeaveDays +
        body.unpaidLeaveDays +
        body.holidayDays +
        body.weekOffDays +
        body.absentDays;

      if (Math.abs(total - record.employedDays) > 0.001) {
        throw new AppError(
          422,
          ERROR_CODES.BUSINESS_RULE_VIOLATION,
          `Those days add up to ${total}, but ${record.employee.fullName} was employed for ${record.employedDays} days this period.`,
        );
      }

      await db.$transaction(async (tx) => {
        await tx.attendanceRecord.update({
          where: { id: record.id },
          data: {
            // Marked as HR's number, which stops the derivation job
            // overwriting it on the next run.
            source: 'HR_MANUAL',
            presentDays: new Prisma.Decimal(body.presentDays),
            paidLeaveDays: new Prisma.Decimal(body.paidLeaveDays),
            unpaidLeaveDays: new Prisma.Decimal(body.unpaidLeaveDays),
            holidayDays: new Prisma.Decimal(body.holidayDays),
            weekOffDays: new Prisma.Decimal(body.weekOffDays),
            absentDays: new Prisma.Decimal(body.absentDays),
            note: body.note ?? null,
            rowVersion: { increment: 1 },
          },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'UPDATE',
            entityType: 'attendance_record',
            entityId: record.id,
            before: {
              presentDays: Number(record.presentDays),
              paidLeaveDays: Number(record.paidLeaveDays),
              unpaidLeaveDays: Number(record.unpaidLeaveDays),
              absentDays: Number(record.absentDays),
            },
            after: {
              presentDays: body.presentDays,
              paidLeaveDays: body.paidLeaveDays,
              unpaidLeaveDays: body.unpaidLeaveDays,
              absentDays: body.absentDays,
              note: body.note ?? null,
            },
            summary: `Corrected ${record.employee.fullName}'s attendance for ${formatMonth(record.period.year, record.period.month)}`,
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      return { id: record.id };
    },
  );

  /* ---------------------------------------------------------------- */
  /* HR: submit the period for manager approval                        */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/hr/attendance/periods/:id/submit',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'attendance:submit', 'ORG');

      const { note } = (request.body ?? {}) as { note?: string };

      return db.$transaction(
        (tx) =>
          submitAttendancePeriod(
            tx,
            principal,
            { periodId: request.params.id, note: note ?? null },
            env.AUDIT_HMAC_KEY,
          ),
        { timeout: 60_000 },
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* Manager: approve or return my slice                               */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/attendance/periods/:id/decide',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'attendance:approve', 'DIRECT_REPORTS');

      const body = attendanceDecision.parse(request.body);

      return db.$transaction((tx) =>
        decideAttendanceSlice(
          tx,
          principal,
          {
            periodId: request.params.id,
            approve: body.decision === 'APPROVE',
            returnReason: body.returnReason ?? null,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* Who still owes an approval — HR's view of the hold-up             */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/hr/attendance/periods/:id/approvals',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'attendance:read', 'ORG');

      const approvals = await db.attendanceApproval.findMany({
        where: {
          organizationId: principal.organizationId,
          attendancePeriodId: request.params.id,
        },
        orderBy: { manager: { fullName: 'asc' } },
        select: {
          id: true,
          status: true,
          recordCount: true,
          decidedAt: true,
          returnReason: true,
          manager: { select: { id: true, fullName: true, initials: true } },
        },
      });

      return {
        items: approvals.map((approval) => ({
          ...approval,
          decidedAt: approval.decidedAt?.toISOString() ?? null,
        })),
        // A count of rows, which is what "waiting on three managers" should be.
        pending: approvals.filter((approval) => approval.status === 'PENDING').length,
      };
    },
  );
}
