import { StateMachine } from './state-machine.js';
import type { Role } from '../rbac/roles.js';

/**
 * The payroll pipeline.
 *
 * A payslip does not exist until the cycle reaches GENERATED, and an employee
 * cannot see it until the cycle reaches PUBLISHED. The order is fixed:
 *
 *   Accounts uploads payroll data
 *     -> HR submits employee attendance
 *     -> the respective Manager reviews and approves attendance
 *     -> the system validates the required payroll inputs
 *     -> payroll and payslips are generated automatically
 *     -> the payslip becomes visible to the employee
 *
 * Each step is gated on the previous one by this machine, by a database check
 * constraint on the cycle's state, and by an authorization check on the actor's
 * role — three independent gates, so a bug in one does not open the pipeline.
 */

export const PAYROLL_CYCLE_STATES = [
  /** Period created. Nothing uploaded yet. */
  'DRAFT',
  /** Accounts has uploaded at least one payroll input batch with no fatal errors. */
  'INPUTS_UPLOADED',
  /** HR has submitted attendance for every employee in scope. */
  'ATTENDANCE_SUBMITTED',
  /** Every manager who owed an approval has given it. */
  'ATTENDANCE_APPROVED',
  /** Pre-generation validation passed for every employee in scope. */
  'VALIDATED',
  /** Validation found blocking problems. Returns to INPUTS_UPLOADED once fixed. */
  'VALIDATION_FAILED',
  /** Generation is running. A lock state: no other transition may interleave. */
  'GENERATING',
  /** Payslips exist, immutable, but are not yet visible to employees. */
  'GENERATED',
  /** Generation failed part-way; nothing was committed. */
  'GENERATION_FAILED',
  /** Payslips are visible to their employees. Terminal for the happy path. */
  'PUBLISHED',
  /** Abandoned before publication. Any generated payslips are voided. */
  'CANCELLED',
] as const;

export type PayrollCycleState = (typeof PAYROLL_CYCLE_STATES)[number];

export const PAYROLL_CYCLE_EVENTS = [
  'UPLOAD_INPUTS',
  'SUBMIT_ATTENDANCE',
  'RETURN_ATTENDANCE',
  'APPROVE_ATTENDANCE',
  'VALIDATE',
  'VALIDATION_PASSED',
  'VALIDATION_REJECTED',
  'GENERATE',
  'GENERATION_SUCCEEDED',
  'GENERATION_ABORTED',
  'PUBLISH',
  'CANCEL',
] as const;

export type PayrollCycleEvent = (typeof PAYROLL_CYCLE_EVENTS)[number];

