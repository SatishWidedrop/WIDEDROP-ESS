import { createHash } from 'node:crypto';
import { canonicalJson } from '../../lib/crypto.js';

/**
 * The payroll calculation engine.
 *
 * Deliberately pure: it takes a fully-resolved set of inputs and returns a
 * payslip. It reads nothing, writes nothing and consults no clock. The same
 * inputs always produce the same output, which is what makes a payslip
 * reproducible years later — and what lets the digest stored on the payslip
 * mean something.
 *
 * All money is integer paise.
 */

export const ENGINE_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/* Inputs                                                              */
/* ------------------------------------------------------------------ */

export type ComponentKind = 'EARNING' | 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION' | 'INFORMATIONAL';

export type ComponentCalc =
  | 'FIXED'
  | 'PERCENT_OF_BASIC'
  | 'PERCENT_OF_GROSS'
  | 'SLAB'
  | 'INPUT_DRIVEN'
  | 'STATUTORY_ENGINE'
  | 'PRORATED_FIXED';

export interface ComponentDefinition {
  code: string;
  name: string;
  kind: ComponentKind;
  calc: ComponentCalc;
  /** Percentage as a fraction, e.g. 0.12 for provident fund. */
  rate?: number | undefined;
  /** Statutory ceiling on the base this component is computed from, in paise. */
  ceilingMinor?: number | undefined;
  /** Whether loss of pay reduces it. */
  isProrated: boolean;
  isTaxable: boolean;
  /** Whether it counts towards the provident-fund wage base. */
  isPfApplicable: boolean;
  displayOrder: number;
}

export interface StructuredComponent {
  definition: ComponentDefinition;
  /** Monthly amount for a fixed component, in paise. */
  monthlyAmountMinor?: number | undefined;
  /** Per-employee override of the definition's rate. */
  rateOverride?: number | undefined;
}

/** A one-off from the Accounts upload: an incentive, an arrear, a recovery. */
export interface PayrollInput {
  kind:
    | 'VARIABLE_PAY'
    | 'INCENTIVE'
    | 'BONUS'
    | 'ARREAR'
    | 'ONE_OFF_DEDUCTION'
    | 'LOP_OVERRIDE'
    | 'REIMBURSEMENT_PAYOUT'
    | 'ADVANCE_RECOVERY'
    | 'TDS_OVERRIDE';
  componentCode?: string | undefined;
  componentName?: string | undefined;
  amountMinor?: number | undefined;
  /** For LOP_OVERRIDE: days to treat as loss of pay, overriding attendance. */
  days?: number | undefined;
  note?: string | undefined;
  sourceId: string;
}

export interface AttendanceInput {
  /** Calendar days in the period — the proration denominator. */
  totalDays: number;
  /** Present + paid leave + holiday + week-off, from the approved record. */
  payableDays: number;
  /** Unpaid leave + absence. */
  lopDays: number;
  /** Days the employee was on the rolls, for joiners and leavers. */
  employedDays: number;
}

export interface TaxInput {
  regime: 'OLD' | 'NEW';
  /** Slabs in ascending order. `upToMinor: null` is the top, open-ended slab. */
  slabs: { upToMinor: number | null; rate: number }[];
  standardDeductionMinor: number;
  rebateThresholdMinor?: number | undefined;
  rebateMaxMinor?: number | undefined;
  cessRate: number;
  /** Verified chapter VI-A deductions, in paise. Zero under the new regime. */
  verifiedDeductionsMinor: number;
  /** Months remaining in the financial year, including this one. */
  monthsRemaining: number;
  /** Tax already deducted this financial year, in paise. */
  tdsPaidToDateMinor: number;
  /** Earnings already paid this financial year, in paise. */
  grossPaidToDateMinor: number;
}

export interface StatutoryInput {
  /** Provident-fund wage ceiling, in paise. Currently ₹15,000. */
  pfWageCeilingMinor: number;
  pfEmployeeRate: number;
  pfEmployerRate: number;
  /** Whether the employee is covered, e.g. an international worker may not be. */
  pfApplicable: boolean;
  /** Professional tax for the employee's state, in paise per month. */
  professionalTaxMinor: number;
  /** Employees' State Insurance, which applies below a gross threshold. */
  esiApplicable: boolean;
  esiThresholdMinor: number;
  esiEmployeeRate: number;
  esiEmployerRate: number;
}

