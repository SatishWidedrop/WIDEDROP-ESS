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
  /** HR has submitted the period. */
  'HR_SUBMITTED',
  /** Managers are reviewing their slices. */
  'MANAGER_APPROVAL_PENDING',
  /** Every manager who owed an approval has given it. */
  'APPROVED',
  /** Consumed by a payroll cycle; no further edits. */
  'LOCKED',
  /** A manager returned a slice, or HR reopened it before payroll consumed it. */
  'REOPENED',
] as const;
export type AttendancePeriodState = (typeof ATTENDANCE_PERIOD_STATES)[number];

export type AttendancePeriodEvent =
  'SUBMIT' | 'ROUTE_TO_MANAGERS' | 'RETURN' | 'APPROVE_ALL' | 'LOCK' | 'REOPEN';

export const attendancePeriodMachine = new StateMachine<
  AttendancePeriodState,
  AttendancePeriodEvent
>({
  name: 'attendance_period',
  initial: 'OPEN',
  states: ATTENDANCE_PERIOD_STATES,
  transitions: [
    { from: 'OPEN', to: 'HR_SUBMITTED', event: 'SUBMIT', description: 'HR submits the period.' },
    {
      from: 'HR_SUBMITTED',
      to: 'MANAGER_APPROVAL_PENDING',
      event: 'ROUTE_TO_MANAGERS',
      description: 'One approval task is raised per manager with people in the period.',
    },
    {
      from: 'MANAGER_APPROVAL_PENDING',
      to: 'REOPENED',
      event: 'RETURN',
      description: 'A manager returns their slice to HR with a reason.',
    },
    {
      from: 'REOPENED',
      to: 'HR_SUBMITTED',
      event: 'SUBMIT',
      description: 'HR resubmits after correcting the flagged records.',
    },
    {
      from: 'MANAGER_APPROVAL_PENDING',
      to: 'APPROVED',
      event: 'APPROVE_ALL',
      description: 'The last outstanding manager approves.',
    },
    {
      from: 'APPROVED',
      to: 'LOCKED',
      event: 'LOCK',
      description: 'A payroll cycle consumes the period.',
    },
    {
      from: 'APPROVED',
      to: 'REOPENED',
      event: 'REOPEN',
      description: 'HR reopens the period before payroll consumes it.',
    },
  ],
});

/** A manager's approval of their own slice of a period. */
export const ATTENDANCE_APPROVAL_STATES = [
  'PENDING',
  'APPROVED',
  'REJECTED',
  'AUTO_ESCALATED',
] as const;
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
  'PENDING_APPROVAL',
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
  name: 'leave_request',
  initial: 'DRAFT',
  states: LEAVE_REQUEST_STATES,
  transitions: [
    {
      from: 'DRAFT',
      to: 'PENDING_APPROVAL',
      event: 'SUBMIT',
      description: 'The employee submits the request; the balance is reserved.',
    },
    {
      from: 'PENDING_APPROVAL',
      to: 'APPROVED',
      event: 'APPROVE',
      description: 'The reporting manager approves; the reservation is consumed.',
    },
    {
      from: 'PENDING_APPROVAL',
      to: 'REJECTED',
      event: 'REJECT',
      description: 'The reporting manager rejects; the reservation is released.',
    },
    {
      from: 'PENDING_APPROVAL',
      to: 'WITHDRAWN',
      event: 'WITHDRAW',
      description: 'The employee withdraws; the reservation is released.',
    },
    {
      from: 'APPROVED',
      to: 'CANCELLED',
      event: 'CANCEL',
      description: 'Cancelled before the leave started; the balance is credited back.',
    },
  ],
});

/** States that hold a claim on the employee's leave balance. */
export const LEAVE_STATES_HOLDING_BALANCE: readonly LeaveRequestState[] = [
  'PENDING_APPROVAL',
  'APPROVED',
];

/* ------------------------------------------------------------------ */
/* Expenses                                                            */
/* ------------------------------------------------------------------ */

export const EXPENSE_CLAIM_STATES = [
  'DRAFT',
  /** Submitted; routing to the reporting manager. */
  'SUBMITTED',
  /** Awaiting the reporting manager's decision. */
  'PENDING_MANAGER',
  'MANAGER_APPROVED',
  'MANAGER_REJECTED',
  /** The manager approved; Accounts must verify the bills and the caps. */
  'PENDING_FINANCE',
  'FINANCE_APPROVED',
  'FINANCE_REJECTED',
  /** Verified and attached to the reimbursement batch that will pay it. */
  'QUEUED_FOR_PAYMENT',
  /** Paid with a named payroll cycle. */
  'REIMBURSED',
  'WITHDRAWN',
  'CANCELLED',
] as const;
export type ExpenseClaimState = (typeof EXPENSE_CLAIM_STATES)[number];

