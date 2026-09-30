import {
  EXPENSE_STATES_AWAITING_DECISION,
  EXPENSE_STATES_AWAITING_PAYMENT,
  expenseClaimMachine,
  financialYearOf,
  toIsoDate,
  type ExpenseClaimEvent,
  type ExpenseClaimState,
  type IsoDate,
} from '@widedrop/shared';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import { cancelApprovalTasks, openApprovalTask, settleApprovalTask } from '../approvals.js';
import { notifyEmployee } from '../notifications.js';
import { nextExpenseReference } from '../reference.js';
import { primaryManagerOn } from '../leave/service.js';

/**
 * Expenses.
 *
 * A claim moves employee → manager → Accounts → a reimbursement batch that a
 * payroll cycle pays. Each hop is a state transition with a recorded decision,
 * so "paid with September salary" is a row that names the cycle rather than a
 * caption on a screen.
 *
 * The total is always the sum of the lines, written in the same transaction as
 * the lines. A client cannot post a total, and the year-to-date tiles read a
 * rollup maintained here rather than summing claims at render time.
 */

export interface ClaimLineInput {
  expenseCategoryId: string;
  description: string;
  spendDate: IsoDate;
  amountMinor: bigint;
}

/* ------------------------------------------------------------------ */
/* Creation and submission                                             */
/* ------------------------------------------------------------------ */

