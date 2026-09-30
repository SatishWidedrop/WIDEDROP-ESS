import {
  EXPENSE_STATES_AWAITING_DECISION,
  EXPENSE_STATES_AWAITING_PAYMENT,
  expenseClaimCreate,
  financialYearOf,
  toIsoDate,
} from '@widedrop/shared';
import type { App } from '../../app.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
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
import { acceptUpload, requireUploadedFile } from '../../services/uploads/service.js';
import { storage } from '../../services/storage.js';
import { recordAudit } from '../../services/audit.js';

/**
 * Expenses.
 *
 * The three tiles read a maintained rollup, and they are returned as null
 * rather than zeroes when no rollup exists — the difference between "you have
 * claimed nothing this year" and "the year has not started for you".
 */
/** Enough for a trip with a few receipts, not enough to be a file store. */
const MAX_BILLS_PER_CLAIM = 5;

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

  /* ---------------------------------------------------------------- */
  /* Bills                                                             */
  /* ---------------------------------------------------------------- */

  /**
   * The claim a bill may be attached to, or a refusal.
   *
   * A claim that has left the employee's hands is evidence in somebody else's
   * decision: letting a bill appear on it after a manager approved it would
   * mean the thing approved and the thing on file are not the same thing. So
   * attaching and detaching are DRAFT-only.
   *
   * Ownership is part of the lookup rather than a check after it, so a claim
   * belonging to somebody else is *not found* — a 403 would confirm that the
   * reference exists, which the caller has not earned.
   */
  const ownDraftClaim = async (claimId: string, principalEmployeeId: string, orgId: string) => {
    const claim = await db.expenseClaim.findFirst({
      where: { id: claimId, organizationId: orgId, employeeId: principalEmployeeId },
      select: { id: true, employeeId: true, status: true, reference: true },
    });
    if (!claim) throw notFound('The claim');
    if (claim.status !== 'DRAFT') {
      throw conflict('This claim has been submitted. Withdraw it before changing its bills.');
    }
    return claim;
  };

  /**
   * What is attached to a claim.
   *
   * Metadata only — no URL. A signed URL is a capability, so it is issued one
   * file at a time by the route below, when somebody is about to open it,
   * rather than handed out in bulk for a list that may sit on screen for an
   * hour.
   */
  app.get<{ Params: { id: string } }>(
    '/api/v1/expenses/:id/attachments',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:read', 'SELF');
      const scope = await employeeScopeFor(db, principal, 'expense:read');

      // The claim is resolved through the caller's scope first, so a claim they
      // may not see is not found rather than forbidden — and an empty list is
      // never mistaken for "no bills on a claim you cannot read".
      const claim = await db.expenseClaim.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          ...employeeWhere(scope),
        },
        select: { id: true },
      });
      if (!claim) throw notFound('The claim');

      const attachments = await db.expenseAttachment.findMany({
        where: { expenseClaimId: claim.id, organizationId: principal.organizationId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          createdAt: true,
          file: { select: { displayFilename: true, contentType: true, sizeBytes: true } },
        },
      });

      return {
        items: attachments.map((attachment) => ({
          id: attachment.id,
          filename: attachment.file.displayFilename,
          contentType: attachment.file.contentType,
          sizeBytes: attachment.file.sizeBytes,
          uploadedAt: attachment.createdAt.toISOString(),
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/expenses/:id/attachments',
    {
      onRequest: app.authenticate(),
      // An upload is heavier than a write and easier to abuse; it gets the
      // stricter budget rather than the ordinary one.
      config: { rateLimitName: 'file:upload' },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:submit', 'SELF');

      // A bill is attached by the person claiming, never on their behalf:
      // no role holds expense:submit beyond SELF.
      if (!principal.employeeId) throw notFound('The claim');
      const claim = await ownDraftClaim(
        request.params.id,
        principal.employeeId,
        principal.organizationId,
      );

      const existing = await db.expenseAttachment.count({ where: { expenseClaimId: claim.id } });
      if (existing >= MAX_BILLS_PER_CLAIM) {
        throw badRequest(`A claim can carry at most ${MAX_BILLS_PER_CLAIM} bills.`);
      }

      const part = await requireUploadedFile(await request.file());

      const attachment = await db.$transaction(async (tx) => {
        const uploaded = await acceptUpload(tx, env, part, {
          organizationId: principal.organizationId,
          purpose: 'EXPENSE_BILL',
          subjectEmployeeId: claim.employeeId,
          uploadedByUserId: principal.userId,
        });

        const row = await tx.expenseAttachment.create({
          data: {
            organizationId: principal.organizationId,
            expenseClaimId: claim.id,
            fileObjectId: uploaded.fileObjectId,
          },
          select: { id: true, createdAt: true },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'UPDATE',
            entityType: 'ExpenseClaim',
            entityId: claim.id,
            summary: `Attached ${uploaded.displayFilename} to ${claim.reference}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return { row, uploaded };
      });

      return reply.status(201).send({
        id: attachment.row.id,
        filename: attachment.uploaded.displayFilename,
        contentType: attachment.uploaded.contentType,
        sizeBytes: attachment.uploaded.sizeBytes,
        uploadedAt: attachment.row.createdAt.toISOString(),
      });
    },
  );

  /**
   * A short-lived link to one bill.
   *
   * Reading somebody else's bill is a scope question, not an ownership one:
   * a manager reviewing a claim has to be able to see what they are approving,
   * so the check is the same `expense:read` scope the claim list uses.
   */
  app.get<{ Params: { id: string; attachmentId: string } }>(
    '/api/v1/expenses/:id/attachments/:attachmentId',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:read', 'SELF');
      const scope = await employeeScopeFor(db, principal, 'expense:read');

      const attachment = await db.expenseAttachment.findFirst({
        where: {
          id: request.params.attachmentId,
          expenseClaimId: request.params.id,
          organizationId: principal.organizationId,
          claim: employeeWhere(scope),
        },
        select: {
          file: { select: { storageKey: true, displayFilename: true, id: true } },
          claim: { select: { reference: true, employeeId: true } },
        },
      });
      if (!attachment) throw notFound('The bill');

      const signed = await storage(env).signedDownloadUrl(attachment.file.storageKey, {
        expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
        downloadFilename: attachment.file.displayFilename,
      });

      // Reading somebody else's receipt is a sensitive read and is recorded as
      // one; reading your own is not, or the trail would be mostly noise.
      if (attachment.claim.employeeId !== principal.employeeId) {
        await db.$transaction((tx) =>
          recordAudit(
            tx,
            {
              organizationId: principal.organizationId,
              action: 'DOWNLOAD',
              entityType: 'FileObject',
              entityId: attachment.file.id,
              summary: `Downloaded a bill on ${attachment.claim.reference}`,
            },
            env.AUDIT_HMAC_KEY,
          ),
        );
      }

      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );

  app.delete<{ Params: { id: string; attachmentId: string } }>(
    '/api/v1/expenses/:id/attachments/:attachmentId',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'expense:submit', 'SELF');

      const attachment = await db.expenseAttachment.findFirst({
        where: {
          id: request.params.attachmentId,
          expenseClaimId: request.params.id,
          organizationId: principal.organizationId,
        },
        select: {
          id: true,
          file: { select: { id: true, displayFilename: true } },
          claim: { select: { id: true, employeeId: true, status: true, reference: true } },
        },
      });
      if (!attachment) throw notFound('The bill');
      if (attachment.claim.employeeId !== principal.employeeId) throw notFound('The bill');
      if (attachment.claim.status !== 'DRAFT') {
        throw conflict('This claim has been submitted. Its bills can no longer be removed.');
      }

      await db.$transaction(async (tx) => {
        await tx.expenseAttachment.delete({ where: { id: attachment.id } });
        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'UPDATE',
            entityType: 'ExpenseClaim',
            entityId: attachment.claim.id,
            summary: `Removed ${attachment.file.displayFilename} from ${attachment.claim.reference}`,
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      // The FileObject row and the object itself are deliberately left:
      // detaching a bill is not a reason to destroy evidence, and the
      // retention sweep is what removes a file nothing references.
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
