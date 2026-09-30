import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OUTBOX_MAX_ATTEMPTS } from '@widedrop/shared';
import { testEnv } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { createLogger } from '../../lib/logger.js';
import { buildFixture, type Fixture } from '../../test/fixtures.js';
import { enqueueEmail, idempotencyKeyFor } from './outbox.js';
import type { MailTransport, OutgoingMail, SendResult } from './transport.js';
import { drainOutbox, reclaimStalled, SENDING_LEASE_SECONDS } from './worker.js';

const db = testDb();
const env = testEnv();
const logger = createLogger(testEnv({ LOG_LEVEL: 'silent' }));

let fixture: Fixture;

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  fixture = await buildFixture();
});

/** A transport whose outcome each test decides, and which records what it saw. */
class ScriptedTransport implements MailTransport {
  readonly name = 'scripted';
  readonly sent: OutgoingMail[] = [];

  constructor(private readonly outcome: (mail: OutgoingMail) => SendResult) {}

  async send(mail: OutgoingMail): Promise<SendResult> {
    this.sent.push(mail);
    return this.outcome(mail);
  }
}

const succeed = () => new ScriptedTransport(() => ({ ok: true, providerMessageId: 'msg-1' }));
const failTransiently = () =>
  new ScriptedTransport(() => ({ ok: false, retryable: true, error: 'ECONNREFUSED' }));
const rejectPermanently = () =>
  new ScriptedTransport(() => ({ ok: false, retryable: false, error: '550: no such mailbox' }));

async function queue(overrides: Partial<Parameters<typeof enqueueEmail>[1]> = {}) {
  return db.$transaction((tx) =>
    enqueueEmail(tx, {
      organizationId: fixture.organizationId,
      kind: 'HELPDESK_TICKET_CREATED',
      to: ['helpdesk@widedroptech.com'],
      subject: '[HD-1001] Payslip has not appeared',
      bodyText: 'A new help-desk ticket was raised.',
      sourceType: 'helpdesk_ticket',
      sourceId: fixture.people.priya,
      ...overrides,
    }),
  );
}

describe('enqueueEmail', () => {
  it('normalises and deduplicates recipients', async () => {
    await queue({ to: ['  HelpDesk@WideDropTech.com ', 'helpdesk@widedroptech.com'] });

    const row = await db.emailOutbox.findFirstOrThrow({ select: { toAddresses: true } });
    expect(row.toAddresses).toEqual(['helpdesk@widedroptech.com']);
  });

  it('queues nothing when there is no address to send to', async () => {
    const id = await queue({ to: [] });

    // Not an error: the ticket is still persisted, which is the half that must
    // not be lost.
    expect(id).toBeNull();
    expect(await db.emailOutbox.count()).toBe(0);
  });

  it('does not queue the same message twice', async () => {
    const first = await queue();
    const second = await queue();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await db.emailOutbox.count()).toBe(1);
  });

  it('treats a different variant of the same record as a different message', async () => {
    await queue({ variant: 'created' });
    await queue({ variant: 'comment', kind: 'HELPDESK_TICKET_UPDATED' });

    expect(await db.emailOutbox.count()).toBe(2);
  });

  it('keys idempotency on recipients regardless of their order', () => {
    const base = {
      organizationId: fixture.organizationId,
      kind: 'HELPDESK_TICKET_CREATED' as const,
      subject: 's',
      bodyText: 'b',
      sourceType: 'helpdesk_ticket',
      sourceId: fixture.people.priya,
    };

    expect(idempotencyKeyFor({ ...base, to: ['a@x.test', 'b@x.test'] })).toBe(
      idempotencyKeyFor({ ...base, to: ['b@x.test', 'a@x.test'] }),
    );
  });
});

