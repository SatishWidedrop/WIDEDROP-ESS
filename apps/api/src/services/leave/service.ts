import {
  addDays,
  eachDay,
  isWeekend,
  leaveRequestMachine,
  toIsoDate,
  type IsoDate,
  type LeaveRequestEvent,
  type LeaveRequestState,
} from '@widedrop/shared';
import { Prisma } from '../../generated/prisma/index.js';
import type { LeaveDayPortion } from '../../generated/prisma/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import { cancelApprovalTasks, openApprovalTask, settleApprovalTask } from '../approvals.js';
import { notifyEmployee } from '../notifications.js';

/**
 * Leave.
 *
 * Three rules hold the module together, and each is enforced on the server:
 *
 *  1. **The day count is computed, never supplied.** The client sends dates and
 *     half-day portions; the number of working days comes from the calendar,
 *     the employee's location holidays and the portions. A client that posts
 *     `workingDays: 0.5` for a fortnight changes nothing.
 *
 *  2. **A balance cannot be spent twice.** Submitting reserves; approving
 *     converts the reservation into consumption and writes a ledger row;
 *     rejecting or withdrawing releases it. The available balance is a
 *     generated column, so no code path can produce a balance the ledger and
 *     the holds do not justify.
 *
 *  3. **Routing is captured at submission.** The approver is stored on the
 *     request, so a later reorganisation does not silently move a pending
 *     decision to someone who never saw it.
 */

const HALF = 0.5;

export interface LeaveDay {
  date: IsoDate;
  portion: LeaveDayPortion;
  fraction: number;
}

/**
 * The days a request actually consumes.
 *
 * Weekends and holidays are dropped; the first and last day may be halves. A
 * request that lands entirely on holidays produces no days at all, which the
 * caller must treat as a validation failure rather than a zero-day request.
 */
export function resolveLeaveDays(input: {
  startDate: IsoDate;
  endDate: IsoDate;
  startPortion: LeaveDayPortion;
  endPortion: LeaveDayPortion;
  holidays: ReadonlySet<IsoDate>;
  /** ISO weekday numbers treated as week-offs, e.g. [6, 7]. */
  weekOffDays?: readonly number[];
}): LeaveDay[] {
  const weekOff = new Set(input.weekOffDays ?? []);
  const isOff = (date: IsoDate): boolean => {
    if (weekOff.size > 0) {
      // ISO weekday: Monday 1 … Sunday 7.
      const day = new Date(`${date}T00:00:00Z`).getUTCDay();
      return weekOff.has(day === 0 ? 7 : day);
    }
    return isWeekend(date);
  };

  const working = eachDay(input.startDate, input.endDate).filter(
    (date) => !isOff(date) && !input.holidays.has(date),
  );

  return working.map((date, index) => {
    const isFirst = index === 0;
    const isLast = index === working.length - 1;

    // A half-day portion applies to the boundary it was asked for, and only
    // when that boundary is a working day the request still contains.
    let portion: LeaveDayPortion = 'FULL';
    if (isFirst && date === input.startDate && input.startPortion !== 'FULL') {
      portion = input.startPortion;
    }
    if (isLast && date === input.endDate && input.endPortion !== 'FULL') {
      portion = input.endPortion;
    }

    return { date, portion, fraction: portion === 'FULL' ? 1 : HALF };
  });
}

/** The holidays that apply to one employee, from their location's calendar. */
export async function holidaysFor(
  tx: Tx,
  input: { organizationId: string; employeeId: string; from: IsoDate; to: IsoDate },
): Promise<{ dates: Set<IsoDate>; weekOffDays: number[] }> {
  const employment = await tx.employeeEmployment.findFirst({
    where: { employeeId: input.employeeId, effectiveTo: null },
    select: { location: { select: { holidayCalendarId: true } } },
  });

  const calendarId = employment?.location.holidayCalendarId ?? null;
  if (!calendarId) return { dates: new Set(), weekOffDays: [] };

  const [calendar, holidays] = await Promise.all([
    tx.holidayCalendar.findUnique({
      where: { id: calendarId },
      select: { weekOffDays: true },
    }),
    tx.holiday.findMany({
      where: {
        organizationId: input.organizationId,
        holidayCalendarId: calendarId,
        date: { gte: new Date(input.from), lte: new Date(input.to) },
        // A restricted holiday is optional: it does not remove a working day
        // from everyone's calendar, so it is not excluded from a leave count.
        kind: { in: ['PUBLIC', 'WEEKEND_COMPENSATORY'] },
      },
      select: { date: true },
    }),
  ]);

  return {
    dates: new Set(holidays.map((holiday) => toIsoDate(holiday.date))),
    weekOffDays: calendar?.weekOffDays ?? [],
  };
}

