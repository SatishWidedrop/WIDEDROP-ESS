import {
  BLOCKING_CHECKS,
  checkDefinition,
  type PayrollValidationCheck,
} from '@widedrop/shared';
import type { Tx } from '../../lib/prisma.js';

/**
 * Pre-generation validation.
 *
 * Every check runs for every employee in the cycle and every result is
 * persisted, so the Accounts validation report shows real findings and every
 * exclusion from a run carries a recorded reason.
 *
 * A blocking failure excludes that employee; it does not fail the cycle. One
 * person's missing bank account must not stop an organisation being paid — and
 * they must not be paid approximately either. They are excluded visibly and
 * picked up by a supplementary run.
 */

export interface EmployeeCheckResult {
  employeeId: string;
  check: PayrollValidationCheck;
  passed: boolean;
  message: string;
}

export interface ValidationSummary {
  attempt: number;
  employeesInScope: number;
  employeesPassing: number;
  employeesExcluded: number;
  /** Every failing check, so the report can group by employee or by cause. */
  failures: EmployeeCheckResult[];
  /** Employees who cleared every blocking check and will be paid. */
  eligibleEmployeeIds: string[];
}

export async function runValidation(
  tx: Tx,
  input: { organizationId: string; payrollCycleId: string },
): Promise<ValidationSummary> {
  const cycle = await tx.payrollCycle.findUniqueOrThrow({
    where: { id: input.payrollCycleId },
    select: {
      id: true,
      organizationId: true,
      periodStart: true,
      periodEnd: true,
      attendancePeriodId: true,
    },
  });

  const previousAttempts = await tx.payrollValidationResult.aggregate({
    where: { payrollCycleId: cycle.id },
    _max: { attempt: true },
  });
  const attempt = (previousAttempts._max.attempt ?? 0) + 1;

  const employees = await employeesInScope(tx, cycle);
  const results: EmployeeCheckResult[] = [];

  for (const employee of employees) {
    results.push(...(await checkEmployee(tx, cycle, employee)));
  }

  // Persist every result, passing and failing alike: a report that showed only
  // failures could not distinguish "checked and fine" from "never checked".
  if (results.length > 0) {
    await tx.payrollValidationResult.createMany({
      data: results.map((result) => {
        const definition = checkDefinition(result.check);
        return {
          organizationId: cycle.organizationId,
          payrollCycleId: cycle.id,
          employeeId: result.employeeId,
          check: result.check,
          severity: definition.severity,
          passed: result.passed,
          message: result.message,
          remedy: result.passed ? null : definition.remedy,
          attempt,
        };
      }),
    });
  }

  const blockedEmployees = new Set(
    results
      .filter((r) => !r.passed && BLOCKING_CHECKS.includes(r.check))
      .map((r) => r.employeeId),
  );

  const eligibleEmployeeIds = employees
    .map((e) => e.id)
    .filter((id) => !blockedEmployees.has(id));

  return {
    attempt,
    employeesInScope: employees.length,
    employeesPassing: eligibleEmployeeIds.length,
    employeesExcluded: blockedEmployees.size,
    failures: results.filter((r) => !r.passed),
    eligibleEmployeeIds,
  };
}

interface ScopedEmployee {
  id: string;
  employeeNumber: string;
  fullName: string;
  dateOfJoining: Date;
  dateOfExit: Date | null;
  employmentStatus: string;
}

/**
 * Who this cycle pays.
 *
 * Anyone on the rolls for at least one day of the period, including joiners,
 * leavers and suspended employees — suspension removes portal access, not the
 * right to be paid for days worked.
 */
async function employeesInScope(
  tx: Tx,
  cycle: { organizationId: string; periodStart: Date; periodEnd: Date },
): Promise<ScopedEmployee[]> {
  return tx.employee.findMany({
    where: {
      organizationId: cycle.organizationId,
      employmentStatus: { in: ['ACTIVE', 'NOTICE_PERIOD', 'SUSPENDED', 'ON_LEAVE', 'EXITED'] },
      dateOfJoining: { lte: cycle.periodEnd },
      OR: [{ dateOfExit: null }, { dateOfExit: { gte: cycle.periodStart } }],
    },
    select: {
      id: true,
      employeeNumber: true,
      fullName: true,
      dateOfJoining: true,
      dateOfExit: true,
      employmentStatus: true,
    },
    orderBy: { employeeNumber: 'asc' },
  });
}

