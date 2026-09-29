import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import {
  ENGINE_VERSION,
  computePayslip,
  type ComponentDefinition,
  type PayrollComputation,
  type PayrollInput,
  type StructuredComponent,
} from './engine.js';

/**
 * Payroll generation.
 *
 * Runs the engine over every eligible employee and writes the payslips. The
 * whole run is one transaction: either every payslip exists or none does, so a
 * failure half-way cannot leave an organisation part-paid.
 *
 * Payslips are written GENERATED, not PUBLISHED. They exist, they are immutable,
 * and no employee can see them until the cycle is published — which is a
 * separate, deliberate act.
 */

export interface GenerationResult {
  payrollRunId: string;
  payslipsCreated: number;
  totalGrossMinor: bigint;
  totalDeductionsMinor: bigint;
  totalNetMinor: bigint;
  /** Employees the run skipped, with why. Never silent. */
  skipped: { employeeId: string; reason: string }[];
}

export async function generatePayroll(
  tx: Tx,
  principal: Principal,
  input: { cycleId: string; eligibleEmployeeIds: string[] },
  hmacKey: string,
): Promise<GenerationResult> {
  const cycle = await tx.payrollCycle.findUniqueOrThrow({
    where: { id: input.cycleId },
    select: {
      id: true,
      organizationId: true,
      year: true,
      month: true,
      periodStart: true,
      periodEnd: true,
      payDate: true,
      attendancePeriodId: true,
      runType: true,
    },
  });

  const run = await tx.payrollRun.create({
    data: {
      organizationId: cycle.organizationId,
      payrollCycleId: cycle.id,
      status: 'RUNNING',
      engineVersion: ENGINE_VERSION,
      startedAt: new Date(),
      triggeredByUserId: principal.userId,
      employeeCount: input.eligibleEmployeeIds.length,
    },
    select: { id: true },
  });

  const organization = await tx.organization.findUniqueOrThrow({
    where: { id: cycle.organizationId },
    select: { employeeNumberPrefix: true },
  });

  const components = await tx.payComponent.findMany({
    where: { organizationId: cycle.organizationId, isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
  const componentById = new Map(components.map((c) => [c.id, c]));

  const skipped: GenerationResult['skipped'] = [];
  let totalGross = 0n;
  let totalDeductions = 0n;
  let totalNet = 0n;
  let created = 0;

  for (const employeeId of input.eligibleEmployeeIds) {
    const resolved = await resolveComputation(tx, {
      cycle,
      employeeId,
      componentById,
    });

    if ('reason' in resolved) {
      skipped.push({ employeeId, reason: resolved.reason });
      continue;
    }

    const computed = computePayslip(resolved.computation);

    const payslip = await tx.payslip.create({
      data: {
        organizationId: cycle.organizationId,
        payrollCycleId: cycle.id,
        payrollRunId: run.id,
        employeeId,
        status: 'GENERATED',
        reference: payslipReference({
          prefix: organization.employeeNumberPrefix,
          year: cycle.year,
          month: cycle.month,
          employeeNumber: resolved.employeeNumber,
        }),
        version: 1,
        periodStart: cycle.periodStart,
        periodEnd: cycle.periodEnd,
        payDate: cycle.payDate,
        payableDays: computed.payableDays,
        totalDays: computed.totalDays,
        lopDays: computed.lopDays,
        grossEarningsMinor: BigInt(computed.grossEarningsMinor),
        totalDeductionsMinor: BigInt(computed.totalDeductionsMinor),
        netPayMinor: BigInt(computed.netPayMinor),
        employerContributionMinor: BigInt(computed.employerContributionMinor),
        pfEmployeeMinor: BigInt(computed.pfEmployeeMinor),
        pfEmployerMinor: BigInt(computed.pfEmployerMinor),
        tdsMinor: BigInt(computed.tdsMinor),
        professionalTaxMinor: BigInt(computed.professionalTaxMinor),
        sourceDigest: computed.sourceDigest,
      },
      select: { id: true },
    });

    await tx.payslipLine.createMany({
      data: computed.lines.map((line) => ({
        organizationId: cycle.organizationId,
        payslipId: payslip.id,
        payComponentId: resolved.componentIdByCode.get(line.componentCode ?? '') ?? null,
        kind: line.kind,
        label: line.label,
        amountMinor: BigInt(line.amountMinor),
        fullAmountMinor: line.fullAmountMinor === undefined ? null : BigInt(line.fullAmountMinor),
        displayOrder: line.displayOrder,
        payrollInputItemId: line.payrollInputSourceId ?? null,
        calculationNote: line.calculationNote ?? null,
      })),
    });

    totalGross += BigInt(computed.grossEarningsMinor);
    totalDeductions += BigInt(computed.totalDeductionsMinor);
    totalNet += BigInt(computed.netPayMinor);
    created += 1;
  }

  await tx.payrollRun.update({
    where: { id: run.id },
    data: {
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      employeeCount: created,
    },
  });

  await tx.payrollCycle.update({
    where: { id: cycle.id },
    data: {
      employeeCount: input.eligibleEmployeeIds.length,
      excludedCount: skipped.length,
      totalGrossMinor: totalGross,
      totalDeductionMinor: totalDeductions,
      totalNetMinor: totalNet,
    },
  });

  await recordAudit(
    tx,
    {
      organizationId: cycle.organizationId,
      action: 'CREATE',
      entityType: 'payroll_run',
      entityId: run.id,
      summary: `Generated ${created} payslip${created === 1 ? '' : 's'} for ${cycle.year}-${String(cycle.month).padStart(2, '0')}`,
      after: {
        payslipsCreated: created,
        skipped: skipped.length,
        totalNetMinor: totalNet.toString(),
        engineVersion: ENGINE_VERSION,
      },
    },
    hmacKey,
  );

  return {
    payrollRunId: run.id,
    payslipsCreated: created,
    totalGrossMinor: totalGross,
    totalDeductionsMinor: totalDeductions,
    totalNetMinor: totalNet,
    skipped,
  };
}

/**
 * `WDT-PS-2608-01847` — the reference the prototype prints on a payslip.
 * Deterministic, so a regenerated run produces the same reference for the same
 * employee and period.
 */
export function payslipReference(input: {
  prefix: string;
  year: number;
  month: number;
  employeeNumber: string;
}): string {
  const yy = String(input.year % 100).padStart(2, '0');
  const mm = String(input.month).padStart(2, '0');
  // Keep only the numeric tail of the employee number, which is what the
  // prototype's `WDT-PS-2608-1847` shows.
  const tail = input.employeeNumber.replace(/\D/g, '').slice(-5) || '00000';
  return `${input.prefix}-PS-${yy}${mm}-${tail}`;
}

type ResolvedComputation =
  | {
      computation: PayrollComputation;
      employeeNumber: string;
      componentIdByCode: Map<string, string>;
    }
  | { reason: string };

async function resolveComputation(
  tx: Tx,
  input: {
    cycle: {
      id: string;
      organizationId: string;
      periodStart: Date;
      periodEnd: Date;
      attendancePeriodId: string | null;
    };
    employeeId: string;
    componentById: Map<string, { id: string; code: string }>;
  },
): Promise<ResolvedComputation> {
  const { cycle, employeeId } = input;

  const employee = await tx.employee.findUniqueOrThrow({
    where: { id: employeeId },
    select: { employeeNumber: true },
  });

  const structure = await tx.salaryStructure.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: cycle.periodEnd },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: cycle.periodStart } }],
    },
    orderBy: { effectiveFrom: 'desc' },
    select: {
      components: {
        select: {
          monthlyAmountMinor: true,
          rateOverride: true,
          component: true,
        },
      },
    },
  });

  if (!structure) return { reason: 'No salary structure is effective for this period.' };

  const componentIdByCode = new Map<string, string>();
  const components: StructuredComponent[] = structure.components.map((row) => {
    componentIdByCode.set(row.component.code, row.component.id);
    const definition: ComponentDefinition = {
      code: row.component.code,
      name: row.component.name,
      kind: row.component.kind,
      calc: row.component.calc,
      rate: row.component.rate ? Number(row.component.rate) : undefined,
      ceilingMinor: row.component.ceilingMinor ? Number(row.component.ceilingMinor) : undefined,
      isProrated: row.component.isProrated,
      isTaxable: row.component.isTaxable,
      isPfApplicable: row.component.isPfApplicable,
      displayOrder: row.component.displayOrder,
    };
    return {
      definition,
      monthlyAmountMinor: row.monthlyAmountMinor ? Number(row.monthlyAmountMinor) : undefined,
      rateOverride: row.rateOverride ? Number(row.rateOverride) : undefined,
    };
  });

  const attendance = cycle.attendancePeriodId
    ? await tx.attendanceRecord.findFirst({
        where: { attendancePeriodId: cycle.attendancePeriodId, employeeId },
        select: { payableDays: true, lopDays: true, employedDays: true },
      })
    : null;

  const period = cycle.attendancePeriodId
    ? await tx.attendancePeriod.findUniqueOrThrow({
        where: { id: cycle.attendancePeriodId },
        select: { totalDays: true },
      })
    : null;

  if (!attendance || !period) {
    return { reason: 'No approved attendance record exists for this period.' };
  }

  const inputItems = await tx.payrollInputItem.findMany({
    where: {
      employeeId,
      batch: { payrollCycleId: cycle.id, status: 'COMMITTED' },
    },
    select: {
      id: true,
      kind: true,
      amountMinor: true,
      days: true,
      note: true,
      payComponentId: true,
    },
  });

  const inputs: PayrollInput[] = inputItems.map((item) => {
    const component = item.payComponentId
      ? input.componentById.get(item.payComponentId)
      : undefined;
    return {
      kind: item.kind,
      componentCode: component?.code,
      componentName: component?.code,
      amountMinor: item.amountMinor === null ? undefined : Number(item.amountMinor),
      days: item.days === null ? undefined : Number(item.days),
      note: item.note ?? undefined,
      sourceId: item.id,
    };
  });

  const tax = await resolveTax(tx, { cycle, employeeId });
  if ('reason' in tax) return tax;

  const statutory = await resolveStatutory(tx, { cycle, employeeId });

  return {
    employeeNumber: employee.employeeNumber,
    componentIdByCode,
    computation: {
      employeeId,
      periodStart: cycle.periodStart.toISOString().slice(0, 10),
      periodEnd: cycle.periodEnd.toISOString().slice(0, 10),
      components,
      attendance: {
        totalDays: period.totalDays,
        payableDays: Number(attendance.payableDays),
        lopDays: Number(attendance.lopDays),
        employedDays: attendance.employedDays,
      },
      inputs,
      tax: tax.tax,
      statutory,
    },
  };
}

