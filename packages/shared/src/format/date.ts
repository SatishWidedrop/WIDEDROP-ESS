/**
 * Date and financial-year helpers.
 *
 * Display formatting matches the prototype: `en-IN`,
 * `{ day: 'numeric', month: 'short', year: 'numeric' }` → `29 Sep 2026`.
 *
 * Dates that represent a calendar day (leave dates, attendance days, payroll
 * periods) are handled as `YYYY-MM-DD` strings in UTC to avoid the timezone
 * drift that turns "1 Apr" into "31 Mar" for a user east or west of the server.
 */

/** A calendar day with no time component, as `YYYY-MM-DD`. */
export type IsoDate = string;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function parseIsoDate(value: IsoDate): Date {
  if (!isIsoDate(value)) throw new RangeError(`Not a valid calendar date: ${value}`);
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

export function toIsoDate(date: Date): IsoDate {
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const d = parseIsoDate(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/** Inclusive list of calendar days from `from` to `to`. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const start = parseIsoDate(from);
  const end = parseIsoDate(to);
  if (end < start) return [];
  const days: IsoDate[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(toIsoDate(cursor));
  }
  return days;
}

/** Saturday or Sunday. Organisation-specific week-offs come from the calendar. */
export function isWeekend(date: IsoDate): boolean {
  const day = parseIsoDate(date).getUTCDay();
  return day === 0 || day === 6;
}

/**
 * Count working days between two dates inclusive, excluding weekends and any
 * date in `holidays`. This is the server-side calculation behind every leave
 * day count — the client never computes it for storage.
 */
export function countWorkingDays(
  from: IsoDate,
  to: IsoDate,
  holidays: ReadonlySet<IsoDate> = new Set(),
): number {
  return eachDay(from, to).filter((d) => !isWeekend(d) && !holidays.has(d)).length;
}

const DISPLAY = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const DISPLAY_WITH_TIME = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'Asia/Kolkata',
});

/**
 * Current ICU renders September as `Sept` in en-IN, where every other month
 * abbreviates to three letters. The prototype uses three letters throughout, and
 * a column of dates only lines up if they are all the same width, so the one
 * four-letter abbreviation is trimmed back.
 */
function threeLetterMonths(formatted: string): string {
  return formatted.replace(/\bSept\b/, 'Sep');
}

/** `29 Sep 2026` — the prototype's date format. */
export function formatDate(value: IsoDate | Date | null | undefined): string {
  if (value == null) return '—';
  const date = typeof value === 'string' ? parseIsoDate(value) : value;
  return threeLetterMonths(DISPLAY.format(date));
}

/** `29 Sep 2026, 18:22` in IST — for audit trails and timestamps. */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (value == null) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return threeLetterMonths(DISPLAY_WITH_TIME.format(date));
}

/** `20 – 24 Oct 2026`, or a single date when both ends match. */
export function formatDateRange(from: IsoDate, to: IsoDate): string {
  return from === to ? formatDate(from) : `${formatDate(from)} – ${formatDate(to)}`;
}

/* ------------------------------------------------------------------ */
/* Indian financial year: 1 April – 31 March                           */
/* ------------------------------------------------------------------ */

export interface FinancialYear {
  /** Calendar year the FY starts in, e.g. 2026 for FY 2026–27. */
  startYear: number;
  start: IsoDate;
  end: IsoDate;
  /** `FY 2026–27` (en dash, as the prototype renders it). */
  label: string;
}

export function financialYearOf(date: IsoDate): FinancialYear {
  const d = parseIsoDate(date);
  const startYear = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return financialYear(startYear);
}

export function financialYear(startYear: number): FinancialYear {
  const endShort = ((startYear + 1) % 100).toString().padStart(2, '0');
  return {
    startYear,
    start: `${startYear}-04-01`,
    end: `${startYear + 1}-03-31`,
    label: `FY ${startYear}–${endShort}`,
  };
}

export type FinancialQuarter = 1 | 2 | 3 | 4;

export interface QuarterRange {
  quarter: FinancialQuarter;
  start: IsoDate;
  end: IsoDate;
  /** `Q1 · Apr – Jun 2026` */
  label: string;
}

const QUARTER_MONTHS: Record<FinancialQuarter, [number, number]> = {
  1: [3, 5], // Apr–Jun
  2: [6, 8], // Jul–Sep
  3: [9, 11], // Oct–Dec
  4: [0, 2], // Jan–Mar (of startYear + 1)
};

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function financialQuarters(startYear: number): QuarterRange[] {
  return ([1, 2, 3, 4] as FinancialQuarter[]).map((quarter) => {
    const [fromMonth, toMonth] = QUARTER_MONTHS[quarter];
    const year = quarter === 4 ? startYear + 1 : startYear;
    const start = toIsoDate(new Date(Date.UTC(year, fromMonth, 1)));
    // Day 0 of the next month is the last day of this one.
    const end = toIsoDate(new Date(Date.UTC(year, toMonth + 1, 0)));
    const label = `Q${quarter} · ${MONTH_SHORT[fromMonth]} – ${MONTH_SHORT[toMonth]} ${year}`;
    return { quarter, start, end, label };
  });
}

/** `August 2026` — payroll period label. */
export function formatMonth(year: number, month: number): string {
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));
}

/** Number of days in a calendar month — the payroll period denominator. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
