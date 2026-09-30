import type { Tone } from '@widedrop/shared';

/**
 * How a status reads and how it looks.
 *
 * One table, so the same server value is the same words and the same colour on
 * every screen. A status the table does not know renders neutrally with its
 * raw value tidied — never guessed at from the text, and never hidden, because
 * a state nobody labelled is a bug worth seeing rather than one to paper over.
 */

export interface StatusPresentation {
  label: string;
  tone: Tone;
  /** Read out after the label where the label alone is terse. */
  description?: string;
}

const STATUSES: Record<string, StatusPresentation> = {
  /* Leave */
  DRAFT: { label: 'Draft', tone: 'gray' },
  PENDING_APPROVAL: { label: 'Awaiting approval', tone: 'amber' },
  APPROVED: { label: 'Approved', tone: 'green' },
  REJECTED: { label: 'Declined', tone: 'red' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'gray' },
  CANCELLED: { label: 'Cancelled', tone: 'gray' },

  /* Expenses */
  SUBMITTED: { label: 'Submitted', tone: 'blue' },
  PENDING_MANAGER: { label: 'With your manager', tone: 'amber' },
  MANAGER_APPROVED: { label: 'Manager approved', tone: 'blue' },
  MANAGER_REJECTED: { label: 'Declined by manager', tone: 'red' },
  PENDING_FINANCE: { label: 'With Accounts', tone: 'amber' },
  FINANCE_APPROVED: {
    label: 'Approved for payment',
    tone: 'green',
    description: 'paid with the next payroll cycle',
  },
  FINANCE_REJECTED: { label: 'Declined by Accounts', tone: 'red' },
  QUEUED_FOR_PAYMENT: { label: 'Queued for payment', tone: 'blue' },
  REIMBURSED: { label: 'Reimbursed', tone: 'green' },

  /* Policies */
  PENDING: { label: 'Awaiting acknowledgement', tone: 'amber' },
  ACKNOWLEDGED: { label: 'Acknowledged', tone: 'green' },
  OVERDUE: { label: 'Overdue', tone: 'red' },
  WAIVED: { label: 'Waived', tone: 'gray' },
  PUBLISHED: { label: 'Published', tone: 'green' },
  SUPERSEDED: { label: 'Superseded', tone: 'gray' },
  IN_REVIEW: { label: 'In review', tone: 'amber' },
  ARCHIVED: { label: 'Archived', tone: 'gray' },

  /* Help desk */
  OPEN: { label: 'Open', tone: 'blue' },
  ASSIGNED: { label: 'Assigned', tone: 'blue' },
  IN_PROGRESS: { label: 'In progress', tone: 'amber' },
  WAITING_ON_EMPLOYEE: { label: 'Waiting on you', tone: 'amber' },
  RESOLVED: { label: 'Resolved', tone: 'green' },
  CLOSED: { label: 'Closed', tone: 'gray' },
  REOPENED: { label: 'Reopened', tone: 'amber' },

  /* Documents */
  PROCESSING: { label: 'Being prepared', tone: 'amber' },
  ISSUED: { label: 'Ready', tone: 'green' },

  /* Attendance */
  HR_SUBMITTED: { label: 'Submitted by People Ops', tone: 'blue' },
  MANAGER_APPROVAL_PENDING: { label: 'Awaiting managers', tone: 'amber' },
  LOCKED: { label: 'Locked', tone: 'gray' },

  /* Payroll cycle */
  INPUTS_OPEN: { label: 'Inputs open', tone: 'blue' },
  INPUTS_LOCKED: { label: 'Inputs locked', tone: 'blue' },
  ATTENDANCE_SUBMITTED: { label: 'Attendance submitted', tone: 'blue' },
  ATTENDANCE_APPROVED: { label: 'Attendance approved', tone: 'blue' },
  VALIDATING: { label: 'Validating', tone: 'amber' },
  VALIDATION_FAILED: { label: 'Validation failed', tone: 'red' },
  VALIDATED: { label: 'Validated', tone: 'blue' },
  CALCULATING: { label: 'Calculating', tone: 'amber' },
  CALCULATED: { label: 'Calculated', tone: 'blue' },

  /* Payslips */
  GENERATED: {
    label: 'Generated',
    tone: 'blue',
    description: 'not yet visible to the employee',
  },

  /* Benefits */
  ELIGIBLE: { label: 'Eligible', tone: 'blue' },
  ENROLLED: { label: 'Enrolled', tone: 'green' },
  DECLINED: { label: 'Declined', tone: 'gray' },
  LAPSED: { label: 'Lapsed', tone: 'gray' },

  /* Employment */
  ACTIVE: { label: 'Active', tone: 'green' },
  ON_LEAVE: { label: 'On leave', tone: 'amber' },
  NOTICE_PERIOD: { label: 'Notice period', tone: 'amber' },
  PRE_JOINING: { label: 'Pre-joining', tone: 'blue' },
  SUSPENDED: { label: 'Suspended', tone: 'red' },
  EXITED: { label: 'Exited', tone: 'gray' },

  /* Reimbursement batches, tax, Form 16 */
  SENT_TO_PAYROLL: { label: 'Sent to payroll', tone: 'blue' },
  PAID: { label: 'Paid', tone: 'green' },
  UPCOMING: { label: 'Upcoming', tone: 'gray' },
  FILED: { label: 'Filed', tone: 'green' },
  VERIFIED: { label: 'Verified', tone: 'green' },
  NOT_ISSUED: { label: 'Not issued', tone: 'gray' },
};

export function statusOf(value: string | null | undefined): StatusPresentation {
  if (!value) return { label: 'Unknown', tone: 'gray' };
  return (
    STATUSES[value] ?? {
      label: value.charAt(0) + value.slice(1).toLowerCase().replace(/_/g, ' '),
      tone: 'gray',
    }
  );
}
