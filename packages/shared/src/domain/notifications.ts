/**
 * Notifications.
 *
 * Every notification is produced by a persisted event — a state transition, a
 * publication, a decision. There is no notification generator that invents
 * something to say, and none that counts anything the database cannot confirm.
 * If a notification exists, the thing it describes happened.
 */

export const NOTIFICATION_TYPES = [
  // Payroll
  'PAYSLIP_PUBLISHED',
  'PAYROLL_INPUTS_UPLOADED',
  'ATTENDANCE_SUBMITTED_FOR_APPROVAL',
  'ATTENDANCE_RETURNED',
  'ATTENDANCE_APPROVAL_COMPLETE',
  'PAYROLL_VALIDATION_FAILED',
  'PAYROLL_CYCLE_PUBLISHED',

  // Leave
  'LEAVE_REQUEST_SUBMITTED',
  'LEAVE_REQUEST_APPROVED',
  'LEAVE_REQUEST_REJECTED',
  'LEAVE_REQUEST_CANCELLED',

  // Expenses
  'EXPENSE_SUBMITTED',
  'EXPENSE_APPROVED',
  'EXPENSE_REJECTED',
  'EXPENSE_REIMBURSED',

  // Policies
  'POLICY_VERSION_PUBLISHED',
  'POLICY_ACKNOWLEDGEMENT_DUE',
  'POLICY_ACKNOWLEDGEMENT_OVERDUE',

  // Documents
  'DOCUMENT_ISSUED',
  'DOCUMENT_REQUEST_REJECTED',
  'DOCUMENT_UPLOADED',

  // Help desk
  'TICKET_ASSIGNED',
  'TICKET_COMMENTED',
  'TICKET_RESOLVED',
  'TICKET_AWAITING_REQUESTER',

  // Profile
  'PROFILE_CHANGE_APPLIED',
  'PROFILE_CHANGE_REJECTED',

  // Announcements
  'ANNOUNCEMENT_PUBLISHED',

  // Tax
  'FORM16_AVAILABLE',
  'TAX_DECLARATION_WINDOW_OPEN',

  // Security — these reach the account owner, always
  'NEW_SIGN_IN',
  'PASSWORD_CHANGED',
  'MFA_ENABLED',
  'MFA_DISABLED',
  'SESSION_REVOKED_TOKEN_REUSE',
  'ROLE_GRANTED',
  'ROLE_REVOKED',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Drives the colour of the dot in the notification popover. */
export type NotificationTone = 'green' | 'amber' | 'red' | 'blue' | 'gray';

export interface NotificationDefinition {
  type: NotificationType;
  tone: NotificationTone;
  /** The module a click navigates to. */
  target:
    | 'payslips'
    | 'tax'
    | 'leave'
    | 'expenses'
    | 'policies'
    | 'documents'
    | 'help'
    | 'approvals'
    | 'announcements'
    | 'profile'
    | 'attendance'
    | 'payroll'
    | 'security';
  /**
   * Security notifications cannot be dismissed without being read, and are
   * delivered by email as well as in the portal.
   */
  security?: boolean;
}

export const NOTIFICATION_DEFINITIONS: Record<NotificationType, NotificationDefinition> = {
  PAYSLIP_PUBLISHED: { type: 'PAYSLIP_PUBLISHED', tone: 'green', target: 'payslips' },
  PAYROLL_INPUTS_UPLOADED: { type: 'PAYROLL_INPUTS_UPLOADED', tone: 'blue', target: 'payroll' },
  ATTENDANCE_SUBMITTED_FOR_APPROVAL: {
    type: 'ATTENDANCE_SUBMITTED_FOR_APPROVAL',
    tone: 'amber',
    target: 'approvals',
  },
  ATTENDANCE_RETURNED: { type: 'ATTENDANCE_RETURNED', tone: 'red', target: 'attendance' },
  ATTENDANCE_APPROVAL_COMPLETE: {
    type: 'ATTENDANCE_APPROVAL_COMPLETE',
    tone: 'green',
    target: 'payroll',
  },
  PAYROLL_VALIDATION_FAILED: { type: 'PAYROLL_VALIDATION_FAILED', tone: 'red', target: 'payroll' },
  PAYROLL_CYCLE_PUBLISHED: { type: 'PAYROLL_CYCLE_PUBLISHED', tone: 'green', target: 'payroll' },

  LEAVE_REQUEST_SUBMITTED: { type: 'LEAVE_REQUEST_SUBMITTED', tone: 'blue', target: 'approvals' },
  LEAVE_REQUEST_APPROVED: { type: 'LEAVE_REQUEST_APPROVED', tone: 'green', target: 'leave' },
  LEAVE_REQUEST_REJECTED: { type: 'LEAVE_REQUEST_REJECTED', tone: 'red', target: 'leave' },
  LEAVE_REQUEST_CANCELLED: { type: 'LEAVE_REQUEST_CANCELLED', tone: 'gray', target: 'leave' },

  EXPENSE_SUBMITTED: { type: 'EXPENSE_SUBMITTED', tone: 'blue', target: 'approvals' },
  EXPENSE_APPROVED: { type: 'EXPENSE_APPROVED', tone: 'green', target: 'expenses' },
  EXPENSE_REJECTED: { type: 'EXPENSE_REJECTED', tone: 'red', target: 'expenses' },
  EXPENSE_REIMBURSED: { type: 'EXPENSE_REIMBURSED', tone: 'green', target: 'expenses' },

  POLICY_VERSION_PUBLISHED: { type: 'POLICY_VERSION_PUBLISHED', tone: 'amber', target: 'policies' },
  POLICY_ACKNOWLEDGEMENT_DUE: {
    type: 'POLICY_ACKNOWLEDGEMENT_DUE',
    tone: 'amber',
    target: 'policies',
  },
  POLICY_ACKNOWLEDGEMENT_OVERDUE: {
    type: 'POLICY_ACKNOWLEDGEMENT_OVERDUE',
    tone: 'red',
    target: 'policies',
  },

  DOCUMENT_ISSUED: { type: 'DOCUMENT_ISSUED', tone: 'green', target: 'documents' },
  DOCUMENT_REQUEST_REJECTED: {
    type: 'DOCUMENT_REQUEST_REJECTED',
    tone: 'red',
    target: 'documents',
  },
  DOCUMENT_UPLOADED: { type: 'DOCUMENT_UPLOADED', tone: 'blue', target: 'documents' },

  TICKET_ASSIGNED: { type: 'TICKET_ASSIGNED', tone: 'blue', target: 'help' },
  TICKET_COMMENTED: { type: 'TICKET_COMMENTED', tone: 'blue', target: 'help' },
  TICKET_RESOLVED: { type: 'TICKET_RESOLVED', tone: 'green', target: 'help' },
  TICKET_AWAITING_REQUESTER: {
    type: 'TICKET_AWAITING_REQUESTER',
    tone: 'amber',
    target: 'help',
  },

  PROFILE_CHANGE_APPLIED: { type: 'PROFILE_CHANGE_APPLIED', tone: 'green', target: 'profile' },
  PROFILE_CHANGE_REJECTED: { type: 'PROFILE_CHANGE_REJECTED', tone: 'red', target: 'profile' },

  ANNOUNCEMENT_PUBLISHED: { type: 'ANNOUNCEMENT_PUBLISHED', tone: 'blue', target: 'announcements' },

  FORM16_AVAILABLE: { type: 'FORM16_AVAILABLE', tone: 'green', target: 'tax' },
  TAX_DECLARATION_WINDOW_OPEN: {
    type: 'TAX_DECLARATION_WINDOW_OPEN',
    tone: 'amber',
    target: 'tax',
  },

  NEW_SIGN_IN: { type: 'NEW_SIGN_IN', tone: 'gray', target: 'security', security: true },
  PASSWORD_CHANGED: { type: 'PASSWORD_CHANGED', tone: 'amber', target: 'security', security: true },
  MFA_ENABLED: { type: 'MFA_ENABLED', tone: 'green', target: 'security', security: true },
  MFA_DISABLED: { type: 'MFA_DISABLED', tone: 'red', target: 'security', security: true },
  SESSION_REVOKED_TOKEN_REUSE: {
    type: 'SESSION_REVOKED_TOKEN_REUSE',
    tone: 'red',
    target: 'security',
    security: true,
  },
  ROLE_GRANTED: { type: 'ROLE_GRANTED', tone: 'blue', target: 'security', security: true },
  ROLE_REVOKED: { type: 'ROLE_REVOKED', tone: 'gray', target: 'security', security: true },
};

export const SECURITY_NOTIFICATION_TYPES = NOTIFICATION_TYPES.filter(
  (t) => NOTIFICATION_DEFINITIONS[t].security === true,
);
