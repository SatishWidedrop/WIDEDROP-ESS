import { createHmac } from 'node:crypto';
import {
  deserializeSealed,
  maskEmail,
  maskPan,
  maskTail,
  open,
  seal,
  serializeSealed,
  type SealedValue,
} from '../lib/crypto.js';
import type { Env } from '../config/env.js';

/**
 * Field-level encryption.
 *
 * Wraps the crypto primitives with the configured key and the context binding,
 * so no call site has to remember either. The context ties a ciphertext to the
 * row it belongs to: a value copied from one employee's record into another's
 * fails to decrypt rather than silently revealing the wrong person's data.
 *
 * The database stores the envelope in three columns — ciphertext, nonce and
 * authentication tag — plus the key version, so the key can be rotated and rows
 * re-encrypted lazily.
 */

/**
 * The three columns an envelope occupies, plus its key version.
 *
 * Reads accept `Uint8Array` because that is what Prisma returns for `Bytes`;
 * writes produce `Buffer`, which is what Prisma accepts.
 */
export interface EncryptedColumns {
  ct: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: string;
}

/**
 * What a write produces. Typed as `Uint8Array` because that is what Prisma's
 * `Bytes` columns accept, and a `Buffer` is one.
 */
export interface EncryptedWrite {
  ct: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
  keyVersion: string;
}

export class EncryptionService {
  private readonly kek: string;
  private readonly keyVersion: string;
  private readonly fingerprintKey: Buffer;

  constructor(env: Pick<Env, 'ENCRYPTION_KEK' | 'ENCRYPTION_KEY_VERSION' | 'AUDIT_HMAC_KEY'>) {
    this.kek = env.ENCRYPTION_KEK;
    this.keyVersion = env.ENCRYPTION_KEY_VERSION;
    // Fingerprints are keyed separately from the encryption key, so a
    // compromise of one does not make the other's output forgeable.
    this.fingerprintKey = Buffer.from(env.AUDIT_HMAC_KEY, 'base64');
  }

  /** `table.column:rowId` — what binds a ciphertext to its row. */
  static context(table: string, column: string, rowId: string): string {
    return `${table}.${column}:${rowId}`;
  }

  encrypt(plaintext: string, context: string): EncryptedWrite {
    const sealed = seal(plaintext, {
      kek: this.kek,
      keyVersion: this.keyVersion,
      context,
    });
    // Copied into a plain Uint8Array rather than handed over as a Buffer: a
    // Buffer may be a view onto Node's shared allocation pool, and the database
    // driver's byte columns want an array that owns its own memory.
    const bytes = (base64: string): Uint8Array<ArrayBuffer> =>
      Uint8Array.from(Buffer.from(base64, 'base64'));
    return {
      ct: bytes(sealed.c),
      iv: bytes(sealed.i),
      tag: bytes(sealed.t),
      // The per-record salt travels with the key version so the envelope stays
      // three columns rather than four.
      keyVersion: `${sealed.v}:${sealed.s}`,
    };
  }

  decrypt(columns: EncryptedColumns, context: string): string {
    const [version, salt] = columns.keyVersion.split(':') as [string, string];
    const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
    const sealed: SealedValue = {
      v: version,
      s: salt ?? '',
      i: base64(columns.iv),
      c: base64(columns.ct),
      t: base64(columns.tag),
    };
    return open(sealed, { kek: this.kek, context });
  }

  /**
   * A keyed digest of a normalised value.
   *
   * Lets a unique constraint and a lookup work over encrypted data: two
   * employees cannot register the same PAN, and a search can find a record by
   * its identifier, without anything being decrypted or the plaintext being
   * stored a second time.
   */
  fingerprint(value: string): string {
    return createHmac('sha256', this.fingerprintKey)
      .update(value.trim().toUpperCase())
      .digest('hex');
  }

  /** Serialise an envelope into a single text column, where one is used. */
  serialize(plaintext: string, context: string): string {
    return serializeSealed(
      seal(plaintext, { kek: this.kek, keyVersion: this.keyVersion, context }),
    );
  }

  deserialize(raw: string, context: string): string {
    return open(deserializeSealed(raw), { kek: this.kek, context });
  }

  /** What a read returns when the caller may know a value exists but not what it is. */
  mask(value: string, kind: 'account' | 'pan' | 'aadhaar' | 'uan' | 'email' | 'phone'): string {
    switch (kind) {
      case 'pan':
        return maskPan(value);
      case 'email':
        return maskEmail(value);
      case 'aadhaar':
      case 'uan':
      case 'account':
        return maskTail(value, 4, 4);
      case 'phone':
        return maskTail(value, 4, 0);
    }
  }
}
