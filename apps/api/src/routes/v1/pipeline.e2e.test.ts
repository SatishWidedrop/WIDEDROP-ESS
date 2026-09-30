import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { buildTestApp, testEnv } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { addPayrollConfig, buildFixture, type Fixture } from '../../test/fixtures.js';
import { hashPassword } from '../../lib/password.js';
import { runWithContext } from '../../lib/request-context.js';
import { generatePayroll } from '../../services/payroll/generation.js';
import { transitionCycle } from '../../services/payroll/pipeline.js';
import { runValidation } from '../../services/payroll/validation.js';
import { renderPendingPayslips } from '../../services/payroll/render.js';
import {
  deriveAttendanceRecords,
  openAttendancePeriod,
  submitAttendancePeriod,
  decideAttendanceSlice,
} from '../../services/attendance/service.js';

/**
 * The requirement, tested end to end over HTTP.
 *
 *   "Payslips must not exist or become visible until the required workflow is
 *    complete: Accounts uploads payroll data → HR submits employee attendance →
 *    respective Manager reviews/approves attendance → system validates required
 *    payroll inputs → automatic payroll/payslip generation → payslip becomes
 *    visible to the employee."
 *
 * The interesting case is the one in the middle: a payslip row **exists** in
 * the database, GENERATED but not published. The employee must not be able to
 * list it, fetch it by its real id, or download it. That is what these tests
 * assert — not that the list happens to be empty, but that the row is
 * unreachable while the workflow is incomplete.
 */

const db = testDb();
const PASSWORD = 'the quiet mountain sings';
const ORIGIN = 'http://127.0.0.1:5173';
const HMAC = testEnv().AUDIT_HMAC_KEY;

let app: App;
let fixture: Fixture;
let cycleId: string;
let priyaToken: string;

/**
 * A distinct sign-in address per test.
 *
 * The login limiter is keyed by the email being attempted and is deliberately
 * left switched on for these tests: a suite that disabled it would not be
 * exercising the stack that ships. Sixteen tests through one address would
 * trip it partway through the file.
 */
let addressCounter = 0;

beforeAll(async () => {
  app = await buildTestApp();
  await resetTestDb(db);
});

afterAll(async () => {
  await app.close();
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);
  fixture = await buildFixture();
  await addPayrollConfig(fixture);

  // Roles the token carries. Personas come from these rows, so a role that
  // does not exist cannot be claimed.
  const employeeRole = await db.role.create({
    data: { persona: 'EMPLOYEE', name: 'Employee', description: 'Their own records.' },
    select: { id: true },
  });
  await db.role.createMany({
    data: [
      { persona: 'MANAGER', name: 'Manager', description: 'Their reporting chain.' },
      { persona: 'HR', name: 'HR', description: 'People records.' },
      { persona: 'ACCOUNTS', name: 'Accounts', description: 'Payroll.' },
    ],
  });

  // Priya signs in for real, so every assertion below goes through the same
  // authentication, CSRF and authorization path production uses.
  const env = testEnv();
  const signInEmail = `priya${(addressCounter += 1)}@widedrop.test`;
  await db.appUser.update({
    where: { id: fixture.users.priya },
    data: {
      email: signInEmail,
      passwordHash: await hashPassword(PASSWORD, env.PASSWORD_PEPPER),
      passwordUpdatedAt: new Date(),
    },
  });
  await db.userRole.create({
    data: { appUserId: fixture.users.priya, roleId: employeeRole.id },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-site' },
    payload: { email: signInEmail, password: PASSWORD },
  });
  expect(signIn.statusCode).toBe(200);
  priyaToken = signIn.json().accessToken;

  // Everyone needs a manager before attendance can be submitted.
  const ananya = await db.employee.findFirstOrThrow({
    where: { employeeNumber: 'WDT-01120' },
    select: { id: true },
  });
  await db.employeeManager.createMany({
    data: [
      {
        organizationId: fixture.organizationId,
        employeeId: fixture.people.arjun,
        managerEmployeeId: fixture.people.divya,
        isPrimary: true,
        effectiveFrom: new Date('2024-07-11'),
      },
      {
        organizationId: fixture.organizationId,
        employeeId: ananya.id,
        managerEmployeeId: fixture.people.divya,
        isPrimary: true,
        effectiveFrom: new Date('2024-07-11'),
      },
    ],
  });

  const cycle = await db.payrollCycle.create({
    data: {
      organizationId: fixture.organizationId,
      year: 2026,
      month: 10,
      label: 'October 2026',
      periodStart: new Date('2026-10-01'),
      periodEnd: new Date('2026-10-31'),
      payDate: new Date('2026-10-31'),
      status: 'DRAFT',
    },
    select: { id: true },
  });
  cycleId = cycle.id;
});