async function checkEmployee(
  tx: Tx,
  cycle: {
    id: string;
    organizationId: string;
    periodStart: Date;
    periodEnd: Date;
    attendancePeriodId: string | null;
  },
  employee: ScopedEmployee,
): Promise<EmployeeCheckResult[]> {
  const results: EmployeeCheckResult[] = [];
  const add = (check: PayrollValidationCheck, passed: boolean, message: string) =>
    results.push({ employeeId: employee.id, check, passed, message });

  /* Salary structure effective for the period. */
  const structure = await tx.salaryStructure.findFirst({
    where: {
      employeeId: employee.id,
      effectiveFrom: { lte: cycle.periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: cycle.periodStart } }],
    },
    select: { id: true, components: { select: { id: true } } },
  });

  add(
    'SALARY_STRUCTURE_EFFECTIVE',
    structure !== null && structure.components.length > 0,
    structure
      ? structure.components.length > 0
        ? 'Salary structure is effective for this period.'
        : 'The salary structure has no components, so there is nothing to pay.'
      : 'No salary structure is effective for this period.',
  );

  /* Attendance approved by the reporting manager. */
  const attendance = cycle.attendancePeriodId
    ? await tx.attendanceRecord.findFirst({
        where: { attendancePeriodId: cycle.attendancePeriodId, employeeId: employee.id },
        select: { status: true, payableDays: true },
      })
    : null;

  add(
    'ATTENDANCE_APPROVED',
    attendance?.status === 'APPROVED' || attendance?.status === 'LOCKED',
    attendance
      ? attendance.status === 'APPROVED' || attendance.status === 'LOCKED'
        ? 'Attendance is approved.'
        : `Attendance is ${attendance.status.toLowerCase()}, not yet approved by the reporting manager.`
      : 'No attendance record exists for this period.',
  );

  /* A verified bank account: payroll will not pay an unverified one. */
  const bank = await tx.employeeBankAccount.findFirst({
    where: { employeeId: employee.id, isActive: true, isPrimary: true },
    select: { verifiedAt: true },
  });

  add(
    'BANK_DETAILS_VERIFIED',
    bank?.verifiedAt != null,
    bank
      ? bank.verifiedAt
        ? 'Bank account is on file and verified.'
        : 'Bank account is on file but has not been verified by Payroll.'
      : 'No bank account is on file.',
  );

  /* Statutory identifiers. PAN is always required; UAN only where PF applies. */
  const statutoryIds = await tx.employeeStatutoryId.findMany({
    where: { employeeId: employee.id },
    select: { kind: true },
  });
  const kinds = new Set(statutoryIds.map((s) => s.kind));

  add(
    'STATUTORY_IDS_PRESENT',
    kinds.has('PAN'),
    kinds.has('PAN') ? 'Statutory identifiers are on file.' : 'PAN is missing.',
  );

  /* A tax regime election, which payroll cannot default silently. */
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: {
      organizationId: cycle.organizationId,
      startDate: { lte: cycle.periodStart },
      endDate: { gte: cycle.periodEnd },
    },
    select: { id: true },
  });

  const election = fiscalYear
    ? await tx.employeeTaxRegimeElection.findFirst({
        where: { employeeId: employee.id, fiscalYearId: fiscalYear.id },
        select: { id: true },
      })
    : null;

  add(
    'TAX_REGIME_ELECTED',
    election !== null,
    election
      ? 'Tax regime is elected for this financial year.'
      : fiscalYear
        ? 'No tax regime has been elected for this financial year.'
        : 'No financial year covers this payroll period.',
  );

  /* Unresolved errors in the uploaded payroll inputs. */
  const badInput = await tx.payrollInputItem.findFirst({
    where: {
      employeeId: employee.id,
      batch: { payrollCycleId: cycle.id, status: { in: ['PARSE_FAILED', 'DISCARDED'] } },
    },
    select: { id: true },
  });

  add(
    'NO_UNRESOLVED_INPUT_ERRORS',
    badInput === null,
    badInput
      ? 'This employee has rows in a batch that failed to parse.'
      : 'Uploaded payroll inputs are clean.',
  );

  /* A payslip already issued for this employee and period. */
  const existing = await tx.payslip.findFirst({
    where: {
      employeeId: employee.id,
      payrollCycleId: cycle.id,
      status: { in: ['GENERATED', 'PUBLISHED'] },
    },
    select: { id: true, reference: true },
  });

  add(
    'NO_EXISTING_PAYSLIP',
    existing === null,
    existing
      ? `Payslip ${existing.reference} already exists for this period.`
      : 'No payslip exists yet for this period.',
  );

  /* Employed for at least one day. A warning: pay is prorated to the days. */
  const joinedBeforeEnd = employee.dateOfJoining <= cycle.periodEnd;
  const leftAfterStart = !employee.dateOfExit || employee.dateOfExit >= cycle.periodStart;

  add(
    'EMPLOYMENT_ACTIVE_IN_PERIOD',
    joinedBeforeEnd && leftAfterStart,
    joinedBeforeEnd && leftAfterStart
      ? 'Employed for part or all of this period.'
      : 'Not employed during this period; pay will be prorated to the days on the rolls.',
  );

  return results;
}