export type ExpenseClaimEvent =
  | 'SUBMIT'
  | 'ROUTE_TO_MANAGER'
  | 'MANAGER_APPROVE'
  | 'MANAGER_REJECT'
  | 'ROUTE_TO_FINANCE'
  | 'FINANCE_APPROVE'
  | 'FINANCE_REJECT'
  | 'QUEUE_FOR_PAYMENT'
  | 'REIMBURSE'
  | 'WITHDRAW'
  | 'CANCEL';

export const expenseClaimMachine = new StateMachine<ExpenseClaimState, ExpenseClaimEvent>({
  name: 'expense_claim',
  initial: 'DRAFT',
  states: EXPENSE_CLAIM_STATES,
  transitions: [
    {
      from: 'DRAFT',
      to: 'SUBMITTED',
      event: 'SUBMIT',
      description: 'The employee submits the claim with its bills.',
    },
    {
      from: 'SUBMITTED',
      to: 'PENDING_MANAGER',
      event: 'ROUTE_TO_MANAGER',
      description: 'An approval task is raised for the reporting manager.',
    },
    {
      from: 'PENDING_MANAGER',
      to: 'MANAGER_APPROVED',
      event: 'MANAGER_APPROVE',
      description: 'The reporting manager approves the business purpose.',
    },
    {
      from: 'PENDING_MANAGER',
      to: 'MANAGER_REJECTED',
      event: 'MANAGER_REJECT',
      description: 'The reporting manager rejects with a reason.',
    },
    {
      from: 'PENDING_MANAGER',
      to: 'WITHDRAWN',
      event: 'WITHDRAW',
      description: 'The employee withdraws before a decision.',
    },
    {
      from: 'SUBMITTED',
      to: 'WITHDRAWN',
      event: 'WITHDRAW',
      description: 'The employee withdraws before it reaches their manager.',
    },
    {
      from: 'MANAGER_APPROVED',
      to: 'PENDING_FINANCE',
      event: 'ROUTE_TO_FINANCE',
      description: 'The claim moves to Accounts for verification.',
    },
    {
      from: 'PENDING_FINANCE',
      to: 'FINANCE_APPROVED',
      event: 'FINANCE_APPROVE',
      description: 'Accounts verifies the bills and applies the category cap.',
    },
    {
      from: 'PENDING_FINANCE',
      to: 'FINANCE_REJECTED',
      event: 'FINANCE_REJECT',
      description: 'Accounts rejects with a reason.',
    },
    {
      from: 'FINANCE_APPROVED',
      to: 'QUEUED_FOR_PAYMENT',
      event: 'QUEUE_FOR_PAYMENT',
      description: 'The claim joins the reimbursement batch for a named payroll cycle.',
    },
    {
      from: 'QUEUED_FOR_PAYMENT',
      to: 'REIMBURSED',
      event: 'REIMBURSE',
      description: 'The payroll cycle pays it.',
    },
    {
      from: 'QUEUED_FOR_PAYMENT',
      to: 'FINANCE_APPROVED',
      event: 'CANCEL',
      description: 'The batch was cancelled; the claim returns to the queue.',
    },
  ],
});

/** Claims that count towards the Expenses screen's "awaiting approval" tile. */
export const EXPENSE_STATES_AWAITING_DECISION: readonly ExpenseClaimState[] = [
  'SUBMITTED',
  'PENDING_MANAGER',
  'MANAGER_APPROVED',
  'PENDING_FINANCE',
];

/** Claims approved and not yet paid — the "approved, paying with salary" tile. */
export const EXPENSE_STATES_AWAITING_PAYMENT: readonly ExpenseClaimState[] = [
  'FINANCE_APPROVED',
  'QUEUED_FOR_PAYMENT',
];

/* ------------------------------------------------------------------ */
/* Policies                                                            */
/* ------------------------------------------------------------------ */

export const POLICY_VERSION_STATES = [
  'DRAFT',
  /** Circulated for review before publication. */
  'IN_REVIEW',
  /** Live from its effective date; employees must acknowledge it. */
  'PUBLISHED',
  /** A newer version has been published. Prior acknowledgements stay valid. */
  'SUPERSEDED',
  /** Withdrawn without a successor. No acknowledgement is expected. */
  'WITHDRAWN',
] as const;
export type PolicyVersionState = (typeof POLICY_VERSION_STATES)[number];

export type PolicyVersionEvent = 'SUBMIT_FOR_REVIEW' | 'PUBLISH' | 'SUPERSEDE' | 'WITHDRAW';

