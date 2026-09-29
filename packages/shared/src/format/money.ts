/**
 * Money handling.
 *
 * Every monetary value crossing the API or stored in the database is an integer
 * number of **paise** (INR minor units). Floating-point rupees are never stored,
 * transmitted or arithmetic'd — see `docs/DATA-MODEL.md`.
 */

/** An integer count of paise. 1 rupee = 100 paise. */
export type Paise = number;

export const PAISE_PER_RUPEE = 100;

/** Largest value that stays exactly representable — ~₹90,071,992,547.40. */
const MAX_SAFE_PAISE = Number.MAX_SAFE_INTEGER;

export function assertPaise(value: number, field = 'amount'): Paise {
  if (!Number.isInteger(value)) {
    throw new RangeError(`${field} must be an integer number of paise, received ${value}`);
  }
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_SAFE_PAISE) {
    throw new RangeError(`${field} exceeds the safe integer range`);
  }
  return value;
}

/** Convert rupees (possibly fractional, e.g. from a CSV upload) to paise. */
export function rupeesToPaise(rupees: number): Paise {
  if (!Number.isFinite(rupees)) {
    throw new RangeError(`Cannot convert a non-finite value to paise: ${rupees}`);
  }
  // Round half away from zero so 0.005 -> 0.01 and -0.005 -> -0.01, matching
  // the statutory rounding convention used for payroll.
  const scaled = rupees * PAISE_PER_RUPEE;
  const rounded = scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
  return assertPaise(rounded);
}

export function paiseToRupees(paise: Paise): number {
  return assertPaise(paise) / PAISE_PER_RUPEE;
}

export function addPaise(...values: Paise[]): Paise {
  return assertPaise(values.reduce((sum, v) => sum + assertPaise(v), 0));
}

/**
 * Multiply a paise amount by a rate, rounding half away from zero.
 * Used for PF (12% of basic), proration and percentage-based components.
 */
export function multiplyPaise(paise: Paise, rate: number): Paise {
  assertPaise(paise);
  if (!Number.isFinite(rate)) {
    throw new RangeError(`Rate must be finite, received ${rate}`);
  }
  const product = paise * rate;
  return assertPaise(product < 0 ? -Math.round(-product) : Math.round(product));
}

/**
 * Prorate an amount by `numerator / denominator` (e.g. payable days over total
 * days), rounding half away from zero. A zero denominator yields zero rather
 * than NaN, so a malformed attendance period can never emit a NaN into the UI.
 */
export function proratePaise(paise: Paise, numerator: number, denominator: number): Paise {
  assertPaise(paise);
  if (denominator <= 0) return 0;
  const clamped = Math.max(0, Math.min(numerator, denominator));
  return multiplyPaise(paise, clamped / denominator);
}

/** Round a paise amount to whole rupees (statutory rounding for net pay). */
export function roundToRupees(paise: Paise): Paise {
  assertPaise(paise);
  const rupees = paise / PAISE_PER_RUPEE;
  const rounded = rupees < 0 ? -Math.round(-rupees) : Math.round(rupees);
  return rounded * PAISE_PER_RUPEE;
}

const INR_WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

const INR_EXACT = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Format paise the way the prototype does: `'₹' + Math.round(n).toLocaleString('en-IN')`
 * — Indian digit grouping, no decimals.
 */
export function formatINR(paise: Paise | null | undefined): string {
  if (paise == null) return EMPTY_VALUE;
  return INR_WHOLE.format(paiseToRupees(assertPaise(paise)));
}

/** Format paise with exact paise, for payslip lines and statutory reports. */
export function formatINRExact(paise: Paise | null | undefined): string {
  if (paise == null) return EMPTY_VALUE;
  return INR_EXACT.format(paiseToRupees(assertPaise(paise)));
}

/**
 * The placeholder shown when a value genuinely does not exist yet.
 *
 * Absent values render as an em dash with an explanatory sub-label — they are
 * never replaced with a zero, an estimate or a sample figure.
 */
export const EMPTY_VALUE = '—';
