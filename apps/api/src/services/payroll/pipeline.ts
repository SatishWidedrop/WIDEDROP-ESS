import {
  PAYROLL_EVENT_ACTOR,
  payrollCycleMachine,
  type PayrollCycleEvent,
  type PayrollCycleState,
  type Persona,
} from '@widedrop/shared';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';

/**
 * The payroll pipeline.
 *
 *   Accounts uploads payroll data
 *     -> HR submits employee attendance
 *     -> the respective Manager reviews and approves attendance
 *     -> the system validates the required payroll inputs
 *     -> payroll and payslips are generated automatically
 *     -> the payslip becomes visible to the employee
 *
 * Every transition passes four gates, and all four must agree:
 *
 *   1. the state machine, which says the move exists at all
 *   2. the actor's persona, which says they may raise that event
 *   3. the guard, which says the work the previous step owed is actually done
 *   4. the database's own check constraints, which refuse a row that claims
 *      to have reached a stage without the stage before it
 *
 * The row is locked FOR UPDATE for the whole transition, so two people clicking
 * at once cannot both advance the cycle.
 */

export interface TransitionResult {
  cycleId: string;
  from: PayrollCycleState;
  to: PayrollCycleState;
  event: PayrollCycleEvent;
}

export interface TransitionOptions {
  /** Extra columns to write in the same statement as the status. */
  data?: Record<string, unknown>;
  /** A line for the audit trail. */
  summary?: string;
  /** Skips the persona check for events the system raises as an outcome. */
  systemRaised?: boolean;
}

export async function transitionCycle(
  tx: Tx,
  principal: Principal,
  input: { cycleId: string; event: PayrollCycleEvent },
  hmacKey: string,
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  // Serialise transitions on this cycle. Two concurrent publishes would
  // otherwise both read CALCULATED and both try to advance.
  const locked = await tx.$queryRaw<{ id: string; status: PayrollCycleState }[]>`
    SELECT id, status FROM ess.payroll_cycle
     WHERE id = ${input.cycleId}::uuid AND organization_id = ${principal.organizationId}::uuid
     FOR UPDATE
  `;

  const current = locked[0];
  if (!current) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, 'That payroll cycle could not be found.');
  }

  const from = current.status;

  // Authorization first, then validity. Answering "you may not do that at all"
  // before "not from this state" keeps a caller who has no business with this
  // cycle from learning where it has got to.
  //
  // A null actor means the system raises the event as the outcome of a previous
  // step; a user may never request it directly.
  const requiredPersona = PAYROLL_EVENT_ACTOR[input.event];
  if (!options.systemRaised) {
    if (requiredPersona === null) {
      throw new AppError(
        403,
        ERROR_CODES.FORBIDDEN,
        'That step is performed by the system, not requested directly.',
        { meta: { event: input.event } },
      );
    }
    if (!principal.personas.includes(requiredPersona)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN, 'You do not have access to this.', {
        meta: { event: input.event, requiredPersona, personas: principal.personas },
      });
    }
  }

  const to = payrollCycleMachine.next(from, input.event);

  if (!to) {
    throw new AppError(
      409,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      transitionMessage(from, input.event),
      { meta: { cycleId: input.cycleId, from, event: input.event } },
    );
  }

  await assertGuard(tx, { cycleId: input.cycleId, event: input.event, from });

  await tx.payrollCycle.update({
    where: { id: input.cycleId },
    // The stage timestamp belongs to the transition, not to whoever asked for
    // it: stamping it here means every caller records it, and the Payroll
    // screen's timeline cannot show a later stage complete while an earlier
    // one looks outstanding. A caller may still add its own columns — who
    // approved, why it was cancelled — and those win.
    data: { status: to, ...stageTimestamp(input.event), ...(options.data ?? {}) },
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'payroll_cycle',
      entityId: input.cycleId,
      fromState: from,
      toState: to,
      summary:
        options.summary ??
        payrollCycleMachine.find(from, input.event)?.description ??
        `${from} to ${to}`,
      ...(options.systemRaised ? { actor: { kind: 'SYSTEM' as const } } : {}),
    },
    hmacKey,
  );

  return { cycleId: input.cycleId, from, to, event: input.event };
}

