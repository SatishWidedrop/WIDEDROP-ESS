import { describe, expect, it } from 'vitest';
import {
  BLOCKING_CHECKS,
  PAYROLL_CHECKS,
  PAYROLL_CYCLE_STATES,
  PAYROLL_EVENT_ACTOR,
  PAYROLL_VALIDATION_CHECKS,
  payrollCycleMachine as m,
  payslipVisibleToEmployee,
  payslipsMayExist,
  type PayrollCycleState,
} from './payroll.js';

describe('the pipeline cannot be short-circuited', () => {
  it('will not submit attendance before inputs are uploaded and locked', () => {
    expect(m.can('DRAFT', 'SUBMIT_ATTENDANCE')).toBe(false);
    expect(m.can('INPUTS_OPEN', 'SUBMIT_ATTENDANCE')).toBe(false);
  });

  it('will not approve attendance before HR has submitted it', () => {
    expect(m.can('DRAFT', 'APPROVE_ATTENDANCE')).toBe(false);
    expect(m.can('INPUTS_OPEN', 'APPROVE_ATTENDANCE')).toBe(false);
    expect(m.can('INPUTS_LOCKED', 'APPROVE_ATTENDANCE')).toBe(false);
  });

  it('will not validate before attendance is approved', () => {
    for (const from of ['DRAFT', 'INPUTS_OPEN', 'INPUTS_LOCKED', 'ATTENDANCE_SUBMITTED'] as const) {
      expect(m.can(from, 'VALIDATE')).toBe(false);
    }
  });

  it('will not calculate before validation has passed', () => {
    for (const from of [
      'DRAFT',
      'INPUTS_OPEN',
      'INPUTS_LOCKED',
      'ATTENDANCE_SUBMITTED',
      'ATTENDANCE_APPROVED',
      'VALIDATING',
      'VALIDATION_FAILED',
    ] as const) {
      expect(m.can(from, 'CALCULATE')).toBe(false);
    }
    expect(m.can('VALIDATED', 'CALCULATE')).toBe(true);
  });

  it('will not publish before the run is calculated and signed off', () => {
    for (const from of PAYROLL_CYCLE_STATES.filter((s) => s !== 'APPROVED')) {
      expect(m.can(from, 'PUBLISH')).toBe(false);
    }
    expect(m.can('CALCULATED', 'PUBLISH')).toBe(false);
    expect(m.can('APPROVED', 'PUBLISH')).toBe(true);
  });

  it('walks the full happy path in the order the business requires', () => {
    let state: PayrollCycleState = m.initial;
    const path = [
      'UPLOAD_INPUTS',
      'LOCK_INPUTS',
      'SUBMIT_ATTENDANCE',
      'APPROVE_ATTENDANCE',
      'VALIDATE',
      'VALIDATION_PASSED',
      'CALCULATE',
      'CALCULATION_SUCCEEDED',
      'APPROVE',
      'PUBLISH',
    ] as const;
    const visited: PayrollCycleState[] = [state];
    for (const event of path) {
      const next = m.next(state, event);
      expect(next, `${state} --${event}-->`).toBeDefined();
      state = next!;
      visited.push(state);
    }
    expect(visited).toEqual([
      'DRAFT',
      'INPUTS_OPEN',
      'INPUTS_LOCKED',
      'ATTENDANCE_SUBMITTED',
      'ATTENDANCE_APPROVED',
      'VALIDATING',
      'VALIDATED',
      'CALCULATING',
      'CALCULATED',
      'APPROVED',
      'PUBLISHED',
    ]);
  });
});

describe('payslip existence and visibility', () => {
  it('allows no payslip row before calculation starts', () => {
    for (const state of [
      'DRAFT',
      'INPUTS_OPEN',
      'INPUTS_LOCKED',
      'ATTENDANCE_SUBMITTED',
      'ATTENDANCE_APPROVED',
      'VALIDATING',
      'VALIDATED',
      'VALIDATION_FAILED',
    ] as const) {
      expect(payslipsMayExist(state)).toBe(false);
    }
  });

  it('shows a payslip to its employee only once the cycle is published', () => {
    for (const state of PAYROLL_CYCLE_STATES.filter((s) => s !== 'PUBLISHED' && s !== 'CLOSED')) {
      expect(payslipVisibleToEmployee(state)).toBe(false);
    }
    expect(payslipVisibleToEmployee('PUBLISHED')).toBe(true);
    // A closed period stays readable: an employee does not lose last year's payslips.
    expect(payslipVisibleToEmployee('CLOSED')).toBe(true);
  });

  it('keeps generated payslips on the record when a cycle is cancelled', () => {
    expect(payslipsMayExist('CANCELLED')).toBe(true);
    expect(payslipVisibleToEmployee('CANCELLED')).toBe(false);
  });

  it('never lets a payslip exist while the pipeline is still upstream of it', () => {
    const upstream = PAYROLL_CYCLE_STATES.slice(0, PAYROLL_CYCLE_STATES.indexOf('CALCULATING'));
    expect(upstream.filter(payslipsMayExist)).toEqual([]);
  });
});

