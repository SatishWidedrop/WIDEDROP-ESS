import { financialYearOf, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';

/**
 * Payslips.
 *
 * The visibility rule the requirement states is enforced here for the third
 * time — after the state machine and the database trigger. Every query filters
 * on `status: 'PUBLISHED'`, so a payslip that exists but has not been published
 * is not merely hidden from the list: it cannot be fetched by id either.
 *
 * An employee with no published payslip gets an empty list, not an error and
 * not a sample. The screen shows its empty state, which is the honest answer.
 */
export async function payslipRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /payslips                                                     */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/payslips', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'payslip:read', 'SELF');

    if (!principal.employeeId) return { items: [], fiscalYear: null, summary: null };

    const { fiscalYear: fiscalYearParam } = request.query as { fiscalYear?: string };

    const payslips = await db.payslip.findMany({
      where: {
        organizationId: principal.organizationId,
        employeeId: principal.employeeId,
        // The whole requirement, in one clause.
        status: 'PUBLISHED',
        ...(fiscalYearParam
          ? {
              periodStart: { gte: new Date(`${fiscalYearParam}-04-01`) },
              periodEnd: { lte: new Date(`${Number(fiscalYearParam) + 1}-03-31`) },
            }
          : {}),
      },
      orderBy: { periodStart: 'desc' },
      take: 36,
      select: {
        id: true,
        reference: true,
        periodStart: true,
        periodEnd: true,
        payDate: true,
        payableDays: true,
        totalDays: true,
        lopDays: true,
        grossEarningsMinor: true,
        totalDeductionsMinor: true,
        netPayMinor: true,
        pdfFileObjectId: true,
        cycle: { select: { label: true } },
      },
    });

    // The four year-to-date tiles. Maintained as payslips publish, so the
    // figures are never summed from encrypted rows at render time — and never
    // shown for a period no payslip covers.
    const currentFy = fiscalYearParam
      ? Number(fiscalYearParam)
      : financialYearOf(toIsoDate(new Date())).startYear;

    const rollup = await db.payslipFyRollup.findFirst({
      where: {
        employeeId: principal.employeeId,
        fiscalYear: { organizationId: principal.organizationId, startYear: currentFy },
      },
      select: {
        payslipCount: true,
        grossMinor: true,
        netMinor: true,
        tdsMinor: true,
        pfEmployeeMinor: true,
        pfEmployerMinor: true,
        coverageLabel: true,
      },
    });

    const years = await db.payslip.findMany({
      where: {
        organizationId: principal.organizationId,
        employeeId: principal.employeeId,
        status: 'PUBLISHED',
      },
      select: { periodStart: true },
      distinct: ['periodStart'],
      orderBy: { periodStart: 'desc' },
    });

    const fiscalYears = [
      ...new Set(years.map((row) => financialYearOf(toIsoDate(row.periodStart)).startYear)),
    ];

    return {
      items: payslips.map((payslip) => ({
        id: payslip.id,
        reference: payslip.reference,
        label: payslip.cycle.label,
        periodStart: toIsoDate(payslip.periodStart),
        periodEnd: toIsoDate(payslip.periodEnd),
        payDate: toIsoDate(payslip.payDate),
        payableDays: Number(payslip.payableDays),
        totalDays: payslip.totalDays,
        lopDays: Number(payslip.lopDays),
        grossEarningsMinor: payslip.grossEarningsMinor.toString(),
        totalDeductionsMinor: payslip.totalDeductionsMinor.toString(),
        netPayMinor: payslip.netPayMinor.toString(),
        hasDocument: payslip.pdfFileObjectId !== null,
      })),

      fiscalYears,
      fiscalYear: currentFy,

      // Null rather than zeroes when nothing has been published: the screen
      // renders em dashes, which is true, instead of a row of ₹0, which is not.
      summary: rollup
        ? {
            payslipCount: rollup.payslipCount,
            grossMinor: rollup.grossMinor.toString(),
            netMinor: rollup.netMinor.toString(),
            tdsMinor: rollup.tdsMinor.toString(),
            pfTotalMinor: (rollup.pfEmployeeMinor + rollup.pfEmployerMinor).toString(),
            coverageLabel: rollup.coverageLabel,
          }
        : null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /payslips/:id                                                 */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/payslips/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payslip:read', 'SELF');

      const payslip = await db.payslip.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          // Scoped to the reader. Even a manager cannot fetch a report's
          // payslip: no role holds `payslip:read` beyond SELF.
          employeeId: principal.employeeId ?? '',
          status: 'PUBLISHED',
        },
        select: {
          id: true,
          reference: true,
          periodStart: true,
          periodEnd: true,
          payDate: true,
          payableDays: true,
          totalDays: true,
          lopDays: true,
          grossEarningsMinor: true,
          totalDeductionsMinor: true,
          netPayMinor: true,
          employerContributionMinor: true,
          pfEmployeeMinor: true,
          pfEmployerMinor: true,
          tdsMinor: true,
          professionalTaxMinor: true,
          publishedAt: true,
          pdfFileObjectId: true,
          cycle: { select: { label: true } },
          employee: {
            select: {
              fullName: true,
              employeeNumber: true,
              employments: {
                where: { effectiveTo: null },
                select: {
                  designation: { select: { title: true } },
                  department: { select: { name: true } },
                  location: { select: { name: true } },
                },
                take: 1,
              },
            },
          },
          lines: {
            orderBy: { displayOrder: 'asc' },
            select: {
              id: true,
              kind: true,
              label: true,
              amountMinor: true,
              fullAmountMinor: true,
              calculationNote: true,
            },
          },
        },
      });

      if (!payslip) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, 'That payslip could not be found.');
      }

      // Reading a payslip is a sensitive read and is recorded: it is how a
      // later question about who saw what gets an answer.
      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'READ_SENSITIVE',
            entityType: 'payslip',
            entityId: payslip.id,
            summary: `Viewed payslip ${payslip.reference}`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      const employment = payslip.employee.employments[0];

      return {
        id: payslip.id,
        reference: payslip.reference,
        label: payslip.cycle.label,
        periodStart: toIsoDate(payslip.periodStart),
        periodEnd: toIsoDate(payslip.periodEnd),
        payDate: toIsoDate(payslip.payDate),
        publishedAt: payslip.publishedAt?.toISOString() ?? null,

        employee: {
          name: payslip.employee.fullName,
          employeeNumber: payslip.employee.employeeNumber,
          designation: employment?.designation.title ?? null,
          department: employment?.department.name ?? null,
          location: employment?.location.name ?? null,
        },

        attendance: {
          payableDays: Number(payslip.payableDays),
          totalDays: payslip.totalDays,
          lopDays: Number(payslip.lopDays),
        },

        totals: {
          grossEarningsMinor: payslip.grossEarningsMinor.toString(),
          totalDeductionsMinor: payslip.totalDeductionsMinor.toString(),
          netPayMinor: payslip.netPayMinor.toString(),
          employerContributionMinor: payslip.employerContributionMinor.toString(),
          pfEmployeeMinor: payslip.pfEmployeeMinor.toString(),
          pfEmployerMinor: payslip.pfEmployerMinor.toString(),
          tdsMinor: payslip.tdsMinor.toString(),
          professionalTaxMinor: payslip.professionalTaxMinor.toString(),
        },

        // Grouped the way the prototype prints them, with the derivation of
        // each line included so a figure is never unexplained.
        earnings: payslip.lines.filter((line) => line.kind === 'EARNING').map(serializeLine),
        deductions: payslip.lines.filter((line) => line.kind === 'DEDUCTION').map(serializeLine),
        employerContributions: payslip.lines
          .filter((line) => line.kind === 'EMPLOYER_CONTRIBUTION')
          .map(serializeLine),

        hasDocument: payslip.pdfFileObjectId !== null,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /payslips/:id/document — a short-lived download URL           */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/payslips/:id/document',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payslip:read', 'SELF');

      const payslip = await db.payslip.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          employeeId: principal.employeeId ?? '',
          status: 'PUBLISHED',
        },
        select: {
          id: true,
          reference: true,
          pdfFileObjectId: true,
          cycle: { select: { label: true } },
        },
      });

      if (!payslip) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND, 'That payslip could not be found.');
      }

      if (!payslip.pdfFileObjectId) {
        throw new AppError(
          409,
          ERROR_CODES.CONFLICT,
          'The document for this payslip is still being prepared. Try again shortly.',
        );
      }

      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'DOWNLOAD',
            entityType: 'payslip',
            entityId: payslip.id,
            summary: `Downloaded payslip ${payslip.reference}`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      const file = await db.fileObject.findUniqueOrThrow({
        where: { id: payslip.pdfFileObjectId },
        select: { storageKey: true, displayFilename: true },
      });

      // The URL is the capability, so its life is short and the authorization
      // check has already happened above.
      const { storage } = await import('../../services/storage.js');
      const signed = await storage(env).signedDownloadUrl(file.storageKey, {
        expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
        downloadFilename: file.displayFilename,
      });

      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );
}

function serializeLine(line: {
  id: string;
  label: string;
  amountMinor: bigint;
  fullAmountMinor: bigint | null;
  calculationNote: string | null;
}) {
  return {
    id: line.id,
    label: line.label,
    amountMinor: line.amountMinor.toString(),
    fullAmountMinor: line.fullAmountMinor?.toString() ?? null,
    note: line.calculationNote,
  };
}
