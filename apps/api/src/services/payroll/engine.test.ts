import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  applySlabs,
  computeMonthlyTds,
  computePayslip,
  digestOf,
  type ComponentDefinition,
  type PayrollComputation,
  type StructuredComponent,
} from './engine.js';

/** ₹1 = 100 paise. Written out so the test figures read as rupees. */
const rupees = (amount: number) => Math.round(amount * 100);

const component = (
  code: string,
  name: string,
  order: number,
  overrides: Partial<ComponentDefinition> = {},
): ComponentDefinition => ({
  code,
  name,
  kind: 'EARNING',
  calc: 'PRORATED_FIXED',
  isProrated: true,
  isTaxable: true,
  isPfApplicable: false,
  displayOrder: order,
  ...overrides,
});

/** The prototype's salary structure: basic ₹86,000, HRA ₹43,000, and so on. */
function standardStructure(): StructuredComponent[] {
  return [
    {
      definition: component('BASIC', 'Basic salary', 1, { isPfApplicable: true }),
      monthlyAmountMinor: rupees(86_000),
    },
    {
      definition: component('HRA', 'House rent allowance', 2, {
        calc: 'PERCENT_OF_BASIC',
        rate: 0.5,
      }),
    },
    {
      definition: component('SPECIAL', 'Special allowance', 3),
      monthlyAmountMinor: rupees(45_400),
    },
    {
      definition: component('LTA', 'Leave travel allowance', 4),
      monthlyAmountMinor: rupees(7_200),
    },
    {
      definition: component('CONVEYANCE', 'Conveyance allowance', 5, { isProrated: false }),
      monthlyAmountMinor: rupees(1_600),
    },
  ];
}

/** The new regime's slabs for FY 2026–27, in paise. */
const NEW_REGIME_SLABS = [
  { upToMinor: rupees(300_000), rate: 0 },
  { upToMinor: rupees(700_000), rate: 0.05 },
  { upToMinor: rupees(1_000_000), rate: 0.1 },
  { upToMinor: rupees(1_200_000), rate: 0.15 },
  { upToMinor: rupees(1_500_000), rate: 0.2 },
  { upToMinor: null, rate: 0.3 },
];

function computation(overrides: Partial<PayrollComputation> = {}): PayrollComputation {
  return {
    employeeId: 'emp_1',
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    components: standardStructure(),
    attendance: { totalDays: 31, payableDays: 31, lopDays: 0, employedDays: 31 },
    inputs: [],
    tax: {
      regime: 'NEW',
      slabs: NEW_REGIME_SLABS,
      standardDeductionMinor: rupees(75_000),
      rebateThresholdMinor: rupees(700_000),
      rebateMaxMinor: rupees(25_000),
      cessRate: 0.04,
      verifiedDeductionsMinor: 0,
      monthsRemaining: 8,
      tdsPaidToDateMinor: 0,
      grossPaidToDateMinor: 0,
    },
    statutory: {
      pfWageCeilingMinor: rupees(15_000),
      pfEmployeeRate: 0.12,
      pfEmployerRate: 0.12,
      pfApplicable: true,
      professionalTaxMinor: rupees(200),
      esiApplicable: false,
      esiThresholdMinor: rupees(21_000),
      esiEmployeeRate: 0.0075,
      esiEmployerRate: 0.0325,
    },
    ...overrides,
  };
}

