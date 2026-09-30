import { z } from 'zod';
import { freeText, id, isoDate, paise, phone, safeString } from './common.js';

/**
 * Request schemas for the self-service modules.
 *
 * Every one is `.strict()`: an unknown key is a rejected request. That is the
 * whole of the mass-assignment defence — a client cannot smuggle `status`,
 * `approvedAmountMinor` or `employeeId` into a body and have it land in a
 * column, because the schema does not know those words.
 *
 * Nothing here accepts a computed value. Day counts, totals, references and
 * statuses are the server's to derive; the client sends the facts a person
 * typed and nothing else.
 */

/* ------------------------------------------------------------------ */
/* Leave                                                               */
/* ------------------------------------------------------------------ */

export const leaveDayPortion = z.enum(['FULL', 'FIRST_HALF', 'SECOND_HALF']);

export const leaveRequestCreate = z
  .object({
    leaveTypeId: id,
    startDate: isoDate,
    endDate: isoDate,
    startPortion: leaveDayPortion.default('FULL'),
    endPortion: leaveDayPortion.default('FULL'),
    reason: freeText(1_000).optional(),
  })
  .strict()
  .refine((value) => value.endDate >= value.startDate, {
    message: 'The end date cannot be before the start date',
    path: ['endDate'],
  });

export type LeaveRequestCreate = z.infer<typeof leaveRequestCreate>;

export const leaveDecision = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: freeText(1_000).optional(),
  })
  .strict()
  .refine((value) => value.decision === 'APPROVE' || (value.note?.trim().length ?? 0) > 0, {
    message: 'Give a reason when declining a request',
    path: ['note'],
  });

export type LeaveDecision = z.infer<typeof leaveDecision>;

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export const expenseClaimLine = z
  .object({
    expenseCategoryId: id,
    description: safeString(2, 200),
    spendDate: isoDate,
    /** Whole paise. Money is never a float anywhere in this system. */
    amountMinor: paise,
  })
  .strict();

export const expenseClaimCreate = z
  .object({
    title: safeString(2, 120),
    lines: z.array(expenseClaimLine).min(1).max(50),
  })
  .strict();

export type ExpenseClaimCreate = z.infer<typeof expenseClaimCreate>;

export const expenseDecision = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT']),
    note: freeText(1_000).optional(),
    /** Accounts only: what is actually payable after a cap. */
    approvedAmountMinor: paise.optional(),
  })
  .strict()
  .refine((value) => value.decision === 'APPROVE' || (value.note?.trim().length ?? 0) > 0, {
    message: 'Give a reason when declining a claim',
    path: ['note'],
  });

export type ExpenseDecision = z.infer<typeof expenseDecision>;

/* ------------------------------------------------------------------ */
/* Help desk                                                           */
/* ------------------------------------------------------------------ */

export const ticketCreate = z
  .object({
    ticketCategoryId: id,
    subject: safeString(4, 160),
    description: freeText(5_000).refine((value) => value.trim().length >= 10, {
      message: 'Describe the problem in a sentence or two so the help desk can act on it',
    }),
    priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).default('NORMAL'),
  })
  .strict();

export type TicketCreate = z.infer<typeof ticketCreate>;

export const ticketComment = z
  .object({
    body: freeText(5_000).refine((value) => value.trim().length > 0, {
      message: 'A comment cannot be empty',
    }),
    /** Help desk only; never returned to the requester. */
    internal: z.boolean().default(false),
  })
  .strict();

