import { StateMachine } from './state-machine.js';

/**
 * The remaining workflow state machines.
 *
 * Each is declared once and shared by the API and the UI, so a screen can only
 * offer an action the server would actually allow, and the server never relies
 * on the screen having offered it.
 */

/* ------------------------------------------------------------------ */
/* Attendance                                                          */
/* ------------------------------------------------------------------ */

export const ATTENDANCE_PERIOD_STATES = [
  /** Open for HR data entry. */
  'OPEN',
  /** HR has submitted; managers are reviewing. */
  'SUBMITTED',
  /** A manager sent it back; HR is correcting it. */
  'RETURNED',
  /** Every manager who owed an approval has given it. */
  'APPROVED',
  /** Consumed by a payroll cycle; no further edits. */
  'LOCKED',
] as const;
export type AttendancePeriodState = (typeof ATTENDANCE_PERIOD_STATES)[number];

export type AttendancePeriodEvent = 'SUBMIT' | 'RETURN' | 'APPROVE_ALL' | 'LOCK' | 'REOPEN';

export const attendancePeriodMachine = new StateMachine<
  AttendancePeriodState,
  AttendancePeriodEvent
>({
  name: 'attendance-period',
  initial: 'OPEN',
  states: ATTENDANCE_PERIOD_STATES,
  transitions: [
    { from: 'OPEN', to: 'SUBMITTED', event: 'SUBMIT', description: 'HR submits the period for manager review.' },
    { from: 'SUBMITTED', to: 'RETURNED', event: 'RETURN', description: 'A manager returns the period to HR with a reason.' },
    { from: 'RETURNED', to: 'SUBMITTED', event: 'SUBMIT', description: 'HR resubmits after correcting the flagged records.' },
    { from: 'SUBMITTED', to: 'APPROVED', event: 'APPROVE_ALL', description: 'The last outstanding manager approves.' },
    { from: 'APPROVED', to: 'LOCKED', event: 'LOCK', description: 'A payroll cycle consumes the period.' },
    { from: 'APPROVED', to: 'SUBMITTED', event: 'REOPEN', description: 'HR reopens the period before payroll consumes it.' },
  ],
});

/** A manager's approval of their own slice of a period. */
export const ATTENDANCE_APPROVAL_STATES = ['PENDING', 'APPROVED', 'RETURNED'] as const;
export type AttendanceApprovalState = (typeof ATTENDANCE_APPROVAL_STATES)[number];

/** How a day in an attendance record is classified. Drives loss-of-pay. */
export const DAY_CLASSIFICATIONS = [
  'PRESENT',
  'PAID_LEAVE',
  'UNPAID_LEAVE',
  'HOLIDAY',
  'WEEK_OFF',
  'ABSENT',
] as const;
export type DayClassification = (typeof DAY_CLASSIFICATIONS)[number];

/** Classifications that are paid. Everything else reduces payable days. */
export const PAID_CLASSIFICATIONS: readonly DayClassification[] = [
  'PRESENT',
  'PAID_LEAVE',
  'HOLIDAY',
  'WEEK_OFF',
];

export function isPaidDay(classification: DayClassification): boolean {
  return PAID_CLASSIFICATIONS.includes(classification);
}

/* ------------------------------------------------------------------ */
/* Leave                                                               */
/* ------------------------------------------------------------------ */

export const LEAVE_REQUEST_STATES = [
  'DRAFT',
  /** Submitted; balance is reserved from this point. */
  'PENDING',
  'APPROVED',
  'REJECTED',
  /** Withdrawn by the employee before a decision. */
  'WITHDRAWN',
  /** Cancelled after approval, before the leave started. */
  'CANCELLED',
] as const;
export type LeaveRequestState = (typeof LEAVE_REQUEST_STATES)[number];

export type LeaveRequestEvent = 'SUBMIT' | 'APPROVE' | 'REJECT' | 'WITHDRAW' | 'CANCEL';

export const leaveRequestMachine = new StateMachine<LeaveRequestState, LeaveRequestEvent>({
  name: 'leave-request',
  initial: 'DRAFT',
  states: LEAVE_REQUEST_STATES,
  transitions: [
    { from: 'DRAFT', to: 'PENDING', event: 'SUBMIT', description: 'The employee submits the request; the balance is reserved.' },
    { from: 'PENDING', to: 'APPROVED', event: 'APPROVE', description: 'The reporting manager approves; the reservation is consumed.' },
    { from: 'PENDING', to: 'REJECTED', event: 'REJECT', description: 'The reporting manager rejects; the reservation is released.' },
    { from: 'PENDING', to: 'WITHDRAWN', event: 'WITHDRAW', description: 'The employee withdraws; the reservation is released.' },
    { from: 'APPROVED', to: 'CANCELLED', event: 'CANCEL', description: 'Cancelled before the leave started; the balance is credited back.' },
  ],
});

