import type {
  ApprovalDecisionOutcome,
  ApprovalTaskKind,
  ApprovalTaskStatus,
} from '../generated/prisma/index.js';
import type { Tx } from '../lib/prisma.js';

/**
 * The manager's queue.
 *
 * Leave, expenses and attendance each create an `approval_task`, so the
 * Approvals badge is a count of rows and the queue is one indexed query rather
 * than three unions assembled in the browser.
 *
 * The display fields — title, subtitle, amount — are resolved from persisted
 * data at creation time. They are a cache of what the record said, not a
 * substitute for it: every decision re-reads the underlying record inside the
 * same transaction and re-checks the approver's scope before acting.
 */

export interface ApprovalTaskInput {
  organizationId: string;
  kind: ApprovalTaskKind;
  subjectType: string;
  subjectId: string;
  subjectEmployeeId: string;
  assigneeEmployeeId: string;
  title: string;
  subtitle?: string | null;
  amountMinor?: bigint | null;
  requestedAt: Date;
  dueAt?: Date | null;
}

/**
 * Create or revive the task for one record and one approver.
 *
 * Upsert rather than insert: a request that is withdrawn and resubmitted, or a
 * cycle whose attendance is returned and submitted again, is the same decision
 * for the same person. A second row would double the badge.
 */
export async function openApprovalTask(tx: Tx, input: ApprovalTaskInput): Promise<string> {
  const task = await tx.approvalTask.upsert({
    where: {
      subjectType_subjectId_assigneeEmployeeId: {
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        assigneeEmployeeId: input.assigneeEmployeeId,
      },
    },
    update: {
      status: 'PENDING',
      title: input.title,
      subtitle: input.subtitle ?? null,
      amountMinor: input.amountMinor ?? null,
      requestedAt: input.requestedAt,
      dueAt: input.dueAt ?? null,
      decidedAt: null,
    },
    create: {
      organizationId: input.organizationId,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      subjectEmployeeId: input.subjectEmployeeId,
      assigneeEmployeeId: input.assigneeEmployeeId,
      title: input.title,
      subtitle: input.subtitle ?? null,
      amountMinor: input.amountMinor ?? null,
      requestedAt: input.requestedAt,
      dueAt: input.dueAt ?? null,
    },
    select: { id: true },
  });

  return task.id;
}

/**
 * Record a decision and close the task.
 *
 * The decision row is append-only and keeps who decided, from where and why,
 * which is what an auditor asks for months later. Closing the task is a
 * separate field so the history survives the queue emptying.
 */
export async function settleApprovalTask(
  tx: Tx,
  input: {
    organizationId: string;
    subjectType: string;
    subjectId: string;
    assigneeEmployeeId?: string;
    outcome: ApprovalDecisionOutcome;
    status: ApprovalTaskStatus;
    decidedByUserId: string;
    decidedByEmployeeId?: string | null;
    note?: string | null;
    ip?: string | null;
  },
): Promise<void> {
  const tasks = await tx.approvalTask.findMany({
    where: {
      organizationId: input.organizationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: 'PENDING',
      ...(input.assigneeEmployeeId ? { assigneeEmployeeId: input.assigneeEmployeeId } : {}),
    },
    select: { id: true },
  });

  const decidedAt = new Date();

  for (const task of tasks) {
    await tx.approvalDecision.create({
      data: {
        organizationId: input.organizationId,
        approvalTaskId: task.id,
        outcome: input.outcome,
        decidedByUserId: input.decidedByUserId,
        decidedByEmployeeId: input.decidedByEmployeeId ?? null,
        note: input.note ?? null,
        ip: input.ip ?? null,
      },
    });

    await tx.approvalTask.update({
      where: { id: task.id },
      data: { status: input.status, decidedAt, rowVersion: { increment: 1 } },
    });
  }
}

/**
 * Cancel the outstanding tasks for a record without recording a decision —
 * what a withdrawal does. The task leaves the queue; no one is recorded as
 * having decided anything, because no one did.
 */
export async function cancelApprovalTasks(
  tx: Tx,
  input: { organizationId: string; subjectType: string; subjectId: string },
): Promise<void> {
  await tx.approvalTask.updateMany({
    where: {
      organizationId: input.organizationId,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      status: 'PENDING',
    },
    data: { status: 'WITHDRAWN', decidedAt: new Date() },
  });
}