export const payrollCycleMachine = new StateMachine<PayrollCycleState, PayrollCycleEvent>({
  name: 'payroll-cycle',
  initial: 'DRAFT',
  states: PAYROLL_CYCLE_STATES,
  transitions: [
    {
      from: 'DRAFT',
      to: 'INPUTS_UPLOADED',
      event: 'UPLOAD_INPUTS',
      description: 'Accounts uploads the payroll input batch for the period.',
    },
    {
      // Re-uploading before attendance is submitted replaces the batch.
      from: 'INPUTS_UPLOADED',
      to: 'INPUTS_UPLOADED',
      event: 'UPLOAD_INPUTS',
      description: 'Accounts uploads a corrected or additional payroll input batch.',
    },
    {
      from: 'INPUTS_UPLOADED',
      to: 'ATTENDANCE_SUBMITTED',
      event: 'SUBMIT_ATTENDANCE',
      description: 'HR submits attendance for every employee in the cycle.',
    },
    {
      from: 'ATTENDANCE_SUBMITTED',
      to: 'INPUTS_UPLOADED',
      event: 'RETURN_ATTENDANCE',
      description: 'A manager returns attendance to HR for correction.',
    },
    {
      from: 'ATTENDANCE_SUBMITTED',
      to: 'ATTENDANCE_APPROVED',
      event: 'APPROVE_ATTENDANCE',
      description: 'The last outstanding manager approves their team’s attendance.',
    },
    {
      from: 'ATTENDANCE_APPROVED',
      to: 'ATTENDANCE_APPROVED',
      event: 'VALIDATE',
      description: 'Accounts runs pre-generation validation.',
    },
    {
      from: 'ATTENDANCE_APPROVED',
      to: 'VALIDATED',
      event: 'VALIDATION_PASSED',
      description: 'Every employee in scope has the inputs payroll needs.',
    },
    {
      from: 'ATTENDANCE_APPROVED',
      to: 'VALIDATION_FAILED',
      event: 'VALIDATION_REJECTED',
      description: 'Validation found blocking problems on one or more employees.',
    },
    {
      from: 'VALIDATION_FAILED',
      to: 'INPUTS_UPLOADED',
      event: 'UPLOAD_INPUTS',
      description: 'Accounts uploads corrected inputs; attendance must be re-approved.',
    },
    {
      from: 'VALIDATED',
      to: 'GENERATING',
      event: 'GENERATE',
      description: 'Accounts starts payroll generation.',
    },
    {
      from: 'GENERATING',
      to: 'GENERATED',
      event: 'GENERATION_SUCCEEDED',
      description: 'Payslips were generated and sealed for every employee in scope.',
    },
    {
      from: 'GENERATING',
      to: 'GENERATION_FAILED',
      event: 'GENERATION_ABORTED',
      description: 'Generation failed; the transaction was rolled back and nothing was written.',
    },
    {
      from: 'GENERATION_FAILED',
      to: 'VALIDATED',
      event: 'VALIDATE',
      description: 'The cause was fixed; the cycle is ready to generate again.',
    },
    {
      from: 'GENERATED',
      to: 'PUBLISHED',
      event: 'PUBLISH',
      description: 'Accounts publishes the cycle; payslips become visible to employees.',
    },
    // A cycle can be abandoned at any point before publication — but never
    // after, because an employee may already have downloaded their payslip.
    ...(
      [
        'DRAFT',
        'INPUTS_UPLOADED',
        'ATTENDANCE_SUBMITTED',
        'ATTENDANCE_APPROVED',
        'VALIDATION_FAILED',
        'GENERATION_FAILED',
        'GENERATED',
      ] as const
    ).map((from) => ({
      from,
      to: 'CANCELLED' as const,
      event: 'CANCEL' as const,
      description: 'Accounts cancels the cycle; any generated payslips are voided.',
    })),
  ],
});

/** Which role may raise each event. Enforced server-side on every request. */
export const PAYROLL_EVENT_ACTOR: Record<PayrollCycleEvent, Role> = {
  UPLOAD_INPUTS: 'ACCOUNTS',
  SUBMIT_ATTENDANCE: 'HR',
  RETURN_ATTENDANCE: 'MANAGER',
  APPROVE_ATTENDANCE: 'MANAGER',
  VALIDATE: 'ACCOUNTS',
  // Raised by the system itself as the outcome of VALIDATE, never by a user.
  VALIDATION_PASSED: 'ACCOUNTS',
  VALIDATION_REJECTED: 'ACCOUNTS',
  GENERATE: 'ACCOUNTS',
  GENERATION_SUCCEEDED: 'ACCOUNTS',
  GENERATION_ABORTED: 'ACCOUNTS',
  PUBLISH: 'ACCOUNTS',
  CANCEL: 'ACCOUNTS',
};

/**
 * States in which payslip rows may exist at all.
 *
 * Enforced by a database check constraint as well as by this list: a payslip row
 * whose cycle is in any other state is a data-integrity bug, not a display bug.
 */
export const STATES_WITH_PAYSLIPS: readonly PayrollCycleState[] = [
  'GENERATED',
  'PUBLISHED',
  'CANCELLED',
];

/** The only state in which an employee may read their own payslip. */
export const EMPLOYEE_VISIBLE_STATES: readonly PayrollCycleState[] = ['PUBLISHED'];

export function payslipsMayExist(state: PayrollCycleState): boolean {
  return STATES_WITH_PAYSLIPS.includes(state);
}

export function payslipVisibleToEmployee(state: PayrollCycleState): boolean {
  return EMPLOYEE_VISIBLE_STATES.includes(state);
}

/* ------------------------------------------------------------------ */
/* Pre-generation validation                                           */
/* ------------------------------------------------------------------ */

/**
 * The checklist the system runs before generating payroll. Every check is
 * evaluated for every employee in the cycle, and the result of each is
 * persisted so the run is auditable and explicable afterwards.
 */
