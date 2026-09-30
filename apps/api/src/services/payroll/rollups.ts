import { financialYearOf, toIsoDate } from '@widedrop/shared';
import type { Tx } from '../../lib/prisma.js';

/**
 * The projections publication maintains.
 *
 * Two screens read these rather than aggregating at render time:
 *
 *  - Payslips' year-to-date tiles read `payslip_fy_rollup`
 *  - Tax slips' quarterly table reads `tds_quarter`
 *
 * Both are recomputed from published payslips rather than incremented, so a
 * projection cannot drift from the rows it summarises — and both are written
 * in the same transaction as the publication that warrants them, so a screen
 * can never show a total for a payslip the employee cannot yet see.
 *
 * Nothing here estimates. A quarter with no published payslip in it keeps a
 * null `tdsMinor`, which the Tax screen renders as an em dash.
 */

export async function refreshPayslipRollups(
  tx: Tx,
  input: { organizationId: string; employeeIds: string[]; onDate: string },
): Promise<void> {
  const year = financialYearOf(input.onDate);

  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { organizationId: input.organizationId, startYear: year.startYear },
    select: { id: true, label: true, startDate: true, endDate: true },
  });
  if (!fiscalYear) return;

  const quarters = await tx.fiscalQuarter.findMany({
    where: { fiscalYearId: fiscalYear.id },
    orderBy: { quarter: 'asc' },
    select: { id: true, quarter: true, startDate: true, endDate: true },
  });

  for (const employeeId of [...new Set(input.employeeIds)]) {
    const payslips = await tx.payslip.findMany({
      where: {
        organizationId: input.organizationId,
        employeeId,
        status: 'PUBLISHED',
        periodStart: { gte: fiscalYear.startDate },
        periodEnd: { lte: fiscalYear.endDate },
      },
      orderBy: { periodStart: 'asc' },
      select: {
        periodStart: true,
        periodEnd: true,
        grossEarningsMinor: true,
        netPayMinor: true,
        tdsMinor: true,
        pfEmployeeMinor: true,
        pfEmployerMinor: true,
      },
    });

    if (payslips.length === 0) continue;

    const sum = (pick: (p: (typeof payslips)[number]) => bigint): bigint =>
      payslips.reduce((total, payslip) => total + pick(payslip), 0n);

    // `Jun – Aug 2026`: what the tiles are actually covering, so a figure is
    // never read as a full year when it is three months.
    const first = payslips[0]!;
    const last = payslips[payslips.length - 1]!;
    const coverageLabel = coverage(first.periodStart, last.periodEnd);

    await tx.payslipFyRollup.upsert({
      where: { employeeId_fiscalYearId: { employeeId, fiscalYearId: fiscalYear.id } },
      update: {
        payslipCount: payslips.length,
        grossMinor: sum((p) => p.grossEarningsMinor),
        netMinor: sum((p) => p.netPayMinor),
        tdsMinor: sum((p) => p.tdsMinor),
        pfEmployeeMinor: sum((p) => p.pfEmployeeMinor),
        pfEmployerMinor: sum((p) => p.pfEmployerMinor),
        coverageLabel,
      },
      create: {
        organizationId: input.organizationId,
        employeeId,
        fiscalYearId: fiscalYear.id,
        payslipCount: payslips.length,
        grossMinor: sum((p) => p.grossEarningsMinor),
        netMinor: sum((p) => p.netPayMinor),
        tdsMinor: sum((p) => p.tdsMinor),
        pfEmployeeMinor: sum((p) => p.pfEmployeeMinor),
        pfEmployerMinor: sum((p) => p.pfEmployerMinor),
        coverageLabel,
      },
    });

    // The quarterly table. A quarter is created only once a payslip has
    // published in it: an upcoming quarter has nothing to say, and saying ₹0
    // would claim no tax was deducted rather than that none is known yet.
    for (const quarter of quarters) {
      const inQuarter = payslips.filter(
        (payslip) =>
          payslip.periodStart >= quarter.startDate && payslip.periodEnd <= quarter.endDate,
      );
      if (inQuarter.length === 0) continue;

      const tds = inQuarter.reduce((total, payslip) => total + payslip.tdsMinor, 0n);

      // IN_PROGRESS means deducted but not yet filed. FILED is a separate
      // act with its own acknowledgement number, so publication never claims
      // a return has been filed.
      const existing = await tx.tdsQuarter.findUnique({
        where: { employeeId_fiscalQuarterId: { employeeId, fiscalQuarterId: quarter.id } },
        select: { status: true },
      });

      await tx.tdsQuarter.upsert({
        where: { employeeId_fiscalQuarterId: { employeeId, fiscalQuarterId: quarter.id } },
        update: {
          tdsMinor: tds,
          // A filed quarter keeps its status: a supplementary run adding to it
          // makes it revised, not un-filed.
          ...(existing?.status === 'FILED' ? { status: 'REVISED' as const } : {}),
        },
        create: {
          organizationId: input.organizationId,
          employeeId,
          fiscalYearId: fiscalYear.id,
          fiscalQuarterId: quarter.id,
          tdsMinor: tds,
          status: 'IN_PROGRESS',
        },
      });
    }
  }
}

/** `Jun – Aug 2026`, or `Apr 2026` when a single month has published. */
function coverage(from: Date, to: Date): string {
  const month = (date: Date) =>
    new Intl.DateTimeFormat('en-IN', { month: 'short', timeZone: 'UTC' })
      .format(date)
      .replace(/\bSept\b/, 'Sep');

  const year = (date: Date) => date.getUTCFullYear();

  if (month(from) === month(to) && year(from) === year(to)) {
    return `${month(from)} ${year(to)}`;
  }
  if (year(from) === year(to)) {
    return `${month(from)} – ${month(to)} ${year(to)}`;
  }
  return `${month(from)} ${year(from)} – ${month(to)} ${year(to)}`;
}

/** The fiscal year an ISO date falls in, for callers that need the label. */
export function fiscalYearLabelFor(date: string): string {
  return financialYearOf(date).label;
}

/** Today, as the rollup refresh's default reference date. */
export function todayIso(): string {
  return toIsoDate(new Date());
}
