import { z } from 'zod';

/**
 * Validation primitives shared by every request schema.
 *
 * Two rules hold throughout:
 *   1. Schemas are `.strict()` — an unknown key is a rejected request, not a
 *      silently ignored one. Mass assignment has no foothold.
 *   2. Strings are trimmed and length-bounded at the edge, so nothing unbounded
 *      reaches the database, a regular expression, or a log line.
 */

/**
 * Characters no field ever accepts:
 *   - C0/C1 control characters, which corrupt logs, CSV exports and terminals
 *   - Unicode bidirectional overrides, which can make a displayed string read
 *     differently from the one that was stored
 * Tab, newline and carriage return are allowed only where noted.
 */
/* eslint-disable no-control-regex -- matching control characters is the point */
const DISALLOWED_ANYWHERE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** As above, and additionally forbids tab, newline and carriage return. */
const DISALLOWED_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
/* eslint-enable no-control-regex */

const NOT_ALLOWED = 'Contains characters that are not allowed';

/** A single-line value: a name, a subject, an addressee. */
export const safeString = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .refine((v) => !DISALLOWED_SINGLE_LINE.test(v), NOT_ALLOWED);

/** Free text a person typed: a reason, a description, a comment. Newlines are fine. */
export const freeText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !DISALLOWED_ANYWHERE.test(v), NOT_ALLOWED);

/**
 * Email. Lower-cased so an account cannot be duplicated by capitalisation, and
 * length-bounded well under the RFC maximum to keep indexes small.
 */
export const email = z.string().trim().toLowerCase().email('Enter a valid email address').max(254);

/** CUID-style identifier, as Prisma generates. */
export const id = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid identifier');

export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((v) => {
    const [y, m, d] = v.split('-').map(Number) as [number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
  }, 'Not a real date');

/** An amount in paise. Never a float, never negative on a claim. */
export const paise = z
  .number()
  .int('Amounts are handled in paise and must be whole numbers')
  .nonnegative();

/** Indian mobile number in E.164, which is what we store. */
export const phone = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{7,14}$/, 'Use the international format, for example +919845012234');

/** Permanent Account Number: five letters, four digits, one letter. */
export const pan = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN, for example ABCDE1234F');

/** Indian Financial System Code: four letters, a zero, six alphanumerics. */
export const ifsc = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC, for example HDFC0000523');

/** Bank account number: digits only, 9–18 as issued by Indian banks. */
export const bankAccountNumber = z
  .string()
  .trim()
  .regex(/^\d{9,18}$/, 'Enter the account number as digits only');

/** Universal Account Number for provident fund: exactly 12 digits. */
export const uan = z
  .string()
  .trim()
  .regex(/^\d{12}$/, 'A UAN is 12 digits');

/**
 * Aadhaar. Validated with the Verhoeff checksum the UIDAI uses, so a typo is
 * caught before it reaches payroll.
 */
const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
] as const;

const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
] as const;

export function isValidAadhaar(value: string): boolean {
  if (!/^\d{12}$/.test(value)) return false;
  // The first digit of a real Aadhaar is never 0 or 1.
  if (value[0] === '0' || value[0] === '1') return false;
  let checksum = 0;
  const digits = value.split('').reverse().map(Number);
  for (let i = 0; i < digits.length; i += 1) {
    checksum = VERHOEFF_D[checksum]![VERHOEFF_P[i % 8]![digits[i]!]!]!;
  }
  return checksum === 0;
}

export const aadhaar = z
  .string()
  .trim()
  .refine(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number');

/* ------------------------------------------------------------------ */
/* Pagination                                                          */
/* ------------------------------------------------------------------ */

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/** Cursor pagination. Bounded so a caller cannot ask for the whole table. */
export const cursorPagination = z
  .object({
    cursor: z.string().trim().max(128).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  })
  .strict();

export type CursorPagination = z.infer<typeof cursorPagination>;

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` to fetch the next page. Absent on the last page. */
  nextCursor?: string;
  /**
   * Total matching rows. Present only where the count is cheap and the UI needs
   * it; a screen never displays a total the server did not return.
   */
  total?: number;
}

export const sortDirection = z.enum(['asc', 'desc']).default('desc');

/* ------------------------------------------------------------------ */
/* Error envelope — the single response shape for every failure        */
/* ------------------------------------------------------------------ */

export const errorDetail = z.object({
  path: z.string().optional(),
  message: z.string(),
  rule: z.string().optional(),
});

export const errorEnvelope = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.array(errorDetail).optional(),
    requestId: z.string(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

/* ------------------------------------------------------------------ */
/* Files                                                               */
/* ------------------------------------------------------------------ */

/** Upload limits. Enforced at the edge, again on the stream, and by the storage layer. */
export const FILE_LIMITS = {
  /** Expense bills, policy documents, profile-change proof. */
  maxBytes: 10 * 1024 * 1024,
  maxFilesPerRequest: 5,
} as const;

/**
 * Accepted upload types, keyed by declared MIME. The magic bytes of the stream
 * must agree with the declared type — a `.pdf` that is really an HTML file is
 * rejected before it is stored.
 */
export const ACCEPTED_UPLOAD_TYPES = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
} as const;

export type AcceptedUploadMime = keyof typeof ACCEPTED_UPLOAD_TYPES;

export const ACCEPTED_UPLOAD_EXTENSIONS = Object.values(ACCEPTED_UPLOAD_TYPES).flat();

/**
 * Strip a client-supplied filename down to something safe to echo back.
 * The stored key is generated server-side regardless; this is for display only.
 */
export function safeDisplayFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? 'file';
  return (
    base
      // eslint-disable-next-line no-control-regex -- stripping them is the point
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .replace(/[^A-Za-z0-9._ -]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'file'
  );
}