const get = (url: string) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${priyaToken}` } });

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
      personas: ['ACCOUNTS'],
      ip: '127.0.0.1',
    },
    fn,
  );
}

/** Run the pipeline up to, but not including, publication. */
async function runToGenerated(): Promise<{ payslipId: string; reference: string }> {
  const { accounts, hr, manager } = fixture.principals;

  // 1. Accounts uploads payroll inputs.
  await as(accounts, () =>
    db.$transaction(async (tx) => {
      const batch = await tx.payrollInputBatch.create({
        data: {
          organizationId: fixture.organizationId,
          payrollCycleId: cycleId,
          status: 'COMMITTED',
          originalFilename: 'october-inputs.csv',
          rowCount: 1,
          acceptedCount: 1,
          uploadedByUserId: accounts.userId,
          committedAt: new Date(),
        },
        select: { id: true },
      });
      await tx.payrollInputItem.create({
        data: {
          organizationId: fixture.organizationId,
          payrollInputBatchId: batch.id,
          employeeId: fixture.people.priya,
          kind: 'INCENTIVE',
          amountMinor: 640_000n,
          note: 'Quarterly incentive',
          sourceRowNumber: 1,
        },
      });
      await transitionCycle(tx, accounts, { cycleId, event: 'UPLOAD_INPUTS' }, HMAC);
      await transitionCycle(tx, accounts, { cycleId, event: 'LOCK_INPUTS' }, HMAC);
    }),
  );

  // 2. HR opens, derives and submits attendance.
  const period = await as(hr, () =>
    db.$transaction((tx) => openAttendancePeriod(tx, hr, { year: 2026, month: 10 }, HMAC)),
  );
  await db.payrollCycle.update({
    where: { id: cycleId },
    data: { attendancePeriodId: period.id },
  });
  await as(hr, () =>
    db.$transaction((tx) => deriveAttendanceRecords(tx, hr, { periodId: period.id }, HMAC)),
  );
  await as(hr, () =>
    db.$transaction((tx) => submitAttendancePeriod(tx, hr, { periodId: period.id }, HMAC)),
  );
  await as(hr, () =>
    db.$transaction((tx) =>
      transitionCycle(tx, hr, { cycleId, event: 'SUBMIT_ATTENDANCE' }, HMAC, {
        data: { attendanceSubmittedAt: new Date() },
      }),
    ),
  );

  // 3. Every manager approves their own slice.
  const divyaUser = await db.employee.findUniqueOrThrow({
    where: { id: fixture.people.divya },
    select: { appUserId: true },
  });
  const divya = {
    userId: divyaUser.appUserId!,
    organizationId: fixture.organizationId,
    employeeId: fixture.people.divya,
    personas: ['EMPLOYEE', 'MANAGER'] as const,
    sessionId: '00000000-0000-4000-8000-0000000000ff',
    mfaSatisfied: true,
  };

  await as(manager, () =>
    db.$transaction((tx) =>
      decideAttendanceSlice(tx, manager, { periodId: period.id, approve: true }, HMAC),
    ),
  );
  await as(divya, () =>
    db.$transaction((tx) =>
      decideAttendanceSlice(
        tx,
        { ...divya, personas: [...divya.personas] },
        { periodId: period.id, approve: true },
        HMAC,
      ),
    ),
  );
  await as(divya, () =>
    db.$transaction((tx) =>
      transitionCycle(
        tx,
        { ...divya, personas: [...divya.personas] },
        { cycleId, event: 'APPROVE_ATTENDANCE' },
        HMAC,
        { data: { attendanceApprovedAt: new Date() } },
      ),
    ),
  );

  // 4. Validation, then 5. generation.
  const summary = await as(fixture.principals.accounts, () =>
    db.$transaction(
      async (tx) => {
        await transitionCycle(
          tx,
          fixture.principals.accounts,
          { cycleId, event: 'VALIDATE' },
          HMAC,
        );
        const result = await runValidation(tx, {
          organizationId: fixture.organizationId,
          payrollCycleId: cycleId,
        });
        await transitionCycle(
          tx,
          fixture.principals.accounts,
          { cycleId, event: 'VALIDATION_PASSED' },
          HMAC,
          { systemRaised: true, data: { validatedAt: new Date() } },
        );
        return result;
      },
      { timeout: 60_000 },
    ),
  );

  expect(summary.eligibleEmployeeIds).toContain(fixture.people.priya);

  await as(fixture.principals.accounts, () =>
    db.$transaction(
      async (tx) => {
        await transitionCycle(
          tx,
          fixture.principals.accounts,
          { cycleId, event: 'CALCULATE' },
          HMAC,
        );
        const generated = await generatePayroll(
          tx,
          fixture.principals.accounts,
          { cycleId, eligibleEmployeeIds: summary.eligibleEmployeeIds },
          HMAC,
        );
        expect(generated.payslipsCreated).toBeGreaterThan(0);
        await transitionCycle(
          tx,
          fixture.principals.accounts,
          { cycleId, event: 'CALCULATION_SUCCEEDED' },
          HMAC,
          { systemRaised: true, data: { calculatedAt: new Date() } },
        );
      },
      { timeout: 120_000 },
    ),
  );

  const payslip = await db.payslip.findFirstOrThrow({
    where: { payrollCycleId: cycleId, employeeId: fixture.people.priya },
    select: { id: true, reference: true, status: true },
  });
  expect(payslip.status).toBe('GENERATED');

  return { payslipId: payslip.id, reference: payslip.reference };
}

async function publish(): Promise<void> {
  const { accounts } = fixture.principals;

  // The pipeline refuses to publish a payslip with no document: an employee
  // told their payslip is ready and then offered nothing to download is worse
  // than one told to wait. The real renderer satisfies it — this used to
  // fabricate FileObject rows, which meant the one step between "calculated"
  // and "the employee can download it" was the one step never exercised.
  const documents = await renderPendingPayslips(db, testEnv(), {
    organizationId: fixture.organizationId,
    cycleId,
  });
  expect(documents.failed).toEqual([]);
  expect(documents.rendered).toBeGreaterThan(0);

  await as(accounts, () =>
    db.$transaction(async (tx) => {
      await transitionCycle(tx, accounts, { cycleId, event: 'APPROVE' }, HMAC, {
        data: { approvedAt: new Date(), approvedByUserId: accounts.userId },
      });
      await transitionCycle(tx, accounts, { cycleId, event: 'PUBLISH' }, HMAC, {
        data: { publishedAt: new Date(), publishedByUserId: accounts.userId },
      });
    }),
  );

  const publishedAt = new Date();
  const payslips = await db.payslip.findMany({
    where: { payrollCycleId: cycleId, status: 'GENERATED' },
    select: { id: true },
  });
  for (const payslip of payslips) {
    await db.payslip.update({
      where: { id: payslip.id },
      data: { status: 'PUBLISHED', publishedAt },
    });
    await db.payslipPublication.create({
      data: {
        organizationId: fixture.organizationId,
        payslipId: payslip.id,
        publishedByUserId: fixture.principals.accounts.userId,
        publishedAt,
      },
    });
  }
}

describe('before the workflow completes', () => {
  it('shows no payslip at all while nothing has been generated', async () => {
    const response = await get('/api/v1/payslips');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ items: [], summary: null });
  });

  it('returns null rather than zeroes for the year-to-date tiles', async () => {
    // The distinction the requirement turns on: no rollup is "payroll has not
    // run", which is not the same claim as "you earned ₹0".
    expect(response(await get('/api/v1/payslips')).summary).toBeNull();
  });

  it('will not list a generated-but-unpublished payslip', async () => {
    await runToGenerated();

    const response = await get('/api/v1/payslips');
    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it('will not serve a generated-but-unpublished payslip by its real id', async () => {
    const { payslipId } = await runToGenerated();

    // The row exists. Knowing its id must not be enough.
    const response = await get(`/api/v1/payslips/${payslipId}`);
    expect(response.statusCode).toBe(404);
  });

  it('will not sign a download URL for an unpublished payslip', async () => {
    const { payslipId } = await runToGenerated();

    const response = await get(`/api/v1/payslips/${payslipId}/document`);
    expect(response.statusCode).toBe(404);
  });

  it('does not mention the unpublished payslip on the home screen', async () => {
    await runToGenerated();

    const home = response(await get('/api/v1/me/home'));
    expect(home.latestPayslip).toBeNull();
  });
});

describe('once the cycle is published', () => {
  it('shows the payslip, with figures the pipeline produced', async () => {
    const { reference } = await runToGenerated();
    await publish();

    const list = response(await get('/api/v1/payslips'));
    expect(list.items).toHaveLength(1);

    const item = list.items[0];
    expect(item.reference).toBe(reference);
    expect(item.label).toBe('October 2026');

    // Basic 60,000 + HRA 30,000 + special 30,000 + the 6,400 incentive
    // Accounts uploaded. Not a number this test wrote: a number the engine
    // computed from the structure and the input batch.
    expect(BigInt(item.grossEarningsMinor)).toBe(12_640_000n);
    expect(BigInt(item.netPayMinor)).toBe(
      BigInt(item.grossEarningsMinor) - BigInt(item.totalDeductionsMinor),
    );
    // A full month: 31 payable days, no loss of pay.
    expect(item.payableDays).toBe(31);
    expect(item.lopDays).toBe(0);
  });

  it('signs a download URL that serves the payslip as a real PDF', async () => {
    const { payslipId, reference } = await runToGenerated();
    await publish();

    const signed = response(await get(`/api/v1/payslips/${payslipId}/document`));
    expect(signed.url).toBeTruthy();
    expect(new Date(signed.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Follow it. This is the last link in the chain the requirement describes,
    // and the one that was fabricated until the renderer existed: "payslip
    // becomes visible to the employee" means an employee can open it.
    const target = new URL(signed.url);
    const download = await app.inject({
      method: 'GET',
      url: target.pathname + target.search,
    });

    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toContain('attachment');
    // A real PDF, not a row claiming one exists.
    expect(download.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(download.rawPayload.subarray(-6).toString('latin1').trim()).toBe('%%EOF');

    // And it is this employee's payslip, with the figures the pipeline
    // produced, printed on it.
    const text = download.rawPayload.toString('latin1');
    expect(text).toContain(reference);
    expect(text).toContain('Priya Raghavan');
    expect(text).toContain('INR 1,26,400.00'); // gross, as the list reported it
  });

  it('serves the detail, with the lines that explain the total', async () => {
    const { payslipId } = await runToGenerated();
    await publish();

    const detail = response(await get(`/api/v1/payslips/${payslipId}`));

    expect(detail.employee.name).toBe('Priya Raghavan');
    expect(detail.earnings.map((line: { label: string }) => line.label)).toEqual(
      expect.arrayContaining(['Basic salary', 'House rent allowance', 'Special allowance']),
    );

    const earnings = detail.earnings.reduce(
      (total: bigint, line: { amountMinor: string }) => total + BigInt(line.amountMinor),
      0n,
    );
    // The lines add up to the header. A payslip whose parts do not explain its
    // total is the single most common complaint about payroll software.
    expect(earnings).toBe(BigInt(detail.totals.grossEarningsMinor));

    const deductions = detail.deductions.reduce(
      (total: bigint, line: { amountMinor: string }) => total + BigInt(line.amountMinor),
      0n,
    );
    expect(deductions).toBe(BigInt(detail.totals.totalDeductionsMinor));
  });

  it('records the read in the audit trail', async () => {
    const { payslipId } = await runToGenerated();
    await publish();

    await get(`/api/v1/payslips/${payslipId}`);

    const audit = await db.auditEvent.findFirst({
      where: { entityType: 'payslip', entityId: payslipId, action: 'READ_SENSITIVE' },
      select: { summary: true, actorUserId: true },
    });
    expect(audit).not.toBeNull();
    expect(audit?.actorUserId).toBe(fixture.users.priya);
  });

  it('shows it on the home screen', async () => {
    await runToGenerated();
    await publish();

    const home = response(await get('/api/v1/me/home'));
    expect(home.latestPayslip).toMatchObject({ label: 'October 2026' });
  });
});

describe('what an employee cannot reach', () => {
  it('refuses the HR employee list', async () => {
    const forbidden = await get('/api/v1/hr/employees');
    expect(forbidden.statusCode).toBe(403);
  });

  it('refuses the payroll cycle list', async () => {
    const forbidden = await get('/api/v1/payroll/cycles');
    expect(forbidden.statusCode).toBe(403);
  });

  it('refuses the payslip register, even for their own cycle', async () => {
    await runToGenerated();
    const forbidden = await get(`/api/v1/payroll/cycles/${cycleId}/payslips`);
    expect(forbidden.statusCode).toBe(403);
  });

  it('refuses the audit trail', async () => {
    const forbidden = await get('/api/v1/audit');
    expect(forbidden.statusCode).toBe(403);
  });

  it('refuses the approvals queue', async () => {
    const forbidden = await get('/api/v1/approvals');
    expect(forbidden.statusCode).toBe(403);
  });

  it('cannot read another employee’s payslip', async () => {
    await runToGenerated();
    await publish();

    const other = await db.payslip.findFirstOrThrow({
      where: { payrollCycleId: cycleId, employeeId: { not: fixture.people.priya } },
      select: { id: true },
    });

    const forbidden = await get(`/api/v1/payslips/${other.id}`);
    // Not 403: a 403 would confirm the payslip exists. The employee simply
    // cannot find it.
    expect(forbidden.statusCode).toBe(404);
  });
});

/** Parse a response body, failing loudly rather than returning undefined. */
function response(reply: { statusCode: number; json: () => Record<string, never> }) {
  expect(reply.statusCode).toBe(200);
  return reply.json() as never;
}
