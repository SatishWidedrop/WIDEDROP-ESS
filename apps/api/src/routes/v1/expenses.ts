import {
  EXPENSE_STATES_AWAITING_DECISION,
  EXPENSE_STATES_AWAITING_PAYMENT,
  expenseClaimCreate,
  financialYearOf,
  toIsoDate,
} from '@widedrop/shared';
import type { App } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import {
  assertPermission,
  employeeScopeFor,
  employeeWhere,
} from '../../services/auth/authorization.js';
import {
  createExpenseClaim,
  submitExpenseClaim,
  withdrawExpenseClaim,
} from '../../services/expenses/service.js';

/**
 * Expenses.
 *
 * The three tiles read a maintained rollup, and they are returned as null
 * rather than zeroes when no rollup exists — the difference between "you have
 * claimed nothing this year" and "the year has not started for you".
 */
export async function expenseRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /expenses                                                     */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/expenses', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'expense:read', 'SELF');

    const { status } = request.query as { status?: string };
    const scope = await employeeScopeFor(db, principal, 'expense:read');

    const statusFilter =
      status === 'pending'
        ? { status: { in: [...EXPENSE_STATES_AWAITING_DECISION] as never[] } }
        : status === 'approved'
          ? { status: { in: [...EXPENSE_STATES_AWAITING_PAYMENT] as never[] } }
          : status
            ? { status: status as never }
            : {};

    const [claims, categories, rollup] = await Promise.all([
      db.expenseClaim.findMany({
        where: {
          organizationId: principal.organizationId,
          ...employeeWhere(scope),
          ...statusFilter,
        },
        orderBy: { spendDate: 'desc' },
        take: 100,
        select: {
          id: true,
          reference: true,
          title: true,
          status: true,
          totalAmountMinor: true,
          approvedAmountMinor: true,
          spendDate: true,
          submittedAt: true,
          managerDecidedAt: true,
          financeDecidedAt: true,
          reimbursedAt: true,
          employee: { select: { id: true, fullName: true, initials: true } },
          batch: {
            select: {
              reference: true,
              cycle: { select: { label: true, payDate: true } },
            },
          },
          _count: { select: { lines: true, attachments: true } },
        },
      }),

      db.expenseCategory.findMany({
        where: { organizationId: principal.organizationId, isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          requiresReceipt: true,
          submissionWindowDays: true,
        },
      }),

      principal.employeeId
        ? db.expenseFyRollup.findFirst({
            where: {
              employeeId: principal.employeeId,
              fiscalYear: {
                organizationId: principal.organizationId,
                startYear: financialYearOf(toIsoDate(new Date())).startYear,
              },
            },
            select: {
              pendingCount: true,
              pendingMinor: true,
              approvedCount: true,
              approvedMinor: true,
              reimbursedCount: true,
              reimbursedMinor: true,
              rejectedCount: true,
              fiscalYear: { select: { label: true } },
            },
          })
        : null,
    ]);

    return {
      items: claims.map((claim) => ({
        id: claim.id,
        reference: claim.reference,
        title: claim.title,
        status: claim.status,
        totalAmountMinor: claim.totalAmountMinor.toString(),
        approvedAmountMinor: claim.approvedAmountMinor?.toString() ?? null,
        spendDate: toIsoDate(claim.spendDate),
        submittedAt: claim.submittedAt?.toISOString() ?? null,
        reimbursedAt: claim.reimbursedAt?.toISOString() ?? null,
        employee: claim.employee,
        lineCount: claim._count.lines,
        attachmentCount: claim._count.attachments,
        // Where it will be paid, when that is a fact rather than a promise.
        payingWith: claim.batch?.cycle
          ? {
              label: claim.batch.cycle.label,
              payDate: toIsoDate(claim.batch.cycle.payDate),
              batchReference: claim.batch.reference,
            }
          : null,
        canSubmit: claim.status === 'DRAFT' && claim.employee.id === principal.employeeId,
        canWithdraw:
          ['SUBMITTED', 'PENDING_MANAGER'].includes(claim.status) &&
          claim.employee.id === principal.employeeId,
      })),

      categories,

      summary: rollup
        ? {
            fiscalYear: rollup.fiscalYear.label,
            pendingCount: rollup.pendingCount,
            pendingMinor: rollup.pendingMinor.toString(),
            approvedCount: rollup.approvedCount,
            approvedMinor: rollup.approvedMinor.toString(),
            reimbursedCount: rollup.reimbursedCount,
            reimbursedMinor: rollup.reimbursedMinor.toString(),
            rejectedCount: rollup.rejectedCount,
          }
        : null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /expenses/:id                                                 */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/expenses/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:read', 'SELF');

      const scope = await employeeScopeFor(db, principal, 'expense:read');

      const claim = await db.expenseClaim.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          ...employeeWhere(scope),
        },
        select: {
          id: true,
          reference: true,
          title: true,
          status: true,
          totalAmountMinor: true,
          approvedAmountMinor: true,
          spendDate: true,
          submittedAt: true,
          managerDecidedAt: true,
          managerNote: true,
          financeDecidedAt: true,
          financeNote: true,
          reimbursedAt: true,
          employee: { select: { id: true, fullName: true, initials: true } },
          batch: {
            select: { reference: true, cycle: { select: { label: true, payDate: true } } },
          },
          lines: {
            orderBy: { spendDate: 'asc' },
            select: {
              id: true,
              description: true,
              spendDate: true,
              amountMinor: true,
              approvedAmountMinor: true,
              capAppliedNote: true,
              category: { select: { id: true, name: true, code: true } },
            },
          },
          attachments: {
            select: {
              id: true,
              file: { select: { id: true, displayFilename: true, sizeBytes: true } },
            },
          },
        },
      });

      if (!claim) throw notFound('That expense claim');

      return {
        ...claim,
        totalAmountMinor: claim.totalAmountMinor.toString(),
        approvedAmountMinor: claim.approvedAmountMinor?.toString() ?? null,
        spendDate: toIsoDate(claim.spendDate),
        submittedAt: claim.submittedAt?.toISOString() ?? null,
        managerDecidedAt: claim.managerDecidedAt?.toISOString() ?? null,
        financeDecidedAt: claim.financeDecidedAt?.toISOString() ?? null,
        reimbursedAt: claim.reimbursedAt?.toISOString() ?? null,
        payingWith: claim.batch?.cycle
          ? {
              label: claim.batch.cycle.label,
              payDate: toIsoDate(claim.batch.cycle.payDate),
              batchReference: claim.batch.reference,
            }
          : null,
        lines: claim.lines.map((line) => ({
          ...line,
          spendDate: toIsoDate(line.spendDate),
          amountMinor: line.amountMinor.toString(),
          approvedAmountMinor: line.approvedAmountMinor?.toString() ?? null,
        })),
        attachments: claim.attachments.map((attachment) => ({
          id: attachment.id,
          fileId: attachment.file.id,
          filename: attachment.file.displayFilename,
          sizeBytes: Number(attachment.file.sizeBytes),
        })),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /expenses                                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/expenses',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:submit', 'SELF');

      const body = expenseClaimCreate.parse(request.body);

      const created = await db.$transaction((tx) =>
        createExpenseClaim(
          tx,
          principal,
          {
            title: body.title,
            lines: body.lines.map((line) => ({
              expenseCategoryId: line.expenseCategoryId,
              description: line.description,
              spendDate: line.spendDate,
              amountMinor: BigInt(line.amountMinor),
            })),
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return reply.status(201).send({
        id: created.id,
        reference: created.reference,
        totalAmountMinor: created.totalAmountMinor.toString(),
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /expenses/:id/submit and /withdraw                           */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/expenses/:id/submit',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:submit', 'SELF');

      await db.$transaction((tx) =>
        submitExpenseClaim(tx, principal, { claimId: request.params.id }, env.AUDIT_HMAC_KEY),
      );

      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/expenses/:id/withdraw',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:withdraw', 'SELF');

      await db.$transaction((tx) =>
        withdrawExpenseClaim(tx, principal, { claimId: request.params.id }, env.AUDIT_HMAC_KEY),
      );

      return reply.status(204).send();
    },
  );
}
