import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CLAIM_STATES,
  LEAVE_REQUEST_STATES,
  LEAVE_STATES_HOLDING_BALANCE,
  OUTBOX_MAX_ATTEMPTS,
  PAID_CLASSIFICATIONS,
  SLA_RUNNING_STATES,
  STATES_ALLOWING_SIGN_IN,
  STATES_IN_PAYROLL_SCOPE,
  attendancePeriodMachine,
  changeRequestMachine,
  documentRequestMachine,
  employmentMachine,
  expenseClaimMachine,
  isPaidDay,
  leaveRequestMachine,
  outboxRetryDelaySeconds,
  policyVersionMachine,
  ticketMachine,
} from './workflows.js';

describe('leave', () => {
  it('reserves balance only while pending or approved', () => {
    expect(LEAVE_STATES_HOLDING_BALANCE).toEqual(['PENDING', 'APPROVED']);
    for (const state of ['REJECTED', 'WITHDRAWN', 'CANCELLED', 'DRAFT'] as const) {
      expect(LEAVE_STATES_HOLDING_BALANCE).not.toContain(state);
    }
  });

  it('cannot approve a request that was never submitted', () => {
    expect(leaveRequestMachine.can('DRAFT', 'APPROVE')).toBe(false);
  });

  it('cannot withdraw a decided request', () => {
    expect(leaveRequestMachine.can('APPROVED', 'WITHDRAW')).toBe(false);
    expect(leaveRequestMachine.can('REJECTED', 'WITHDRAW')).toBe(false);
  });

  it('cannot revive a rejected request', () => {
    for (const state of LEAVE_REQUEST_STATES) {
      if (state === 'APPROVED') continue;
      expect(leaveRequestMachine.canReach('REJECTED', state)).toBe(state === 'REJECTED');
    }
  });
});

describe('expenses', () => {
  it('requires both a manager and Accounts before reimbursement', () => {
    expect(expenseClaimMachine.can('PENDING_MANAGER', 'REIMBURSE')).toBe(false);
    expect(expenseClaimMachine.can('PENDING_ACCOUNTS', 'REIMBURSE')).toBe(false);
    expect(expenseClaimMachine.can('APPROVED', 'REIMBURSE')).toBe(true);
  });

  it('walks submit -> manager -> accounts -> reimbursed', () => {
    let state = expenseClaimMachine.initial;
    for (const event of ['SUBMIT', 'MANAGER_APPROVE', 'ACCOUNTS_VERIFY', 'REIMBURSE'] as const) {
      const next = expenseClaimMachine.next(state, event);
      expect(next, `${state} --${event}-->`).toBeDefined();
      state = next!;
    }
    expect(state).toBe('REIMBURSED');
  });

  it('treats reimbursement as final', () => {
    expect(expenseClaimMachine.isTerminal('REIMBURSED')).toBe(true);
    for (const state of EXPENSE_CLAIM_STATES) {
      if (state === 'REIMBURSED') continue;
      expect(expenseClaimMachine.canReach('REIMBURSED', state)).toBe(false);
    }
  });

  it('cannot withdraw a claim a manager has already approved', () => {
    expect(expenseClaimMachine.can('PENDING_ACCOUNTS', 'WITHDRAW')).toBe(false);
  });
});

describe('attendance', () => {
  it('cannot approve before HR submits', () => {
    expect(attendancePeriodMachine.can('OPEN', 'APPROVE_ALL')).toBe(false);
  });

  it('cannot edit a period a payroll cycle has consumed', () => {
    expect(attendancePeriodMachine.isTerminal('LOCKED')).toBe(true);
  });

  it('lets a returned period be resubmitted', () => {
    expect(attendancePeriodMachine.next('RETURNED', 'SUBMIT')).toBe('SUBMITTED');
  });

  it('counts holidays and week-offs as paid, absence and unpaid leave as not', () => {
    expect(PAID_CLASSIFICATIONS).toEqual(['PRESENT', 'PAID_LEAVE', 'HOLIDAY', 'WEEK_OFF']);
    expect(isPaidDay('ABSENT')).toBe(false);
    expect(isPaidDay('UNPAID_LEAVE')).toBe(false);
    expect(isPaidDay('HOLIDAY')).toBe(true);
  });
});

