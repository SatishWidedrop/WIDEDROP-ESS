import { StateMachine } from './state-machine.js';
import type { Persona } from '../rbac/roles.js';

/**
 * The payroll pipeline.
 *
 * The order is fixed by the business:
 *
 *   Accounts uploads payroll data
 *     -> HR submits employee attendance
 *     -> the respective Manager reviews and approves attendance
 *     -> the system validates the required payroll inputs
 *     -> payroll and payslips are generated automatically
 *     -> the payslip becomes visible to the employee
 *
 * Each step is gated on the one before it three times over: by this machine, by
 * a check constraint and trigger in the database, and by the authorization check
 * on the route. A bug in one does not open the pipeline.
 *
 * State names match the `ess_payroll_cycle_status` enum exactly.
 */

export const PAYROLL_CYCLE_STATES = [
  /** The period exists. Nothing has been uploaded. */
  'DRAFT',
  /** Accounts is uploading payroll inputs; batches may still be replaced. */
  'INPUTS_OPEN',
  /** Accounts has closed the input window. HR may now submit attendance. */
  'INPUTS_LOCKED',
  /** HR has submitted attendance for every employee in scope. */
  'ATTENDANCE_SUBMITTED',
  /** Every manager who owed an approval has given it. */
  'ATTENDANCE_APPROVED',
  /** Pre-generation validation is running. */
  'VALIDATING',
  /** Validation found blocking problems. Inputs must be corrected. */
  'VALIDATION_FAILED',
  /** Every employee in scope has the inputs payroll needs. */
  'VALIDATED',
  /** Generation is running. A lock state: no other transition may interleave. */
  'CALCULATING',
  /** Payslips exist, immutable, and are not yet visible to employees. */
  'CALCULATED',
  /** Signed off inside Accounts. Still not visible to employees. */
  'APPROVED',
  /** Payslips are visible to their employees. */
  'PUBLISHED',
  /** The period is closed to further change. */
  'CLOSED',
  /** Abandoned before publication. Any generated payslips are revoked. */
  'CANCELLED',
] as const;

export type PayrollCycleState = (typeof PAYROLL_CYCLE_STATES)[number];

export const PAYROLL_CYCLE_EVENTS = [
  'UPLOAD_INPUTS',
  'LOCK_INPUTS',
  'REOPEN_INPUTS',
  'SUBMIT_ATTENDANCE',
  'RETURN_ATTENDANCE',
  'APPROVE_ATTENDANCE',
  'VALIDATE',
  'VALIDATION_PASSED',
  'VALIDATION_REJECTED',
  'CALCULATE',
  'CALCULATION_SUCCEEDED',
  'CALCULATION_FAILED',
  'APPROVE',
  'PUBLISH',
  'CLOSE',
  'CANCEL',
] as const;

export type PayrollCycleEvent = (typeof PAYROLL_CYCLE_EVENTS)[number];