/**
 * A message that says what is actually blocking, rather than restating the
 * state names. Someone looking at a stuck cycle should learn what to do next.
 */
function transitionMessage(from: PayrollCycleState, event: PayrollCycleEvent): string {
  const explanations: Partial<Record<PayrollCycleEvent, string>> = {
    SUBMIT_ATTENDANCE: 'Attendance can be submitted once Accounts has locked the payroll inputs.',
    APPROVE_ATTENDANCE: 'Attendance can be approved once HR has submitted it.',
    VALIDATE: 'Validation runs once every manager has approved their team’s attendance.',
    CALCULATE: 'Payroll can be calculated once validation has passed.',
    APPROVE: 'A run can be signed off once it has been calculated.',
    PUBLISH: 'Payslips can be published once the run has been signed off.',
    CANCEL: 'A published cycle cannot be cancelled.',
  };
  const explanation = explanations[event];
  return explanation ?? `This cycle is ${humanState(from)} and cannot do that yet.`;
}

function humanState(state: PayrollCycleState): string {
  return state.toLowerCase().replace(/_/g, ' ');
}

/**
 * The work the previous step owed.
 *
 * The state machine says a move is possible in principle; these checks say it
 * is possible now. They are the difference between "the cycle says attendance
 * was submitted" and "every employee actually has a record".
 */
async function assertGuard(
  tx: Tx,
  input: { cycleId: string; event: PayrollCycleEvent; from: PayrollCycleState },
): Promise<void> {
  switch (input.event) {
    case 'LOCK_INPUTS': {
      const committed = await tx.payrollInputBatch.count({
        where: { payrollCycleId: input.cycleId, status: 'COMMITTED' },
      });
      if (committed === 0) {
        throw guardFailed(
          'No payroll input batch has been committed for this cycle yet.',
          'Upload and commit at least one batch before locking inputs.',
        );
      }
      return;
    }

    case 'SUBMIT_ATTENDANCE': {
      const cycle = await tx.payrollCycle.findUniqueOrThrow({
        where: { id: input.cycleId },
        select: { attendancePeriodId: true },
      });
      if (!cycle.attendancePeriodId) {
        throw guardFailed(
          'This cycle has no attendance period attached.',
          'Attach the attendance period for this month before submitting.',
        );
      }
      const draft = await tx.attendanceRecord.count({
        where: { attendancePeriodId: cycle.attendancePeriodId, status: 'DRAFT' },
      });
      if (draft > 0) {
        throw guardFailed(
          `${draft} attendance ${draft === 1 ? 'record is' : 'records are'} still in draft.`,
          'Complete every employee’s attendance before submitting the period.',
        );
      }
      return;
    }

    case 'APPROVE_ATTENDANCE': {
      // The cycle only advances when the LAST manager approves. Until then the
      // event is refused with the count of who is still outstanding.
      const cycle = await tx.payrollCycle.findUniqueOrThrow({
        where: { id: input.cycleId },
        select: { attendancePeriodId: true },
      });
      if (!cycle.attendancePeriodId) {
        throw guardFailed('This cycle has no attendance period attached.', 'Attach it first.');
      }
      const outstanding = await tx.attendanceApproval.count({
        where: { attendancePeriodId: cycle.attendancePeriodId, status: 'PENDING' },
      });
      if (outstanding > 0) {
        throw guardFailed(
          `${outstanding} ${outstanding === 1 ? 'manager has' : 'managers have'} not approved their team’s attendance yet.`,
          'The cycle advances when the last approval arrives.',
        );
      }
      return;
    }

    case 'CALCULATE': {
      const failures = await tx.payrollValidationResult.count({
        where: {
          payrollCycleId: input.cycleId,
          passed: false,
          severity: 'ERROR',
          attempt: await latestAttempt(tx, input.cycleId),
        },
      });
      const eligible = await eligibleCount(tx, input.cycleId);
      if (eligible === 0) {
        throw guardFailed(
          failures > 0
            ? 'Every employee in this cycle failed a blocking validation check.'
            : 'No employees are in scope for this cycle.',
          'Clear the blocking findings on the validation report, then validate again.',
        );
      }
      return;
    }

    case 'PUBLISH': {
      const generated = await tx.payslip.count({
        where: { payrollCycleId: input.cycleId, status: 'GENERATED' },
      });
      if (generated === 0) {
        throw guardFailed(
          'This cycle has no generated payslips to publish.',
          'Calculate the run before publishing it.',
        );
      }
      // A payslip with no PDF would be published as a row the employee can see
      // but not download, which reads as a broken portal rather than an
      // in-progress one.
      const missingPdf = await tx.payslip.count({
        where: { payrollCycleId: input.cycleId, status: 'GENERATED', pdfFileObjectId: null },
      });
      if (missingPdf > 0) {
        throw guardFailed(
          `${missingPdf} ${missingPdf === 1 ? 'payslip has' : 'payslips have'} no document yet.`,
          'Wait for payslip documents to finish rendering, then publish.',
        );
      }
      return;
    }

    default:
      return;
  }
}