describe('a full month with no loss of pay', () => {
  const result = computePayslip(computation());

  it('earns the sum of the structure', () => {
    // 86,000 basic + 43,000 HRA (50% of basic) + 45,400 + 7,200 + 1,600
    expect(result.grossEarningsMinor).toBe(rupees(183_200));
  });

  it('derives house rent allowance from basic rather than storing it twice', () => {
    const hra = result.lines.find((l) => l.componentCode === 'HRA');
    expect(hra?.amountMinor).toBe(rupees(43_000));
    expect(hra?.calculationNote).toContain('50% of basic');
  });

  it('caps provident fund at the statutory wage ceiling', () => {
    // Basic is ₹86,000 but the ceiling is ₹15,000, so PF is 12% of 15,000.
    expect(result.pfEmployeeMinor).toBe(rupees(1_800));
    expect(result.pfEmployerMinor).toBe(rupees(1_800));
    const line = result.lines.find((l) => l.componentCode === 'PF_EMPLOYEE');
    expect(line?.calculationNote).toContain('ceiling');
  });

  it('adds up: net is gross minus deductions', () => {
    const deductions = result.lines
      .filter((l) => l.kind === 'DEDUCTION')
      .reduce((sum, l) => sum + l.amountMinor, 0);
    expect(result.totalDeductionsMinor).toBe(deductions);
    expect(result.netPayMinor).toBe(result.grossEarningsMinor - result.totalDeductionsMinor);
  });

  it('keeps the employer contribution out of the employee’s deductions', () => {
    expect(result.employerContributionMinor).toBe(rupees(1_800));
    const employerLines = result.lines.filter((l) => l.kind === 'EMPLOYER_CONTRIBUTION');
    expect(employerLines).toHaveLength(1);
    // It must not reduce take-home pay.
    expect(result.netPayMinor + result.totalDeductionsMinor).toBe(result.grossEarningsMinor);
  });

  it('orders the lines the same way every time', () => {
    const orders = result.lines.map((l) => l.displayOrder);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});

describe('loss of pay', () => {
  it('prorates by payable days over total days', () => {
    const result = computePayslip(
      computation({
        attendance: { totalDays: 31, payableDays: 28, lopDays: 3, employedDays: 31 },
      }),
    );

    const basic = result.lines.find((l) => l.componentCode === 'BASIC');
    // 86,000 × 28/31 = 77,677.42
    expect(basic?.amountMinor).toBe(rupees(77_677.42));
    expect(basic?.fullAmountMinor).toBe(rupees(86_000));
    expect(basic?.calculationNote).toContain('28 of 31');
  });

  it('leaves a non-prorated component whole', () => {
    const result = computePayslip(
      computation({
        attendance: { totalDays: 31, payableDays: 20, lopDays: 11, employedDays: 31 },
      }),
    );
    const conveyance = result.lines.find((l) => l.componentCode === 'CONVEYANCE');
    expect(conveyance?.amountMinor).toBe(rupees(1_600));
    expect(conveyance?.fullAmountMinor).toBeUndefined();
  });

  it('honours an explicit override from Accounts over the attendance record', () => {
    const result = computePayslip(
      computation({
        attendance: { totalDays: 31, payableDays: 31, lopDays: 0, employedDays: 31 },
        inputs: [
          { kind: 'LOP_OVERRIDE', days: 5, sourceId: 'input_1', note: 'Unapproved absence' },
        ],
      }),
    );
    expect(result.lopDays).toBe(5);
    expect(result.payableDays).toBe(26);
  });

  it('pays nothing when no day is payable, and does not go negative', () => {
    const result = computePayslip(
      computation({
        attendance: { totalDays: 31, payableDays: 0, lopDays: 31, employedDays: 31 },
      }),
    );
    const basic = result.lines.find((l) => l.componentCode === 'BASIC');
    expect(basic?.amountMinor).toBe(0);
    expect(result.grossEarningsMinor).toBeGreaterThanOrEqual(0);
  });

  it('returns zero rather than NaN for a malformed period', () => {
    const result = computePayslip(
      computation({
        attendance: { totalDays: 0, payableDays: 0, lopDays: 0, employedDays: 0 },
      }),
    );
    expect(Number.isNaN(result.grossEarningsMinor)).toBe(false);
    expect(result.grossEarningsMinor).toBe(rupees(1_600)); // the non-prorated line only
  });
});

describe('one-off payroll inputs', () => {
  it('adds an incentive as its own earning line, traceable to its upload', () => {
    const result = computePayslip(
      computation({
        inputs: [
          {
            kind: 'INCENTIVE',
            componentName: 'Performance incentive',
            amountMinor: rupees(6_420),
            sourceId: 'input_42',
          },
        ],
      }),
    );

    const line = result.lines.find((l) => l.label === 'Performance incentive');
    expect(line?.amountMinor).toBe(rupees(6_420));
    expect(line?.payrollInputSourceId).toBe('input_42');
    expect(result.grossEarningsMinor).toBe(rupees(183_200 + 6_420));
  });

  it('applies a one-off deduction', () => {
    const result = computePayslip(
      computation({
        inputs: [
          {
            kind: 'ADVANCE_RECOVERY',
            componentName: 'Salary advance recovery',
            amountMinor: rupees(10_000),
            sourceId: 'input_7',
          },
        ],
      }),
    );
    const line = result.lines.find((l) => l.label === 'Salary advance recovery');
    expect(line?.kind).toBe('DEDUCTION');
    expect(result.netPayMinor).toBe(result.grossEarningsMinor - result.totalDeductionsMinor);
  });

  it('lets Payroll override the computed tax, and says so on the line', () => {
    const result = computePayslip(
      computation({
        inputs: [{ kind: 'TDS_OVERRIDE', amountMinor: rupees(30_000), sourceId: 'input_9' }],
      }),
    );
    expect(result.tdsMinor).toBe(rupees(30_000));
    const line = result.lines.find((l) => l.componentCode === 'TDS');
    expect(line?.calculationNote).toBe('Adjusted by Payroll');
    expect(line?.payrollInputSourceId).toBe('input_9');
  });
});

describe('statutory deductions', () => {
  it('skips provident fund when the employee is not covered', () => {
    const base = computation();
    const result = computePayslip({
      ...base,
      statutory: { ...base.statutory, pfApplicable: false },
    });
    expect(result.pfEmployeeMinor).toBe(0);
    expect(result.lines.some((l) => l.componentCode === 'PF_EMPLOYEE')).toBe(false);
  });

  it('applies state insurance only below the threshold', () => {
    const low = standardStructure().map((c) =>
      c.definition.code === 'BASIC'
        ? { ...c, monthlyAmountMinor: rupees(8_000) }
        : { ...c, monthlyAmountMinor: c.monthlyAmountMinor ? rupees(1_000) : undefined },
    );

    const base = computation();
    const covered = computePayslip({
      ...base,
      components: low,
      statutory: { ...base.statutory, esiApplicable: true },
    });
    expect(covered.lines.some((l) => l.componentCode === 'ESI_EMPLOYEE')).toBe(true);

    const notCovered = computePayslip({
      ...base,
      statutory: { ...base.statutory, esiApplicable: true },
    });
    expect(notCovered.lines.some((l) => l.componentCode === 'ESI_EMPLOYEE')).toBe(false);
  });

  it('deducts professional tax as a flat state levy', () => {
    const result = computePayslip(computation());
    expect(result.professionalTaxMinor).toBe(rupees(200));
  });
});

describe('income tax', () => {
  it('applies each slab only to the income within its band', () => {
    // ₹8,00,000 under the new regime:
    //   0–3,00,000   @ 0%  =       0
    //   3–7,00,000   @ 5%  =  20,000
    //   7–8,00,000   @ 10% =  10,000
    expect(applySlabs(rupees(800_000), NEW_REGIME_SLABS)).toBe(rupees(30_000));
  });

  it('charges nothing below the first slab', () => {
    expect(applySlabs(rupees(250_000), NEW_REGIME_SLABS)).toBe(0);
    expect(applySlabs(0, NEW_REGIME_SLABS)).toBe(0);
  });

  it('applies the top rate above the last band', () => {
    // ₹20,00,000: the bands to 15,00,000 plus 30% of the remaining 5,00,000.
    const toFifteen = applySlabs(rupees(1_500_000), NEW_REGIME_SLABS);
    expect(applySlabs(rupees(2_000_000), NEW_REGIME_SLABS)).toBe(toFifteen + rupees(150_000));
  });

  it('reduces a small liability to nil under the section 87A rebate', () => {
    const tax = computeMonthlyTds({
      grossThisMonth: rupees(50_000),
      pfEmployee: rupees(1_800),
      professionalTax: rupees(200),
      tax: {
        regime: 'NEW',
        slabs: NEW_REGIME_SLABS,
        standardDeductionMinor: rupees(75_000),
        rebateThresholdMinor: rupees(700_000),
        rebateMaxMinor: rupees(25_000),
        cessRate: 0.04,
        verifiedDeductionsMinor: 0,
        monthsRemaining: 12,
        tdsPaidToDateMinor: 0,
        grossPaidToDateMinor: 0,
      },
    });
    // ₹6,00,000 projected, less ₹75,000 standard deduction, is ₹5,25,000 —
    // inside the rebate threshold, so nothing is owed.
    expect(tax).toBe(0);
  });

  it('allows chapter VI-A deductions under the old regime only', () => {
    const shared = {
      grossThisMonth: rupees(150_000),
      pfEmployee: rupees(1_800),
      professionalTax: rupees(200),
    };
    const base = {
      slabs: NEW_REGIME_SLABS,
      standardDeductionMinor: rupees(75_000),
      cessRate: 0.04,
      verifiedDeductionsMinor: rupees(150_000),
      monthsRemaining: 12,
      tdsPaidToDateMinor: 0,
      grossPaidToDateMinor: 0,
    };

    const oldRegime = computeMonthlyTds({ ...shared, tax: { ...base, regime: 'OLD' } });
    const newRegime = computeMonthlyTds({ ...shared, tax: { ...base, regime: 'NEW' } });
    expect(oldRegime).toBeLessThan(newRegime);
  });

  it('spreads the remaining liability over the months that remain', () => {
    // The same annual salary, seen from different points in the year: the
    // months already paid are in grossPaidToDate, so the projected annual
    // income is identical and only the number of months left to collect it
    // over changes.
    const monthly = rupees(150_000);
    const atMonth = (monthsElapsed: number) =>
      computeMonthlyTds({
        grossThisMonth: monthly,
        pfEmployee: rupees(1_800),
        professionalTax: rupees(200),
        tax: {
          regime: 'NEW',
          slabs: NEW_REGIME_SLABS,
          standardDeductionMinor: rupees(75_000),
          cessRate: 0.04,
          verifiedDeductionsMinor: 0,
          monthsRemaining: 12 - monthsElapsed,
          tdsPaidToDateMinor: 0,
          grossPaidToDateMinor: monthly * monthsElapsed,
        },
      });

    // Nine months in, with nothing yet deducted, the same annual liability has
    // three months to be collected in — so each month costs more.
    expect(atMonth(9)).toBeGreaterThan(atMonth(0));
  });

  it('raises the deduction in the month a one-off payment lands', () => {
    const tax = (grossThisMonth: number) =>
      computeMonthlyTds({
        grossThisMonth,
        pfEmployee: rupees(1_800),
        professionalTax: rupees(200),
        tax: {
          regime: 'NEW',
          slabs: NEW_REGIME_SLABS,
          standardDeductionMinor: rupees(75_000),
          cessRate: 0.04,
          verifiedDeductionsMinor: 0,
          monthsRemaining: 6,
          tdsPaidToDateMinor: rupees(60_000),
          grossPaidToDateMinor: rupees(900_000),
        },
      });

    // This is why the figure moves between months: the projection is rebuilt
    // from what is being paid now.
    expect(tax(rupees(160_000))).toBeGreaterThan(tax(rupees(150_000)));
  });

  it('subtracts tax already deducted this year', () => {
    const withoutPaid = computeMonthlyTds({
      grossThisMonth: rupees(150_000),
      pfEmployee: rupees(1_800),
      professionalTax: rupees(200),
      tax: {
        regime: 'NEW',
        slabs: NEW_REGIME_SLABS,
        standardDeductionMinor: rupees(75_000),
        cessRate: 0.04,
        verifiedDeductionsMinor: 0,
        monthsRemaining: 6,
        tdsPaidToDateMinor: 0,
        grossPaidToDateMinor: rupees(900_000),
      },
    });

    const withPaid = computeMonthlyTds({
      grossThisMonth: rupees(150_000),
      pfEmployee: rupees(1_800),
      professionalTax: rupees(200),
      tax: {
        regime: 'NEW',
        slabs: NEW_REGIME_SLABS,
        standardDeductionMinor: rupees(75_000),
        cessRate: 0.04,
        verifiedDeductionsMinor: 0,
        monthsRemaining: 6,
        tdsPaidToDateMinor: rupees(100_000),
        grossPaidToDateMinor: rupees(900_000),
      },
    });

    expect(withPaid).toBeLessThan(withoutPaid);
  });

  it('never returns a negative deduction when too much was already paid', () => {
    const tax = computeMonthlyTds({
      grossThisMonth: rupees(50_000),
      pfEmployee: 0,
      professionalTax: 0,
      tax: {
        regime: 'NEW',
        slabs: NEW_REGIME_SLABS,
        standardDeductionMinor: rupees(75_000),
        cessRate: 0.04,
        verifiedDeductionsMinor: 0,
        monthsRemaining: 1,
        tdsPaidToDateMinor: rupees(500_000),
        grossPaidToDateMinor: rupees(550_000),
      },
    });
    expect(tax).toBe(0);
  });
});

describe('determinism and traceability', () => {
  it('produces the same result for the same inputs', () => {
    const a = computePayslip(computation());
    const b = computePayslip(computation());
    expect(a).toEqual(b);
  });

  it('produces the same digest for the same inputs', () => {
    expect(digestOf(computation())).toBe(digestOf(computation()));
    expect(digestOf(computation())).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different digest when any input changes', () => {
    const base = digestOf(computation());
    expect(
      digestOf(
        computation({
          attendance: { totalDays: 31, payableDays: 30, lopDays: 1, employedDays: 31 },
        }),
      ),
    ).not.toBe(base);
    expect(
      digestOf(computation({ inputs: [{ kind: 'BONUS', amountMinor: 1, sourceId: 'x' }] })),
    ).not.toBe(base);
  });

  it('is unaffected by the order of keys in its input', () => {
    const forward = computation();
    const reordered: PayrollComputation = {
      statutory: forward.statutory,
      tax: forward.tax,
      inputs: forward.inputs,
      attendance: forward.attendance,
      components: forward.components,
      periodEnd: forward.periodEnd,
      periodStart: forward.periodStart,
      employeeId: forward.employeeId,
    };
    expect(digestOf(reordered)).toBe(digestOf(forward));
  });

  it('records the engine version, so a rule change is visible in history', () => {
    expect(computePayslip(computation()).engineVersion).toBe(ENGINE_VERSION);
  });

  it('every amount is a whole number of paise', () => {
    const result = computePayslip(
      computation({
        attendance: { totalDays: 31, payableDays: 17, lopDays: 14, employedDays: 31 },
      }),
    );
    for (const line of result.lines) {
      expect(Number.isInteger(line.amountMinor), line.label).toBe(true);
    }
    expect(Number.isInteger(result.netPayMinor)).toBe(true);
  });
});