/* ------------------------------------------------------------------ */
/* Submission                                                          */
/* ------------------------------------------------------------------ */

export interface SubmitLeaveInput {
  leaveTypeId: string;
  startDate: IsoDate;
  endDate: IsoDate;
  startPortion: LeaveDayPortion;
  endPortion: LeaveDayPortion;
  reason?: string | null;
}

export async function submitLeaveRequest(
  tx: Tx,
  principal: Principal,
  input: SubmitLeaveInput,
  hmacKey: string,
): Promise<{ id: string; workingDays: number; approverEmployeeId: string | null }> {
  const employeeId = principal.employeeId;
  if (!employeeId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'This account is not linked to an employee.');
  }

  if (input.endDate < input.startDate) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'The end date is before the start date.',
    );
  }

  const leaveType = await tx.leaveType.findFirst({
    where: { id: input.leaveTypeId, organizationId: principal.organizationId, isActive: true },
    select: {
      id: true,
      name: true,
      code: true,
      isPaid: true,
      allowsHalfDay: true,
      requiresApproval: true,
      minNoticeDays: true,
      documentRequiredAfterDays: true,
    },
  });
  if (!leaveType) throw notFound('That leave type');

  if (!leaveType.allowsHalfDay && (input.startPortion !== 'FULL' || input.endPortion !== 'FULL')) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      `${leaveType.name} cannot be taken as a half day.`,
    );
  }

  // The leave year the request falls in. A request that straddles two years is
  // refused rather than silently split, because the balances differ.
  const period = await tx.leavePeriod.findFirst({
    where: {
      organizationId: principal.organizationId,
      startDate: { lte: new Date(input.startDate) },
      endDate: { gte: new Date(input.startDate) },
    },
    select: { id: true, name: true, endDate: true, isClosed: true },
  });
  if (!period) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'No leave year covers that start date. People Ops opens the leave year before requests can be made.',
    );
  }
  if (period.isClosed) {
    throw conflict('That leave year is closed.');
  }
  if (toIsoDate(period.endDate) < input.endDate) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'A request cannot span two leave years. Submit one request per year.',
    );
  }

  const { dates, weekOffDays } = await holidaysFor(tx, {
    organizationId: principal.organizationId,
    employeeId,
    from: input.startDate,
    to: input.endDate,
  });

  const days = resolveLeaveDays({
    startDate: input.startDate,
    endDate: input.endDate,
    startPortion: input.startPortion,
    endPortion: input.endPortion,
    holidays: dates,
    weekOffDays,
  });

  if (days.length === 0) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'Those dates are all weekends or holidays, so no leave would be used.',
    );
  }

  const workingDays = days.reduce((total, day) => total + day.fraction, 0);

  // Overlap check. A day already spoken for by a pending or approved request
  // cannot be claimed again — this is the check that stops a double booking,
  // and it runs against rows rather than against anything the client sent.
  const overlapping = await tx.leaveRequestDay.findFirst({
    where: {
      organizationId: principal.organizationId,
      date: { in: days.map((day) => new Date(day.date)) },
      request: { employeeId, status: { in: ['PENDING_APPROVAL', 'APPROVED'] } },
    },
    select: { date: true, request: { select: { id: true } } },
  });
  if (overlapping) {
    throw new AppError(
      422,
      ERROR_CODES.OVERLAPPING_REQUEST,
      `You already have leave on ${toIsoDate(overlapping.date)}.`,
    );
  }

  // Balance. Unpaid leave has no balance to check — it becomes loss of pay,
  // which the attendance period records and payroll prorates.
  if (leaveType.isPaid) {
    const balance = await tx.leaveBalance.findUnique({
      where: {
        employeeId_leaveTypeId_leavePeriodId: {
          employeeId,
          leaveTypeId: leaveType.id,
          leavePeriodId: period.id,
        },
      },
      select: { availableDays: true },
    });

    const available = balance ? Number(balance.availableDays) : 0;
    if (available < workingDays) {
      throw new AppError(
        422,
        ERROR_CODES.INSUFFICIENT_LEAVE_BALANCE,
        balance
          ? `You have ${available} ${available === 1 ? 'day' : 'days'} of ${leaveType.name} available and this request needs ${workingDays}.`
          : `You have no ${leaveType.name} balance for ${period.name}.`,
      );
    }
  }

  const approverEmployeeId = await primaryManagerOn(tx, {
    organizationId: principal.organizationId,
    employeeId,
    on: input.startDate,
  });

  if (leaveType.requiresApproval && !approverEmployeeId) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'You do not have a manager assigned, so this request has nobody to approve it. Raise a help-desk ticket and People Ops will set one.',
    );
  }

  const submittedAt = new Date();

  const request = await tx.leaveRequest.create({
    data: {
      organizationId: principal.organizationId,
      employeeId,
      leaveTypeId: leaveType.id,
      leavePeriodId: period.id,
      status: 'PENDING_APPROVAL',
      startDate: new Date(input.startDate),
      endDate: new Date(input.endDate),
      startPortion: input.startPortion,
      endPortion: input.endPortion,
      workingDays: new Prisma.Decimal(workingDays),
      reason: input.reason ?? null,
      approverEmployeeId,
      submittedAt,
      days: {
        create: days.map((day) => ({
          organizationId: principal.organizationId,
          date: new Date(day.date),
          portion: day.portion,
          dayFraction: new Prisma.Decimal(day.fraction),
        })),
      },
    },
    select: { id: true, employee: { select: { fullName: true } } },
  });

  // The hold. Reserved rather than consumed: the days are not spent until
  // someone approves, but they cannot be promised to another request either.
  if (leaveType.isPaid) {
    await tx.leaveBalance.update({
      where: {
        employeeId_leaveTypeId_leavePeriodId: {
          employeeId,
          leaveTypeId: leaveType.id,
          leavePeriodId: period.id,
        },
      },
      data: { reservedDays: { increment: new Prisma.Decimal(workingDays) } },
    });
  }

  if (approverEmployeeId) {
    await openApprovalTask(tx, {
      organizationId: principal.organizationId,
      kind: 'LEAVE_REQUEST',
      subjectType: 'leave_request',
      subjectId: request.id,
      subjectEmployeeId: employeeId,
      assigneeEmployeeId: approverEmployeeId,
      title: `${leaveType.name} · ${request.employee.fullName}`,
      subtitle: `${input.startDate} to ${input.endDate} · ${workingDays} ${workingDays === 1 ? 'day' : 'days'}`,
      requestedAt: submittedAt,
    });

    await notifyEmployee(tx, {
      organizationId: principal.organizationId,
      employeeId: approverEmployeeId,
      kind: 'LEAVE_SUBMITTED',
      tone: 'BLUE',
      title: `${request.employee.fullName} requested ${leaveType.name}`,
      body: `${workingDays} ${workingDays === 1 ? 'day' : 'days'} from ${input.startDate}`,
      targetModule: 'approvals',
      targetId: request.id,
      sourceType: 'leave_request',
      sourceId: request.id,
    });
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'CREATE',
      entityType: 'leave_request',
      entityId: request.id,
      toState: 'PENDING_APPROVAL',
      after: {
        leaveType: leaveType.code,
        startDate: input.startDate,
        endDate: input.endDate,
        workingDays,
      },
      summary: `Requested ${workingDays} ${workingDays === 1 ? 'day' : 'days'} of ${leaveType.name}`,
    },
    hmacKey,
  );

  return { id: request.id, workingDays, approverEmployeeId };
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

