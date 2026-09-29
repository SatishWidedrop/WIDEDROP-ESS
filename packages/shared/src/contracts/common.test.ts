import { describe, expect, it } from 'vitest';
import {
  MAX_PAGE_SIZE,
  aadhaar,
  bankAccountNumber,
  cursorPagination,
  email,
  freeText,
  ifsc,
  isValidAadhaar,
  isoDate,
  paise,
  pan,
  phone,
  safeDisplayFilename,
  safeString,
  uan,
} from './common.js';

describe('text validators', () => {
  it('rejects control characters and bidi overrides in a single-line field', () => {
    const name = safeString(1, 100);
    expect(name.safeParse('Priya Raghavan').success).toBe(true);
    expect(name.safeParse('Priya\u0000Raghavan').success).toBe(false);
    expect(name.safeParse('Priya\nRaghavan').success).toBe(false);
    expect(name.safeParse('invoice‮fdp.exe').success).toBe(false);
  });

  it('allows newlines in free text but not other control characters', () => {
    const body = freeText(500);
    expect(body.safeParse('Line one\nLine two\tindented').success).toBe(true);
    expect(body.safeParse('bad \u0007 bell').success).toBe(false);
    expect(body.safeParse('spoofed ⁦order⁩').success).toBe(false);
  });

  it('trims and bounds length', () => {
    expect(safeString(1, 5).safeParse('  hi  ').data).toBe('hi');
    expect(safeString(1, 5).safeParse('too long').success).toBe(false);
    expect(safeString(1, 5).safeParse('   ').success).toBe(false);
  });
});

describe('email', () => {
  it('lower-cases so an account cannot be duplicated by capitalisation', () => {
    expect(email.parse('  Priya.Raghavan@Widedrop.COM ')).toBe('priya.raghavan@widedrop.com');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['no-at-sign', 'a@', '@b.com', 'a b@c.com']) {
      expect(email.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe('Indian statutory identifiers', () => {
  it('validates PAN', () => {
    expect(pan.parse(' axypr1234k ')).toBe('AXYPR1234K');
    for (const bad of ['AXYP1234K', 'AXYPR12345', '12345ABCDE', 'AXYPR1234KK']) {
      expect(pan.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('validates IFSC', () => {
    expect(ifsc.parse('hdfc0000523')).toBe('HDFC0000523');
    for (const bad of ['HDFC1000523', 'HDF00000523', 'HDFC000052']) {
      expect(ifsc.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('validates a bank account number as digits only', () => {
    expect(bankAccountNumber.safeParse('50100412344412').success).toBe(true);
    expect(bankAccountNumber.safeParse('5010-0412').success).toBe(false);
    expect(bankAccountNumber.safeParse('12345678').success).toBe(false);
  });

  it('validates a 12-digit UAN', () => {
    expect(uan.safeParse('101234567890').success).toBe(true);
    expect(uan.safeParse('10123456789').success).toBe(false);
  });

  it('validates Aadhaar with the Verhoeff checksum', () => {
    // 234123412346 is the standard Verhoeff-valid example.
    expect(isValidAadhaar('234123412346')).toBe(true);
    expect(aadhaar.safeParse('234123412346').success).toBe(true);

    // A single transposed digit must fail the checksum.
    expect(isValidAadhaar('234123412345')).toBe(false);
    expect(isValidAadhaar('234123412364')).toBe(false);
    // Real Aadhaar numbers never begin with 0 or 1.
    expect(isValidAadhaar('012345678901')).toBe(false);
    expect(isValidAadhaar('12345')).toBe(false);
  });
});

describe('phone', () => {
  it('requires E.164', () => {
    expect(phone.safeParse('+919845012234').success).toBe(true);
    expect(phone.safeParse('9845012234').success).toBe(false);
    expect(phone.safeParse('+0919845012234').success).toBe(false);
  });
});

describe('dates and money', () => {
  it('rejects impossible dates', () => {
    expect(isoDate.safeParse('2026-02-29').success).toBe(false);
    expect(isoDate.safeParse('2024-02-29').success).toBe(true);
    expect(isoDate.safeParse('2026-13-01').success).toBe(false);
    expect(isoDate.safeParse('29-09-2026').success).toBe(false);
  });

  it('accepts only whole, non-negative paise', () => {
    expect(paise.safeParse(8600000).success).toBe(true);
    expect(paise.safeParse(86000.5).success).toBe(false);
    expect(paise.safeParse(-100).success).toBe(false);
  });
});

describe('pagination', () => {
  it('defaults and caps the page size', () => {
    expect(cursorPagination.parse({}).limit).toBe(25);
    expect(cursorPagination.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(cursorPagination.safeParse({ limit: 0 }).success).toBe(false);
  });

  it('rejects unknown keys rather than ignoring them', () => {
    expect(cursorPagination.safeParse({ limit: 10, employeeId: 'other' }).success).toBe(false);
  });
});

describe('filename sanitisation', () => {
  it('strips directory traversal', () => {
    expect(safeDisplayFilename('../../etc/passwd')).toBe('passwd');
    expect(safeDisplayFilename('..\\..\\windows\\system32')).toBe('system32');
  });

  it('strips control characters and leading dots', () => {
    expect(safeDisplayFilename('.hidden\u0000.pdf')).toBe('hidden.pdf');
  });

  it('always returns something usable', () => {
    expect(safeDisplayFilename('')).toBe('file');
    expect(safeDisplayFilename('...')).toBe('file');
  });

  it('bounds the length', () => {
    expect(safeDisplayFilename('a'.repeat(400)).length).toBe(120);
  });
});