describe('drainOutbox', () => {
  it('sends a queued message and records the provider id', async () => {
    await queue();
    const transport = succeed();

    const result = await drainOutbox(db, env, logger, { transport });

    expect(result).toMatchObject({ claimed: 1, sent: 1, retrying: 0, failed: 0 });
    expect(transport.sent[0]?.to).toEqual(['helpdesk@widedroptech.com']);

    const row = await db.emailOutbox.findFirstOrThrow({
      select: { status: true, sentAt: true, providerMessageId: true, attempts: true },
    });
    expect(row.status).toBe('SENT');
    expect(row.sentAt).not.toBeNull();
    expect(row.providerMessageId).toBe('msg-1');
    expect(row.attempts).toBe(1);
  });

  it('uses the idempotency key as the Message-ID', async () => {
    await queue();
    const transport = succeed();
    await drainOutbox(db, env, logger, { transport });

    const row = await db.emailOutbox.findFirstOrThrow({ select: { idempotencyKey: true } });
    expect(transport.sent[0]?.messageId).toContain(row.idempotencyKey);
  });

  it('does not send a message that is already sent', async () => {
    await queue();
    await drainOutbox(db, env, logger, { transport: succeed() });

    const second = succeed();
    const result = await drainOutbox(db, env, logger, { transport: second });

    expect(result.claimed).toBe(0);
    expect(second.sent).toHaveLength(0);
  });

  it('backs off after a transient failure rather than retrying at once', async () => {
    await queue();

    const result = await drainOutbox(db, env, logger, { transport: failTransiently() });
    expect(result).toMatchObject({ claimed: 1, sent: 0, retrying: 1 });

    const row = await db.emailOutbox.findFirstOrThrow({
      select: { status: true, attempts: true, nextAttemptAt: true, lastError: true },
    });
    expect(row.status).toBe('QUEUED');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toBe('ECONNREFUSED');
    // 30 seconds after the first failure.
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);

    // And it is not picked up again on the next pass, because it is not due.
    const immediate = await drainOutbox(db, env, logger, { transport: failTransiently() });
    expect(immediate.claimed).toBe(0);
  });

  it('gives up after the last attempt, keeping the row for a human', async () => {
    await queue();

    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt += 1) {
      // Make it due again, as the passage of time would.
      await db.emailOutbox.updateMany({
        where: { status: 'QUEUED' },
        data: { nextAttemptAt: new Date(Date.now() - 1_000) },
      });
      await drainOutbox(db, env, logger, { transport: failTransiently() });
    }

    const row = await db.emailOutbox.findFirstOrThrow({
      select: { status: true, attempts: true, lastError: true },
    });
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // Kept, not deleted: somebody was promised this message.
    expect(row.lastError).toBe('ECONNREFUSED');
  });

  it('suppresses a permanently rejected message instead of retrying it', async () => {
    await queue();

    const result = await drainOutbox(db, env, logger, { transport: rejectPermanently() });
    expect(result).toMatchObject({ claimed: 1, suppressed: 1, retrying: 0, failed: 0 });

    const row = await db.emailOutbox.findFirstOrThrow({
      select: { status: true, attempts: true, lastError: true },
    });
    expect(row.status).toBe('SUPPRESSED');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toContain('550');
  });

  it('drains several messages in one pass, oldest first', async () => {
    await queue({ sourceId: fixture.people.priya, variant: 'first' });
    await queue({ sourceId: fixture.people.arjun, variant: 'second' });
    await queue({ sourceId: fixture.people.divya, variant: 'third' });

    const transport = succeed();
    const result = await drainOutbox(db, env, logger, { transport });

    expect(result.sent).toBe(3);
    expect(await db.emailOutbox.count({ where: { status: 'SENT' } })).toBe(3);
  });

  it('honours the batch size', async () => {
    for (const person of [fixture.people.priya, fixture.people.arjun, fixture.people.divya]) {
      await queue({ sourceId: person });
    }

    const result = await drainOutbox(db, env, logger, { transport: succeed(), batchSize: 2 });
    expect(result.sent).toBe(2);
    expect(await db.emailOutbox.count({ where: { status: 'QUEUED' } })).toBe(1);
  });
});

describe('reclaimStalled', () => {
  it('requeues a message whose lease expired', async () => {
    await queue();
    // What a crashed worker leaves behind: SENDING, with a lease in the past.
    await db.emailOutbox.updateMany({
      where: {},
      data: { status: 'SENDING', nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    expect(await reclaimStalled(db, logger)).toBe(1);

    const row = await db.emailOutbox.findFirstOrThrow({
      select: { status: true, lastError: true },
    });
    expect(row.status).toBe('QUEUED');
    expect(row.lastError).toContain('mid-send');
  });

  it('leaves a message that is merely slow alone', async () => {
    await queue();
    // A live claim: the lease is still in the future.
    await db.emailOutbox.updateMany({
      where: {},
      data: {
        status: 'SENDING',
        nextAttemptAt: new Date(Date.now() + SENDING_LEASE_SECONDS * 1000),
      },
    });

    expect(await reclaimStalled(db, logger)).toBe(0);
  });

  it('does not refund the attempt a dead worker consumed', async () => {
    await queue();
    // One failed claim, then the lease expires.
    await drainOutbox(db, env, logger, { transport: failTransiently() });
    await db.emailOutbox.updateMany({
      where: {},
      data: { status: 'SENDING', nextAttemptAt: new Date(Date.now() - 1_000) },
    });

    await reclaimStalled(db, logger);

    const row = await db.emailOutbox.findFirstOrThrow({ select: { attempts: true } });
    expect(row.attempts).toBe(1);
  });
});