/**
 * Approve or reject. Callable only by the approver the request was routed to —
 * checked here against the stored `approverEmployeeId`, not against who
 * manages the employee today.
 */
export async function decideLeaveRequest(
  tx: Tx,
  principal: Principal,
  input: {
    requestId: string;
    event: Extract<LeaveRequestEvent, 'APPROVE' | 'REJECT'>;
    note?: string | null;
    ip?: string | null;
  },
  hmacKey: string,
): Promise<void> {
  const request = await lockRequest(tx, principal.organizationId, input.requestId);

  if (request.approverEmployeeId !== principal.employeeId) {
    throw new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'This request was not routed to you.');
  }

  assertTransition(request.status, input.event);

  const approved = input.event === 'APPROVE';
  const decidedAt = new Date();

  await tx.leaveRequest.update({
    where: { id: request.id },
    data: {
      status: approved ? 'APPROVED' : 'REJECTED',
      decidedAt,
      decidedByUserId: principal.userId,
      decisionNote: input.note ?? null,
      rowVersion: { increment: 1 },
    },
  });

  if (request.leaveType.isPaid) {
    await releaseReservation(tx, request, approved ? 'consume' : 'release', hmacKey);
  }

  await settleApprovalTask(tx, {
    organizationId: principal.organizationId,
    subjectType: 'leave_request',
    subjectId: request.id,
    outcome: approved ? 'APPROVED' : 'REJECTED',
    status: approved ? 'APPROVED' : 'REJECTED',
    decidedByUserId: principal.userId,
    decidedByEmployeeId: principal.employeeId ?? null,
    note: input.note ?? null,
    ip: input.ip ?? null,
  });

  await notifyEmployee(tx, {
    organizationId: principal.organizationId,
    employeeId: request.employeeId,
    kind: 'LEAVE_DECIDED',
    tone: approved ? 'GREEN' : 'RED',
    title: `${request.leaveType.name} ${approved ? 'approved' : 'declined'}`,
    body: `${toIsoDate(request.startDate)} to ${toIsoDate(request.endDate)}${input.note ? ` · ${input.note}` : ''}`,
    targetModule: 'leave',
    targetId: request.id,
    sourceType: 'leave_request',
    sourceId: request.id,
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'leave_request',
      entityId: request.id,
      fromState: request.status,
      toState: approved ? 'APPROVED' : 'REJECTED',
      summary: `${approved ? 'Approved' : 'Declined'} ${request.leaveType.name} for ${request.employee.fullName}`,
      after: { note: input.note ?? null },
    },
    hmacKey,
  );
}

