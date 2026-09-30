import { createHash } from 'node:crypto';
import type { EmailKind } from '../../generated/prisma/index.js';
import type { Tx } from '../../lib/prisma.js';

/**
 * The transactional outbox.
 *
 * A message is written in the same transaction as the change that warrants it.
 * That is what makes the requirement "persist the ticket **and** send the
 * help-desk notification" safe: either both happen or neither does. A mail
 * outage delays delivery; it cannot lose the record, and it cannot leave a
 * ticket that nobody was told about.
 *
 * Delivery is at-least-once, so every message carries an idempotency key. The
 * worker refuses to send a key it has already sent.
 */

export interface EmailMessage {
  organizationId: string;
  kind: EmailKind;
  to: string[];
  cc?: string[];
  replyTo?: string | null;
  subject: string;
  /** Plain text is authoritative. HTML, when present, must say the same thing. */
  bodyText: string;
  bodyHtml?: string | null;
  sourceType: string;
  sourceId: string;
  /**
   * Distinguishes two messages about the same record — a ticket's creation
   * notice from its first reply. Defaults to the kind.
   */
  variant?: string;
}

export function idempotencyKeyFor(message: EmailMessage): string {
  const recipients = [...message.to].sort().join(',');
  return createHash('sha256')
    .update(
      [
        message.sourceType,
        message.sourceId,
        message.kind,
        message.variant ?? message.kind,
        recipients,
      ].join('|'),
    )
    .digest('hex')
    .slice(0, 48);
}

/**
 * Queue a message. Returns the row id, or null when an identical message is
 * already queued — which is not a failure: it means the notice this change
 * warrants is already on its way.
 */
export async function enqueueEmail(tx: Tx, message: EmailMessage): Promise<string | null> {
  const recipients = [...new Set(message.to.map((address) => address.trim().toLowerCase()))].filter(
    (address) => address.length > 0,
  );

  // Nothing to deliver is not an error. It is what happens when a category has
  // no routing address configured and the organisation has no help-desk
  // address either — the ticket is still persisted, which is the part that
  // must not be lost.
  if (recipients.length === 0) return null;

  const existing = await tx.emailOutbox.findUnique({
    where: { idempotencyKey: idempotencyKeyFor(message) },
    select: { id: true },
  });
  if (existing) return null;

  const row = await tx.emailOutbox.create({
    data: {
      organizationId: message.organizationId,
      kind: message.kind,
      toAddresses: recipients,
      ccAddresses: [
        ...new Set((message.cc ?? []).map((address) => address.trim().toLowerCase())),
      ].filter((address) => address.length > 0 && !recipients.includes(address)),
      replyTo: message.replyTo ?? null,
      subject: message.subject,
      bodyText: message.bodyText,
      bodyHtml: message.bodyHtml ?? null,
      sourceType: message.sourceType,
      sourceId: message.sourceId,
      idempotencyKey: idempotencyKeyFor(message),
    },
    select: { id: true },
  });

  return row.id;
}
