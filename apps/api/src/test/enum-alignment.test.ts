import { describe, expect, it } from 'vitest';
import {
  ACKNOWLEDGEMENT_STATES,
  ATTENDANCE_APPROVAL_STATES,
  ATTENDANCE_PERIOD_STATES,
  DAY_CLASSIFICATIONS,
  DOCUMENT_REQUEST_STATES,
  EXPENSE_CLAIM_STATES,
  LEAVE_REQUEST_STATES,
  PAYROLL_CYCLE_STATES,
  PAYROLL_RUN_TYPES,
  PAYSLIP_LINE_KINDS,
  PAYSLIP_STATES,
  PERSONAS,
  POLICY_VERSION_STATES,
  TICKET_STATES,
} from '@widedrop/shared';
import {
  AttendanceApprovalStatus,
  AttendancePeriodStatus,
  DocumentRequestStatus,
  ExpenseClaimStatus,
  LeaveRequestStatus,
  PayrollCycleStatus,
  PayrollRunTypeEnum,
  PayslipLineKind,
  PayslipStatus,
  Persona,
  PolicyAckStatus,
  PolicyVersionStatus,
  TicketStatus,
} from '../generated/prisma/index.js';

/**
 * The shared package and the database must agree on every state name.
 *
 * If they drift, a service can write a status the database rejects, or the UI
 * can offer an action the server will refuse — and the failure surfaces in
 * production rather than here. These comparisons make the drift a failing test.
 */

const values = (enumObject: Record<string, string>) => Object.values(enumObject).sort();
const shared = (states: readonly string[]) => [...states].sort();

describe('shared state machines match the database enums', () => {
  it.each([
    ['payroll cycle', shared(PAYROLL_CYCLE_STATES), values(PayrollCycleStatus)],
    ['payslip', shared(PAYSLIP_STATES), values(PayslipStatus)],
    ['payslip line kind', shared(PAYSLIP_LINE_KINDS), values(PayslipLineKind)],
    ['payroll run type', shared(PAYROLL_RUN_TYPES), values(PayrollRunTypeEnum)],
    ['attendance period', shared(ATTENDANCE_PERIOD_STATES), values(AttendancePeriodStatus)],
    ['attendance approval', shared(ATTENDANCE_APPROVAL_STATES), values(AttendanceApprovalStatus)],
    ['leave request', shared(LEAVE_REQUEST_STATES), values(LeaveRequestStatus)],
    ['expense claim', shared(EXPENSE_CLAIM_STATES), values(ExpenseClaimStatus)],
    ['policy version', shared(POLICY_VERSION_STATES), values(PolicyVersionStatus)],
    ['policy acknowledgement', shared(ACKNOWLEDGEMENT_STATES), values(PolicyAckStatus)],
    ['helpdesk ticket', shared(TICKET_STATES), values(TicketStatus)],
    ['document request', shared(DOCUMENT_REQUEST_STATES), values(DocumentRequestStatus)],
    ['persona', shared(PERSONAS), values(Persona)],
  ])('%s', (_name, sharedStates, databaseStates) => {
    expect(sharedStates).toEqual(databaseStates);
  });
});

describe('day classification', () => {
  it('is an application concept with no database enum, and stays exhaustive', () => {
    // Day classification drives the derived payable/loss-of-pay counts, which
    // the database computes from the six day-count columns rather than from a
    // stored classification.
    expect([...DAY_CLASSIFICATIONS].sort()).toEqual([
      'ABSENT',
      'HOLIDAY',
      'PAID_LEAVE',
      'PRESENT',
      'UNPAID_LEAVE',
      'WEEK_OFF',
    ]);
  });
});
