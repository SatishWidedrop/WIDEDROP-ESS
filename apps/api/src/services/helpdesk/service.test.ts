import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runWithContext } from '../../lib/request-context.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, HMAC_KEY, type Fixture } from '../../test/fixtures.js';
import { addTicketComment, createTicket, transitionTicket } from './service.js';

const db = testDb();
let fixture: Fixture;

const OPTIONS = {
  helpdeskEmail: 'helpdesk@widedroptech.com',
  webUrl: 'https://ess.widedrop.com',
  hmacKey: HMAC_KEY,
};

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

async function as<T>(
  principal: { userId: string; organizationId: string; employeeId?: string | undefined },
  fn: () => Promise<T>,
): Promise<T> {
  return runWithContext(
    {
      requestId: 'test',
      startedAt: Date.now(),
      userId: principal.userId,
      organizationId: principal.organizationId,
      employeeId: principal.employeeId,
      personas: ['EMPLOYEE'],
      ip: '127.0.0.1',
    },
    fn,
  );
}

function raise(subject = 'Payslip for August has not appeared') {
  return as(fixture.principals.employee, () =>
    db.$transaction((tx) =>
      createTicket(
        tx,
        fixture.principals.employee,
        {
          ticketCategoryId: fixture.ticketCategoryId,
          subject,
          description: 'My August payslip is not in the portal and payroll has been published.',
        },
        OPTIONS,
      ),
    ),
  );
}

describe('createTicket', () => {
  it('persists the ticket and queues the help-desk notification together', async () => {
    const ticket = await raise();

    const stored = await db.helpdeskTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { reference: true, status: true, requesterEmployeeId: true },
    });
    expect(stored.status).toBe('OPEN');
    expect(stored.requesterEmployeeId).toBe(fixture.people.priya);

    const outbox = await db.emailOutbox.findMany({
      where: { sourceType: 'helpdesk_ticket', sourceId: ticket.id },
      select: { toAddresses: true, subject: true, bodyText: true, status: true, replyTo: true },
    });

    expect(outbox).toHaveLength(1);
    // The requirement names this address explicitly.
    expect(outbox[0]?.toAddresses).toContain('helpdesk@widedroptech.com');
    // The category's own queue is notified alongside it, not instead of it.
    expect(outbox[0]?.toAddresses).toContain('payroll@widedroptech.com');
    expect(outbox[0]?.status).toBe('QUEUED');
    expect(outbox[0]?.subject).toContain(stored.reference);
    expect(outbox[0]?.bodyText).toContain('Priya Raghavan');
    expect(outbox[0]?.replyTo).toBe('priya.raghavan@widedrop.test');

    expect(ticket.notificationQueued).toBe(true);
  });

  it('rolls the queued email back with the ticket when the transaction fails', async () => {
    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction(async (tx) => {
          await createTicket(
            tx,
            fixture.principals.employee,
            {
              ticketCategoryId: fixture.ticketCategoryId,
              subject: 'This will not survive',
              description: 'The transaction is about to fail after the ticket is written.',
            },
            OPTIONS,
          );
          throw new Error('something later in the request failed');
        }),
      ),
    ).rejects.toThrow('something later in the request failed');

    // Neither half exists: no orphaned ticket, and no email promising one.
    expect(await db.helpdeskTicket.count()).toBe(0);
    expect(await db.emailOutbox.count()).toBe(0);
  });

  it('derives the SLA due times from the category and the creation time', async () => {
    const ticket = await raise();

    const stored = await db.helpdeskTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { createdAt: true, firstResponseDueAt: true, resolutionDueAt: true },
    });

    // The fixture's category promises 8 hours to first reply, 48 to resolve.
    expect(stored.firstResponseDueAt!.getTime() - stored.createdAt.getTime()).toBe(8 * 3_600_000);
    expect(stored.resolutionDueAt!.getTime() - stored.createdAt.getTime()).toBe(48 * 3_600_000);
  });

  it('issues sequential references within the organisation', async () => {
    const first = await raise('First');
    const second = await raise('Second');

    expect(first.reference).toBe('HD-1001');
    expect(second.reference).toBe('HD-1002');
  });

  it('records the raising in the audit trail', async () => {
    const ticket = await raise();

    const audit = await db.auditEvent.findFirstOrThrow({
      where: { entityType: 'helpdesk_ticket', entityId: ticket.id },
      select: { action: true, summary: true, actorUserId: true },
    });

    expect(audit.action).toBe('CREATE');
    expect(audit.summary).toContain(ticket.reference);
    expect(audit.actorUserId).toBe(fixture.principals.employee.userId);
  });
});

describe('ticket conversation', () => {
  it('stops the first-response clock on the first public reply from the help desk', async () => {
    const ticket = await raise();

    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        addTicketComment(
          tx,
          fixture.principals.hr,
          { ticketId: ticket.id, body: 'Looking into it now.', internal: false },
          OPTIONS,
        ),
      ),
    );

    const stored = await db.helpdeskTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { firstResponseAt: true },
    });
    expect(stored.firstResponseAt).not.toBeNull();
  });

  it('does not let the requester write an internal note', async () => {
    const ticket = await raise();

    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          addTicketComment(
            tx,
            fixture.principals.employee,
            { ticketId: ticket.id, body: 'Secret', internal: true },
            OPTIONS,
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('banks the paused time when the requester replies', async () => {
    const ticket = await raise();

    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        transitionTicket(
          tx,
          fixture.principals.hr,
          { ticketId: ticket.id, event: 'START' },
          { hmacKey: HMAC_KEY },
        ),
      ),
    );
    await as(fixture.principals.hr, () =>
      db.$transaction((tx) =>
        transitionTicket(
          tx,
          fixture.principals.hr,
          { ticketId: ticket.id, event: 'REQUEST_INFO' },
          { hmacKey: HMAC_KEY },
        ),
      ),
    );

    const paused = await db.helpdeskTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { status: true, pausedAt: true },
    });
    expect(paused.status).toBe('WAITING_ON_EMPLOYEE');
    expect(paused.pausedAt).not.toBeNull();

    const result = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        addTicketComment(
          tx,
          fixture.principals.employee,
          { ticketId: ticket.id, body: 'Here is the detail you asked for.', internal: false },
          OPTIONS,
        ),
      ),
    );

    expect(result.status).toBe('IN_PROGRESS');
    const resumed = await db.helpdeskTicket.findUniqueOrThrow({
      where: { id: ticket.id },
      select: { pausedAt: true },
    });
    expect(resumed.pausedAt).toBeNull();
  });

  it('refuses a transition the state machine does not allow', async () => {
    const ticket = await raise();

    await expect(
      as(fixture.principals.hr, () =>
        db.$transaction((tx) =>
          transitionTicket(
            tx,
            fixture.principals.hr,
            { ticketId: ticket.id, event: 'CLOSE' },
            { hmacKey: HMAC_KEY },
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVALID_STATE_TRANSITION' });
  });
});