export const policyVersionMachine = new StateMachine<PolicyVersionState, PolicyVersionEvent>({
  name: 'policy_version',
  initial: 'DRAFT',
  states: POLICY_VERSION_STATES,
  transitions: [
    {
      from: 'DRAFT',
      to: 'IN_REVIEW',
      event: 'SUBMIT_FOR_REVIEW',
      description: 'The owning team circulates the draft for review.',
    },
    {
      from: 'IN_REVIEW',
      to: 'DRAFT',
      event: 'WITHDRAW',
      description: 'Review sends it back for changes.',
    },
    {
      from: 'IN_REVIEW',
      to: 'PUBLISHED',
      event: 'PUBLISH',
      description:
        'HR publishes it with an effective date and assigns it to everyone it applies to.',
    },
    {
      from: 'DRAFT',
      to: 'PUBLISHED',
      event: 'PUBLISH',
      description: 'HR publishes a version that needed no review.',
    },
    {
      from: 'PUBLISHED',
      to: 'SUPERSEDED',
      event: 'SUPERSEDE',
      description:
        'A newer version is published in its place; acknowledgements of this one stay valid.',
    },
    {
      from: 'PUBLISHED',
      to: 'WITHDRAWN',
      event: 'WITHDRAW',
      description: 'HR withdraws the policy without a successor.',
    },
    { from: 'DRAFT', to: 'WITHDRAWN', event: 'WITHDRAW', description: 'HR discards the draft.' },
  ],
});

/**
 * An acknowledgement is recorded against a specific policy version and never
 * moves. When a new version publishes, the employee's prior acknowledgement
 * stays valid for the version it was given for, and a fresh PENDING row appears
 * for the new one.
 */
export const ACKNOWLEDGEMENT_STATES = ['PENDING', 'ACKNOWLEDGED', 'WAIVED', 'OVERDUE'] as const;
export type AcknowledgementState = (typeof ACKNOWLEDGEMENT_STATES)[number];

/* ------------------------------------------------------------------ */
/* Help desk                                                           */
/* ------------------------------------------------------------------ */

export const TICKET_STATES = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  /** Waiting on the person who raised it. The SLA clock is paused. */
  'WAITING_ON_EMPLOYEE',
  'RESOLVED',
  'CLOSED',
  'REOPENED',
  'CANCELLED',
] as const;
export type TicketState = (typeof TICKET_STATES)[number];

export type TicketEvent =
  | 'ASSIGN'
  | 'START'
  | 'REQUEST_INFO'
  | 'REQUESTER_REPLIED'
  | 'RESOLVE'
  | 'CLOSE'
  | 'REOPEN'
  | 'CANCEL';

export const ticketMachine = new StateMachine<TicketState, TicketEvent>({
  name: 'helpdesk_ticket',
  initial: 'OPEN',
  states: TICKET_STATES,
  transitions: [
    {
      from: 'OPEN',
      to: 'ASSIGNED',
      event: 'ASSIGN',
      description: 'The ticket is assigned to an owner.',
    },
    { from: 'ASSIGNED', to: 'IN_PROGRESS', event: 'START', description: 'The owner starts work.' },
    {
      from: 'OPEN',
      to: 'IN_PROGRESS',
      event: 'START',
      description: 'An owner picks the ticket up directly.',
    },
    {
      from: 'REOPENED',
      to: 'IN_PROGRESS',
      event: 'START',
      description: 'The owner picks the reopened ticket back up.',
    },
    {
      from: 'IN_PROGRESS',
      to: 'WAITING_ON_EMPLOYEE',
      event: 'REQUEST_INFO',
      description: 'The owner asks the requester for more detail; the SLA clock pauses.',
    },
    {
      from: 'WAITING_ON_EMPLOYEE',
      to: 'IN_PROGRESS',
      event: 'REQUESTER_REPLIED',
      description: 'The requester replies and the clock resumes.',
    },
    {
      from: 'IN_PROGRESS',
      to: 'RESOLVED',
      event: 'RESOLVE',
      description: 'The owner resolves the ticket.',
    },
    {
      from: 'ASSIGNED',
      to: 'RESOLVED',
      event: 'RESOLVE',
      description: 'The owner resolves it without further work.',
    },
    {
      from: 'RESOLVED',
      to: 'CLOSED',
      event: 'CLOSE',
      description: 'Closed by the requester, or automatically after the grace period.',
    },
    {
      from: 'RESOLVED',
      to: 'REOPENED',
      event: 'REOPEN',
      description: 'The requester reopens it within the grace period.',
    },
    { from: 'CLOSED', to: 'REOPENED', event: 'REOPEN', description: 'Reopened by the help desk.' },
    {
      from: 'OPEN',
      to: 'CANCELLED',
      event: 'CANCEL',
      description: 'The requester cancels before anyone picks it up.',
    },
  ],
});

