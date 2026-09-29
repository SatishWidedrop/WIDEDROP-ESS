import { describe, expect, it } from 'vitest';
import {
  addDays,
  countWorkingDays,
  daysInMonth,
  eachDay,
  financialQuarters,
  financialYear,
  financialYearOf,
  formatDate,
  formatDateRange,
  formatMonth,
  isIsoDate,
  isWeekend,
  toIsoDate,
} from './date.js';

describe('calendar dates', () => {
  it('validates real dates only', () => {
    expect(isIsoDate('2026-09-29')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-29')).toBe(false);
  });

  it('does not drift across timezones', () => {
    // Formatting is pinned to UTC, so 1 April never renders as 31 March.
    expect(formatDate('2026-04-01')).toBe('1 Apr 2026');
    expect(toIsoDate(new Date(Date.UTC(2026, 3, 1)))).toBe('2026-04-01');
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('enumerates an inclusive range and nothing for a reversed one', () => {
    expect(eachDay('2026-10-20', '2026-10-24')).toHaveLength(5);
    expect(eachDay('2026-10-24', '2026-10-20')).toEqual([]);
  });
});

describe('working days', () => {
  it('excludes weekends', () => {
    // Mon 5 Oct 2026 to Fri 9 Oct 2026.
    expect(countWorkingDays('2026-10-05', '2026-10-09')).toBe(5);
    // The same range extended over the weekend adds no payable days.
    expect(countWorkingDays('2026-10-05', '2026-10-11')).toBe(5);
  });

  it('excludes holidays from the calendar', () => {
    const holidays = new Set(['2026-10-20']);
    expect(countWorkingDays('2026-10-19', '2026-10-23', holidays)).toBe(4);
  });

  it('returns zero for a range entirely on a weekend', () => {
    expect(countWorkingDays('2026-10-10', '2026-10-11')).toBe(0);
  });

  it('identifies weekends', () => {
    expect(isWeekend('2026-10-10')).toBe(true); // Saturday
    expect(isWeekend('2026-10-11')).toBe(true); // Sunday
    expect(isWeekend('2026-10-12')).toBe(false); // Monday
  });
});

describe('financial year', () => {
  it('runs April to March', () => {
    expect(financialYear(2026)).toMatchObject({
      start: '2026-04-01',
      end: '2027-03-31',
      label: 'FY 2026–27',
    });
  });

  it('places a March date in the preceding financial year', () => {
    expect(financialYearOf('2026-03-31').startYear).toBe(2025);
    expect(financialYearOf('2026-04-01').startYear).toBe(2026);
  });

  it('builds the four quarters the tax screen shows', () => {
    const quarters = financialQuarters(2026);
    expect(quarters.map((q) => q.label)).toEqual([
      'Q1 · Apr – Jun 2026',
      'Q2 · Jul – Sep 2026',
      'Q3 · Oct – Dec 2026',
      'Q4 · Jan – Mar 2027',
    ]);
    expect(quarters[0]).toMatchObject({ start: '2026-04-01', end: '2026-06-30' });
    expect(quarters[3]).toMatchObject({ start: '2027-01-01', end: '2027-03-31' });
  });
});

describe('payroll periods', () => {
  it('labels a month the way the payslip list does', () => {
    expect(formatMonth(2026, 8)).toBe('August 2026');
  });

  it('counts the days in a month, including a leap February', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2026, 8)).toBe(31);
    expect(daysInMonth(2026, 9)).toBe(30);
  });
});

describe('display', () => {
  it('formats a range, collapsing a single day', () => {
    expect(formatDateRange('2026-10-20', '2026-10-24')).toBe('20 Oct 2026 – 24 Oct 2026');
    expect(formatDateRange('2026-09-15', '2026-09-15')).toBe('15 Sep 2026');
  });

  it('abbreviates every month to three letters so a date column lines up', () => {
    const widths = new Set(
      Array.from(
        { length: 12 },
        (_, i) => formatDate(`2026-${String(i + 1).padStart(2, '0')}-01`).split(' ')[1]!.length,
      ),
    );
    expect(widths).toEqual(new Set([3]));
    expect(formatDate('2026-09-15')).toBe('15 Sep 2026');
  });

  it('shows an em dash for an absent date', () => {
    expect(formatDate(null)).toBe('—');
  });
});
