import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cryptographic primitives.
 *
 * Application-layer encryption sits on top of the database's own at-rest
 * encryption, so that a leaked backup or a compromised read-replica still does
 * not reveal bank accounts, statutory identifiers or salary structures.
 *
 * Scheme: AES-256-GCM envelope encryption.
 *   - A key-encrypting key (KEK) comes from ENCRYPTION_KEK.
 *   - A per-record data key (DEK) is derived from the KEK with HKDF-SHA256,
 *     salted per record, so two records never share a key stream.
 *   - The ciphertext is stored with its key version, salt, IV and auth tag, so
 *     the KEK can be rotated and old rows re-encrypted lazily.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, the GCM standard
const SALT_BYTES = 16;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/** Serialised ciphertext, safe to store in a single text column. */
export interface SealedValue {
  /** Which KEK version sealed this value, e.g. `v1`. */
  v: string;
  /** Base64 per-record salt for the HKDF derivation. */
  s: string;
  /** Base64 GCM nonce. */
  i: string;
  /** Base64 ciphertext. */
  c: string;
  /** Base64 GCM authentication tag. */
  t: string;
}

function hkdf(kek: Buffer, salt: Buffer, info: string): Buffer {
  // RFC 5869 with SHA-256. Node's crypto.hkdfSync is available, but is written
  // out here so the construction is auditable and the `info` binding explicit.
  const prk = createHmac('sha256', salt).update(kek).digest();
  const okm = createHmac('sha256', prk)
    .update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([0x01])]))
    .digest();
  return okm.subarray(0, KEY_BYTES);
}

function decodeKek(kekBase64: string): Buffer {
  const kek = Buffer.from(kekBase64, 'base64');
  if (kek.length !== KEY_BYTES) {
    throw new Error('ENCRYPTION_KEK must decode to exactly 32 bytes');
  }
  return kek;
}

/**
 * Encrypt a value.
 *
 * `context` binds the ciphertext to where it lives (for example
 * `employee.bank_account_number:<employeeId>`). It is mixed into the key
 * derivation and authenticated as GCM additional data, so a ciphertext copied
 * from one row into another fails to decrypt instead of silently revealing the
 * wrong person's data.
 */
export function seal(
  plaintext: string,
  opts: { kek: string; keyVersion: string; context: string },
): SealedValue {
  const kek = decodeKek(opts.kek);
  const salt = randomBytes(SALT_BYTES);
  const key = hkdf(kek, salt, opts.context);
  const iv = randomBytes(IV_BYTES);

  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(`${opts.keyVersion}:${opts.context}`, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  key.fill(0);

  return {
    v: opts.keyVersion,
    s: salt.toString('base64'),
    i: iv.toString('base64'),
    c: ciphertext.toString('base64'),
    t: cipher.getAuthTag().toString('base64'),
  };
}

export function open(sealed: SealedValue, opts: { kek: string; context: string }): string {
  const kek = decodeKek(opts.kek);
  const salt = Buffer.from(sealed.s, 'base64');
  const key = hkdf(kek, salt, opts.context);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(sealed.i, 'base64'), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(Buffer.from(`${sealed.v}:${opts.context}`, 'utf8'));
    decipher.setAuthTag(Buffer.from(sealed.t, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.c, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Never leak which part failed — an attacker learns nothing from the error.
    throw new Error('Unable to decrypt value: authentication failed or wrong key');
  } finally {
    key.fill(0);
  }
}

export function serializeSealed(sealed: SealedValue): string {
  return JSON.stringify(sealed);
}

export function deserializeSealed(raw: string): SealedValue {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !['v', 's', 'i', 'c', 't'].every(
      (k) => typeof (parsed as Record<string, unknown>)[k] === 'string',
    )
  ) {
    throw new Error('Malformed sealed value');
  }
  return parsed as SealedValue;
}

/* ------------------------------------------------------------------ */
/* Masking — what a read returns when the caller may see that a value  */
/* exists but not the value itself.                                    */
/* ------------------------------------------------------------------ */

/**
 * `•• •••• •••• 4412` — keep the last `visible` characters, mask the rest.
 * Groups are formed from the right, so the visible tail is never split.
 */
export function maskTail(value: string, visible = 4, groupSize = 4): string {
  const clean = value.replace(/\s+/g, '');
  if (clean.length <= visible) return '\u2022'.repeat(clean.length);
  const masked = '\u2022'.repeat(clean.length - visible) + clean.slice(-visible);
  if (groupSize <= 0) return masked;
  const groups: string[] = [];
  for (let end = masked.length; end > 0; end -= groupSize) {
    groups.unshift(masked.slice(Math.max(0, end - groupSize), end));
  }
  return groups.join(' ');
}

/** `AXYPR••••K` — PAN keeps its first five and last character. */
export function maskPan(pan: string): string {
  const clean = pan.replace(/\s+/g, '').toUpperCase();
  if (clean.length !== 10) return '•'.repeat(Math.max(clean.length, 1));
  return `${clean.slice(0, 5)}••••${clean.slice(9)}`;
}

/** `p•••••@gmail.com` — enough to recognise, not enough to harvest. */
export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '•'.repeat(email.length);
  const local = email.slice(0, at);
  const head = local.slice(0, 1);
  return `${head}${'•'.repeat(Math.max(local.length - 1, 1))}${email.slice(at)}`;
}