export const payrollCycleMachine = new StateMachine<PayrollCycleState, PayrollCycleEvent>({
  name: 'payroll_cycle',
  initial: 'DRAFT',
  states: PAYROLL_CYCLE_STATES,
  transitions: [
    {
      from: 'DRAFT',
      to: 'INPUTS_OPEN',
      event: 'UPLOAD_INPUTS',
      description: 'Accounts uploads the first payroll input batch for the period.',
    },
    {
      from: 'INPUTS_OPEN',
      to: 'INPUTS_OPEN',
      event: 'UPLOAD_INPUTS',
      description: 'Accounts uploads a corrected or additional batch, superseding the last.',
    },
    {
      from: 'INPUTS_OPEN',
      to: 'INPUTS_LOCKED',
      event: 'LOCK_INPUTS',
      description: 'Accounts closes the input window so attendance can be submitted against it.',
    },
    {
      from: 'INPUTS_LOCKED',
      to: 'ATTENDANCE_SUBMITTED',
      event: 'SUBMIT_ATTENDANCE',
      description: 'HR submits attendance for every employee in the cycle.',
    },
    {
      from: 'ATTENDANCE_SUBMITTED',
      to: 'INPUTS_LOCKED',
      event: 'RETURN_ATTENDANCE',
      description: 'A manager returns their slice to HR with a reason; HR corrects and resubmits.',
    },
    {
      from: 'ATTENDANCE_SUBMITTED',
      to: 'ATTENDANCE_APPROVED',
      event: 'APPROVE_ATTENDANCE',
      description: 'The last outstanding manager approves their team’s attendance.',
    },
    {
      from: 'ATTENDANCE_APPROVED',
      to: 'VALIDATING',
      event: 'VALIDATE',
      description: 'Accounts runs the pre-generation validation checklist.',
    },
    {
      from: 'VALIDATING',
      to: 'VALIDATED',
      event: 'VALIDATION_PASSED',
      description: 'Every employee in scope has the inputs payroll needs.',
    },
    {
      from: 'VALIDATING',
      to: 'VALIDATION_FAILED',
      event: 'VALIDATION_REJECTED',
      description: 'Validation found blocking problems; each is recorded against its employee.',
    },
    {
      from: 'VALIDATION_FAILED',
      to: 'INPUTS_OPEN',
      event: 'REOPEN_INPUTS',
      description: 'Accounts reopens inputs to correct them; attendance must be approved again.',
    },
    {
      from: 'VALIDATED',
      to: 'CALCULATING',
      event: 'CALCULATE',
      description: 'Payroll generation starts. Nothing else may touch the cycle while it runs.',
    },
    {
      from: 'CALCULATING',
      to: 'CALCULATED',
      event: 'CALCULATION_SUCCEEDED',
      description: 'Payslips were generated and sealed for every employee in scope.',
    },
    {
      from: 'CALCULATING',
      to: 'VALIDATED',
      event: 'CALCULATION_FAILED',
      description:
        'Generation failed and rolled back; nothing was written and the run records why.',
    },
    {
      from: 'CALCULATED',
      to: 'APPROVED',
      event: 'APPROVE',
      description: 'Accounts signs the run off. Payslips are still not visible to employees.',
    },
    {
      from: 'APPROVED',
      to: 'PUBLISHED',
      event: 'PUBLISH',
      description: 'The cycle is published; payslips become visible to their employees.',
    },
    {
      from: 'PUBLISHED',
      to: 'CLOSED',
      event: 'CLOSE',
      description: 'The period is closed; corrections go through a supplementary run.',
    },
    // A cycle can be abandoned at any point before publication — never after,
    // because an employee may already have downloaded their payslip.
    ...(
      [
        'DRAFT',
        'INPUTS_OPEN',
        'INPUTS_LOCKED',
        'ATTENDANCE_SUBMITTED',
        'ATTENDANCE_APPROVED',
        'VALIDATION_FAILED',
        'VALIDATED',
        'CALCULATED',
        'APPROVED',
      ] as const
    ).map((from) => ({
      from,
      to: 'CANCELLED' as const,
      event: 'CANCEL' as const,
      description: 'Accounts cancels the cycle; any generated payslips are revoked.',
    })),
  ],
});

/**
 * Which persona may raise each event. Enforced server-side per request; events
 * marked `null` are raised by the system as the outcome of a previous one and
 * can never be requested by a user.
 */
export const PAYROLL_EVENT_ACTOR: Record<PayrollCycleEvent, Persona | null> = {
  UPLOAD_INPUTS: 'ACCOUNTS',
  LOCK_INPUTS: 'ACCOUNTS',
  REOPEN_INPUTS: 'ACCOUNTS',
  SUBMIT_ATTENDANCE: 'HR',
  RETURN_ATTENDANCE: 'MANAGER',
  APPROVE_ATTENDANCE: 'MANAGER',
  VALIDATE: 'ACCOUNTS',
  VALIDATION_PASSED: null,
  VALIDATION_REJECTED: null,
  CALCULATE: 'ACCOUNTS',
  CALCULATION_SUCCEEDED: null,
  CALCULATION_FAILED: null,
  APPROVE: 'ACCOUNTS',
  PUBLISH: 'ACCOUNTS',
  CLOSE: 'ACCOUNTS',
  CANCEL: 'ACCOUNTS',
};

/**
 * States in which payslip rows may exist at all. Mirrored by a database trigger:
 * a payslip whose cycle is in any other state cannot be inserted.
 */
export const STATES_WITH_PAYSLIPS: readonly PayrollCycleState[] = [
  'CALCULATING',
  'CALCULATED',
  'APPROVED',
  'PUBLISHED',
  'CLOSED',
  'CANCELLED',
];

/** The only states in which an employee may read their own payslip. */
export const EMPLOYEE_VISIBLE_STATES: readonly PayrollCycleState[] = ['PUBLISHED', 'CLOSED'];

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
 * The checklist the system runs before generating payroll. Every check runs for
 * every employee in the cycle and its result is persisted, so the run is
 * auditable and every exclusion carries a recorded reason.
 */