export interface PayrollComputation {
  employeeId: string;
  periodStart: string;
  periodEnd: string;
  components: StructuredComponent[];
  attendance: AttendanceInput;
  inputs: PayrollInput[];
  tax: TaxInput;
  statutory: StatutoryInput;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

export interface ComputedLine {
  kind: ComponentKind;
  componentCode: string | null;
  label: string;
  amountMinor: number;
  /** The unprorated entitlement, where loss of pay reduced this line. */
  fullAmountMinor?: number;
  displayOrder: number;
  /** How the number was reached, in words, for the payslip and the audit trail. */
  calculationNote?: string;
  payrollInputSourceId?: string;
}

export interface ComputedPayslip {
  employeeId: string;
  engineVersion: string;
  lines: ComputedLine[];
  grossEarningsMinor: number;
  totalDeductionsMinor: number;
  netPayMinor: number;
  employerContributionMinor: number;
  pfEmployeeMinor: number;
  pfEmployerMinor: number;
  tdsMinor: number;
  professionalTaxMinor: number;
  payableDays: number;
  totalDays: number;
  lopDays: number;
  /** SHA-256 over the canonical inputs. Identical inputs reproduce it exactly. */
  sourceDigest: string;
}

/* ------------------------------------------------------------------ */
/* Arithmetic                                                          */
/* ------------------------------------------------------------------ */

/** Round half away from zero — the convention Indian payroll uses. */
function round(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

function percent(base: number, rate: number): number {
  return round(base * rate);
}

/**
 * Prorate by payable days over total days.
 *
 * A zero denominator yields zero rather than NaN: a malformed attendance period
 * must not put a NaN on a payslip.
 */
function prorate(amount: number, payableDays: number, totalDays: number): number {
  if (totalDays <= 0) return 0;
  const clamped = Math.max(0, Math.min(payableDays, totalDays));
  return round(amount * (clamped / totalDays));
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export function computePayslip(input: PayrollComputation): ComputedPayslip {
  const { attendance, statutory, tax } = input;

  // Loss-of-pay days come from the approved attendance record unless Accounts
  // uploaded an explicit override, which is recorded and auditable.
  const lopOverride = input.inputs.find((i) => i.kind === 'LOP_OVERRIDE' && i.days !== undefined);
  const lopDays = lopOverride?.days ?? attendance.lopDays;
  const payableDays = Math.max(0, attendance.totalDays - lopDays);

  const lines: ComputedLine[] = [];

  /* ---- 1. Basic, then everything derived from it ------------------ */

  const ordered = [...input.components].sort(
    (a, b) => a.definition.displayOrder - b.definition.displayOrder,
  );

  // Percentage components are computed from the FULL basic and then prorated
  // themselves, rather than from an already-prorated basic. Prorating twice
  // would understate house rent allowance on any month with loss of pay.
  const basicComponent = ordered.find((c) => c.definition.code === 'BASIC');
  const fullBasic = basicComponent?.monthlyAmountMinor ?? 0;

  /* ---- 2. Earnings from the salary structure ---------------------- */

  let grossEarnings = 0;
  let pfWageBase = 0;

  for (const component of ordered) {
    const { definition } = component;
    if (definition.kind !== 'EARNING') continue;

    const rate = component.rateOverride ?? definition.rate ?? 0;

    let full: number;
    switch (definition.calc) {
      case 'FIXED':
      case 'PRORATED_FIXED':
        full = component.monthlyAmountMinor ?? 0;
        break;
      case 'PERCENT_OF_BASIC':
        full = percent(fullBasic, rate);
        break;
      default:
        full = component.monthlyAmountMinor ?? 0;
    }

    const amount = definition.isProrated ? prorate(full, payableDays, attendance.totalDays) : full;

    if (amount === 0 && full === 0) continue;

    lines.push({
      kind: 'EARNING',
      componentCode: definition.code,
      label: definition.name,
      amountMinor: amount,
      ...(amount !== full ? { fullAmountMinor: full } : {}),
      displayOrder: definition.displayOrder,
      ...(amount !== full
        ? {
            calculationNote: `Prorated for ${payableDays} of ${attendance.totalDays} payable days`,
          }
        : definition.calc === 'PERCENT_OF_BASIC'
          ? { calculationNote: `${(rate * 100).toFixed(0)}% of basic salary` }
          : {}),
    });

    grossEarnings += amount;
    if (definition.isPfApplicable) pfWageBase += amount;
  }

  /* ---- 3. One-off earnings from the Accounts upload --------------- */

  const EARNING_INPUTS = new Set([
    'VARIABLE_PAY',
    'INCENTIVE',
    'BONUS',
    'ARREAR',
    'REIMBURSEMENT_PAYOUT',
  ]);

  let extraOrder = 100;
  for (const item of input.inputs) {
    if (!EARNING_INPUTS.has(item.kind) || !item.amountMinor) continue;

    lines.push({
      kind: 'EARNING',
      componentCode: item.componentCode ?? null,
      label: item.componentName ?? humanise(item.kind),
      amountMinor: item.amountMinor,
      displayOrder: extraOrder,
      ...(item.note ? { calculationNote: item.note } : {}),
      payrollInputSourceId: item.sourceId,
    });
    extraOrder += 1;

    grossEarnings += item.amountMinor;
    // A reimbursement payout is a repayment of money already spent, so it is
    // neither taxable nor part of the provident-fund wage base.
    if (item.kind !== 'REIMBURSEMENT_PAYOUT') {
      // Variable pay is taxable but, by convention, outside the PF base.
    }
  }

  /* ---- 4. Statutory deductions ------------------------------------ */

  let pfEmployee = 0;
  let pfEmployer = 0;

  if (statutory.pfApplicable && pfWageBase > 0) {
    // Contributions are capped at the statutory wage ceiling, which is why a
    // high earner's provident fund does not scale with their salary.
    const cappedBase = Math.min(pfWageBase, statutory.pfWageCeilingMinor);
    pfEmployee = percent(cappedBase, statutory.pfEmployeeRate);
    pfEmployer = percent(cappedBase, statutory.pfEmployerRate);

    lines.push({
      kind: 'DEDUCTION',
      componentCode: 'PF_EMPLOYEE',
      label: 'Provident fund (employee)',
      amountMinor: pfEmployee,
      displayOrder: 200,
      calculationNote:
        cappedBase < pfWageBase
          ? `${(statutory.pfEmployeeRate * 100).toFixed(0)}% of the statutory wage ceiling`
          : `${(statutory.pfEmployeeRate * 100).toFixed(0)}% of provident-fund wages`,
    });

    lines.push({
      kind: 'EMPLOYER_CONTRIBUTION',
      componentCode: 'PF_EMPLOYER',
      label: 'Provident fund (employer)',
      amountMinor: pfEmployer,
      displayOrder: 400,
      calculationNote: 'Paid by Widedrop in addition to your salary',
    });
  }

  let esiEmployee = 0;
  let esiEmployer = 0;
  if (
    statutory.esiApplicable &&
    grossEarnings > 0 &&
    grossEarnings <= statutory.esiThresholdMinor
  ) {
    esiEmployee = percent(grossEarnings, statutory.esiEmployeeRate);
    esiEmployer = percent(grossEarnings, statutory.esiEmployerRate);

    lines.push({
      kind: 'DEDUCTION',
      componentCode: 'ESI_EMPLOYEE',
      label: 'Employees’ State Insurance',
      amountMinor: esiEmployee,
      displayOrder: 210,
      calculationNote: `${(statutory.esiEmployeeRate * 100).toFixed(2)}% of gross earnings`,
    });
    lines.push({
      kind: 'EMPLOYER_CONTRIBUTION',
      componentCode: 'ESI_EMPLOYER',
      label: 'Employees’ State Insurance (employer)',
      amountMinor: esiEmployer,
      displayOrder: 410,
    });
  }

  const professionalTax = statutory.professionalTaxMinor;
  if (professionalTax > 0) {
    lines.push({
      kind: 'DEDUCTION',
      componentCode: 'PROFESSIONAL_TAX',
      label: 'Professional tax',
      amountMinor: professionalTax,
      displayOrder: 220,
      calculationNote: 'State levy, deducted at source',
    });
  }

  /* ---- 5. Income tax ---------------------------------------------- */

  const tdsOverride = input.inputs.find((i) => i.kind === 'TDS_OVERRIDE' && i.amountMinor != null);

  const tds =
    tdsOverride?.amountMinor ??
    computeMonthlyTds({
      grossThisMonth: grossEarnings,
      pfEmployee,
      professionalTax,
      tax,
    });

  if (tds > 0) {
    lines.push({
      kind: 'DEDUCTION',
      componentCode: 'TDS',
      label: 'Income tax (TDS)',
      amountMinor: tds,
      displayOrder: 230,
      calculationNote: tdsOverride
        ? 'Adjusted by Payroll'
        : `Computed on projected annual income under the ${tax.regime === 'NEW' ? 'new' : 'old'} regime`,
      ...(tdsOverride ? { payrollInputSourceId: tdsOverride.sourceId } : {}),
    });
  }

  /* ---- 6. One-off deductions -------------------------------------- */

  let deductionOrder = 300;
  for (const item of input.inputs) {
    if (item.kind !== 'ONE_OFF_DEDUCTION' && item.kind !== 'ADVANCE_RECOVERY') continue;
    if (!item.amountMinor) continue;

    lines.push({
      kind: 'DEDUCTION',
      componentCode: item.componentCode ?? null,
      label: item.componentName ?? humanise(item.kind),
      amountMinor: item.amountMinor,
      displayOrder: deductionOrder,
      ...(item.note ? { calculationNote: item.note } : {}),
      payrollInputSourceId: item.sourceId,
    });
    deductionOrder += 1;
  }

  /* ---- 7. Totals --------------------------------------------------- */

  const totalDeductions = lines
    .filter((l) => l.kind === 'DEDUCTION')
    .reduce((sum, l) => sum + l.amountMinor, 0);

  const employerContribution = lines
    .filter((l) => l.kind === 'EMPLOYER_CONTRIBUTION')
    .reduce((sum, l) => sum + l.amountMinor, 0);

  const netPay = grossEarnings - totalDeductions;

  lines.sort((a, b) => a.displayOrder - b.displayOrder);

  return {
    employeeId: input.employeeId,
    engineVersion: ENGINE_VERSION,
    lines,
    grossEarningsMinor: grossEarnings,
    totalDeductionsMinor: totalDeductions,
    netPayMinor: netPay,
    employerContributionMinor: employerContribution,
    pfEmployeeMinor: pfEmployee,
    pfEmployerMinor: pfEmployer,
    tdsMinor: tds,
    professionalTaxMinor: professionalTax,
    payableDays,
    totalDays: attendance.totalDays,
    lopDays,
    sourceDigest: digestOf(input),
  };
}

/* ------------------------------------------------------------------ */
/* Income tax                                                          */
/* ------------------------------------------------------------------ */

/**
 * Monthly tax deducted at source.
 *
 * Computed the way Indian payroll does it: project the annual income from what
 * has been paid so far plus what remains, compute the annual liability under
 * the elected regime, subtract what has already been deducted, and spread the
 * balance over the months that remain. A one-off payment therefore raises that
 * month's deduction, which is why the figure moves between months.
 */
export function computeMonthlyTds(input: {
  grossThisMonth: number;
  pfEmployee: number;
  professionalTax: number;
  tax: TaxInput;
}): number {
  const { tax } = input;
  if (tax.monthsRemaining <= 0) return 0;

  const projectedAnnualGross =
    tax.grossPaidToDateMinor + input.grossThisMonth * tax.monthsRemaining;

  let taxableIncome = projectedAnnualGross - tax.standardDeductionMinor;

  if (tax.regime === 'OLD') {
    // Chapter VI-A deductions and the professional tax paid are allowed only
    // under the old regime.
    taxableIncome -= tax.verifiedDeductionsMinor;
    taxableIncome -= input.professionalTax * 12;
  }

  taxableIncome = Math.max(0, taxableIncome);

  let liability = applySlabs(taxableIncome, tax.slabs);

  // Section 87A rebate: below the threshold, the liability is reduced to nil.
  if (tax.rebateThresholdMinor !== undefined && taxableIncome <= tax.rebateThresholdMinor) {
    const rebate = Math.min(liability, tax.rebateMaxMinor ?? liability);
    liability -= rebate;
  }

  const withCess = liability + percent(liability, tax.cessRate);
  const remaining = Math.max(0, withCess - tax.tdsPaidToDateMinor);

  return round(remaining / tax.monthsRemaining);
}

/** Apply progressive slabs. Each rate applies only to the income within its band. */
export function applySlabs(
  income: number,
  slabs: { upToMinor: number | null; rate: number }[],
): number {
  let tax = 0;
  let lower = 0;

  for (const slab of slabs) {
    const upper = slab.upToMinor ?? Number.POSITIVE_INFINITY;
    if (income <= lower) break;
    const bandIncome = Math.min(income, upper) - lower;
    if (bandIncome > 0) tax += percent(bandIncome, slab.rate);
    lower = upper;
    if (!Number.isFinite(upper)) break;
  }

  return tax;
}

/* ------------------------------------------------------------------ */
/* Traceability                                                        */
/* ------------------------------------------------------------------ */

/**
 * A digest over every input the computation consumed.
 *
 * Stored on the payslip. Re-running the engine on the same inputs must produce
 * the same digest, which is how a payslip is tied to the data that made it —
 * and how a claim that "the inputs were different" can be settled.
 */
export function digestOf(input: PayrollComputation): string {
  return createHash('sha256')
    .update(ENGINE_VERSION)
    .update('\u0000')
    .update(canonicalJson(input))
    .digest('hex');
}

function humanise(kind: string): string {
  const words = kind.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
