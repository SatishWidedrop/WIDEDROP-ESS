import { expenseDecision, leaveDecision, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { assertPermission } from '../../services/auth/authorization.js';
import { decideExpenseClaimAsManager } from '../../services/expenses/service.js';
import { decideLeaveRequest } from '../../services/leave/service.js';

/**
 * The manager's queue.
 *
 * One list, because leave, expenses and attendance all raise an
 * `approval_task`. The decision endpoints dispatch back into the module that
 * owns the record, so the balance arithmetic and the state machine live in one
 * place rather than being re-implemented for the queue.
 *
 * Every decision re-checks, inside the transaction, that this approver is the
 * one the record was routed to. The queue is a convenience; it is not the
 * authorization.
 */
export async function approvalRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /approvals                                                    */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/approvals', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    // A manager reaches this queue; the permission is checked against the
    // decision they would take, not against the word "approvals".
    assertPermission(principal, 'leave:decide', 'DIRECT_REPORTS');

    const { status } = request.query as { status?: string };
    const wantHistory = status === 'history';

    const tasks = await db.approvalTask.findMany({
      where: {
        organizationId: principal.organizationId,
        assigneeEmployeeId: principal.employeeId ?? '',
        status: wantHistory ? { not: 'PENDING' } : 'PENDING',
      },
      orderBy: wantHistory ? { decidedAt: 'desc' } : { requestedAt: 'asc' },
      take: wantHistory ? 100 : 200,
      select: {
        id: true,
        kind: true,
        status: true,
        subjectType: true,
        subjectId: true,
        title: true,
        subtitle: true,
        amountMinor: true,
        requestedAt: true,
        dueAt: true,
        decidedAt: true,
        subjectEmployee: {
          select: {
            id: true,
            fullName: true,
            initials: true,
            employments: {
              where: { effectiveTo: null },
              take: 1,
              select: {
                designation: { select: { title: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
        decisions: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { outcome: true, note: true, createdAt: true },
        },
      },
    });

    return {
      items: tasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        subjectType: task.subjectType,
        subjectId: task.subjectId,
        title: task.title,
        subtitle: task.subtitle,
        amountMinor: task.amountMinor?.toString() ?? null,
        requestedAt: task.requestedAt.toISOString(),
        dueAt: task.dueAt?.toISOString() ?? null,
        decidedAt: task.decidedAt?.toISOString() ?? null,
        employee: {
          id: task.subjectEmployee.id,
          fullName: task.subjectEmployee.fullName,
          initials: task.subjectEmployee.initials,
          designation: task.subjectEmployee.employments[0]?.designation.title ?? null,
          department: task.subjectEmployee.employments[0]?.department.name ?? null,
        },
        lastDecision: task.decisions[0]
          ? {
              outcome: task.decisions[0].outcome,
              note: task.decisions[0].note,
              at: task.decisions[0].createdAt.toISOString(),
            }
          : null,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /approvals/:id — the full record behind one task              */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/approvals/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'leave:decide', 'DIRECT_REPORTS');

      const task = await db.approvalTask.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          assigneeEmployeeId: principal.employeeId ?? '',
        },
        select: {
          id: true,
          kind: true,
          status: true,
          subjectType: true,
          subjectId: true,
          title: true,
          subtitle: true,
          amountMinor: true,
          requestedAt: true,
          subjectEmployee: { select: { id: true, fullName: true, initials: true } },
        },
      });

      if (!task) throw notFound('That approval');

      // The detail comes from the record itself, not from the cached display
      // fields on the task: a decision should be taken against what the
      // request says now.
      const detail =
        task.kind === 'LEAVE_REQUEST'
          ? await leaveDetail(db, principal.organizationId, task.subjectId)
          : task.kind === 'EXPENSE_CLAIM'
            ? await expenseDetail(db, principal.organizationId, task.subjectId)
            : null;

      return {
        id: task.id,
        kind: task.kind,
        status: task.status,
        title: task.title,
        subtitle: task.subtitle,
        amountMinor: task.amountMinor?.toString() ?? null,
        requestedAt: task.requestedAt.toISOString(),
        employee: task.subjectEmployee,
        detail,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /approvals/:id/decide                                        */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/approvals/:id/decide',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);

      const task = await db.approvalTask.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          assigneeEmployeeId: principal.employeeId ?? '',
        },
        select: { id: true, kind: true, status: true, subjectId: true },
      });

      if (!task) throw notFound('That approval');
      if (task.status !== 'PENDING') {
        throw new AppError(
          409,
          ERROR_CODES.CONFLICT,
          'This has already been decided. Reload to see the outcome.',
        );
      }

      switch (task.kind) {
        case 'LEAVE_REQUEST': {
          assertPermission(principal, 'leave:decide', 'DIRECT_REPORTS');
          const body = leaveDecision.parse(request.body);

          await db.$transaction((tx) =>
            decideLeaveRequest(
              tx,
              principal,
              {
                requestId: task.subjectId,
                event: body.decision,
                note: body.note ?? null,
                ip: request.context.ip ?? null,
              },
              env.AUDIT_HMAC_KEY,
            ),
          );
          return { decided: body.decision };
        }

        case 'EXPENSE_CLAIM': {
          assertPermission(principal, 'expense:decide', 'DIRECT_REPORTS');
          const body = expenseDecision.parse(request.body);

          // A manager approves the business purpose. The amount payable is
          // Accounts' to set, so an approved amount sent here is ignored
          // rather than silently honoured.
          await db.$transaction((tx) =>
            decideExpenseClaimAsManager(
              tx,
              principal,
              {
                claimId: task.subjectId,
                approve: body.decision === 'APPROVE',
                note: body.note ?? null,
                ip: request.context.ip ?? null,
              },
              env.AUDIT_HMAC_KEY,
            ),
          );
          return { decided: body.decision };
        }

        default:
          throw new AppError(
            409,
            ERROR_CODES.CONFLICT,
            'This kind of approval is decided on its own screen.',
            { meta: { kind: task.kind } },
          );
      }
    },
  );
}