/** Withdraw an undecided request, or cancel an approved one before it starts. */
export async function withdrawLeaveRequest(
  tx: Tx,
  principal: Principal,
  input: { requestId: string },
  hmacKey: string,
): Promise<void> {
  const request = await lockRequest(tx, principal.organizationId, input.requestId);

  if (request.employeeId !== principal.employeeId) {
    throw new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'That request is not yours.');
  }

  const event: LeaveRequestEvent = request.status === 'APPROVED' ? 'CANCEL' : 'WITHDRAW';
  assertTransition(request.status, event);

  // Approved leave that has already started cannot be cancelled here: the days
  // are in the attendance period, and unwinding them is an HR adjustment with
  // its own record rather than a self-service button.
  if (event === 'CANCEL' && toIsoDate(request.startDate) <= toIsoDate(new Date())) {
    throw conflict(
      'This leave has already started. Raise a help-desk ticket and People Ops will adjust it.',
    );
  }

  const now = new Date();
  await tx.leaveRequest.update({
    where: { id: request.id },
    data: {
      status: event === 'CANCEL' ? 'CANCELLED' : 'WITHDRAWN',
      ...(event === 'CANCEL' ? { cancelledAt: now } : { withdrawnAt: now }),
      rowVersion: { increment: 1 },
    },
  });

  if (request.leaveType.isPaid) {
    await releaseReservation(
      tx,
      request,
      request.status === 'APPROVED' ? 'reverse' : 'release',
      hmacKey,
    );
  }

  await cancelApprovalTasks(tx, {
    organizationId: principal.organizationId,
    subjectType: 'leave_request',
    subjectId: request.id,
  });

  if (request.approverEmployeeId) {
    await notifyEmployee(tx, {
      organizationId: principal.organizationId,
      employeeId: request.approverEmployeeId,
      kind: 'LEAVE_DECIDED',
      tone: 'GRAY',
      title: `${request.employee.fullName} withdrew a leave request`,
      body: `${request.leaveType.name} · ${toIsoDate(request.startDate)} to ${toIsoDate(request.endDate)}`,
      targetModule: 'approvals',
      targetId: request.id,
      sourceType: 'leave_request_withdrawal',
      sourceId: request.id,
    });
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'leave_request',
      entityId: request.id,
      fromState: request.status,
      toState: event === 'CANCEL' ? 'CANCELLED' : 'WITHDRAWN',
      summary: `${event === 'CANCEL' ? 'Cancelled' : 'Withdrew'} ${request.leaveType.name}`,
    },
    hmacKey,
  );
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

type LockedRequest = {
  id: string;
  organizationId: string;
  employeeId: string;
  leaveTypeId: string;
  leavePeriodId: string;
  status: LeaveRequestState;
  startDate: Date;
  endDate: Date;
  workingDays: Prisma.Decimal;
  approverEmployeeId: string | null;
  leaveType: { id: string; name: string; isPaid: boolean };
  employee: { fullName: string };
};

/**
 * Read the request under a row lock.
 *
 * Without it, two approvers — or an approval racing a withdrawal — could both
 * read `PENDING_APPROVAL` and both write, releasing the same reservation twice.
 */