async function latestAttempt(tx: Tx, cycleId: string): Promise<number> {
  const result = await tx.payrollValidationResult.aggregate({
    where: { payrollCycleId: cycleId },
    _max: { attempt: true },
  });
  return result._max.attempt ?? 0;
}

/** Employees who cleared every blocking check on the most recent validation. */
export async function eligibleCount(tx: Tx, cycleId: string): Promise<number> {
  const attempt = await latestAttempt(tx, cycleId);
  if (attempt === 0) return 0;

  const checked = await tx.payrollValidationResult.findMany({
    where: { payrollCycleId: cycleId, attempt },
    select: { employeeId: true, passed: true, severity: true },
  });

  const employees = new Set<string>();
  const blocked = new Set<string>();
  for (const row of checked) {
    if (!row.employeeId) continue;
    employees.add(row.employeeId);
    if (!row.passed && row.severity === 'ERROR') blocked.add(row.employeeId);
  }

  return [...employees].filter((id) => !blocked.has(id)).length;
}

function guardFailed(what: string, remedy: string): AppError {
  return new AppError(422, ERROR_CODES.PAYROLL_PREREQUISITE_NOT_MET, `${what} ${remedy}`, {
    details: [{ message: what }, { message: remedy, rule: 'remedy' }],
  });
}

/**
 * Whether one persona could raise an event from here.
 *
 * Used to render the actions a screen offers, so the UI never shows a button
 * the server would refuse.
 */
export function availableEvents(
  state: PayrollCycleState,
  personas: readonly Persona[],
): PayrollCycleEvent[] {
  return payrollCycleMachine.eventsFrom(state).filter((event) => {
    const required = PAYROLL_EVENT_ACTOR[event];
    return required !== null && personas.includes(required);
  });
}

/**
 * The column each event stamps.
 *
 * Only the seven stages the pipeline's timeline draws. Events that move a
 * cycle without completing a stage — a validation rejection, an input reopen —
 * stamp nothing, because the stage they would touch has not been reached.
 */
function stageTimestamp(event: PayrollCycleEvent): Record<string, Date> {
  const now = new Date();
  switch (event) {
    case 'LOCK_INPUTS':
      return { inputsLockedAt: now };
    case 'SUBMIT_ATTENDANCE':
      return { attendanceSubmittedAt: now };
    case 'APPROVE_ATTENDANCE':
      return { attendanceApprovedAt: now };
    case 'VALIDATION_PASSED':
      return { validatedAt: now };
    case 'CALCULATION_SUCCEEDED':
      return { calculatedAt: now };
    case 'APPROVE':
      return { approvedAt: now };
    case 'PUBLISH':
      return { publishedAt: now };
    case 'CLOSE':
      return { closedAt: now };
    case 'CANCEL':
      return { cancelledAt: now };
    default:
      return {};
  }
}