export async function createExpenseClaim(
  tx: Tx,
  principal: Principal,
  input: { title: string; lines: ClaimLineInput[] },
  hmacKey: string,
): Promise<{ id: string; reference: string; totalAmountMinor: bigint }> {
  const employeeId = principal.employeeId;
  if (!employeeId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'This account is not linked to an employee.');
  }
  if (input.lines.length === 0) {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'A claim needs at least one line.');
  }

  const categories = await tx.expenseCategory.findMany({
    where: {
      organizationId: principal.organizationId,
      isActive: true,
      id: { in: [...new Set(input.lines.map((line) => line.expenseCategoryId))] },
    },
    select: { id: true, name: true, submissionWindowDays: true, requiresReceipt: true },
  });
  const categoryById = new Map(categories.map((category) => [category.id, category]));

  const today = toIsoDate(new Date());

  for (const line of input.lines) {
    const category = categoryById.get(line.expenseCategoryId);
    if (!category) throw notFound('One of the expense categories');

    if (line.spendDate > today) {
      throw new AppError(
        422,
        ERROR_CODES.BUSINESS_RULE_VIOLATION,
        'An expense cannot be dated in the future.',
      );
    }

    const ageDays = Math.floor(
      (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${line.spendDate}T00:00:00Z`)) / 86_400_000,
    );
    if (ageDays > category.submissionWindowDays) {
      throw new AppError(
        422,
        ERROR_CODES.BUSINESS_RULE_VIOLATION,
        `${category.name} must be claimed within ${category.submissionWindowDays} days of the spend. That one is ${ageDays} days old.`,
      );
    }

    if (line.amountMinor <= 0n) {
      throw new AppError(
        400,
        ERROR_CODES.VALIDATION_FAILED,
        'A claim line must be more than zero.',
      );
    }
  }

  const total = input.lines.reduce((sum, line) => sum + line.amountMinor, 0n);

  // The spend date of the claim is its earliest line: what the expense policy
  // window and the reimbursement cutoff are measured against.
  const spendDate = input.lines
    .map((line) => line.spendDate)
    .reduce((earliest, date) => (date < earliest ? date : earliest));

  const reference = await nextExpenseReference(tx, principal.organizationId);

  const claim = await tx.expenseClaim.create({
    data: {
      organizationId: principal.organizationId,
      employeeId,
      reference,
      title: input.title,
      status: 'DRAFT',
      totalAmountMinor: total,
      spendDate: new Date(spendDate),
      lines: {
        create: input.lines.map((line) => ({
          organizationId: principal.organizationId,
          expenseCategoryId: line.expenseCategoryId,
          description: line.description,
          spendDate: new Date(line.spendDate),
          amountMinor: line.amountMinor,
        })),
      },
    },
    select: { id: true, reference: true, totalAmountMinor: true },
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'CREATE',
      entityType: 'expense_claim',
      entityId: claim.id,
      toState: 'DRAFT',
      after: { reference: claim.reference, totalAmountMinor: total.toString() },
      summary: `Created expense claim ${claim.reference}`,
    },
    hmacKey,
  );

  await refreshExpenseRollup(tx, principal.organizationId, employeeId, spendDate);

  return claim;
}

export async function submitExpenseClaim(
  tx: Tx,
  principal: Principal,
  input: { claimId: string },
  hmacKey: string,
): Promise<void> {
  const claim = await lockClaim(tx, principal.organizationId, input.claimId);

  if (claim.employeeId !== principal.employeeId) {
    throw new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'That claim is not yours.');
  }
  // Two transitions, applied together: SUBMIT records the employee's act and
  // ROUTE_TO_MANAGER is what the system does with it. Neither is a state a
  // person waits in, so the claim lands on PENDING_MANAGER in one write.
  assertTransition(claim.status, 'SUBMIT');
  assertTransition('SUBMITTED', 'ROUTE_TO_MANAGER');

  const missingReceipt = await claimMissingReceipt(tx, claim.id);
  if (missingReceipt) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      `${missingReceipt} needs a receipt attached before this claim can be submitted.`,
    );
  }

  const approverEmployeeId = await primaryManagerOn(tx, {
    organizationId: principal.organizationId,
    employeeId: claim.employeeId,
    on: toIsoDate(new Date()),
  });
  if (!approverEmployeeId) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'You do not have a manager assigned, so this claim has nobody to approve it. Raise a help-desk ticket and People Ops will set one.',
    );
  }

  const submittedAt = new Date();

  await tx.expenseClaim.update({
    where: { id: claim.id },
    data: {
      status: 'PENDING_MANAGER',
      submittedAt,
      approverEmployeeId,
      rowVersion: { increment: 1 },
    },
  });

  await openApprovalTask(tx, {
    organizationId: principal.organizationId,
    kind: 'EXPENSE_CLAIM',
    subjectType: 'expense_claim',
    subjectId: claim.id,
    subjectEmployeeId: claim.employeeId,
    assigneeEmployeeId: approverEmployeeId,
    title: `${claim.title} · ${claim.employee.fullName}`,
    subtitle: `${claim.reference} · spent ${toIsoDate(claim.spendDate)}`,
    amountMinor: claim.totalAmountMinor,
    requestedAt: submittedAt,
  });

  await notifyEmployee(tx, {
    organizationId: principal.organizationId,
    employeeId: approverEmployeeId,
    kind: 'EXPENSE_SUBMITTED',
    tone: 'BLUE',
    title: `${claim.employee.fullName} submitted ${claim.reference}`,
    body: claim.title,
    targetModule: 'approvals',
    targetId: claim.id,
    sourceType: 'expense_claim',
    sourceId: claim.id,
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'expense_claim',
      entityId: claim.id,
      fromState: claim.status,
      toState: 'PENDING_MANAGER',
      summary: `Submitted expense claim ${claim.reference}`,
    },
    hmacKey,
  );

  await refreshExpenseRollup(
    tx,
    principal.organizationId,
    claim.employeeId,
    toIsoDate(claim.spendDate),
  );
}

export async function withdrawExpenseClaim(
  tx: Tx,
  principal: Principal,
  input: { claimId: string },
  hmacKey: string,
): Promise<void> {
  const claim = await lockClaim(tx, principal.organizationId, input.claimId);

  if (claim.employeeId !== principal.employeeId) {
    throw new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'That claim is not yours.');
  }
  assertTransition(claim.status, 'WITHDRAW');

  await tx.expenseClaim.update({
    where: { id: claim.id },
    data: { status: 'WITHDRAWN', withdrawnAt: new Date(), rowVersion: { increment: 1 } },
  });

  await cancelApprovalTasks(tx, {
    organizationId: principal.organizationId,
    subjectType: 'expense_claim',
    subjectId: claim.id,
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'expense_claim',
      entityId: claim.id,
      fromState: claim.status,
      toState: 'WITHDRAWN',
      summary: `Withdrew expense claim ${claim.reference}`,
    },
    hmacKey,
  );

  await refreshExpenseRollup(
    tx,
    principal.organizationId,
    claim.employeeId,
    toIsoDate(claim.spendDate),
  );
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

/** The manager's decision. Approving sends it on to Accounts, not to payment. */
export async function decideExpenseClaimAsManager(
  tx: Tx,
  principal: Principal,
  input: { claimId: string; approve: boolean; note?: string | null; ip?: string | null },
  hmacKey: string,
): Promise<void> {
  const claim = await lockClaim(tx, principal.organizationId, input.claimId);

  if (claim.approverEmployeeId !== principal.employeeId) {
    throw new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'This claim was not routed to you.');
  }
  assertTransition(claim.status, input.approve ? 'MANAGER_APPROVE' : 'MANAGER_REJECT');
  if (input.approve) assertTransition('MANAGER_APPROVED', 'ROUTE_TO_FINANCE');

  // An approval moves straight on to Accounts: MANAGER_APPROVED is a moment,
  // not a queue anybody works.
  const next: ExpenseClaimState = input.approve ? 'PENDING_FINANCE' : 'MANAGER_REJECTED';

  await tx.expenseClaim.update({
    where: { id: claim.id },
    data: {
      status: next,
      managerDecidedAt: new Date(),
      managerDecidedByUserId: principal.userId,
      managerNote: input.note ?? null,
      rowVersion: { increment: 1 },
    },
  });

  await settleApprovalTask(tx, {
    organizationId: principal.organizationId,
    subjectType: 'expense_claim',
    subjectId: claim.id,
    outcome: input.approve ? 'APPROVED' : 'REJECTED',
    status: input.approve ? 'APPROVED' : 'REJECTED',
    decidedByUserId: principal.userId,
    decidedByEmployeeId: principal.employeeId ?? null,
    note: input.note ?? null,
    ip: input.ip ?? null,
  });

  await notifyEmployee(tx, {
    organizationId: principal.organizationId,
    employeeId: claim.employeeId,
    kind: 'EXPENSE_DECIDED',
    tone: input.approve ? 'BLUE' : 'RED',
    title: `${claim.reference} ${input.approve ? 'approved by your manager' : 'declined'}`,
    body: input.approve
      ? 'Accounts will review it before it is paid.'
      : (input.note ?? claim.title),
    targetModule: 'expenses',
    targetId: claim.id,
    sourceType: 'expense_claim_manager',
    sourceId: claim.id,
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'expense_claim',
      entityId: claim.id,
      fromState: claim.status,
      toState: next,
      summary: `${input.approve ? 'Approved' : 'Declined'} ${claim.reference} for ${claim.employee.fullName}`,
      after: { note: input.note ?? null },
    },
    hmacKey,
  );

  await refreshExpenseRollup(
    tx,
    principal.organizationId,
    claim.employeeId,
    toIsoDate(claim.spendDate),
  );
}

/**
 * Accounts' decision.
 *
 * `approvedAmountMinor` may be less than claimed where a cap applied, and the
 * reason is stored on the line so the employee is told why rather than
 * discovering a smaller number.
 */
export async function decideExpenseClaimAsFinance(
  tx: Tx,
  principal: Principal,
  input: {
    claimId: string;
    approve: boolean;
    note?: string | null;
    approvedAmountMinor?: bigint | null;
    ip?: string | null;
  },
  hmacKey: string,
): Promise<void> {
  const claim = await lockClaim(tx, principal.organizationId, input.claimId);
  assertTransition(claim.status, input.approve ? 'FINANCE_APPROVE' : 'FINANCE_REJECT');

  const approvedAmount = input.approve
    ? (input.approvedAmountMinor ?? claim.totalAmountMinor)
    : null;

  if (approvedAmount !== null && (approvedAmount < 0n || approvedAmount > claim.totalAmountMinor)) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'The approved amount cannot be negative or exceed the amount claimed.',
    );
  }

  const next: ExpenseClaimState = input.approve ? 'FINANCE_APPROVED' : 'FINANCE_REJECTED';

  await tx.expenseClaim.update({
    where: { id: claim.id },
    data: {
      status: next,
      approvedAmountMinor: approvedAmount,
      financeDecidedAt: new Date(),
      financeDecidedByUserId: principal.userId,
      financeNote: input.note ?? null,
      rowVersion: { increment: 1 },
    },
  });

  await notifyEmployee(tx, {
    organizationId: principal.organizationId,
    employeeId: claim.employeeId,
    kind: 'EXPENSE_DECIDED',
    tone: input.approve ? 'GREEN' : 'RED',
    title: `${claim.reference} ${input.approve ? 'approved for payment' : 'declined by Accounts'}`,
    body: input.note ?? claim.title,
    targetModule: 'expenses',
    targetId: claim.id,
    sourceType: 'expense_claim_finance',
    sourceId: claim.id,
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'expense_claim',
      entityId: claim.id,
      fromState: claim.status,
      toState: next,
      summary: `Accounts ${input.approve ? 'approved' : 'declined'} ${claim.reference}`,
      after: {
        approvedAmountMinor: approvedAmount?.toString() ?? null,
        note: input.note ?? null,
      },
    },
    hmacKey,
  );

  await refreshExpenseRollup(
    tx,
    principal.organizationId,
    claim.employeeId,
    toIsoDate(claim.spendDate),
  );
}

/* ------------------------------------------------------------------ */
/* Rollup                                                              */
/* ------------------------------------------------------------------ */

/**
 * The three tiles on the Expenses screen.
 *
 * Recomputed from the claims themselves rather than incremented, so a rollup
 * cannot drift from the rows it summarises. The cost is one grouped query per
 * change, which is cheaper than the class of bug the alternative invites.
 */
export async function refreshExpenseRollup(
  tx: Tx,
  organizationId: string,
  employeeId: string,
  onDate: IsoDate,
): Promise<void> {
  const year = financialYearOf(onDate);

  const fiscalYear = await tx.fiscalYear.findFirst({
    where: { organizationId, startYear: year.startYear },
    select: { id: true, startDate: true, endDate: true },
  });
  if (!fiscalYear) return;

  const grouped = await tx.expenseClaim.groupBy({
    by: ['status'],
    where: {
      organizationId,
      employeeId,
      spendDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate },
    },
    _count: { _all: true },
    _sum: { totalAmountMinor: true, approvedAmountMinor: true },
  });

  const bucket = (statuses: ExpenseClaimState[]) =>
    grouped.filter((row) => statuses.includes(row.status as ExpenseClaimState));

  const sum = (rows: typeof grouped, field: 'totalAmountMinor' | 'approvedAmountMinor'): bigint =>
    rows.reduce((total, row) => total + (row._sum[field] ?? 0n), 0n);

  const count = (rows: typeof grouped): number =>
    rows.reduce((total, row) => total + row._count._all, 0);

  const pending = bucket([...EXPENSE_STATES_AWAITING_DECISION]);
  const approved = bucket([...EXPENSE_STATES_AWAITING_PAYMENT]);
  const reimbursed = bucket(['REIMBURSED']);
  const rejected = bucket(['MANAGER_REJECTED', 'FINANCE_REJECTED']);

  await tx.expenseFyRollup.upsert({
    where: { employeeId_fiscalYearId: { employeeId, fiscalYearId: fiscalYear.id } },
    update: {
      pendingCount: count(pending),
      pendingMinor: sum(pending, 'totalAmountMinor'),
      approvedCount: count(approved),
      approvedMinor: sum(approved, 'approvedAmountMinor') || sum(approved, 'totalAmountMinor'),
      reimbursedCount: count(reimbursed),
      reimbursedMinor:
        sum(reimbursed, 'approvedAmountMinor') || sum(reimbursed, 'totalAmountMinor'),
      rejectedCount: count(rejected),
    },
    create: {
      organizationId,
      employeeId,
      fiscalYearId: fiscalYear.id,
      pendingCount: count(pending),
      pendingMinor: sum(pending, 'totalAmountMinor'),
      approvedCount: count(approved),
      approvedMinor: sum(approved, 'approvedAmountMinor') || sum(approved, 'totalAmountMinor'),
      reimbursedCount: count(reimbursed),
      reimbursedMinor:
        sum(reimbursed, 'approvedAmountMinor') || sum(reimbursed, 'totalAmountMinor'),
      rejectedCount: count(rejected),
    },
  });
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

type LockedClaim = {
  id: string;
  organizationId: string;
  employeeId: string;
  reference: string;
  title: string;
  status: ExpenseClaimState;
  totalAmountMinor: bigint;
  spendDate: Date;
  approverEmployeeId: string | null;
  employee: { fullName: string };
};

async function lockClaim(tx: Tx, organizationId: string, claimId: string): Promise<LockedClaim> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ess.expense_claim
    WHERE id = ${claimId}::uuid AND organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  if (locked.length === 0) throw notFound('That expense claim');

  const claim = await tx.expenseClaim.findUniqueOrThrow({
    where: { id: claimId },
    select: {
      id: true,
      organizationId: true,
      employeeId: true,
      reference: true,
      title: true,
      status: true,
      totalAmountMinor: true,
      spendDate: true,
      approverEmployeeId: true,
      employee: { select: { fullName: true } },
    },
  });

  return claim as LockedClaim;
}

function assertTransition(from: ExpenseClaimState, event: ExpenseClaimEvent): void {
  if (!expenseClaimMachine.can(from, event)) {
    throw conflict(
      `A claim that is ${from.toLowerCase().replace(/_/g, ' ')} cannot take that action.`,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { from, event },
    );
  }
}

/** The first category on the claim that needs a receipt and has none attached. */
async function claimMissingReceipt(tx: Tx, claimId: string): Promise<string | null> {
  const [lines, attachmentCount] = await Promise.all([
    tx.expenseClaimLine.findMany({
      where: { expenseClaimId: claimId },
      select: { category: { select: { name: true, requiresReceipt: true } } },
    }),
    tx.expenseAttachment.count({ where: { expenseClaimId: claimId } }),
  ]);

  if (attachmentCount > 0) return null;
  return lines.find((line) => line.category.requiresReceipt)?.category.name ?? null;
}