describe('policy versions', () => {
  it('never edits a published version — it supersedes it', () => {
    expect(policyVersionMachine.can('PUBLISHED', 'PUBLISH')).toBe(false);
    expect(policyVersionMachine.next('PUBLISHED', 'SUPERSEDE')).toBe('SUPERSEDED');
  });

  it('treats superseded and archived as final', () => {
    expect(policyVersionMachine.isTerminal('SUPERSEDED')).toBe(true);
    expect(policyVersionMachine.isTerminal('ARCHIVED')).toBe(true);
  });
});

describe('help desk', () => {
  it('pauses the SLA clock while waiting on the requester', () => {
    expect(SLA_RUNNING_STATES).not.toContain('AWAITING_REQUESTER');
    expect(SLA_RUNNING_STATES).not.toContain('RESOLVED');
    expect(SLA_RUNNING_STATES).toContain('OPEN');
  });

  it('allows a closed ticket to be reopened', () => {
    expect(ticketMachine.next('CLOSED', 'REOPEN')).toBe('IN_PROGRESS');
  });

  it('cannot resolve a ticket nobody has touched', () => {
    expect(ticketMachine.can('OPEN', 'RESOLVE')).toBe(false);
  });
});

describe('document requests', () => {
  it('issues only from in-progress', () => {
    expect(documentRequestMachine.can('REQUESTED', 'ISSUE')).toBe(false);
    expect(documentRequestMachine.next('IN_PROGRESS', 'ISSUE')).toBe('ISSUED');
  });

  it('cannot cancel a request HR has started', () => {
    expect(documentRequestMachine.can('IN_PROGRESS', 'CANCEL')).toBe(false);
  });
});

describe('profile change requests', () => {
  it('cannot apply a change without review', () => {
    expect(changeRequestMachine.can('SUBMITTED', 'APPROVE')).toBe(false);
    expect(changeRequestMachine.next('UNDER_REVIEW', 'APPROVE')).toBe('APPLIED');
  });
});

describe('employment lifecycle', () => {
  it('lets only active and notice-period employees sign in', () => {
    expect(STATES_ALLOWING_SIGN_IN).toEqual(['ACTIVE', 'NOTICE_PERIOD']);
    for (const state of ['INVITED', 'SUSPENDED', 'OFFBOARDED'] as const) {
      expect(STATES_ALLOWING_SIGN_IN).not.toContain(state);
    }
  });

  it('keeps a suspended employee in payroll scope but out of the portal', () => {
    expect(STATES_IN_PAYROLL_SCOPE).toContain('SUSPENDED');
    expect(STATES_ALLOWING_SIGN_IN).not.toContain('SUSPENDED');
  });

  it('excludes offboarded employees from new payroll cycles', () => {
    expect(STATES_IN_PAYROLL_SCOPE).not.toContain('OFFBOARDED');
  });

  it('treats offboarding as final', () => {
    expect(employmentMachine.isTerminal('OFFBOARDED')).toBe(true);
  });

  it('cannot activate an offboarded account', () => {
    expect(employmentMachine.can('OFFBOARDED', 'ACTIVATE')).toBe(false);
  });
});

describe('email outbox backoff', () => {
  it('backs off exponentially and reaches roughly half a day', () => {
    const delays = Array.from({ length: OUTBOX_MAX_ATTEMPTS }, (_, i) =>
      outboxRetryDelaySeconds(i + 1),
    );
    expect(delays).toEqual([30, 120, 480, 1920, 7680, 30720]);
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]!).toBeGreaterThan(delays[i - 1]!);
    }
  });

  it('never returns a negative delay', () => {
    expect(outboxRetryDelaySeconds(0)).toBe(30);
    expect(outboxRetryDelaySeconds(-5)).toBe(30);
  });
});
