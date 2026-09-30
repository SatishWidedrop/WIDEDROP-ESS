import type { Readable } from 'node:stream';

/**
 * Object storage.
 *
 * Payslip PDFs, expense bills, policy documents and letters are business
 * records: private, durable, and never served directly from the origin. The API
 * is the only thing that can read them, and it issues a short-lived signed URL
 * only after an authorization check has passed.
 *
 * Two drivers implement this: `filesystem` for development and `s3` for
 * production. Nothing above this interface knows which is in use.
 */

export interface StoredObject {
  /** Server-generated key. Never derived from a client-supplied filename. */
  key: string;
  size: number;
  contentType: string;
  /** SHA-256 of the bytes, for integrity checks and deduplication. */
  sha256: string;
}

export interface PutObjectInput {
  key: string;
  body: Buffer | Readable;
  contentType: string;
  /** Filename offered to the browser on download. Sanitised by the caller. */
  downloadFilename?: string;
  /** Written as object metadata so an orphaned object can be traced back. */
  metadata?: Record<string, string>;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface StorageDriver {
  readonly name: 'filesystem' | 's3';

  put(input: PutObjectInput): Promise<StoredObject>;

  get(key: string): Promise<{ body: Readable; contentType: string; size: number }>;

  /**
   * A time-limited URL the browser can follow. Callers must already have
   * checked that this user may read this object — the URL itself is the
   * capability, so its lifetime is kept short.
   */
  signedDownloadUrl(
    key: string,
    options: { expiresInSeconds: number; downloadFilename: string },
  ): Promise<SignedUrl>;

  delete(key: string): Promise<void>;

  exists(key: string): Promise<boolean>;
}

/**
 * Build a storage key. Keys are opaque, namespaced by purpose and date so that
 * lifecycle rules can act on them, and end in a random component so one object's
 * key can never be guessed from another's.
 *
 * Nothing in a key is taken from user input.
 */
export function buildStorageKey(input: {
  purpose: string;
  /** Owning entity, e.g. an employee or payroll cycle id. */
  scopeId: string;
  /** Random, unique per object. */
  objectId: string;
  extension: string;
  /** Defaults to the current date; passed in so callers stay deterministic. */
  date: Date;
}): string {
  const year = input.date.getUTCFullYear();
  const month = String(input.date.getUTCMonth() + 1).padStart(2, '0');
  const safe = (v: string) => v.replace(/[^A-Za-z0-9_-]/g, '');
  const extension = input.extension.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return `${safe(input.purpose)}/${year}/${month}/${safe(input.scopeId)}/${safe(input.objectId)}.${extension}`;
}

/**
 * The exact shape `buildStorageKey` produces, and nothing else.
 *
 * Keys are generated server-side, so this is defence in depth — it is the one
 * check both drivers make before a key reaches a filesystem path or an S3
 * request line. A key that fails here never becomes either.
 */
export function isValidStorageKey(key: string): boolean {
  if (key.length === 0 || key.length > 512) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F\\]/.test(key)) return false;
  if (key.startsWith('/') || key.endsWith('/')) return false;
  const segments = key.split('/');
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      /^[A-Za-z0-9._-]+$/.test(segment) &&
      segment !== '.' &&
      segment !== '..',
  );
}

/**
 * A `Content-Disposition` value that offers `filename` to the browser without
 * letting it inject a header.
 *
 * The filename reaches here from a database row that an employee's upload named,
 * so it is treated as hostile: the quoted form is reduced to a conservative
 * ASCII subset, and the RFC 5987 form carries the real name percent-encoded for
 * every browser in use. A name that reduces to nothing falls back to `download`
 * rather than emitting an empty filename, which some browsers ignore entirely.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .replace(/[^\x20-\x7E]/g, '_')
    .replace(/["\\]/g, '_')
    .slice(0, 200)
    .trim();
  const fallback = ascii.length > 0 ? ascii : 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(filename)}`;
}

function encodeRFC5987(value: string): string {
  return encodeURIComponent(value.slice(0, 200))
    .replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%(7C|60|5E)/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