/** States that hold a claim on the employee's leave balance. */
export const LEAVE_STATES_HOLDING_BALANCE: readonly LeaveRequestState[] = ['PENDING', 'APPROVED'];

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export const EXPENSE_CLAIM_STATES = [
  'DRAFT',
  /** Awaiting the reporting manager. */
  'PENDING_MANAGER',
  /** Manager approved; Accounts must verify the bills. */
  'PENDING_ACCOUNTS',
  /** Verified and queued for the payroll cycle that will pay it. */
  'APPROVED',
  /** Paid with a named payroll cycle. */
  'REIMBURSED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type ExpenseClaimState = (typeof EXPENSE_CLAIM_STATES)[number];

export type ExpenseClaimEvent =
  | 'SUBMIT'
  | 'MANAGER_APPROVE'
  | 'MANAGER_REJECT'
  | 'ACCOUNTS_VERIFY'
  | 'ACCOUNTS_REJECT'
  | 'REIMBURSE'
  | 'WITHDRAW';

export const expenseClaimMachine = new StateMachine<ExpenseClaimState, ExpenseClaimEvent>({
  name: 'expense-claim',
  initial: 'DRAFT',
  states: EXPENSE_CLAIM_STATES,
  transitions: [
    { from: 'DRAFT', to: 'PENDING_MANAGER', event: 'SUBMIT', description: 'The employee submits the claim with its bills.' },
    { from: 'PENDING_MANAGER', to: 'PENDING_ACCOUNTS', event: 'MANAGER_APPROVE', description: 'The reporting manager approves the business purpose.' },
    { from: 'PENDING_MANAGER', to: 'REJECTED', event: 'MANAGER_REJECT', description: 'The reporting manager rejects with a reason.' },
    { from: 'PENDING_MANAGER', to: 'WITHDRAWN', event: 'WITHDRAW', description: 'The employee withdraws before a decision.' },
    { from: 'PENDING_ACCOUNTS', to: 'APPROVED', event: 'ACCOUNTS_VERIFY', description: 'Accounts verifies the bills and the category cap.' },
    { from: 'PENDING_ACCOUNTS', to: 'REJECTED', event: 'ACCOUNTS_REJECT', description: 'Accounts rejects with a reason.' },
    { from: 'APPROVED', to: 'REIMBURSED', event: 'REIMBURSE', description: 'Paid with a named payroll cycle.' },
  ],
});

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export const POLICY_VERSION_STATES = [
  'DRAFT',
  /** Live from its effective date; employees must acknowledge it. */
  'PUBLISHED',
  /** A newer version has been published. Prior acknowledgements stay valid. */
  'SUPERSEDED',
  /** Withdrawn without a successor. No acknowledgement is expected. */
  'ARCHIVED',
] as const;
export type PolicyVersionState = (typeof POLICY_VERSION_STATES)[number];

export type PolicyVersionEvent = 'PUBLISH' | 'SUPERSEDE' | 'ARCHIVE';

export const policyVersionMachine = new StateMachine<PolicyVersionState, PolicyVersionEvent>({
  name: 'policy-version',
  initial: 'DRAFT',
  states: POLICY_VERSION_STATES,
  transitions: [
    { from: 'DRAFT', to: 'PUBLISHED', event: 'PUBLISH', description: 'HR publishes the version with an effective date.' },
    { from: 'PUBLISHED', to: 'SUPERSEDED', event: 'SUPERSEDE', description: 'A newer version is published in its place.' },
    { from: 'PUBLISHED', to: 'ARCHIVED', event: 'ARCHIVE', description: 'HR withdraws the policy without a successor.' },
    { from: 'DRAFT', to: 'ARCHIVED', event: 'ARCHIVE', description: 'HR discards the draft.' },
  ],
});

/**
 * An acknowledgement is recorded against a specific policy version and never
 * moves. When a new version publishes, the employee's prior acknowledgement
 * stays valid for the version it was given for, and a fresh PENDING row appears
 * for the new one.
 */
export const ACKNOWLEDGEMENT_STATES = ['PENDING', 'ACKNOWLEDGED', 'OVERDUE', 'WAIVED'] as const;
export type AcknowledgementState = (typeof ACKNOWLEDGEMENT_STATES)[number];

/* ------------------------------------------------------------------ */
/* Help desk                                                           */
/* ------------------------------------------------------------------ */

export const TICKET_STATES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  /** Waiting on the person who raised it. The SLA clock is paused. */
  'AWAITING_REQUESTER',
  'RESOLVED',
  'CLOSED',
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export type TicketEvent =
  | 'ASSIGN'
  | 'START'
  | 'REQUEST_INFO'
  | 'REQUESTER_REPLIED'
  | 'RESOLVE'
  | 'CLOSE'
  | 'REOPEN';

export const ticketMachine = new StateMachine<TicketState, TicketEvent>({
  name: 'helpdesk-ticket',
  initial: 'OPEN',
  states: TICKET_STATES,
  transitions: [
    { from: 'OPEN', to: 'ASSIGNED', event: 'ASSIGN', description: 'The ticket is assigned to an owner.' },
    { from: 'ASSIGNED', to: 'IN_PROGRESS', event: 'START', description: 'The owner starts work.' },
    { from: 'OPEN', to: 'IN_PROGRESS', event: 'START', description: 'An owner picks the ticket up directly.' },
    { from: 'IN_PROGRESS', to: 'AWAITING_REQUESTER', event: 'REQUEST_INFO', description: 'The owner asks the requester for more detail.' },
    { from: 'AWAITING_REQUESTER', to: 'IN_PROGRESS', event: 'REQUESTER_REPLIED', description: 'The requester replies and the clock resumes.' },
    { from: 'IN_PROGRESS', to: 'RESOLVED', event: 'RESOLVE', description: 'The owner resolves the ticket.' },
    { from: 'ASSIGNED', to: 'RESOLVED', event: 'RESOLVE', description: 'The owner resolves it without further work.' },
    { from: 'RESOLVED', to: 'CLOSED', event: 'CLOSE', description: 'Closed by the requester or automatically after the grace period.' },
    { from: 'RESOLVED', to: 'IN_PROGRESS', event: 'REOPEN', description: 'The requester reopens it within the grace period.' },
    { from: 'CLOSED', to: 'IN_PROGRESS', event: 'REOPEN', description: 'Reopened by the help desk.' },
  ],
});

/** States in which the first-response and resolution SLA clocks run. */
export const SLA_RUNNING_STATES: readonly TicketState[] = ['OPEN', 'ASSIGNED', 'IN_PROGRESS'];

/* ------------------------------------------------------------------ */
/* Documents & letters                                                 */
/* ------------------------------------------------------------------ */

export const DOCUMENT_REQUEST_STATES = [
  'REQUESTED',
  'IN_PROGRESS',
  /** The generated PDF is stored and downloadable. */
  'ISSUED',
  'REJECTED',
  'CANCELLED',
] as const;
export type DocumentRequestState = (typeof DOCUMENT_REQUEST_STATES)[number];

export type DocumentRequestEvent = 'START' | 'ISSUE' | 'REJECT' | 'CANCEL';

export const documentRequestMachine = new StateMachine<DocumentRequestState, DocumentRequestEvent>({
  name: 'document-request',
  initial: 'REQUESTED',
  states: DOCUMENT_REQUEST_STATES,
  transitions: [
    { from: 'REQUESTED', to: 'IN_PROGRESS', event: 'START', description: 'HR picks up the request.' },
    { from: 'REQUESTED', to: 'CANCELLED', event: 'CANCEL', description: 'The employee cancels before it is picked up.' },
    { from: 'IN_PROGRESS', to: 'ISSUED', event: 'ISSUE', description: 'HR issues the letter; the PDF is stored against the request.' },
    { from: 'IN_PROGRESS', to: 'REJECTED', event: 'REJECT', description: 'HR declines the request with a reason.' },
  ],
});

/* ------------------------------------------------------------------ */
/* Profile change requests                                             */
/* ------------------------------------------------------------------ */

export const CHANGE_REQUEST_STATES = [
  'SUBMITTED',
  /** HR or Payroll is checking the supporting proof. */
  'UNDER_REVIEW',
  /** Applied to the employee record, with a before/after audit entry. */
  'APPLIED',
  'REJECTED',
  'WITHDRAWN',
] as const;
export type ChangeRequestState = (typeof CHANGE_REQUEST_STATES)[number];

export type ChangeRequestEvent = 'REVIEW' | 'APPROVE' | 'REJECT' | 'WITHDRAW';

export const changeRequestMachine = new StateMachine<ChangeRequestState, ChangeRequestEvent>({
  name: 'profile-change-request',
  initial: 'SUBMITTED',
  states: CHANGE_REQUEST_STATES,
  transitions: [
    { from: 'SUBMITTED', to: 'UNDER_REVIEW', event: 'REVIEW', description: 'HR or Payroll begins verification.' },
    { from: 'SUBMITTED', to: 'WITHDRAWN', event: 'WITHDRAW', description: 'The employee withdraws the request.' },
    { from: 'UNDER_REVIEW', to: 'APPLIED', event: 'APPROVE', description: 'The change is applied to the employee record.' },
    { from: 'UNDER_REVIEW', to: 'REJECTED', event: 'REJECT', description: 'The change is declined with a reason.' },
  ],
});

/* ------------------------------------------------------------------ */
/* Employment lifecycle                                                */
/* ------------------------------------------------------------------ */

export const EMPLOYMENT_STATES = [
  /** Invited but not yet activated. Cannot sign in. */
  'INVITED',
  'ACTIVE',
  /** Access revoked, employment continues (investigation, long leave). */
  'SUSPENDED',
  /** Serving notice. Still paid, still in payroll scope. */
  'NOTICE_PERIOD',
  /** Left. No access. Excluded from new payroll cycles; history is retained. */
  'OFFBOARDED',
] as const;
export type EmploymentState = (typeof EMPLOYMENT_STATES)[number];

export type EmploymentEvent =
  | 'ACTIVATE'
  | 'SUSPEND'
  | 'REINSTATE'
  | 'START_NOTICE'
  | 'OFFBOARD'
  | 'REVOKE_INVITE';

export const employmentMachine = new StateMachine<EmploymentState, EmploymentEvent>({
  name: 'employment',
  initial: 'INVITED',
  states: EMPLOYMENT_STATES,
  transitions: [
    { from: 'INVITED', to: 'ACTIVE', event: 'ACTIVATE', description: 'The employee accepts the invitation and sets a password.' },
    { from: 'INVITED', to: 'OFFBOARDED', event: 'REVOKE_INVITE', description: 'HR revokes an invitation that was never accepted.' },
    { from: 'ACTIVE', to: 'SUSPENDED', event: 'SUSPEND', description: 'HR suspends access; every session is revoked.' },
    { from: 'SUSPENDED', to: 'ACTIVE', event: 'REINSTATE', description: 'HR restores access.' },
    { from: 'ACTIVE', to: 'NOTICE_PERIOD', event: 'START_NOTICE', description: 'Resignation accepted; the last working day is recorded.' },
    { from: 'NOTICE_PERIOD', to: 'ACTIVE', event: 'REINSTATE', description: 'The resignation is withdrawn.' },
    { from: 'NOTICE_PERIOD', to: 'OFFBOARDED', event: 'OFFBOARD', description: 'The last working day passes; access ends.' },
    { from: 'ACTIVE', to: 'OFFBOARDED', event: 'OFFBOARD', description: 'Employment ends immediately.' },
    { from: 'SUSPENDED', to: 'OFFBOARDED', event: 'OFFBOARD', description: 'Employment ends during suspension.' },
  ],
});

/** Employment states that may sign in. */
export const STATES_ALLOWING_SIGN_IN: readonly EmploymentState[] = ['ACTIVE', 'NOTICE_PERIOD'];

/** Employment states included in a new payroll cycle. */
export const STATES_IN_PAYROLL_SCOPE: readonly EmploymentState[] = [
  'ACTIVE',
  'NOTICE_PERIOD',
  'SUSPENDED',
];

/* ------------------------------------------------------------------ */
/* Transactional email outbox                                          */
/* ------------------------------------------------------------------ */

export const OUTBOX_STATES = ['QUEUED', 'SENDING', 'SENT', 'FAILED', 'DEAD_LETTER'] as const;
export type OutboxState = (typeof OUTBOX_STATES)[number];

/** Delivery attempts before a message is parked for manual attention. */
export const OUTBOX_MAX_ATTEMPTS = 6;

/** Exponential backoff in seconds: 30s, 2m, 8m, 32m, 2h8m, 8h32m. */
export function outboxRetryDelaySeconds(attempt: number): number {
  return 30 * 4 ** Math.max(0, attempt - 1);
}
