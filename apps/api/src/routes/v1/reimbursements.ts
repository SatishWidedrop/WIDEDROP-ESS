import { EXPENSE_STATES_AWAITING_PAYMENT, expenseDecision, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';
import {
  decideExpenseClaimAsFinance,
  refreshExpenseRollup,
} from '../../services/expenses/service.js';
import { notifyEmployee } from '../../services/notifications.js';
import { allocateReference } from '../../services/reference.js';

/**
 * Reimbursements — the bridge between expenses and payroll.
 *
 * A batch is what makes "paid with September salary" a fact: approved claims
 * are gathered against a named payroll cycle, the batch locks, and paying it
 * marks every claim in it reimbursed and tells each employee. Without the
 * batch, a claim's payment date would be a caption somebody typed.
 */
export async function reimbursementRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /payroll/reimbursements                                       */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/payroll/reimbursements', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'expense:reimburse', 'ORG');

    const [awaitingFinance, awaitingPayment, batches, cycles] = await Promise.all([
      db.expenseClaim.findMany({
        where: { organizationId: principal.organizationId, status: 'PENDING_FINANCE' },
        orderBy: { managerDecidedAt: 'asc' },
        take: 200,
        select: {
          id: true,
          reference: true,
          title: true,
          totalAmountMinor: true,
          spendDate: true,
          managerDecidedAt: true,
          managerNote: true,
          employee: { select: { id: true, fullName: true, initials: true, employeeNumber: true } },
          lines: {
            select: {
              id: true,
              description: true,
              amountMinor: true,
              category: { select: { name: true } },
            },
          },
          _count: { select: { attachments: true } },
        },
      }),

      db.expenseClaim.findMany({
        where: {
          organizationId: principal.organizationId,
          status: { in: [...EXPENSE_STATES_AWAITING_PAYMENT] as never[] },
        },
        orderBy: { financeDecidedAt: 'asc' },
        take: 300,
        select: {
          id: true,
          reference: true,
          title: true,
          status: true,
          approvedAmountMinor: true,
          totalAmountMinor: true,
          financeDecidedAt: true,
          reimbursementBatchId: true,
          employee: { select: { id: true, fullName: true, initials: true } },
        },
      }),

      db.reimbursementBatch.findMany({
        where: { organizationId: principal.organizationId },
        orderBy: { createdAt: 'desc' },
        take: 24,
        select: {
          id: true,
          reference: true,
          status: true,
          cutoffDate: true,
          claimCount: true,
          totalAmountMinor: true,
          lockedAt: true,
          paidAt: true,
          createdAt: true,
          cycle: { select: { id: true, label: true, payDate: true, status: true } },
        },
      }),

      // Cycles a batch may still be attached to: one already published has
      // paid what it was going to pay.
      db.payrollCycle.findMany({
        where: {
          organizationId: principal.organizationId,
          status: {
            in: [
              'DRAFT',
              'INPUTS_OPEN',
              'INPUTS_LOCKED',
              'ATTENDANCE_SUBMITTED',
              'ATTENDANCE_APPROVED',
              'VALIDATED',
              'CALCULATED',
            ],
          },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        select: { id: true, label: true, payDate: true, status: true },
      }),
    ]);

    return {
      awaitingFinance: awaitingFinance.map((claim) => ({
        id: claim.id,
        reference: claim.reference,
        title: claim.title,
        totalAmountMinor: claim.totalAmountMinor.toString(),
        spendDate: toIsoDate(claim.spendDate),
        managerDecidedAt: claim.managerDecidedAt?.toISOString() ?? null,
        managerNote: claim.managerNote,
        employee: claim.employee,
        attachmentCount: claim._count.attachments,
        lines: claim.lines.map((line) => ({
          id: line.id,
          description: line.description,
          amountMinor: line.amountMinor.toString(),
          category: line.category.name,
        })),
      })),

      awaitingPayment: awaitingPayment.map((claim) => ({
        id: claim.id,
        reference: claim.reference,
        title: claim.title,
        status: claim.status,
        // What will actually be paid, which may be less than claimed.
        payableMinor: (claim.approvedAmountMinor ?? claim.totalAmountMinor).toString(),
        financeDecidedAt: claim.financeDecidedAt?.toISOString() ?? null,
        batchId: claim.reimbursementBatchId,
        employee: claim.employee,
      })),

      batches: batches.map((batch) => ({
        id: batch.id,
        reference: batch.reference,
        status: batch.status,
        cutoffDate: toIsoDate(batch.cutoffDate),
        claimCount: batch.claimCount,
        totalAmountMinor: batch.totalAmountMinor.toString(),
        lockedAt: batch.lockedAt?.toISOString() ?? null,
        paidAt: batch.paidAt?.toISOString() ?? null,
        createdAt: batch.createdAt.toISOString(),
        cycle: batch.cycle
          ? {
              id: batch.cycle.id,
              label: batch.cycle.label,
              payDate: toIsoDate(batch.cycle.payDate),
              status: batch.cycle.status,
            }
          : null,
      })),

      cycles: cycles.map((cycle) => ({
        id: cycle.id,
        label: cycle.label,
        payDate: toIsoDate(cycle.payDate),
        status: cycle.status,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /payroll/reimbursements/claims/:id/decide                    */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/payroll/reimbursements/claims/:id/decide',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:reimburse', 'ORG');

      const body = expenseDecision.parse(request.body);

      await db.$transaction((tx) =>
        decideExpenseClaimAsFinance(
          tx,
          principal,
          {
            claimId: request.params.id,
            approve: body.decision === 'APPROVE',
            note: body.note ?? null,
            approvedAmountMinor:
              body.approvedAmountMinor === undefined ? null : BigInt(body.approvedAmountMinor),
            ip: request.context.ip ?? null,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return { decided: body.decision };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /payroll/reimbursements/batches                              */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/payroll/reimbursements/batches',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:reimburse', 'ORG');

      const body = request.body as { payrollCycleId?: string; cutoffDate?: string };
      if (!body.cutoffDate) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          'Give the cut-off date: claims approved on or before it are included.',
        );
      }

      const cycle = body.payrollCycleId
        ? await db.payrollCycle.findFirst({
            where: { id: body.payrollCycleId, organizationId: principal.organizationId },
            select: { id: true, label: true, status: true },
          })
        : null;

      if (body.payrollCycleId && !cycle) throw notFound('That payroll cycle');
      if (cycle && ['PUBLISHED', 'CLOSED', 'CANCELLED'].includes(cycle.status)) {
        throw conflict(`${cycle.label} has already been published, so it cannot pay new claims.`);
      }

      const created = await db.$transaction(async (tx) => {
        const reference = await allocateReference(tx, {
          organizationId: principal.organizationId,
          prefix: 'RB',
          start: 101,
          readHighest: async () => {
            const latest = await tx.reimbursementBatch.findFirst({
              where: { organizationId: principal.organizationId },
              orderBy: { createdAt: 'desc' },
              select: { reference: true },
            });
            return latest?.reference ?? null;
          },
        });

        // The claims this batch pays, resolved from rows rather than from a
        // list the client sent: Accounts chooses a cut-off, not a selection.
        const claims = await tx.expenseClaim.findMany({
          where: {
            organizationId: principal.organizationId,
            status: 'FINANCE_APPROVED',
            reimbursementBatchId: null,
            financeDecidedAt: { lte: new Date(`${body.cutoffDate}T23:59:59.999Z`) },
          },
          select: { id: true, approvedAmountMinor: true, totalAmountMinor: true },
        });

        if (claims.length === 0) {
          throw new AppError(
            422,
            ERROR_CODES.BUSINESS_RULE_VIOLATION,
            'No approved claims are waiting on or before that date.',
          );
        }

        const total = claims.reduce(
          (sum, claim) => sum + (claim.approvedAmountMinor ?? claim.totalAmountMinor),
          0n,
        );

        const batch = await tx.reimbursementBatch.create({
          data: {
            organizationId: principal.organizationId,
            payrollCycleId: cycle?.id ?? null,
            reference,
            status: 'LOCKED',
            cutoffDate: new Date(body.cutoffDate!),
            claimCount: claims.length,
            totalAmountMinor: total,
            lockedAt: new Date(),
            createdByUserId: principal.userId,
          },
          select: { id: true, reference: true, claimCount: true, totalAmountMinor: true },
        });

        await tx.expenseClaim.updateMany({
          where: { id: { in: claims.map((claim) => claim.id) } },
          data: { status: 'QUEUED_FOR_PAYMENT', reimbursementBatchId: batch.id },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'reimbursement_batch',
            entityId: batch.id,
            after: {
              reference: batch.reference,
              claimCount: batch.claimCount,
              totalMinor: total.toString(),
              cycle: cycle?.label ?? null,
            },
            summary: `Batched ${batch.claimCount} ${batch.claimCount === 1 ? 'claim' : 'claims'} for payment${cycle ? ` with ${cycle.label}` : ''}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return batch;
      });

      return reply.status(201).send({
        id: created.id,
        reference: created.reference,
        claimCount: created.claimCount,
        totalAmountMinor: created.totalAmountMinor.toString(),
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /payroll/reimbursements/batches/:id/pay                      */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/payroll/reimbursements/batches/:id/pay',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:reimburse', 'ORG');

      const batch = await db.reimbursementBatch.findFirst({
        where: { id: request.params.id, organizationId: principal.organizationId },
        select: {
          id: true,
          reference: true,
          status: true,
          claimCount: true,
          cycle: { select: { label: true, status: true, payDate: true } },
        },
      });
      if (!batch) throw notFound('That batch');

      if (batch.status !== 'LOCKED' && batch.status !== 'SENT_TO_PAYROLL') {
        throw conflict(`Batch ${batch.reference} is ${batch.status.toLowerCase()}.`);
      }

      // A batch attached to a cycle is paid when that cycle is. Marking it
      // paid before the cycle publishes would tell employees they have been
      // paid when the money has not moved.
      if (batch.cycle && !['PUBLISHED', 'CLOSED'].includes(batch.cycle.status)) {
        throw conflict(
          `${batch.cycle.label} has not been published yet, so this batch has not been paid.`,
        );
      }

      const paidAt = new Date();

      const result = await db.$transaction(
        async (tx) => {
          const claims = await tx.expenseClaim.findMany({
            where: { reimbursementBatchId: batch.id, status: 'QUEUED_FOR_PAYMENT' },
            select: {
              id: true,
              reference: true,
              employeeId: true,
              spendDate: true,
              approvedAmountMinor: true,
              totalAmountMinor: true,
            },
          });

          await tx.expenseClaim.updateMany({
            where: { id: { in: claims.map((claim) => claim.id) } },
            data: { status: 'REIMBURSED', reimbursedAt: paidAt },
          });

          await tx.reimbursementBatch.update({
            where: { id: batch.id },
            data: { status: 'PAID', paidAt, rowVersion: { increment: 1 } },
          });

          for (const claim of claims) {
            await notifyEmployee(tx, {
              organizationId: principal.organizationId,
              employeeId: claim.employeeId,
              kind: 'EXPENSE_REIMBURSED',
              tone: 'GREEN',
              title: `${claim.reference} has been reimbursed`,
              body: batch.cycle ? `Paid with your ${batch.cycle.label} salary` : null,
              targetModule: 'expenses',
              targetId: claim.id,
              sourceType: 'reimbursement_batch',
              sourceId: batch.id,
            });

            await refreshExpenseRollup(
              tx,
              principal.organizationId,
              claim.employeeId,
              toIsoDate(claim.spendDate),
            );
          }

          await recordAudit(
            tx,
            {
              organizationId: principal.organizationId,
              action: 'STATE_TRANSITION',
              entityType: 'reimbursement_batch',
              entityId: batch.id,
              fromState: batch.status,
              toState: 'PAID',
              after: { claimCount: claims.length },
              summary: `Paid ${claims.length} ${claims.length === 1 ? 'claim' : 'claims'} in batch ${batch.reference}`,
            },
            env.AUDIT_HMAC_KEY,
          );

          return { claimCount: claims.length };
        },
        { timeout: 120_000 },
      );

      return { id: batch.id, paidAt: paidAt.toISOString(), claimCount: result.claimCount };
    },
  );
}