export const ticketTransition = z
  .object({
    event: z.enum([
      'ASSIGN',
      'START',
      'REQUEST_INFO',
      'REQUESTER_REPLIED',
      'RESOLVE',
      'CLOSE',
      'REOPEN',
      'CANCEL',
    ]),
    assigneeEmployeeId: id.optional(),
    resolutionNote: freeText(2_000).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export const policyAcknowledge = z
  .object({
    /**
     * The version the person actually read, echoed back. A mismatch with the
     * current version means they read something that has since been replaced,
     * and the acknowledgement is refused rather than recorded against text
     * they never saw.
     */
    policyVersionId: id,
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Documents                                                           */
/* ------------------------------------------------------------------ */

export const documentRequestCreate = z
  .object({
    documentTypeId: id,
    addressee: safeString(2, 160).optional(),
    purpose: freeText(500).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Profile                                                             */
/* ------------------------------------------------------------------ */

/**
 * A change an employee may make directly: their own emergency contacts.
 * Everything else goes through a change request HR verifies.
 */
export const emergencyContactWrite = z
  .object({
    name: safeString(2, 120),
    relationship: safeString(2, 60),
    phone,
    isPrimary: z.boolean().default(false),
  })
  .strict();

export const profileChangeRequestCreate = z
  .object({
    section: z.enum(['personal', 'bank', 'statutory', 'emergency']),
    /**
     * The fields being asked for, as plain strings. Validated against the
     * section's allowed keys on the server — a key the section does not own is
     * a rejected request, not an ignored one.
     */
    changes: z.record(safeString(1, 200)).refine((value) => Object.keys(value).length > 0, {
      message: 'Name at least one field to change',
    }),
    reason: freeText(1_000).optional(),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Tax                                                                 */
/* ------------------------------------------------------------------ */

export const taxRegimeElection = z
  .object({
    fiscalYearStartYear: z.number().int().min(2000).max(2100),
    regime: z.enum(['OLD', 'NEW']),
  })
  .strict();

export const taxDeclarationItem = z
  .object({
    sectionCode: safeString(2, 12),
    label: safeString(2, 120),
    declaredMinor: paise,
    note: freeText(500).optional(),
  })
  .strict();

export const taxDeclarationSave = z
  .object({
    fiscalYearStartYear: z.number().int().min(2000).max(2100),
    items: z.array(taxDeclarationItem).max(40),
    submit: z.boolean().default(false),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Benefits                                                            */
/* ------------------------------------------------------------------ */

export const benefitEnrol = z
  .object({
    benefitPlanYearId: id,
    dependentIds: z.array(id).max(10).default([]),
  })
  .strict();

export const dependentWrite = z
  .object({
    fullName: safeString(2, 120),
    relationship: z.enum([
      'SPOUSE',
      'SON',
      'DAUGHTER',
      'FATHER',
      'MOTHER',
      'FATHER_IN_LAW',
      'MOTHER_IN_LAW',
      'SIBLING',
      'OTHER',
    ]),
    dateOfBirth: isoDate.optional(),
    gender: z.enum(['FEMALE', 'MALE', 'NON_BINARY', 'UNDISCLOSED']).default('UNDISCLOSED'),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

export const attendanceRecordCorrection = z
  .object({
    presentDays: z.number().min(0).max(31),
    paidLeaveDays: z.number().min(0).max(31),
    unpaidLeaveDays: z.number().min(0).max(31),
    holidayDays: z.number().min(0).max(31),
    weekOffDays: z.number().min(0).max(31),
    absentDays: z.number().min(0).max(31),
    note: freeText(500).optional(),
  })
  .strict();

export const attendanceDecision = z
  .object({
    decision: z.enum(['APPROVE', 'RETURN']),
    returnReason: freeText(1_000).optional(),
  })
  .strict()
  .refine((value) => value.decision === 'APPROVE' || (value.returnReason?.trim().length ?? 0) > 0, {
    message: 'Say what needs correcting',
    path: ['returnReason'],
  });

/* ------------------------------------------------------------------ */
/* Announcements                                                       */
/* ------------------------------------------------------------------ */

export const announcementCreate = z
  .object({
    title: safeString(4, 160),
    departmentLabel: safeString(2, 60),
    paragraphs: z.array(freeText(4_000)).min(1).max(30),
    isPinned: z.boolean().default(false),
    expiresAt: isoDate.optional(),
    audience: z
      .array(
        z
          .object({
            kind: z.enum(['ALL', 'DEPARTMENT', 'LOCATION', 'EMPLOYMENT_TYPE', 'EMPLOYEE']),
            targetId: id.optional(),
            targetValue: safeString(1, 60).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

/* ------------------------------------------------------------------ */
/* Payroll — Accounts                                                  */
/* ------------------------------------------------------------------ */

export const payrollCycleCreate = z
  .object({
    year: z.number().int().min(2000).max(2100),
    month: z.number().int().min(1).max(12),
    payDate: isoDate,
  })
  .strict();

export const payrollCycleEvent = z
  .object({
    /**
     * The events a person may request. The outcome events the system raises
     * for itself — VALIDATION_PASSED, VALIDATION_REJECTED,
     * CALCULATION_SUCCEEDED, CALCULATION_FAILED — are deliberately absent:
     * they are conclusions, not requests, and the server refuses them here.
     */
    event: z.enum([
      'UPLOAD_INPUTS',
      'LOCK_INPUTS',
      'REOPEN_INPUTS',
      'SUBMIT_ATTENDANCE',
      'RETURN_ATTENDANCE',
      'APPROVE_ATTENDANCE',
      'APPROVE',
      'PUBLISH',
      'CLOSE',
      'CANCEL',
    ]),
    note: freeText(1_000).optional(),
  })
  .strict();

export const payrollInputItemCreate = z
  .object({
    employeeId: id,
    kind: z.enum([
      'VARIABLE_PAY',
      'INCENTIVE',
      'BONUS',
      'ARREAR',
      'ONE_OFF_DEDUCTION',
      'LOP_OVERRIDE',
      'REIMBURSEMENT_PAYOUT',
      'ADVANCE_RECOVERY',
      'TDS_OVERRIDE',
    ]),
    amountMinor: paise,
    note: freeText(300).optional(),
  })
  .strict();

export const payrollInputBatchCreate = z
  .object({
    payrollCycleId: id,
    items: z.array(payrollInputItemCreate).min(1).max(2_000),
    /** The file this batch came from, for the audit trail. */
    sourceFilename: safeString(1, 255).optional(),
  })
  .strict();