/** States in which the first-response and resolution SLA clocks run. */
export const SLA_RUNNING_STATES: readonly TicketState[] = [
  'OPEN',
  'ASSIGNED',
  'IN_PROGRESS',
  'REOPENED',
];

/* ------------------------------------------------------------------ */
/* Documents & letters                                                 */
/* ------------------------------------------------------------------ */

export const DOCUMENT_REQUEST_STATES = [
  'SUBMITTED',
  'IN_REVIEW',
  'PROCESSING',
  /** The generated PDF is stored and downloadable. */
  'ISSUED',
  'REJECTED',
  'CANCELLED',
] as const;
export type DocumentRequestState = (typeof DOCUMENT_REQUEST_STATES)[number];

export type DocumentRequestEvent = 'REVIEW' | 'START' | 'ISSUE' | 'REJECT' | 'CANCEL';

export const documentRequestMachine = new StateMachine<DocumentRequestState, DocumentRequestEvent>({
  name: 'document_request',
  initial: 'SUBMITTED',
  states: DOCUMENT_REQUEST_STATES,
  transitions: [
    {
      from: 'SUBMITTED',
      to: 'IN_REVIEW',
      event: 'REVIEW',
      description: 'HR picks up the request.',
    },
    {
      from: 'SUBMITTED',
      to: 'CANCELLED',
      event: 'CANCEL',
      description: 'The employee cancels before it is picked up.',
    },
    {
      from: 'IN_REVIEW',
      to: 'PROCESSING',
      event: 'START',
      description: 'HR accepts it and the letter is being prepared.',
    },
    {
      from: 'IN_REVIEW',
      to: 'REJECTED',
      event: 'REJECT',
      description: 'HR declines the request with a reason.',
    },
    {
      from: 'PROCESSING',
      to: 'ISSUED',
      event: 'ISSUE',
      description: 'The letter is issued; the PDF is stored against the request.',
    },
    {
      from: 'PROCESSING',
      to: 'REJECTED',
      event: 'REJECT',
      description: 'Preparation found the request cannot be fulfilled.',
    },
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
  name: 'profile_change_request',
  initial: 'SUBMITTED',
  states: CHANGE_REQUEST_STATES,
  transitions: [
    {
      from: 'SUBMITTED',
      to: 'UNDER_REVIEW',
      event: 'REVIEW',
      description: 'HR or Payroll begins verification.',
    },
    {
      from: 'SUBMITTED',
      to: 'WITHDRAWN',
      event: 'WITHDRAW',
      description: 'The employee withdraws the request.',
    },
    {
      from: 'UNDER_REVIEW',
      to: 'APPLIED',
      event: 'APPROVE',
      description: 'The change is applied to the employee record.',
    },
    {
      from: 'UNDER_REVIEW',
      to: 'REJECTED',
      event: 'REJECT',
      description: 'The change is declined with a reason.',
    },
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
  'ACTIVATE' | 'SUSPEND' | 'REINSTATE' | 'START_NOTICE' | 'OFFBOARD' | 'REVOKE_INVITE';

export const employmentMachine = new StateMachine<EmploymentState, EmploymentEvent>({
  name: 'employment',
  initial: 'INVITED',
  states: EMPLOYMENT_STATES,
  transitions: [
    {
      from: 'INVITED',
      to: 'ACTIVE',
      event: 'ACTIVATE',
      description: 'The employee accepts the invitation and sets a password.',
    },
    {
      from: 'INVITED',
      to: 'OFFBOARDED',
      event: 'REVOKE_INVITE',
      description: 'HR revokes an invitation that was never accepted.',
    },
    {
      from: 'ACTIVE',
      to: 'SUSPENDED',
      event: 'SUSPEND',
      description: 'HR suspends access; every session is revoked.',
    },
    { from: 'SUSPENDED', to: 'ACTIVE', event: 'REINSTATE', description: 'HR restores access.' },
    {
      from: 'ACTIVE',
      to: 'NOTICE_PERIOD',
      event: 'START_NOTICE',
      description: 'Resignation accepted; the last working day is recorded.',
    },
    {
      from: 'NOTICE_PERIOD',
      to: 'ACTIVE',
      event: 'REINSTATE',
      description: 'The resignation is withdrawn.',
    },
    {
      from: 'NOTICE_PERIOD',
      to: 'OFFBOARDED',
      event: 'OFFBOARD',
      description: 'The last working day passes; access ends.',
    },
    {
      from: 'ACTIVE',
      to: 'OFFBOARDED',
      event: 'OFFBOARD',
      description: 'Employment ends immediately.',
    },
    {
      from: 'SUSPENDED',
      to: 'OFFBOARDED',
      event: 'OFFBOARD',
      description: 'Employment ends during suspension.',
    },
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
