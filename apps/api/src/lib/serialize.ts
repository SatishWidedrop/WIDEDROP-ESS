/**
 * JSON serialisation.
 *
 * Money is stored as `bigint` paise, which `JSON.stringify` refuses to
 * serialise. Every amount therefore crosses the wire as a **string of minor
 * units** — `"8600000"` — never as a JavaScript number: a salary in paise can
 * exceed 2^53, and a number that quietly loses precision on the way to a
 * payslip is a defect nobody notices until an employee does.
 *
 * The client converts to rupees only at render time.
 */

/**
 * Replacer for `JSON.stringify`. Converts bigint to a decimal string and Date
 * to an ISO instant; everything else is left alone.
 */
export function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value, jsonReplacer);
}

/**
 * Prisma's `Decimal` (day counts, rates) reaches us as an object with a
 * `toFixed`. Day counts are small and exact to two places, so they serialise as
 * numbers; rates keep their full precision as strings.
 */
export interface DecimalLike {
  toFixed(places?: number): string;
  toString(): string;
}

export function isDecimal(value: unknown): value is DecimalLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DecimalLike).toFixed === 'function' &&
    value.constructor?.name === 'Decimal'
  );
}

/** A day count: at most two decimal places, always exact. */
export function decimalToNumber(value: DecimalLike): number {
  return Number(value.toFixed(2));
}

/** A rate or multiplier: kept as a string so six decimal places survive. */
export function decimalToString(value: DecimalLike): string {
  return value.toString();
}