export const PAYROLL_VALIDATION_CHECKS = [
  'SALARY_STRUCTURE_EFFECTIVE',
  'ATTENDANCE_APPROVED',
  'BANK_DETAILS_PRESENT',
  'STATUTORY_IDS_PRESENT',
  'TAX_REGIME_ELECTED',
  'NO_UNRESOLVED_INPUT_ERRORS',
  'NO_EXISTING_PAYSLIP',
  'EMPLOYMENT_ACTIVE_IN_PERIOD',
] as const;

export type PayrollValidationCheck = (typeof PAYROLL_VALIDATION_CHECKS)[number];

export type ValidationSeverity = 'BLOCKING' | 'WARNING';

export interface PayrollCheckDefinition {
  check: PayrollValidationCheck;
  severity: ValidationSeverity;
  /** Shown to Accounts on the validation report. */
  label: string;
  /** What Accounts or HR must do to clear it. */
  remedy: string;
}

/**
 * A BLOCKING failure excludes that employee from the run and records why; the
 * cycle itself only fails when *every* employee is excluded, or when Accounts
 * chooses not to proceed. This is deliberate: one employee missing a bank
 * account must not stop an organisation being paid, but they must not be paid
 * silently or approximately either — they are excluded with a recorded reason
 * and picked up by a supplementary run.
 */
export const PAYROLL_CHECKS: readonly PayrollCheckDefinition[] = [
  {
    check: 'SALARY_STRUCTURE_EFFECTIVE',
    severity: 'BLOCKING',
    label: 'Salary structure effective for the period',
    remedy: 'Accounts uploads an effective-dated salary structure for this employee.',
  },
  {
    check: 'ATTENDANCE_APPROVED',
    severity: 'BLOCKING',
    label: 'Attendance approved by the reporting manager',
    remedy: 'The reporting manager approves the attendance slice for this period.',
  },
  {
    check: 'BANK_DETAILS_PRESENT',
    severity: 'BLOCKING',
    label: 'Verified bank account on file',
    remedy: 'The employee submits bank details and Payroll verifies them.',
  },
  {
    check: 'STATUTORY_IDS_PRESENT',
    severity: 'BLOCKING',
    label: 'PAN and, where applicable, UAN on file',
    remedy: 'The employee submits the missing identifier through My profile.',
  },
  {
    check: 'TAX_REGIME_ELECTED',
    severity: 'BLOCKING',
    label: 'Tax regime elected for the financial year',
    remedy: 'The employee elects a regime, or HR applies the statutory default.',
  },
  {
    check: 'NO_UNRESOLVED_INPUT_ERRORS',
    severity: 'BLOCKING',
    label: 'No unresolved errors in the uploaded payroll inputs',
    remedy: 'Accounts corrects the flagged rows and re-uploads the batch.',
  },
  {
    check: 'NO_EXISTING_PAYSLIP',
    severity: 'BLOCKING',
    label: 'No payslip already issued for this employee and period',
    remedy: 'Use a supplementary run to issue a correction rather than a second payslip.',
  },
  {
    check: 'EMPLOYMENT_ACTIVE_IN_PERIOD',
    severity: 'WARNING',
    label: 'Employed for at least one day of the period',
    remedy: 'Confirm the joining or leaving date; pay is prorated to the days employed.',
  },
];

export const BLOCKING_CHECKS = PAYROLL_CHECKS.filter((c) => c.severity === 'BLOCKING').map(
  (c) => c.check,
);

/* ------------------------------------------------------------------ */
/* Payslip                                                             */
/* ------------------------------------------------------------------ */

export const PAYSLIP_STATES = [
  /** Generated and sealed, not yet visible to the employee. */
  'GENERATED',
  /** Visible to the employee. */
  'PUBLISHED',
  /** Superseded by a revision. Kept for the audit trail, never deleted. */
  'SUPERSEDED',
  /** The cycle was cancelled after generation. Not payable, not visible. */
  'VOIDED',
] as const;

export type PayslipState = (typeof PAYSLIP_STATES)[number];

/** Payroll runs. A correction never mutates a payslip; it issues a new one. */
export const PAYROLL_RUN_TYPES = ['REGULAR', 'SUPPLEMENTARY', 'OFF_CYCLE'] as const;
export type PayrollRunType = (typeof PAYROLL_RUN_TYPES)[number];

export const PAYSLIP_LINE_KINDS = ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'] as const;
export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];
