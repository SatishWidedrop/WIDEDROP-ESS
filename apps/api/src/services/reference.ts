import type { Tx } from '../lib/prisma.js';

/**
 * Human-facing references — `HD-4821`, `EXP-2291`.
 *
 * A reference is quoted in emails, approval notifications and conversations
 * with the help desk, so it must be short, unique within the organisation and
 * stable once issued.
 *
 * Allocation takes a transaction-scoped advisory lock on the organisation and
 * prefix, then reads the highest number already issued. Two concurrent
 * submissions therefore queue rather than racing to the same number, and the
 * lock is released on commit or rollback with no cleanup path to forget.
 *
 * The number comes from the data rather than a database sequence on purpose: a
 * sequence advances on a rolled-back transaction, which would leave visible
 * gaps in a series people read as a count.
 */
export async function allocateReference(
  tx: Tx,
  input: {
    organizationId: string;
    /** `HD`, `EXP`, `RB` — the letters before the dash. */
    prefix: string;
    /** The highest reference already issued for this prefix, or null. */
    readHighest: () => Promise<string | null>;
    /** Where the series starts when nothing has been issued yet. */
    start?: number;
  },
): Promise<string> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`reference:${input.organizationId}:${input.prefix}`}))
  `;

  const highest = await input.readHighest();
  const current = highest ? Number.parseInt(highest.replace(/^\D+-?/, ''), 10) : Number.NaN;
  const next = Number.isFinite(current) ? current + 1 : (input.start ?? 1001);

  return `${input.prefix}-${next}`;
}

/** The next help-desk ticket reference for an organisation. */
export async function nextTicketReference(tx: Tx, organizationId: string): Promise<string> {
  return allocateReference(tx, {
    organizationId,
    prefix: 'HD',
    start: 1001,
    readHighest: async () => {
      const latest = await tx.helpdeskTicket.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: { reference: true },
      });
      return latest?.reference ?? null;
    },
  });
}

/** The next expense claim reference for an organisation. */
export async function nextExpenseReference(tx: Tx, organizationId: string): Promise<string> {
  return allocateReference(tx, {
    organizationId,
    prefix: 'EXP',
    start: 1001,
    readHighest: async () => {
      const latest = await tx.expenseClaim.findFirst({
        where: { organizationId },
        orderBy: { createdAt: 'desc' },
        select: { reference: true },
      });
      return latest?.reference ?? null;
    },
  });
}
