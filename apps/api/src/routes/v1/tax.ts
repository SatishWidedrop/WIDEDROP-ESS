import {
  financialYear,
  financialYearOf,
  taxDeclarationSave,
  taxRegimeElection,
  toIsoDate,
} from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';

/**
 * Tax.
 *
 * Every figure on this screen has a source that can be named. Quarterly TDS is
 * summed from published payslips and is null — an em dash — for a quarter no
 * payslip has published in. The projection is the persisted output of the
 * payroll tax engine, so what the employee sees is what payroll deducted, not
 * a second calculation that might disagree.
 *
 * Form 16 offers a download only when a file exists.
 */
export async function taxRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /tax                                                          */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/tax', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'tax:read', 'SELF');

    if (!principal.employeeId) {
      return {
        fiscalYear: null,
        fiscalYears: [],
        regime: null,
        projection: null,
        quarters: [],
        form16s: [],
        declaration: null,
      };
    }

    const requested = Number((request.query as { fiscalYear?: string }).fiscalYear);
    const startYear = Number.isFinite(requested)
      ? requested
      : financialYearOf(toIsoDate(new Date())).startYear;

    const fiscalYearRow = await db.fiscalYear.findFirst({
      where: { organizationId: principal.organizationId, startYear },
      select: { id: true, label: true, startDate: true, endDate: true, startYear: true },
    });

    if (!fiscalYearRow) {
      return {
        fiscalYear: null,
        fiscalYears: [],
        regime: null,
        projection: null,
        quarters: [],
        form16s: [],
        declaration: null,
      };
    }

    const [fiscalYears, election, projection, quarters, form16s, declaration] = await Promise.all([
      db.fiscalYear.findMany({
        where: { organizationId: principal.organizationId },
        orderBy: { startYear: 'desc' },
        select: { startYear: true, label: true },
      }),

      db.employeeTaxRegimeElection.findUnique({
        where: {
          employeeId_fiscalYearId: {
            employeeId: principal.employeeId,
            fiscalYearId: fiscalYearRow.id,
          },
        },
        select: {
          electedAt: true,
          isDefaultApplied: true,
          regime: {
            select: {
              code: true,
              name: true,
              standardDeductionMinor: true,
              allowsDeductions: true,
            },
          },
        },
      }),

      db.employeeTaxProjection.findUnique({
        where: {
          employeeId_fiscalYearId: {
            employeeId: principal.employeeId,
            fiscalYearId: fiscalYearRow.id,
          },
        },
        select: {
          projectedGrossMinor: true,
          exemptionsMinor: true,
          deductionsMinor: true,
          taxableIncomeMinor: true,
          computedTaxMinor: true,
          cessMinor: true,
          totalLiabilityMinor: true,
          tdsDeductedToDateMinor: true,
          remainingLiabilityMinor: true,
          computedAt: true,
        },
      }),

      db.tdsQuarter.findMany({
        where: {
          organizationId: principal.organizationId,
          employeeId: principal.employeeId,
          fiscalYearId: fiscalYearRow.id,
        },
        orderBy: { quarter: { quarter: 'asc' } },
        select: {
          id: true,
          status: true,
          tdsMinor: true,
          filingReference: true,
          filedAt: true,
          quarter: {
            select: { quarter: true, label: true, startDate: true, endDate: true },
          },
        },
      }),

      db.form16Document.findMany({
        where: {
          organizationId: principal.organizationId,
          employeeId: principal.employeeId,
        },
        orderBy: [{ fiscalYear: { startYear: 'desc' } }, { revision: 'desc' }],
        select: {
          id: true,
          status: true,
          revision: true,
          issuedAt: true,
          fileObjectId: true,
          fiscalYear: { select: { label: true, startYear: true } },
        },
      }),

      db.employeeTaxDeclaration.findUnique({
        where: {
          employeeId_fiscalYearId: {
            employeeId: principal.employeeId,
            fiscalYearId: fiscalYearRow.id,
          },
        },
        select: {
          id: true,
          status: true,
          submittedAt: true,
          verifiedAt: true,
          rejectionReason: true,
          items: {
            orderBy: { sectionCode: 'asc' },
            select: {
              id: true,
              sectionCode: true,
              label: true,
              declaredMinor: true,
              verifiedMinor: true,
              note: true,
              proofFileObjectId: true,
            },
          },
        },
      }),
    ]);

    return {
      fiscalYear: { startYear: fiscalYearRow.startYear, label: fiscalYearRow.label },
      fiscalYears,

      regime: election
        ? {
            code: election.regime.code,
            name: election.regime.name,
            standardDeductionMinor: election.regime.standardDeductionMinor.toString(),
            allowsDeductions: election.regime.allowsDeductions,
            electedAt: election.electedAt.toISOString(),
            // Shown as such: an employee should know whether they chose this
            // or whether the statutory default was applied on their behalf.
            isDefaultApplied: election.isDefaultApplied,
          }
        : null,

      // Null until payroll has produced one. Four tiles of ₹0 would assert
      // that no tax is due, which is a different claim from "not computed yet".
      projection: projection
        ? {
            projectedGrossMinor: projection.projectedGrossMinor.toString(),
            exemptionsMinor: projection.exemptionsMinor.toString(),
            deductionsMinor: projection.deductionsMinor.toString(),
            taxableIncomeMinor: projection.taxableIncomeMinor.toString(),
            computedTaxMinor: projection.computedTaxMinor.toString(),
            cessMinor: projection.cessMinor.toString(),
            totalLiabilityMinor: projection.totalLiabilityMinor.toString(),
            tdsDeductedToDateMinor: projection.tdsDeductedToDateMinor.toString(),
            remainingLiabilityMinor: projection.remainingLiabilityMinor.toString(),
            computedAt: projection.computedAt.toISOString(),
          }
        : null,

      quarters: quarters.map((quarter) => ({
        id: quarter.id,
        quarterNumber: quarter.quarter.quarter,
        label: quarter.quarter.label,
        startDate: toIsoDate(quarter.quarter.startDate),
        endDate: toIsoDate(quarter.quarter.endDate),
        status: quarter.status,
        // Null, not zero, until a payslip in the quarter has published.
        tdsMinor: quarter.tdsMinor?.toString() ?? null,
        filingReference: quarter.filingReference,
        filedAt: quarter.filedAt?.toISOString() ?? null,
      })),

      form16s: form16s.map((form16) => ({
        id: form16.id,
        fiscalYear: form16.fiscalYear.label,
        status: form16.status,
        revision: form16.revision,
        issuedAt: form16.issuedAt?.toISOString() ?? null,
        hasDocument: form16.fileObjectId !== null,
      })),

      declaration: declaration
        ? {
            id: declaration.id,
            status: declaration.status,
            submittedAt: declaration.submittedAt?.toISOString() ?? null,
            verifiedAt: declaration.verifiedAt?.toISOString() ?? null,
            rejectionReason: declaration.rejectionReason,
            items: declaration.items.map((item) => ({
              id: item.id,
              sectionCode: item.sectionCode,
              label: item.label,
              declaredMinor: item.declaredMinor.toString(),
              verifiedMinor: item.verifiedMinor?.toString() ?? null,
              note: item.note,
              hasProof: item.proofFileObjectId !== null,
            })),
          }
        : null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /tax/regime                                                  */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/tax/regime',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'tax:declare', 'SELF');

      const employeeId = principal.employeeId;
      if (!employeeId) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          'This account is not linked to an employee.',
        );
      }

      const body = taxRegimeElection.parse(request.body);

      const [fiscalYearRow, regime] = await Promise.all([
        db.fiscalYear.findFirst({
          where: { organizationId: principal.organizationId, startYear: body.fiscalYearStartYear },
          select: { id: true, label: true },
        }),
        db.taxRegime.findUnique({
          where: {
            code_fiscalYearStartYear: {
              code: body.regime,
              fiscalYearStartYear: body.fiscalYearStartYear,
            },
          },
          select: { id: true, name: true },
        }),
      ]);

      if (!fiscalYearRow || !regime) throw notFound('That financial year');

      // An election cannot be changed once a payslip in the year has
      // published: the tax already deducted was computed under the old regime,
      // and silently switching would make the year's arithmetic unexplainable.
      const published = await db.payslip.count({
        where: {
          employeeId,
          status: 'PUBLISHED',
          periodStart: { gte: new Date(financialYear(body.fiscalYearStartYear).start) },
          periodEnd: { lte: new Date(financialYear(body.fiscalYearStartYear).end) },
        },
      });
      if (published > 0) {
        throw conflict(
          'Payroll has already run under the regime recorded for this year. Raise a help-desk ticket to have it changed.',
        );
      }

      const existing = await db.employeeTaxRegimeElection.findUnique({
        where: { employeeId_fiscalYearId: { employeeId, fiscalYearId: fiscalYearRow.id } },
        select: { regime: { select: { code: true } } },
      });

      await db.$transaction(async (tx) => {
        await tx.employeeTaxRegimeElection.upsert({
          where: { employeeId_fiscalYearId: { employeeId, fiscalYearId: fiscalYearRow.id } },
          update: { taxRegimeId: regime.id, electedAt: new Date(), isDefaultApplied: false },
          create: {
            organizationId: principal.organizationId,
            employeeId,
            fiscalYearId: fiscalYearRow.id,
            taxRegimeId: regime.id,
            isDefaultApplied: false,
          },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'UPDATE',
            entityType: 'employee_tax_regime_election',
            entityId: employeeId,
            before: { regime: existing?.regime.code ?? null },
            after: { regime: body.regime, fiscalYear: fiscalYearRow.label },
            summary: `Elected the ${regime.name} for ${fiscalYearRow.label}`,
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      return { regime: body.regime, fiscalYear: fiscalYearRow.label };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /tax/declaration                                             */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/tax/declaration',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'tax:declare', 'SELF');

      const employeeId = principal.employeeId;
      if (!employeeId) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          'This account is not linked to an employee.',
        );
      }

      const body = taxDeclarationSave.parse(request.body);

      const fiscalYearRow = await db.fiscalYear.findFirst({
        where: { organizationId: principal.organizationId, startYear: body.fiscalYearStartYear },
        select: { id: true, label: true },
      });
      if (!fiscalYearRow) throw notFound('That financial year');

      const result = await db.$transaction(async (tx) => {
        const existing = await tx.employeeTaxDeclaration.findUnique({
          where: { employeeId_fiscalYearId: { employeeId, fiscalYearId: fiscalYearRow.id } },
          select: { id: true, status: true },
        });

        // A verified declaration is closed: payroll has already allowed the
        // amounts on it, and editing would leave the deduction unexplainable.
        if (existing && ['VERIFIED', 'LOCKED'].includes(existing.status)) {
          throw conflict(
            'This declaration has been verified and can no longer be edited. Raise a help-desk ticket to change it.',
          );
        }

        const declaration = existing
          ? await tx.employeeTaxDeclaration.update({
              where: { id: existing.id },
              data: {
                status: body.submit ? 'SUBMITTED' : 'DRAFT',
                submittedAt: body.submit ? new Date() : null,
                rowVersion: { increment: 1 },
              },
              select: { id: true, status: true },
            })
          : await tx.employeeTaxDeclaration.create({
              data: {
                organizationId: principal.organizationId,
                employeeId,
                fiscalYearId: fiscalYearRow.id,
                status: body.submit ? 'SUBMITTED' : 'DRAFT',
                submittedAt: body.submit ? new Date() : null,
              },
              select: { id: true, status: true },
            });

        // Replace wholesale: the client sends the full set, and a partial
        // update would leave an item nobody can see but payroll would allow.
        await tx.employeeTaxDeclarationItem.deleteMany({
          where: { declarationId: declaration.id },
        });

        if (body.items.length > 0) {
          await tx.employeeTaxDeclarationItem.createMany({
            data: body.items.map((item) => ({
              declarationId: declaration.id,
              sectionCode: item.sectionCode.toUpperCase(),
              label: item.label,
              declaredMinor: BigInt(item.declaredMinor),
              note: item.note ?? null,
            })),
          });
        }

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: body.submit ? 'STATE_TRANSITION' : 'UPDATE',
            entityType: 'employee_tax_declaration',
            entityId: declaration.id,
            toState: declaration.status,
            after: {
              fiscalYear: fiscalYearRow.label,
              itemCount: body.items.length,
              totalDeclaredMinor: body.items
                .reduce((total, item) => total + BigInt(item.declaredMinor), 0n)
                .toString(),
            },
            summary: body.submit
              ? `Submitted tax declaration for ${fiscalYearRow.label}`
              : `Saved tax declaration draft for ${fiscalYearRow.label}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return declaration;
      });

      return result;
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /tax/form16/:id/document                                      */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/tax/form16/:id/document',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'tax:read', 'SELF');

      const form16 = await db.form16Document.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          employeeId: principal.employeeId ?? '',
          status: 'ISSUED',
        },
        select: {
          id: true,
          fiscalYear: { select: { label: true } },
          file: { select: { storageKey: true, displayFilename: true } },
        },
      });

      if (!form16?.file) throw notFound('That Form 16');

      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'DOWNLOAD',
            entityType: 'form16_document',
            entityId: form16.id,
            summary: `Downloaded Form 16 for ${form16.fiscalYear.label}`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      const { storage } = await import('../../services/storage.js');
      const signed = await storage(env).signedDownloadUrl(form16.file.storageKey, {
        expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
        downloadFilename: form16.file.displayFilename,
      });

      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );
}