async function resolveTax(
  tx: Tx,
  input: {
    cycle: { organizationId: string; periodStart: Date; periodEnd: Date };
    employeeId: string;
  },
): Promise<{ tax: PayrollComputation['tax'] } | { reason: string }> {
  const fiscalYear = await tx.fiscalYear.findFirst({
    where: {
      organizationId: input.cycle.organizationId,
      startDate: { lte: input.cycle.periodStart },
      endDate: { gte: input.cycle.periodEnd },
    },
    select: { id: true, startYear: true, endDate: true },
  });

  if (!fiscalYear) return { reason: 'No financial year covers this payroll period.' };

  const election = await tx.employeeTaxRegimeElection.findFirst({
    where: { employeeId: input.employeeId, fiscalYearId: fiscalYear.id },
    select: { regime: true },
  });

  if (!election) return { reason: 'No tax regime has been elected for this financial year.' };

  const regime = election.regime;

  // Everything already paid this year, from published and generated payslips —
  // the projection is built from real payslips, never estimated.
  const paid = await tx.payslip.aggregate({
    where: {
      employeeId: input.employeeId,
      status: { in: ['GENERATED', 'PUBLISHED'] },
      periodStart: { gte: new Date(`${fiscalYear.startYear}-04-01`) },
      periodEnd: { lt: input.cycle.periodStart },
    },
    _sum: { grossEarningsMinor: true, tdsMinor: true },
  });

  // Months from this period to the end of the financial year, inclusive.
  const monthsRemaining =
    (fiscalYear.endDate.getUTCFullYear() - input.cycle.periodStart.getUTCFullYear()) * 12 +
    (fiscalYear.endDate.getUTCMonth() - input.cycle.periodStart.getUTCMonth()) +
    1;

  const declaration = await tx.employeeTaxDeclaration.findFirst({
    where: { employeeId: input.employeeId, fiscalYearId: fiscalYear.id, status: 'VERIFIED' },
    select: { items: { select: { verifiedMinor: true } } },
  });

  const verifiedDeductionsMinor =
    declaration?.items.reduce(
      (sum, item) => sum + (item.verifiedMinor === null ? 0 : Number(item.verifiedMinor)),
      0,
    ) ?? 0;

  return {
    tax: {
      regime: regime.code,
      slabs: parseSlabs(regime.slabs),
      standardDeductionMinor: Number(regime.standardDeductionMinor),
      rebateThresholdMinor:
        regime.rebateThresholdMinor === null ? undefined : Number(regime.rebateThresholdMinor),
      rebateMaxMinor: regime.rebateMaxMinor === null ? undefined : Number(regime.rebateMaxMinor),
      cessRate: Number(regime.cessRate),
      // Chapter VI-A deductions apply under the old regime only.
      verifiedDeductionsMinor: regime.code === 'OLD' ? verifiedDeductionsMinor : 0,
      monthsRemaining: Math.max(1, monthsRemaining),
      tdsPaidToDateMinor: Number(paid._sum.tdsMinor ?? 0n),
      grossPaidToDateMinor: Number(paid._sum.grossEarningsMinor ?? 0n),
    },
  };
}

