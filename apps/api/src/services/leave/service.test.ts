import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { runWithContext } from '../../lib/request-context.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, HMAC_KEY, type Fixture } from '../../test/fixtures.js';
import {
  decideLeaveRequest,
  resolveLeaveDays,
  submitLeaveRequest,
  withdrawLeaveRequest,
} from './service.js';

const db = testDb();
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

/** Run inside the request context the audit trail reads its actor from. */
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

async function balance(employeeId: string, leaveTypeId: string) {
  const row = await db.leaveBalance.findUniqueOrThrow({
    where: {
      employeeId_leaveTypeId_leavePeriodId: {
        employeeId,
        leaveTypeId,
        leavePeriodId: fixture.leavePeriodId,
      },
    },
    select: { availableDays: true, reservedDays: true, consumedDays: true },
  });
  return {
    available: Number(row.availableDays),
    reserved: Number(row.reservedDays),
    consumed: Number(row.consumedDays),
  };
}

describe('resolveLeaveDays', () => {
  it('drops weekends and holidays', () => {
    // Thu 1 Oct to Mon 5 Oct 2026. Fri 2 Oct is a holiday; 3–4 Oct is a weekend.
    const days = resolveLeaveDays({
      startDate: '2026-10-01',
      endDate: '2026-10-05',
      startPortion: 'FULL',
      endPortion: 'FULL',
      holidays: new Set(['2026-10-02']),
      weekOffDays: [6, 7],
    });

    expect(days.map((day) => day.date)).toEqual(['2026-10-01', '2026-10-05']);
    expect(days.reduce((total, day) => total + day.fraction, 0)).toBe(2);
  });

  it('counts a half day as half', () => {
    const days = resolveLeaveDays({
      startDate: '2026-10-05',
      endDate: '2026-10-06',
      startPortion: 'SECOND_HALF',
      endPortion: 'FULL',
      holidays: new Set(),
      weekOffDays: [6, 7],
    });

    expect(days).toHaveLength(2);
    expect(days[0]?.fraction).toBe(0.5);
    expect(days.reduce((total, day) => total + day.fraction, 0)).toBe(1.5);
  });

  it('returns nothing when the whole range is non-working', () => {
    // 3–4 October 2026 is a Saturday and a Sunday.
    expect(
      resolveLeaveDays({
        startDate: '2026-10-03',
        endDate: '2026-10-04',
        startPortion: 'FULL',
        endPortion: 'FULL',
        holidays: new Set(),
        weekOffDays: [6, 7],
      }),
    ).toHaveLength(0);
  });
});

