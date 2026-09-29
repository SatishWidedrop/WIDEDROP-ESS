import { describe, expect, it } from 'vitest';
import { REDACTED, redactValue } from './logger.js';

describe('redactValue', () => {
  it('strips credentials at any depth', () => {
    const input = {
      email: 'priya.raghavan@widedrop.com',
      password: 'hunter2',
      nested: { refreshToken: 'abc', deeper: { mfaSecret: 'JBSWY3DP' } },
    };
    expect(redactValue(input)).toEqual({
      email: 'priya.raghavan@widedrop.com',
      password: REDACTED,
      nested: { refreshToken: REDACTED, deeper: { mfaSecret: REDACTED } },
    });
  });

  it('strips statutory identifiers', () => {
    expect(
      redactValue({ pan: 'AXYPR1234K', aadhaar: '111122223333', uan: '101234567890' }),
    ).toEqual({
      pan: REDACTED,
      aadhaar: REDACTED,
      uan: REDACTED,
    });
  });

  it('matches keys regardless of casing or separators', () => {
    expect(
      redactValue({ Bank_Account_Number: '123', 'set-cookie': 'x', ACCESSTOKEN: 'y' }),
    ).toEqual({
      Bank_Account_Number: REDACTED,
      'set-cookie': REDACTED,
      ACCESSTOKEN: REDACTED,
    });
  });

  it('walks arrays', () => {
    expect(redactValue([{ token: 'a' }, { token: 'b' }])).toEqual([
      { token: REDACTED },
      { token: REDACTED },
    ]);
  });

  it('keeps non-sensitive operational fields', () => {
    expect(
      redactValue({ employeeId: 'emp_1', payrollCycleId: 'pc_1', netPayPaise: 12345 }),
    ).toEqual({
      employeeId: 'emp_1',
      payrollCycleId: 'pc_1',
      netPayPaise: 12345,
    });
  });

  it('caps recursion depth', () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    expect(JSON.stringify(redactValue(deep))).toContain('[truncated]');
  });

  it('serialises errors without a stack', () => {
    const result = redactValue(new Error('boom')) as Record<string, unknown>;
    expect(result).toEqual({ name: 'Error', message: 'boom' });
  });
});