export const PAYROLL_VALIDATION_CHECKS = [
  'SALARY_STRUCTURE_EFFECTIVE',
  'ATTENDANCE_APPROVED',
  'BANK_DETAILS_VERIFIED',
  'STATUTORY_IDS_PRESENT',
  'TAX_REGIME_ELECTED',
  'NO_UNRESOLVED_INPUT_ERRORS',
  'NO_EXISTING_PAYSLIP',
  'EMPLOYMENT_ACTIVE_IN_PERIOD',
] as const;

export type PayrollValidationCheck = (typeof PAYROLL_VALIDATION_CHECKS)[number];

/** Matches the `ess_payroll_validation_severity` enum. */
export type ValidationSeverity = 'INFO' | 'WARNING' | 'ERROR';

export interface PayrollCheckDefinition {
  check: PayrollValidationCheck;
  severity: ValidationSeverity;
  /** Shown to Accounts on the validation report. */
  label: string;
  /** What Accounts or HR must do to clear it. */
  remedy: string;
}

/**
 * An ERROR excludes that employee from the run with a recorded reason; the cycle
 * itself fails only when every employee is excluded. That is deliberate: one
 * person's missing bank account must not stop an organisation being paid, and
 * they must not be paid approximately either — they are excluded visibly and
 * picked up by a supplementary run.
 */
export const PAYROLL_CHECKS: readonly PayrollCheckDefinition[] = [
  {
    check: 'SALARY_STRUCTURE_EFFECTIVE',
    severity: 'ERROR',
    label: 'Salary structure effective for the period',
    remedy: 'Accounts uploads an effective-dated salary structure for this employee.',
  },
  {
    check: 'ATTENDANCE_APPROVED',
    severity: 'ERROR',
    label: 'Attendance approved by the reporting manager',
    remedy: 'The reporting manager approves the attendance slice for this period.',
  },
  {
    check: 'BANK_DETAILS_VERIFIED',
    severity: 'ERROR',
    label: 'Verified bank account on file',
    remedy: 'The employee submits bank details and Payroll verifies the cancelled cheque.',
  },
  {
    check: 'STATUTORY_IDS_PRESENT',
    severity: 'ERROR',
    label: 'PAN and, where applicable, UAN on file',
    remedy: 'The employee submits the missing identifier through My profile.',
  },
  {
    check: 'TAX_REGIME_ELECTED',
    severity: 'ERROR',
    label: 'Tax regime elected for the financial year',
    remedy: 'The employee elects a regime, or HR records the statutory default against them.',
  },
  {
    check: 'NO_UNRESOLVED_INPUT_ERRORS',
    severity: 'ERROR',
    label: 'No unresolved errors in the uploaded payroll inputs',
    remedy: 'Accounts corrects the flagged rows and uploads the batch again.',
  },
  {
    check: 'NO_EXISTING_PAYSLIP',
    severity: 'ERROR',
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

export const BLOCKING_CHECKS = PAYROLL_CHECKS.filter((c) => c.severity === 'ERROR').map(
  (c) => c.check,
);

export function checkDefinition(check: PayrollValidationCheck): PayrollCheckDefinition {
  const found = PAYROLL_CHECKS.find((c) => c.check === check);
  if (!found) throw new Error(`Unknown payroll validation check: ${check}`);
  return found;
}

/* ------------------------------------------------------------------ */
/* Payslip                                                             */
/* ------------------------------------------------------------------ */

/** Matches the `ess_payslip_status` enum. */
export const PAYSLIP_STATES = ['GENERATED', 'PUBLISHED', 'SUPERSEDED', 'REVOKED'] as const;
export type PayslipState = (typeof PAYSLIP_STATES)[number];

/** Matches the `ess_payroll_run_type` enum. A correction never edits a payslip. */
export const PAYROLL_RUN_TYPES = ['REGULAR', 'SUPPLEMENTARY', 'OFF_CYCLE'] as const;
export type PayrollRunType = (typeof PAYROLL_RUN_TYPES)[number];

/** Matches the `ess_payslip_line_kind` enum. */
export const PAYSLIP_LINE_KINDS = [
  'EARNING',
  'DEDUCTION',
  'EMPLOYER_CONTRIBUTION',
  'INFORMATIONAL',
] as const;
export type PayslipLineKind = (typeof PAYSLIP_LINE_KINDS)[number];