describe('submitLeaveRequest', () => {
  it('computes the day count from the calendar and reserves the balance', async () => {
    const before = await balance(fixture.people.priya, fixture.leaveTypes.earned);
    expect(before.available).toBe(18);

    const created = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.earned,
            startDate: '2026-10-01',
            endDate: '2026-10-05',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );

    // Two working days: 2 October is a holiday, 3–4 October a weekend.
    expect(created.workingDays).toBe(2);
    expect(created.approverEmployeeId).toBe(fixture.people.arjun);

    const after = await balance(fixture.people.priya, fixture.leaveTypes.earned);
    expect(after.reserved).toBe(2);
    expect(after.consumed).toBe(0);
    // The generated column has the reservation subtracted already.
    expect(after.available).toBe(16);
  });

  it('raises exactly one approval task, for the manager the request routes to', async () => {
    await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.earned,
            startDate: '2026-10-06',
            endDate: '2026-10-06',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );

    const tasks = await db.approvalTask.findMany({ select: { assigneeEmployeeId: true } });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.assigneeEmployeeId).toBe(fixture.people.arjun);
  });

  it('refuses a request that overlaps one already in flight', async () => {
    const submit = (start: string, end: string) =>
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          submitLeaveRequest(
            tx,
            fixture.principals.employee,
            {
              leaveTypeId: fixture.leaveTypes.earned,
              startDate: start,
              endDate: end,
              startPortion: 'FULL',
              endPortion: 'FULL',
            },
            HMAC_KEY,
          ),
        ),
      );

    await submit('2026-10-06', '2026-10-08');
    await expect(submit('2026-10-08', '2026-10-09')).rejects.toMatchObject({
      statusCode: 422,
      code: 'OVERLAPPING_REQUEST',
    });
  });

  it('refuses a request larger than the available balance', async () => {
    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          submitLeaveRequest(
            tx,
            fixture.principals.employee,
            {
              leaveTypeId: fixture.leaveTypes.sick,
              startDate: '2026-10-05',
              endDate: '2026-10-30',
              startPortion: 'FULL',
              endPortion: 'FULL',
            },
            HMAC_KEY,
          ),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'INSUFFICIENT_LEAVE_BALANCE' });
  });

  it('refuses a half day on a type that does not allow one', async () => {
    await expect(
      as(fixture.principals.employee, () =>
        db.$transaction((tx) =>
          submitLeaveRequest(
            tx,
            fixture.principals.employee,
            {
              leaveTypeId: fixture.leaveTypes.sick,
              startDate: '2026-10-05',
              endDate: '2026-10-05',
              startPortion: 'FIRST_HALF',
              endPortion: 'FIRST_HALF',
            },
            HMAC_KEY,
          ),
        ),
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('holds no balance for unpaid leave, which becomes loss of pay instead', async () => {
    const created = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.unpaid,
            startDate: '2026-10-06',
            endDate: '2026-10-06',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );

    expect(created.workingDays).toBe(1);
    const earned = await balance(fixture.people.priya, fixture.leaveTypes.earned);
    expect(earned.reserved).toBe(0);
  });
});

describe('decideLeaveRequest', () => {
  async function submitTwoDays(): Promise<string> {
    const created = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.earned,
            startDate: '2026-10-06',
            endDate: '2026-10-07',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );
    return created.id;
  }

  it('turns the reservation into consumption and writes a ledger row', async () => {
    const requestId = await submitTwoDays();

    await as(fixture.principals.manager, () =>
      db.$transaction((tx) =>
        decideLeaveRequest(
          tx,
          fixture.principals.manager,
          { requestId, event: 'APPROVE' },
          HMAC_KEY,
        ),
      ),
    );

    const after = await balance(fixture.people.priya, fixture.leaveTypes.earned);
    expect(after.reserved).toBe(0);
    expect(after.consumed).toBe(2);
    expect(after.available).toBe(16);

    const ledger = await db.leaveBalanceLedger.findMany({
      where: { sourceType: 'leave_request', sourceId: requestId },
      select: { kind: true, deltaDays: true },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.kind).toBe('CONSUMPTION');
    expect(Number(ledger[0]?.deltaDays)).toBe(-2);
  });

  it('releases the reservation on a rejection, with no consumption', async () => {
    const requestId = await submitTwoDays();

    await as(fixture.principals.manager, () =>
      db.$transaction((tx) =>
        decideLeaveRequest(
          tx,
          fixture.principals.manager,
          { requestId, event: 'REJECT', note: 'Clashes with the release' },
          HMAC_KEY,
        ),
      ),
    );

    const after = await balance(fixture.people.priya, fixture.leaveTypes.earned);
    expect(after).toMatchObject({ reserved: 0, consumed: 0, available: 18 });

    const ledger = await db.leaveBalanceLedger.count({
      where: { sourceType: 'leave_request', sourceId: requestId },
    });
    expect(ledger).toBe(0);
  });

  it('refuses a decision from anyone but the approver the request was routed to', async () => {
    const requestId = await submitTwoDays();

    // Divya is a peer, not Priya's manager.
    const peer = {
      ...fixture.principals.employee,
      employeeId: fixture.people.divya,
    };

    await expect(
      as(peer, () =>
        db.$transaction((tx) =>
          decideLeaveRequest(tx, peer, { requestId, event: 'APPROVE' }, HMAC_KEY),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'OUT_OF_SCOPE' });
  });

  it('refuses a second decision on a request already decided', async () => {
    const requestId = await submitTwoDays();

    const decide = () =>
      as(fixture.principals.manager, () =>
        db.$transaction((tx) =>
          decideLeaveRequest(
            tx,
            fixture.principals.manager,
            { requestId, event: 'APPROVE' },
            HMAC_KEY,
          ),
        ),
      );

    await decide();
    await expect(decide()).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_STATE_TRANSITION',
    });
  });

  it('records the decision against the task rather than deleting it', async () => {
    const requestId = await submitTwoDays();

    await as(fixture.principals.manager, () =>
      db.$transaction((tx) =>
        decideLeaveRequest(
          tx,
          fixture.principals.manager,
          { requestId, event: 'APPROVE', note: 'Enjoy' },
          HMAC_KEY,
        ),
      ),
    );

    const task = await db.approvalTask.findFirstOrThrow({
      where: { subjectId: requestId },
      select: {
        status: true,
        decidedAt: true,
        decisions: { select: { outcome: true, note: true } },
      },
    });

    expect(task.status).toBe('APPROVED');
    expect(task.decidedAt).not.toBeNull();
    expect(task.decisions).toEqual([{ outcome: 'APPROVED', note: 'Enjoy' }]);
  });
});

describe('withdrawLeaveRequest', () => {
  it('returns the hold and clears the approver queue', async () => {
    const created = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.earned,
            startDate: '2026-10-06',
            endDate: '2026-10-07',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );

    await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        withdrawLeaveRequest(tx, fixture.principals.employee, { requestId: created.id }, HMAC_KEY),
      ),
    );

    expect(await balance(fixture.people.priya, fixture.leaveTypes.earned)).toMatchObject({
      reserved: 0,
      consumed: 0,
      available: 18,
    });

    const task = await db.approvalTask.findFirstOrThrow({
      where: { subjectId: created.id },
      select: { status: true, decisions: true },
    });
    expect(task.status).toBe('WITHDRAWN');
    // Nobody decided anything, so nothing is recorded as a decision.
    expect(task.decisions).toHaveLength(0);
  });

  it('refuses to withdraw someone else’s request', async () => {
    const created = await as(fixture.principals.employee, () =>
      db.$transaction((tx) =>
        submitLeaveRequest(
          tx,
          fixture.principals.employee,
          {
            leaveTypeId: fixture.leaveTypes.earned,
            startDate: '2026-10-06',
            endDate: '2026-10-06',
            startPortion: 'FULL',
            endPortion: 'FULL',
          },
          HMAC_KEY,
        ),
      ),
    );

    await expect(
      as(fixture.principals.manager, () =>
        db.$transaction((tx) =>
          withdrawLeaveRequest(tx, fixture.principals.manager, { requestId: created.id }, HMAC_KEY),
        ),
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