/* ------------------------------------------------------------------ */
/* Tokens                                                              */
/* ------------------------------------------------------------------ */

/** A 256-bit opaque token, URL-safe. Used for refresh, reset and invite tokens. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a bearer-style token for storage. SHA-256 is correct here (unlike for
 * passwords): the token already carries 256 bits of entropy, so there is nothing
 * to brute-force, and the hash must be fast enough to check on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

/** Constant-time comparison of two hex/base64 digests of equal length. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export { randomUUID };

/* ------------------------------------------------------------------ */
/* Audit chain                                                         */
/* ------------------------------------------------------------------ */

/**
 * Deterministic canonical JSON: object keys sorted recursively, so the same
 * logical payload always produces the same digest regardless of key order.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object' && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    if (v instanceof Date) return v.toISOString();
    if (typeof v === 'bigint') return v.toString();
    return v;
  };
  return JSON.stringify(walk(value));
}

export interface AuditChainInput {
  /** Digest of the preceding row; the genesis row uses GENESIS_HASH. */
  previousHash: string;
  /** The row's own content, excluding its hash columns. */
  payload: unknown;
}

/** Digest of the empty chain — the `previous_hash` of the very first row. */
export const GENESIS_HASH = '0'.repeat(64);

/**
 * Seal an audit row into the chain: HMAC-SHA256 over the previous digest and the
 * canonicalised payload, keyed by AUDIT_HMAC_KEY.
 *
 * Because the key never leaves the application, an attacker with write access to
 * the database can alter a row but cannot recompute a valid chain — the break is
 * detectable by `verifyAuditChain`.
 */
export function sealAuditRow(input: AuditChainInput, hmacKeyBase64: string): string {
  const key = Buffer.from(hmacKeyBase64, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error('AUDIT_HMAC_KEY must decode to exactly 32 bytes');
  }
  return createHmac('sha256', key)
    .update(input.previousHash)
    .update('\u0000')
    .update(canonicalJson(input.payload))
    .digest('hex');
}

export interface AuditChainRow {
  id: string;
  previousHash: string;
  rowHash: string;
  payload: unknown;
}

export interface AuditChainVerification {
  valid: boolean;
  checked: number;
  /** The first row whose hash does not match, if any. */
  brokenAt?: { id: string; index: number; reason: 'hash-mismatch' | 'link-mismatch' };
}

/**
 * Walk a contiguous run of audit rows in order and verify both links:
 * each row's `previousHash` must equal its predecessor's `rowHash`, and each
 * row's `rowHash` must be reproducible from its payload.
 */
export function verifyAuditChain(
  rows: readonly AuditChainRow[],
  hmacKeyBase64: string,
  expectedFirstPreviousHash: string = GENESIS_HASH,
): AuditChainVerification {
  let previous = expectedFirstPreviousHash;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    if (row.previousHash !== previous) {
      return {
        valid: false,
        checked: index,
        brokenAt: { id: row.id, index, reason: 'link-mismatch' },
      };
    }
    const expected = sealAuditRow(
      { previousHash: row.previousHash, payload: row.payload },
      hmacKeyBase64,
    );
    if (!safeEqual(expected, row.rowHash)) {
      return {
        valid: false,
        checked: index,
        brokenAt: { id: row.id, index, reason: 'hash-mismatch' },
      };
    }
    previous = row.rowHash;
  }

  return { valid: true, checked: rows.length };
}