async function leaveDetail(db: App['db'], organizationId: string, id: string) {
  const leave = await db.leaveRequest.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      status: true,
      startDate: true,
      endDate: true,
      startPortion: true,
      endPortion: true,
      workingDays: true,
      reason: true,
      leaveType: { select: { name: true, code: true, isPaid: true } },
      days: { orderBy: { date: 'asc' }, select: { date: true, portion: true } },
      employee: {
        select: {
          leaveBalances: {
            where: { period: { isClosed: false } },
            select: {
              availableDays: true,
              entitlementDays: true,
              leaveType: { select: { code: true, name: true } },
            },
          },
        },
      },
    },
  });

  if (!leave) return null;

  return {
    kind: 'leave' as const,
    status: leave.status,
    startDate: toIsoDate(leave.startDate),
    endDate: toIsoDate(leave.endDate),
    startPortion: leave.startPortion,
    endPortion: leave.endPortion,
    workingDays: Number(leave.workingDays),
    reason: leave.reason,
    type: leave.leaveType,
    days: leave.days.map((day) => ({ date: toIsoDate(day.date), portion: day.portion })),
    // What the decision costs them, so a manager is not approving blind.
    balances: leave.employee.leaveBalances.map((balance) => ({
      code: balance.leaveType.code,
      name: balance.leaveType.name,
      availableDays: Number(balance.availableDays),
      entitlementDays: Number(balance.entitlementDays),
    })),
  };
}

async function expenseDetail(db: App['db'], organizationId: string, id: string) {
  const claim = await db.expenseClaim.findFirst({
    where: { id, organizationId },
    select: {
      id: true,
      reference: true,
      title: true,
      status: true,
      totalAmountMinor: true,
      spendDate: true,
      lines: {
        orderBy: { spendDate: 'asc' },
        select: {
          id: true,
          description: true,
          spendDate: true,
          amountMinor: true,
          category: { select: { name: true } },
        },
      },
      attachments: { select: { id: true, file: { select: { displayFilename: true } } } },
    },
  });

  if (!claim) return null;

  return {
    kind: 'expense' as const,
    reference: claim.reference,
    title: claim.title,
    status: claim.status,
    totalAmountMinor: claim.totalAmountMinor.toString(),
    spendDate: toIsoDate(claim.spendDate),
    lines: claim.lines.map((line) => ({
      id: line.id,
      description: line.description,
      spendDate: toIsoDate(line.spendDate),
      amountMinor: line.amountMinor.toString(),
      category: line.category.name,
    })),
    attachments: claim.attachments.map((attachment) => ({
      id: attachment.id,
      filename: attachment.file.displayFilename,
    })),
  };
}
