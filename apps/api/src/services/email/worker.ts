import { OUTBOX_MAX_ATTEMPTS, outboxRetryDelaySeconds } from '@widedrop/shared';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';
import type { Database } from '../../lib/prisma.js';
import { mailTransport, type MailTransport } from './transport.js';

/**
 * The outbox worker.
 *
 * Claims due messages with `FOR UPDATE SKIP LOCKED`, so several workers can
 * share the queue without two of them sending the same message. Each claim is
 * a separate short transaction: holding one open across an SMTP round-trip
 * would pin a database connection for the length of a network call.
 *
 * Delivery is at-least-once, so the message id sent to the provider is the
 * outbox row's idempotency key. A provider that deduplicates on Message-ID
 * therefore collapses a double send, and one that does not at least leaves the
 * duplicate traceable to its cause.
 *
 * Retries back off exponentially — 30s, 2m, 8m, 32m, 2h, 8h — and a message
 * that exhausts them is marked FAILED rather than dropped, because a help-desk
 * ticket nobody was told about is exactly the failure the transactional outbox
 * exists to prevent.
 */

/**
 * How long a claim is good for.
 *
 * A claim writes `next_attempt_at` this far ahead, which is the row's lease: a
 * worker that dies mid-send leaves a SENDING row whose lease expires, and
 * `reclaimStalled` requeues it. The lease is written rather than inferred from
 * `updated_at`, because a database trigger owns that column — nothing in the
 * application can set it, so nothing in the application should depend on its
 * value meaning "when we claimed this".
 *
 * Generous on purpose: a slow SMTP server is not a crashed worker, and sending
 * a message twice is worse than sending it ten minutes late.
 */
export const SENDING_LEASE_SECONDS = 600;

export interface DrainResult {
  claimed: number;
  sent: number;
  retrying: number;
  failed: number;
  suppressed: number;
}

export async function drainOutbox(
  db: Database,
  env: Env,
  logger: Logger,
  options: { batchSize?: number; workerId?: string; transport?: MailTransport } = {},
): Promise<DrainResult> {
  const batchSize = Math.min(options.batchSize ?? 25, 200);
  const transport = options.transport ?? mailTransport(env);

  const result: DrainResult = { claimed: 0, sent: 0, retrying: 0, failed: 0, suppressed: 0 };

  for (let processed = 0; processed < batchSize; processed += 1) {
    const claimed = await claimOne(db);
    if (!claimed) break;

    result.claimed += 1;

    const outcome = await transport.send({
      to: claimed.toAddresses,
      cc: claimed.ccAddresses,
      replyTo: claimed.replyTo,
      subject: claimed.subject,
      text: claimed.bodyText,
      html: claimed.bodyHtml,
      // The idempotency key, so a resend is recognisable as the same message.
      messageId: `${claimed.idempotencyKey}@${new URL(env.API_PUBLIC_URL).hostname}`,
    });

    if (outcome.ok) {
      await db.emailOutbox.update({
        where: { id: claimed.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: outcome.providerMessageId,
          lastError: null,
        },
      });
      result.sent += 1;
      logger.info(
        { outboxId: claimed.id, kind: claimed.kind, transport: transport.name },
        'email sent',
      );
      continue;
    }

    // A permanent rejection is not retried: sending the same message to the
    // same rejected address five more times changes nothing and delays
    // everything behind it.
    if (!outcome.retryable) {
      await db.emailOutbox.update({
        where: { id: claimed.id },
        data: { status: 'SUPPRESSED', lastError: outcome.error },
      });
      result.suppressed += 1;
      logger.error(
        { outboxId: claimed.id, kind: claimed.kind, reason: outcome.error },
        'email permanently rejected',
      );
      continue;
    }

    const attempts = claimed.attempts;
    const exhausted = attempts >= OUTBOX_MAX_ATTEMPTS;

    await db.emailOutbox.update({
      where: { id: claimed.id },
      data: exhausted
        ? { status: 'FAILED', lastError: outcome.error }
        : {
            status: 'QUEUED',
            lastError: outcome.error,
            nextAttemptAt: new Date(Date.now() + outboxRetryDelaySeconds(attempts) * 1000),
          },
    });

    if (exhausted) {
      result.failed += 1;
      // Loud, because this is a message somebody was promised. The row stays
      // for a human to look at; nothing is deleted.
      logger.error(
        {
          outboxId: claimed.id,
          kind: claimed.kind,
          sourceType: claimed.sourceType,
          sourceId: claimed.sourceId,
          attempts,
          reason: outcome.error,
        },
        'email failed after every attempt and needs attention',
      );
    } else {
      result.retrying += 1;
      logger.warn(
        { outboxId: claimed.id, attempts, reason: outcome.error },
        'email delivery failed; will retry',
      );
    }
  }

  return result;
}

