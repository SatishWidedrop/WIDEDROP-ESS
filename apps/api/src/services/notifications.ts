import type { NotificationKind, NotificationTone } from '../generated/prisma/index.js';
import type { Tx } from '../lib/prisma.js';

/**
 * In-portal notifications.
 *
 * Every notification names the persisted record that warrants it — `sourceType`
 * and `sourceId` — and the unique constraint over (user, source, kind) makes
 * the write idempotent. A retried transaction cannot produce a second copy, and
 * nothing here can say something the database does not hold.
 *
 * Written inside the same transaction as the change it announces, for the same
 * reason the audit row is: a notification that survives a rolled-back change
 * would be a claim about something that never happened.
 */

export interface NotificationInput {
  organizationId: string;
  /** The recipient's account. Resolve from an employee with `notifyEmployee`. */
  appUserId: string;
  kind: NotificationKind;
  tone?: NotificationTone;
  title: string;
  body?: string | null;
  /** Where a click goes: the nav id and the record within it. */
  targetModule?: string | null;
  targetId?: string | null;
  sourceType: string;
  sourceId: string;
}

export async function notify(tx: Tx, input: NotificationInput): Promise<void> {
  await tx.notification.upsert({
    where: {
      appUserId_sourceType_sourceId_kind: {
        appUserId: input.appUserId,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        kind: input.kind,
      },
    },
    // A repeat of the same event is not a new notification. The title is
    // refreshed because the underlying record may have been corrected.
    update: { title: input.title, body: input.body ?? null },
    create: {
      organizationId: input.organizationId,
      appUserId: input.appUserId,
      kind: input.kind,
      tone: input.tone ?? 'BLUE',
      title: input.title,
      body: input.body ?? null,
      targetModule: input.targetModule ?? null,
      targetId: input.targetId ?? null,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
    },
  });
}

/**
 * Notify the person behind an employee record.
 *
 * Silently does nothing when the employee has no portal account — a contractor
 * on the payroll who never signs in is a legitimate case, and failing the whole
 * transaction over an undeliverable notification would block the actual work.
 */
export async function notifyEmployee(
  tx: Tx,
  input: Omit<NotificationInput, 'appUserId'> & { employeeId: string },
): Promise<void> {
  const employee = await tx.employee.findFirst({
    where: {
      id: input.employeeId,
      organizationId: input.organizationId,
      appUser: { disabledAt: null },
    },
    select: { appUserId: true },
  });
  if (!employee?.appUserId) return;

  const { employeeId: _employeeId, ...rest } = input;
  await notify(tx, { ...rest, appUserId: employee.appUserId });
}