describe('separation of duties', () => {
  it('assigns each step to the role the business requires', () => {
    expect(PAYROLL_EVENT_ACTOR.UPLOAD_INPUTS).toBe('ACCOUNTS');
    expect(PAYROLL_EVENT_ACTOR.SUBMIT_ATTENDANCE).toBe('HR');
    expect(PAYROLL_EVENT_ACTOR.APPROVE_ATTENDANCE).toBe('MANAGER');
    expect(PAYROLL_EVENT_ACTOR.CALCULATE).toBe('ACCOUNTS');
    expect(PAYROLL_EVENT_ACTOR.PUBLISH).toBe('ACCOUNTS');
  });

  it('marks system-raised outcomes so a user can never request them', () => {
    for (const event of [
      'VALIDATION_PASSED',
      'VALIDATION_REJECTED',
      'CALCULATION_SUCCEEDED',
      'CALCULATION_FAILED',
    ] as const) {
      expect(PAYROLL_EVENT_ACTOR[event]).toBeNull();
    }
  });
});

describe('terminal states and recovery', () => {
  it('treats CLOSED and CANCELLED as terminal', () => {
    expect(m.isTerminal('CLOSED')).toBe(true);
    expect(m.isTerminal('CANCELLED')).toBe(true);
  });

  it('cannot cancel a cycle once it is published', () => {
    expect(m.can('PUBLISHED', 'CANCEL')).toBe(false);
  });

  it('lets a returned or failed cycle recover to publication', () => {
    expect(m.canReach('VALIDATION_FAILED', 'PUBLISHED')).toBe(true);
    expect(m.canReach('CALCULATING', 'PUBLISHED')).toBe(true);
    expect(m.canReach('CANCELLED', 'PUBLISHED')).toBe(false);
  });

  it('sends a manager’s return back to HR for correction', () => {
    expect(m.next('ATTENDANCE_SUBMITTED', 'RETURN_ATTENDANCE')).toBe('INPUTS_LOCKED');
  });

  it('forces attendance to be approved again after corrected inputs', () => {
    expect(m.next('VALIDATION_FAILED', 'REOPEN_INPUTS')).toBe('INPUTS_OPEN');
    expect(m.can('INPUTS_OPEN', 'CALCULATE')).toBe(false);
    expect(m.can('INPUTS_OPEN', 'VALIDATE')).toBe(false);
  });

  it('rolls a failed calculation back to VALIDATED so it can be retried', () => {
    expect(m.next('CALCULATING', 'CALCULATION_FAILED')).toBe('VALIDATED');
  });

  it('reaches every state from the initial one', () => {
    for (const state of PAYROLL_CYCLE_STATES) {
      expect(m.canReach('DRAFT', state), `unreachable: ${state}`).toBe(true);
    }
  });
});

describe('validation checklist', () => {
  it('defines every declared check exactly once', () => {
    expect(PAYROLL_CHECKS.map((c) => c.check).sort()).toEqual(
      [...PAYROLL_VALIDATION_CHECKS].sort(),
    );
  });

  it('blocks on everything payroll cannot be computed without', () => {
    for (const check of [
      'SALARY_STRUCTURE_EFFECTIVE',
      'ATTENDANCE_APPROVED',
      'BANK_DETAILS_VERIFIED',
      'TAX_REGIME_ELECTED',
      'NO_EXISTING_PAYSLIP',
    ] as const) {
      expect(BLOCKING_CHECKS).toContain(check);
    }
  });

  it('gives every check a remedy someone can act on', () => {
    for (const check of PAYROLL_CHECKS) {
      expect(check.remedy.length).toBeGreaterThan(20);
      expect(check.label.length).toBeGreaterThan(5);
    }
  });
});