async function lockRequest(
  tx: Tx,
  organizationId: string,
  requestId: string,
): Promise<LockedRequest> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ess.leave_request
    WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  if (locked.length === 0) throw notFound('That leave request');

  const request = await tx.leaveRequest.findUniqueOrThrow({
    where: { id: requestId },
    select: {
      id: true,
      organizationId: true,
      employeeId: true,
      leaveTypeId: true,
      leavePeriodId: true,
      status: true,
      startDate: true,
      endDate: true,
      workingDays: true,
      approverEmployeeId: true,
      leaveType: { select: { id: true, name: true, isPaid: true } },
      employee: { select: { fullName: true } },
    },
  });

  return request as LockedRequest;
}

function assertTransition(from: LeaveRequestState, event: LeaveRequestEvent): void {
  if (!leaveRequestMachine.can(from, event)) {
    throw new AppError(
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      `A ${from.toLowerCase().replace(/_/g, ' ')} request cannot be ${event.toLowerCase()}d.`,
      { meta: { from, event } },
    );
  }
}

/**
 * Move a hold.
 *
 *  - `consume`  — approval: the reservation becomes consumption, and the ledger
 *                 gains the row that explains the balance.
 *  - `release`  — rejection or withdrawal before a decision: the hold goes back.
 *  - `reverse`  — cancelling already-approved leave: consumption is reversed,
 *                 with its own ledger row so the history shows both movements.
 */
async function releaseReservation(
  tx: Tx,
  request: LockedRequest,
  mode: 'consume' | 'release' | 'reverse',
  hmacKey: string,
): Promise<void> {
  const days = request.workingDays;
  const key = {
    employeeId_leaveTypeId_leavePeriodId: {
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      leavePeriodId: request.leavePeriodId,
    },
  };

  if (mode === 'consume') {
    await tx.leaveBalance.update({
      where: key,
      data: { reservedDays: { decrement: days }, consumedDays: { increment: days } },
    });
    await tx.leaveBalanceLedger.create({
      data: {
        organizationId: request.organizationId,
        employeeId: request.employeeId,
        leaveTypeId: request.leaveTypeId,
        leavePeriodId: request.leavePeriodId,
        kind: 'CONSUMPTION',
        deltaDays: days.negated(),
        sourceType: 'leave_request',
        sourceId: request.id,
        effectiveOn: request.startDate,
        note: `${request.leaveType.name} ${toIsoDate(request.startDate)} to ${toIsoDate(request.endDate)}`,
      },
    });
    return;
  }

  if (mode === 'release') {
    await tx.leaveBalance.update({
      where: key,
      data: { reservedDays: { decrement: days } },
    });
    return;
  }

  await tx.leaveBalance.update({
    where: key,
    data: { consumedDays: { decrement: days } },
  });
  await tx.leaveBalanceLedger.create({
    data: {
      organizationId: request.organizationId,
      employeeId: request.employeeId,
      leaveTypeId: request.leaveTypeId,
      leavePeriodId: request.leavePeriodId,
      kind: 'CONSUMPTION_REVERSAL',
      deltaDays: days,
      sourceType: 'leave_request',
      sourceId: request.id,
      effectiveOn: new Date(),
      note: `Cancelled ${request.leaveType.name}`,
    },
  });

  await recordAudit(
    tx,
    {
      organizationId: request.organizationId,
      action: 'UPDATE',
      entityType: 'leave_balance',
      entityId: request.id,
      summary: `Reversed ${days.toString()} days of ${request.leaveType.name}`,
    },
    hmacKey,
  );
}

/** The manager a request routes to: the primary relationship live on that date. */
export async function primaryManagerOn(
  tx: Tx,
  input: { organizationId: string; employeeId: string; on: IsoDate },
): Promise<string | null> {
  const relationship = await tx.employeeManager.findFirst({
    where: {
      organizationId: input.organizationId,
      employeeId: input.employeeId,
      isPrimary: true,
      effectiveFrom: { lte: new Date(input.on) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date(input.on) } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: { managerEmployeeId: true },
  });

  // A manager cannot approve their own leave. Where the relationship points at
  // the employee themselves — a data error — the request is treated as having
  // no approver rather than self-approving.
  if (relationship && relationship.managerEmployeeId !== input.employeeId) {
    return relationship.managerEmployeeId;
  }
  return null;
}

/** Tomorrow, as the earliest date a planned request may start. */
export function earliestPlannedStart(minNoticeDays: number): IsoDate {
  return addDays(toIsoDate(new Date()), Math.max(minNoticeDays, 0));
}