interface ClaimedMessage {
  id: string;
  kind: string;
  toAddresses: string[];
  ccAddresses: string[];
  replyTo: string | null;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  sourceType: string;
  sourceId: string;
  idempotencyKey: string;
  attempts: number;
}

/**
 * Take one due message.
 *
 * `SKIP LOCKED` is what makes several workers safe: a row another worker has
 * claimed is passed over rather than waited on. `attempts` is incremented as
 * part of the claim, so a worker that crashes mid-send has still consumed an
 * attempt and cannot loop forever on a message that kills it.
 */
async function claimOne(db: Database): Promise<ClaimedMessage | null> {
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id
        FROM ess_ops.email_outbox
       WHERE status = 'QUEUED'
         AND next_attempt_at <= now()
       ORDER BY next_attempt_at ASC
       LIMIT 1
         FOR UPDATE SKIP LOCKED
    `;

    const id = rows[0]?.id;
    if (!id) return null;

    const claimed = await tx.emailOutbox.update({
      where: { id },
      data: {
        status: 'SENDING',
        attempts: { increment: 1 },
        // The lease. Expires if this worker never comes back.
        nextAttemptAt: new Date(Date.now() + SENDING_LEASE_SECONDS * 1000),
      },
      select: {
        id: true,
        kind: true,
        toAddresses: true,
        ccAddresses: true,
        replyTo: true,
        subject: true,
        bodyText: true,
        bodyHtml: true,
        sourceType: true,
        sourceId: true,
        idempotencyKey: true,
        attempts: true,
      },
    });

    return claimed;
  });
}

/**
 * Reclaim messages whose lease has expired.
 *
 * Without this a worker killed between the claim and the update would park its
 * message forever. The attempt it consumed is not refunded: a message that
 * reliably kills its worker must not retry indefinitely.
 */
export async function reclaimStalled(db: Database, logger: Logger): Promise<number> {
  const result = await db.emailOutbox.updateMany({
    where: { status: 'SENDING', nextAttemptAt: { lt: new Date() } },
    data: {
      status: 'QUEUED',
      nextAttemptAt: new Date(),
      lastError: 'a worker stopped mid-send; requeued',
    },
  });

  if (result.count > 0) {
    logger.warn({ count: result.count }, 'requeued stalled outbox messages');
  }
  return result.count;
}

/**
 * Run the worker until the process is asked to stop.
 *
 * A single loop with a poll interval rather than a scheduler: the outbox is the
 * only queue, the volume is a few hundred messages a day, and a dependency on
 * Redis for this would be a dependency to operate for no gain.
 */
export function startOutboxWorker(
  db: Database,
  env: Env,
  logger: Logger,
): { stop: () => Promise<void> } {
  const workerLogger = logger.child({ worker: 'email-outbox' });
  let running = true;
  let currentRun: Promise<unknown> = Promise.resolve();

  const loop = async (): Promise<void> => {
    workerLogger.info(
      { driver: env.MAIL_DRIVER, pollMs: env.WORKER_POLL_INTERVAL_MS },
      'outbox worker started',
    );

    while (running) {
      try {
        await reclaimStalled(db, workerLogger);
        const result = await drainOutbox(db, env, workerLogger);
        if (result.claimed > 0) {
          workerLogger.info(result, 'outbox drained');
        }
      } catch (error) {
        // A failure here is the worker's, not a message's. It sleeps and tries
        // again rather than exiting, so a transient database blip does not stop
        // mail for the rest of the deployment's life.
        workerLogger.error({ err: error }, 'outbox drain failed');
      }

      await sleep(env.WORKER_POLL_INTERVAL_MS, () => running);
    }

    workerLogger.info('outbox worker stopped');
  };

  currentRun = loop();

  return {
    async stop() {
      running = false;
      await currentRun;
    },
  };
}

/** Sleep, waking early if the caller says to stop. */
async function sleep(ms: number, stillRunning: () => boolean): Promise<void> {
  const step = 250;
  for (let waited = 0; waited < ms; waited += step) {
    if (!stillRunning()) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(step, ms - waited)));
  }
}
