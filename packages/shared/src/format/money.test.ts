import { describe, expect, it } from 'vitest';
import {
  EMPTY_VALUE,
  addPaise,
  assertPaise,
  formatINR,
  formatINRExact,
  multiplyPaise,
  paiseToRupees,
  proratePaise,
  roundToRupees,
  rupeesToPaise,
} from './money.js';

describe('paise arithmetic', () => {
  it('refuses a fractional amount', () => {
    expect(() => assertPaise(100.5)).toThrow(/integer number of paise/);
  });

  it('converts rupees to paise, rounding half away from zero', () => {
    expect(rupeesToPaise(86000)).toBe(8_600_000);
    expect(rupeesToPaise(0.005)).toBe(1);
    expect(rupeesToPaise(-0.005)).toBe(-1);
    expect(rupeesToPaise(1199.99)).toBe(119_999);
  });

  it('round-trips through rupees', () => {
    expect(paiseToRupees(rupeesToPaise(45_400.25))).toBe(45_400.25);
  });

  it('adds without floating-point drift', () => {
    // The classic 0.1 + 0.2 problem, which integers do not have.
    expect(addPaise(rupeesToPaise(0.1), rupeesToPaise(0.2))).toBe(30);
    expect(paiseToRupees(addPaise(rupeesToPaise(0.1), rupeesToPaise(0.2)))).toBe(0.3);
  });

  it('computes a percentage component exactly', () => {
    // Provident fund: 12% of a basic of ₹86,000.
    expect(multiplyPaise(8_600_000, 0.12)).toBe(1_032_000);
    expect(formatINR(multiplyPaise(8_600_000, 0.12))).toBe('₹10,320');
  });

  it('rejects a non-finite rate', () => {
    expect(() => multiplyPaise(100, Number.NaN)).toThrow(/finite/);
  });
});

describe('proration', () => {
  it('prorates by payable days over total days', () => {
    // 20 of 31 payable days on a basic of ₹86,000.
    expect(proratePaise(8_600_000, 20, 31)).toBe(5_548_387);
  });

  it('returns the full amount when every day is payable', () => {
    expect(proratePaise(8_600_000, 31, 31)).toBe(8_600_000);
  });

  it('returns zero, not NaN, for a malformed period', () => {
    expect(proratePaise(8_600_000, 10, 0)).toBe(0);
    expect(proratePaise(8_600_000, 10, -5)).toBe(0);
  });

  it('clamps a day count that exceeds the period', () => {
    expect(proratePaise(8_600_000, 40, 31)).toBe(8_600_000);
    expect(proratePaise(8_600_000, -3, 31)).toBe(0);
  });
});

describe('statutory rounding', () => {
  it('rounds net pay to whole rupees', () => {
    expect(roundToRupees(1_234_567)).toBe(1_234_600);
    expect(roundToRupees(1_234_549)).toBe(1_234_500);
  });
});

describe('formatting', () => {
  it('uses Indian digit grouping with no decimals, as the prototype does', () => {
    expect(formatINR(15_872_000)).toBe('₹1,58,720');
    expect(formatINR(8_600_000)).toBe('₹86,000');
    expect(formatINR(0)).toBe('₹0');
  });

  it('shows exact paise where a payslip line needs them', () => {
    expect(formatINRExact(119_999)).toBe('₹1,199.99');
  });

  it('shows an em dash for a value that does not exist, never a zero', () => {
    expect(formatINR(null)).toBe(EMPTY_VALUE);
    expect(formatINR(undefined)).toBe(EMPTY_VALUE);
    expect(formatINR(null)).not.toBe('₹0');
  });
});
