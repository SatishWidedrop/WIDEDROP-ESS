import { describe, expect, it } from 'vitest';
import {
  GENESIS_HASH,
  canonicalJson,
  deserializeSealed,
  generateOpaqueToken,
  hashToken,
  maskEmail,
  maskPan,
  maskTail,
  open,
  safeEqual,
  seal,
  sealAuditRow,
  serializeSealed,
  verifyAuditChain,
} from './crypto.js';

const KEK = Buffer.alloc(32, 7).toString('base64');
const HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
const CONTEXT = 'employee.bank_account_number:emp_1';

describe('envelope encryption', () => {
  it('round-trips a value', () => {
    const sealed = seal('50100412345678', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    expect(open(sealed, { kek: KEK, context: CONTEXT })).toBe('50100412345678');
  });

  it('produces a different ciphertext each time for the same plaintext', () => {
    const a = seal('AXYPR1234K', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    const b = seal('AXYPR1234K', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    expect(a.c).not.toBe(b.c);
    expect(a.i).not.toBe(b.i);
    expect(a.s).not.toBe(b.s);
  });

  it('refuses to decrypt a ciphertext moved to another record', () => {
    const sealed = seal('50100412345678', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    expect(() =>
      open(sealed, { kek: KEK, context: 'employee.bank_account_number:emp_2' }),
    ).toThrow(/authentication failed/i);
  });

  it('refuses to decrypt with the wrong key', () => {
    const sealed = seal('secret', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    const otherKek = Buffer.alloc(32, 8).toString('base64');
    expect(() => open(sealed, { kek: otherKek, context: CONTEXT })).toThrow();
  });

  it('detects a tampered ciphertext', () => {
    const sealed = seal('50100412345678', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    const bytes = Buffer.from(sealed.c, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;
    expect(() => open({ ...sealed, c: bytes.toString('base64') }, { kek: KEK, context: CONTEXT })).toThrow();
  });

  it('survives serialisation to a text column', () => {
    const sealed = seal('KA/BNG/0048221', { kek: KEK, keyVersion: 'v1', context: CONTEXT });
    const restored = deserializeSealed(serializeSealed(sealed));
    expect(open(restored, { kek: KEK, context: CONTEXT })).toBe('KA/BNG/0048221');
  });

  it('rejects a KEK that is not 32 bytes', () => {
    expect(() => seal('x', { kek: 'c2hvcnQ=', keyVersion: 'v1', context: CONTEXT })).toThrow(/32 bytes/);
  });
});

describe('masking', () => {
  it('masks an account number keeping the last four digits', () => {
    expect(maskTail('50100412344412')).toBe('•• •••• •••• 4412');
  });

  it('masks a PAN', () => {
    expect(maskPan('AXYPR1234K')).toBe('AXYPR••••K');
  });

  it('masks an email local part', () => {
    expect(maskEmail('priya.r94@gmail.com')).toBe('p••••••••@gmail.com');
  });

  it('never reveals a short value', () => {
    expect(maskTail('12', 4)).toBe('••');
  });
});

describe('tokens', () => {
  it('generates distinct high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => generateOpaqueToken()));
    expect(tokens.size).toBe(200);
    expect([...tokens][0]!.length).toBeGreaterThanOrEqual(43);
  });

  it('hashes deterministically', () => {
    const token = generateOpaqueToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
  });

  it('compares in constant time without throwing on length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('canonical JSON', () => {
  it('is independent of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it('preserves array order', () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });
});

describe('audit chain', () => {
  const build = (payloads: unknown[]) => {
    let previousHash = GENESIS_HASH;
    return payloads.map((payload, index) => {
      const rowHash = sealAuditRow({ previousHash, payload }, HMAC_KEY);
      const row = { id: `audit_${index}`, previousHash, rowHash, payload };
      previousHash = rowHash;
      return row;
    });
  };

  it('verifies an intact chain', () => {
    const rows = build([{ action: 'login' }, { action: 'payslip.publish' }, { action: 'logout' }]);
    expect(verifyAuditChain(rows, HMAC_KEY)).toEqual({ valid: true, checked: 3 });
  });

  it('detects an edited payload', () => {
    const rows = build([{ action: 'login' }, { action: 'payslip.publish', amount: 100 }]);
    rows[1] = { ...rows[1]!, payload: { action: 'payslip.publish', amount: 999 } };
    const result = verifyAuditChain(rows, HMAC_KEY);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toMatchObject({ index: 1, reason: 'hash-mismatch' });
  });

  it('detects a deleted row by the broken link', () => {
    const rows = build([{ a: 1 }, { b: 2 }, { c: 3 }]);
    const result = verifyAuditChain([rows[0]!, rows[2]!], HMAC_KEY);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toMatchObject({ index: 1, reason: 'link-mismatch' });
  });

  it('cannot be forged without the HMAC key', () => {
    const rows = build([{ a: 1 }]);
    const forged = sealAuditRow(
      { previousHash: GENESIS_HASH, payload: { a: 2 } },
      Buffer.alloc(32, 1).toString('base64'),
    );
    expect(forged).not.toBe(rows[0]!.rowHash);
  });

  it('accepts an empty chain', () => {
    expect(verifyAuditChain([], HMAC_KEY)).toEqual({ valid: true, checked: 0 });
  });
});