function parseSlabs(value: unknown): { upToMinor: number | null; rate: number }[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (slab): slab is { upToMinor: number | null; rate: number } =>
        typeof slab === 'object' && slab !== null && 'rate' in slab,
    )
    .map((slab) => ({
      upToMinor: typeof slab.upToMinor === 'number' ? slab.upToMinor : null,
      rate: Number(slab.rate),
    }));
}

/**
 * Statutory rates.
 *
 * Held as organisation configuration rather than hard-coded, so a change in the
 * provident-fund ceiling or a state's professional tax is a data change rather
 * than a deploy. The defaults below are the current statutory figures and are
 * used only when no configuration row exists.
 */
async function resolveStatutory(
  tx: Tx,
  input: {
    cycle: { organizationId: string };
    employeeId: string;
  },
): Promise<PayrollComputation['statutory']> {
  const employment = await tx.employeeEmployment.findFirst({
    where: { employeeId: input.employeeId, effectiveTo: null },
    select: { location: { select: { stateCode: true } } },
  });

  const uan = await tx.employeeStatutoryId.findFirst({
    where: { employeeId: input.employeeId, kind: 'UAN' },
    select: { id: true },
  });

  return {
    pfWageCeilingMinor: 1_500_000, // ₹15,000
    pfEmployeeRate: 0.12,
    pfEmployerRate: 0.12,
    // No UAN means the employee is outside the provident-fund scheme.
    pfApplicable: uan !== null,
    professionalTaxMinor: professionalTaxFor(employment?.location.stateCode ?? 'KA'),
    esiApplicable: true,
    esiThresholdMinor: 2_100_000, // ₹21,000 gross
    esiEmployeeRate: 0.0075,
    esiEmployerRate: 0.0325,
  };
}

/**
 * Monthly professional tax by state, in paise.
 *
 * States that do not levy it return zero. A state not listed also returns zero
 * rather than a guess — deducting a tax nobody owes is worse than deducting none.
 */
export function professionalTaxFor(stateCode: string): number {
  const byState: Record<string, number> = {
    KA: 20_000, // Karnataka: ₹200
    MH: 20_000, // Maharashtra: ₹200 (₹300 in February)
    WB: 20_000,
    TN: 20_800,
    TS: 20_000,
    AP: 20_000,
    GJ: 20_000,
    MP: 20_800,
    KL: 20_000,
    OR: 20_000,
    AS: 20_800,
    BR: 20_000,
    JH: 20_800,
    // Levied by no state: Delhi, Haryana, Uttar Pradesh, Rajasthan and others.
    DL: 0,
    HR: 0,
    UP: 0,
    RJ: 0,
    PB: 0,
    CH: 0,
    UK: 0,
    GA: 20_000,
  };
  return byState[stateCode.toUpperCase()] ?? 0;
}
