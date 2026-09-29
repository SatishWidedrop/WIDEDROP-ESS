import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { runWithContext } from '../../lib/request-context.js';
import type { Principal } from '../auth/authorization.js';
import { rebuildReportingClosure } from '../auth/authorization.js';
import { generatePayroll } from './generation.js';
import { availableEvents, transitionCycle } from './pipeline.js';
import { runValidation } from './validation.js';

const db = testDb();
const HMAC = Buffer.alloc(32, 41).toString('base64');
const rupees = (amount: number) => BigInt(Math.round(amount * 100));

let organizationId: string;
let fiscalYearId: string;
let attendancePeriodId: string;
let cycleId: string;
let priyaId: string;
let arjunId: string;
let componentIds: Record<string, string>;

/**
 * Actors in the pipeline, each holding exactly the persona their step requires.
 * User ids are real UUIDs because the columns that record who did what are too.
 */
const ACTOR_IDS: Record<string, string> = {
  karan: '00000000-0000-4000-8000-000000000001',
  ananya: '00000000-0000-4000-8000-000000000002',
  arjun: '00000000-0000-4000-8000-000000000003',
  priya: '00000000-0000-4000-8000-000000000004',
};

const actor = (name: string, personas: Principal['personas'], employeeId?: string): Principal => ({
  userId: ACTOR_IDS[name]!,
  organizationId,
  employeeId,
  personas,
  sessionId: '00000000-0000-4000-8000-0000000000ff',
  mfaSatisfied: true,
});

let accounts: Principal;
let hr: Principal;
let manager: Principal;
let employee: Principal;

beforeAll(async () => {
  await resetTestDb(db);
});

afterAll(async () => {
  await closeTestDb();
});

beforeEach(async () => {
  await resetTestDb(db);

  const org = await db.organization.create({
    data: {
      legalName: 'Widedrop Technologies Pvt Ltd',
      displayName: 'Widedrop',
      domain: 'widedrop.test',
      helpdeskEmail: 'helpdesk@widedroptech.com',
      employeeNumberPrefix: 'WDT',
    },
  });
  organizationId = org.id;

  const fy = await db.fiscalYear.create({
    data: {
      organizationId,
      startYear: 2026,
      label: 'FY 2026–27',
      startDate: new Date('2026-04-01'),
      endDate: new Date('2027-03-31'),
    },
  });
  fiscalYearId = fy.id;

  const regime = await db.taxRegime.create({
    data: {
      code: 'NEW',
      fiscalYearStartYear: 2026,
      name: 'New regime',
      slabs: [
        { upToMinor: 30_000_000, rate: 0 },
        { upToMinor: 70_000_000, rate: 0.05 },
        { upToMinor: 100_000_000, rate: 0.1 },
        { upToMinor: 120_000_000, rate: 0.15 },
        { upToMinor: 150_000_000, rate: 0.2 },
        { upToMinor: null, rate: 0.3 },
      ],
      standardDeductionMinor: rupees(75_000),
      rebateThresholdMinor: rupees(700_000),
      rebateMaxMinor: rupees(25_000),
      cessRate: 0.04,
      allowsDeductions: false,
    },
  });

  const department = await db.department.create({
    data: { organizationId, code: 'PLAT', name: 'Platform Engineering' },
  });
  const designation = await db.designation.create({
    data: { organizationId, code: 'SSE', title: 'Senior Software Engineer', grade: 5 },
  });
  const location = await db.location.create({
    data: { organizationId, code: 'BLR', name: 'Bengaluru', city: 'Bengaluru', stateCode: 'KA' },
  });

  const makeEmployee = async (code: string, first: string, last: string) => {
    const created = await db.employee.create({
      data: {
        organizationId,
        employeeNumber: code,
        firstName: first,
        lastName: last,
        workEmail: `${first.toLowerCase()}.${last.toLowerCase()}@widedrop.test`,
        dateOfJoining: new Date('2022-07-11'),
        employmentStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    await db.employeeEmployment.create({
      data: {
        organizationId,
        employeeId: created.id,
        departmentId: department.id,
        designationId: designation.id,
        locationId: location.id,
        employmentType: 'FULL_TIME_PERMANENT',
        effectiveFrom: new Date('2022-07-11'),
      },
    });
    return created.id;
  };

  arjunId = await makeEmployee('WDT-01001', 'Arjun', 'Malhotra');
  priyaId = await makeEmployee('WDT-01847', 'Priya', 'Raghavan');

  await db.employeeManager.create({
    data: {
      organizationId,
      employeeId: priyaId,
      managerEmployeeId: arjunId,
      isPrimary: true,
      effectiveFrom: new Date('2022-07-11'),
    },
  });
  await rebuildReportingClosure(db, organizationId);

  // Everything payroll needs from Priya's record.
  await db.employeeBankAccount.create({
    data: {
      organizationId,
      employeeId: priyaId,
      bankName: 'HDFC Bank',
      accountNumberCt: Buffer.from('ct'),
      accountNumberIv: Buffer.from('iv'),
      accountNumberTag: Buffer.from('tag'),
      accountNumberMasked: '•• •••• •••• 4412',
      accountNumberFingerprint: 'fp-1',
      ifscCt: Buffer.from('ct'),
      ifscIv: Buffer.from('iv'),
      ifscTag: Buffer.from('tag'),
      ifscMasked: 'HDFC000••••',
      accountHolderName: 'Priya Raghavan',
      verifiedAt: new Date('2022-07-20'),
    },
  });

  for (const kind of ['PAN', 'UAN'] as const) {
    await db.employeeStatutoryId.create({
      data: {
        organizationId,
        employeeId: priyaId,
        kind,
        valueCt: Buffer.from('ct'),
        valueIv: Buffer.from('iv'),
        valueTag: Buffer.from('tag'),
        maskedValue: kind === 'PAN' ? 'AXYPR••••K' : '•••• 7890',
        fingerprint: `fp-${kind}`,
      },
    });
  }

  await db.employeeTaxRegimeElection.create({
    data: { organizationId, employeeId: priyaId, fiscalYearId, taxRegimeId: regime.id },
  });

  // Pay components, in payslip order.
  componentIds = {};
  const componentSpec = [
    { code: 'BASIC', name: 'Basic salary', calc: 'PRORATED_FIXED', order: 1, pf: true },
    { code: 'HRA', name: 'House rent allowance', calc: 'PERCENT_OF_BASIC', order: 2, rate: 0.5 },
    { code: 'SPECIAL', name: 'Special allowance', calc: 'PRORATED_FIXED', order: 3 },
    { code: 'CONVEYANCE', name: 'Conveyance allowance', calc: 'FIXED', order: 5, prorated: false },
  ] as const;

  for (const spec of componentSpec) {
    const created = await db.payComponent.create({
      data: {
        organizationId,
        code: spec.code,
        name: spec.name,
        kind: 'EARNING',
        calc: spec.calc,
        rate: 'rate' in spec ? spec.rate : null,
        isProrated: 'prorated' in spec ? spec.prorated : true,
        isPfApplicable: 'pf' in spec ? spec.pf : false,
        displayOrder: spec.order,
      },
      select: { id: true },
    });
    componentIds[spec.code] = created.id;
  }

  const structure = await db.salaryStructure.create({
    data: {
      organizationId,
      employeeId: priyaId,
      effectiveFrom: new Date('2026-04-01'),
      annualCtcMinor: rupees(2_200_000),
    },
    select: { id: true },
  });

  await db.salaryStructureComponent.createMany({
    data: [
      {
        organizationId,
        salaryStructureId: structure.id,
        payComponentId: componentIds.BASIC!,
        monthlyAmountMinor: rupees(86_000),
      },
      { organizationId, salaryStructureId: structure.id, payComponentId: componentIds.HRA! },
      {
        organizationId,
        salaryStructureId: structure.id,
        payComponentId: componentIds.SPECIAL!,
        monthlyAmountMinor: rupees(45_400),
      },
      {
        organizationId,
        salaryStructureId: structure.id,
        payComponentId: componentIds.CONVEYANCE!,
        monthlyAmountMinor: rupees(1_600),
      },
    ],
  });

  const period = await db.attendancePeriod.create({
    data: {
      organizationId,
      year: 2026,
      month: 8,
      startDate: new Date('2026-08-01'),
      endDate: new Date('2026-08-31'),
      totalDays: 31,
      status: 'OPEN',
    },
    select: { id: true },
  });
  attendancePeriodId = period.id;

  const cycle = await db.payrollCycle.create({
    data: {
      organizationId,
      year: 2026,
      month: 8,
      label: 'August 2026',
      periodStart: new Date('2026-08-01'),
      periodEnd: new Date('2026-08-31'),
      payDate: new Date('2026-08-31'),
      status: 'DRAFT',
      attendancePeriodId,
    },
    select: { id: true },
  });
  cycleId = cycle.id;

  accounts = actor('karan', ['ACCOUNTS']);
  hr = actor('ananya', ['HR']);
  manager = actor('arjun', ['MANAGER'], arjunId);
  employee = actor('priya', ['EMPLOYEE'], priyaId);
});

/* ------------------------------------------------------------------ */
/* Helpers that perform each step of the pipeline                      */
/* ------------------------------------------------------------------ */

const withContext = <T>(fn: () => Promise<T>) =>
  runWithContext({ requestId: 'req_pipeline', personas: [] }, fn);

async function uploadInputs(
  items: { employeeId: string; kind: string; amountMinor?: bigint }[] = [],
) {
  const batch = await db.payrollInputBatch.create({
    data: {
      organizationId,
      payrollCycleId: cycleId,
      status: 'COMMITTED',
      rowCount: items.length,
      acceptedCount: items.length,
      uploadedByUserId: accounts.userId,
      committedAt: new Date(),
    },
    select: { id: true },
  });

  for (const item of items) {
    await db.payrollInputItem.create({
      data: {
        organizationId,
        payrollInputBatchId: batch.id,
        employeeId: item.employeeId,
        kind: item.kind as never,
        amountMinor: item.amountMinor ?? null,
      },
    });
  }

  return withContext(() =>
    transitionCycle(db, accounts, { cycleId, event: 'UPLOAD_INPUTS' }, HMAC),
  );
}

const lockInputs = () =>
  withContext(() => transitionCycle(db, accounts, { cycleId, event: 'LOCK_INPUTS' }, HMAC));

async function enterAttendance(overrides: { lopDays?: number } = {}) {
  const lop = overrides.lopDays ?? 0;
  await db.attendanceRecord.create({
    data: {
      organizationId,
      attendancePeriodId,
      employeeId: priyaId,
      managerEmployeeId: arjunId,
      status: 'SUBMITTED',
      source: 'HR_MANUAL',
      presentDays: 21 - lop,
      paidLeaveDays: 0,
      unpaidLeaveDays: lop,
      holidayDays: 1,
      weekOffDays: 9,
      absentDays: 0,
      employedDays: 31,
    },
  });
  await db.attendanceApproval.create({
    data: {
      organizationId,
      attendancePeriodId,
      managerEmployeeId: arjunId,
      status: 'PENDING',
      recordCount: 1,
    },
  });
  await db.attendancePeriod.update({
    where: { id: attendancePeriodId },
    data: { status: 'HR_SUBMITTED', submittedAt: new Date() },
  });
}

const submitAttendance = () =>
  withContext(() =>
    transitionCycle(db, hr, { cycleId, event: 'SUBMIT_ATTENDANCE' }, HMAC, {
      data: { attendanceSubmittedAt: new Date() },
    }),
  );

async function approveAttendance() {
  await db.attendanceApproval.updateMany({
    where: { attendancePeriodId, managerEmployeeId: arjunId },
    data: { status: 'APPROVED', decidedAt: new Date(), decidedByUserId: manager.userId },
  });
  await db.attendanceRecord.updateMany({
    where: { attendancePeriodId },
    data: { status: 'APPROVED' },
  });
  await db.attendancePeriod.update({
    where: { id: attendancePeriodId },
    data: { status: 'APPROVED', approvedAt: new Date() },
  });
  return withContext(() =>
    transitionCycle(db, manager, { cycleId, event: 'APPROVE_ATTENDANCE' }, HMAC, {
      data: { attendanceApprovedAt: new Date() },
    }),
  );
}

async function validate() {
  await withContext(() => transitionCycle(db, accounts, { cycleId, event: 'VALIDATE' }, HMAC));
  const summary = await runValidation(db, { organizationId, payrollCycleId: cycleId });
  await withContext(() =>
    transitionCycle(
      db,
      accounts,
      {
        cycleId,
        event: summary.employeesPassing > 0 ? 'VALIDATION_PASSED' : 'VALIDATION_REJECTED',
      },
      HMAC,
      { systemRaised: true, data: summary.employeesPassing > 0 ? { validatedAt: new Date() } : {} },
    ),
  );
  return summary;
}

async function calculate(eligibleEmployeeIds: string[]) {
  await withContext(() => transitionCycle(db, accounts, { cycleId, event: 'CALCULATE' }, HMAC));
  const result = await withContext(() =>
    generatePayroll(db, accounts, { cycleId, eligibleEmployeeIds }, HMAC),
  );
  await withContext(() =>
    transitionCycle(db, accounts, { cycleId, event: 'CALCULATION_SUCCEEDED' }, HMAC, {
      systemRaised: true,
      data: { calculatedAt: new Date() },
    }),
  );
  return result;
}

async function publish() {
  // A payslip with no document would be visible but not downloadable, so the
  // guard requires one. Stand in a stored file for the test.
  const file = await db.fileObject.create({
    data: {
      organizationId,
      purpose: 'PAYSLIP_PDF',
      storageKey: `PAYSLIP_PDF/2026/08/${priyaId}/doc.pdf`,
      displayFilename: 'Payslip_Aug-2026.pdf',
      contentType: 'application/pdf',
      sizeBytes: 1024,
      sha256: 'a'.repeat(64),
      scanStatus: 'CLEAN',
    },
    select: { id: true },
  });
  await db.payslip.updateMany({
    where: { payrollCycleId: cycleId },
    data: { pdfFileObjectId: file.id },
  });

  await withContext(() =>
    transitionCycle(db, accounts, { cycleId, event: 'APPROVE' }, HMAC, {
      data: { approvedAt: new Date(), approvedByUserId: accounts.userId },
    }),
  );
  await withContext(() =>
    transitionCycle(db, accounts, { cycleId, event: 'PUBLISH' }, HMAC, {
      data: { publishedAt: new Date(), publishedByUserId: accounts.userId },
    }),
  );
  await db.payslip.updateMany({
    where: { payrollCycleId: cycleId },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('the pipeline cannot be short-circuited', () => {
  it('will not let HR submit attendance before Accounts has uploaded and locked inputs', async () => {
    await expect(submitAttendance()).rejects.toThrow(/cannot do that yet|once Accounts/i);
    await uploadInputs();
    await expect(submitAttendance()).rejects.toThrow(/locked/i);
  });

  it('will not let a manager approve before HR has submitted', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    // Attendance exists and the manager holds the right persona, but HR has
    // not submitted the period, so there is nothing to approve yet.
    await expect(
      withContext(() =>
        transitionCycle(db, manager, { cycleId, event: 'APPROVE_ATTENDANCE' }, HMAC),
      ),
    ).rejects.toThrow(/once HR has submitted/i);
  });

  it('will not validate before every manager has approved', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();

    // One approval still outstanding.
    await expect(
      withContext(() => transitionCycle(db, accounts, { cycleId, event: 'VALIDATE' }, HMAC)),
    ).rejects.toThrow(AppError);
  });

  it('will not calculate before validation has passed', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();

    await expect(
      withContext(() => transitionCycle(db, accounts, { cycleId, event: 'CALCULATE' }, HMAC)),
    ).rejects.toThrow(AppError);
  });

  it('will not publish before the run is calculated and signed off', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();
    const summary = await validate();
    await calculate(summary.eligibleEmployeeIds);

    // Calculated, but not yet signed off.
    await expect(
      withContext(() => transitionCycle(db, accounts, { cycleId, event: 'PUBLISH' }, HMAC)),
    ).rejects.toThrow(AppError);
  });
});

describe('separation of duties', () => {
  it('lets only Accounts upload payroll inputs', async () => {
    for (const other of [hr, manager, employee]) {
      await expect(
        withContext(() => transitionCycle(db, other, { cycleId, event: 'UPLOAD_INPUTS' }, HMAC)),
      ).rejects.toThrow(/do not have access/);
    }
  });

  it('lets only HR submit attendance', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    for (const other of [accounts, manager, employee]) {
      await expect(
        withContext(() =>
          transitionCycle(db, other, { cycleId, event: 'SUBMIT_ATTENDANCE' }, HMAC),
        ),
      ).rejects.toThrow(/do not have access/);
    }
    await expect(submitAttendance()).resolves.toMatchObject({ to: 'ATTENDANCE_SUBMITTED' });
  });

  it('lets only a manager approve attendance', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    for (const other of [accounts, hr, employee]) {
      await expect(
        withContext(() =>
          transitionCycle(db, other, { cycleId, event: 'APPROVE_ATTENDANCE' }, HMAC),
        ),
      ).rejects.toThrow(/do not have access/);
    }
  });

  it('refuses a system-raised outcome requested by a user', async () => {
    await expect(
      withContext(() =>
        transitionCycle(db, accounts, { cycleId, event: 'VALIDATION_PASSED' }, HMAC),
      ),
    ).rejects.toThrow(/performed by the system/);
  });

  it('offers a screen only the actions that persona could take', () => {
    expect(availableEvents('DRAFT', ['ACCOUNTS'])).toContain('UPLOAD_INPUTS');
    expect(availableEvents('DRAFT', ['HR'])).toEqual([]);
    expect(availableEvents('INPUTS_LOCKED', ['HR'])).toEqual(['SUBMIT_ATTENDANCE']);
    expect(availableEvents('ATTENDANCE_SUBMITTED', ['MANAGER'])).toEqual([
      'RETURN_ATTENDANCE',
      'APPROVE_ATTENDANCE',
    ]);
  });
});

describe('no payslip exists before the workflow completes', () => {
  it('has no payslip at any stage before calculation', async () => {
    const count = () => db.payslip.count({ where: { payrollCycleId: cycleId } });

    expect(await count()).toBe(0);
    await uploadInputs();
    expect(await count()).toBe(0);
    await lockInputs();
    expect(await count()).toBe(0);
    await enterAttendance();
    await submitAttendance();
    expect(await count()).toBe(0);
    await approveAttendance();
    expect(await count()).toBe(0);
    await validate();
    expect(await count()).toBe(0);
  });

  it('refuses a payslip written directly into an unstarted cycle', async () => {
    const run = await db.payrollRun.create({
      data: {
        organizationId,
        payrollCycleId: cycleId,
        status: 'SUCCEEDED',
        engineVersion: '1.0.0',
        triggeredByUserId: accounts.userId,
      },
      select: { id: true },
    });

    await expect(
      db.payslip.create({
        data: {
          organizationId,
          payrollCycleId: cycleId,
          payrollRunId: run.id,
          employeeId: priyaId,
          reference: 'WDT-PS-2608-01847',
          periodStart: new Date('2026-08-01'),
          periodEnd: new Date('2026-08-31'),
          payDate: new Date('2026-08-31'),
          payableDays: 31,
          totalDays: 31,
          lopDays: 0,
          grossEarningsMinor: rupees(183_200),
          totalDeductionsMinor: rupees(2_000),
          netPayMinor: rupees(181_200),
          sourceDigest: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow(/cannot exist while its payroll cycle is DRAFT/);
  });
});

describe('the whole pipeline, end to end', () => {
  it('produces a payslip the employee can see, and only then', async () => {
    await uploadInputs([{ employeeId: priyaId, kind: 'INCENTIVE', amountMinor: rupees(6_420) }]);
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();

    const summary = await validate();
    expect(summary.employeesInScope).toBe(2);
    // Arjun has no salary structure, bank account or tax election, so he is
    // excluded with recorded reasons rather than paid approximately.
    expect(summary.eligibleEmployeeIds).toEqual([priyaId]);
    expect(summary.employeesExcluded).toBe(1);
    expect(summary.failures.some((f) => f.employeeId === arjunId)).toBe(true);

    const generated = await calculate(summary.eligibleEmployeeIds);
    expect(generated.payslipsCreated).toBe(1);

    // The payslip exists but is not yet visible.
    const beforePublish = await db.payslip.findFirstOrThrow({
      where: { payrollCycleId: cycleId },
    });
    expect(beforePublish.status).toBe('GENERATED');
    expect(beforePublish.publishedAt).toBeNull();

    await publish();

    const afterPublish = await db.payslip.findFirstOrThrow({
      where: { payrollCycleId: cycleId },
    });
    expect(afterPublish.status).toBe('PUBLISHED');
    expect(afterPublish.publishedAt).not.toBeNull();

    const cycle = await db.payrollCycle.findUniqueOrThrow({ where: { id: cycleId } });
    expect(cycle.status).toBe('PUBLISHED');
  });

  it('computes the payslip from the structure, attendance and uploaded inputs', async () => {
    await uploadInputs([{ employeeId: priyaId, kind: 'INCENTIVE', amountMinor: rupees(6_420) }]);
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();
    const summary = await validate();
    await calculate(summary.eligibleEmployeeIds);

    const payslip = await db.payslip.findFirstOrThrow({
      where: { payrollCycleId: cycleId },
      include: { lines: { orderBy: { displayOrder: 'asc' } } },
    });

    // 86,000 basic + 43,000 HRA + 45,400 special + 1,600 conveyance + 6,420 incentive
    expect(payslip.grossEarningsMinor).toBe(rupees(182_420));
    expect(payslip.netPayMinor).toBe(payslip.grossEarningsMinor - payslip.totalDeductionsMinor);

    // Provident fund is capped at the statutory ceiling, not 12% of basic.
    expect(payslip.pfEmployeeMinor).toBe(rupees(1_800));

    const labels = payslip.lines.map((l) => l.label);
    expect(labels).toContain('Basic salary');
    expect(labels).toContain('House rent allowance');
    expect(labels).toContain('Provident fund (employee)');
    expect(labels).toContain('Professional tax');

    // Every line traces to a component or an uploaded input.
    const incentive = payslip.lines.find(
      (l) => l.label === 'INCENTIVE' || l.amountMinor === rupees(6_420),
    );
    expect(incentive?.payrollInputItemId).not.toBeNull();

    // The digest ties the payslip to the data that made it.
    expect(payslip.sourceDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prorates pay when attendance records loss of pay', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance({ lopDays: 3 });
    await submitAttendance();
    await approveAttendance();
    const summary = await validate();
    await calculate(summary.eligibleEmployeeIds);

    const payslip = await db.payslip.findFirstOrThrow({
      where: { payrollCycleId: cycleId },
      include: { lines: true },
    });

    expect(Number(payslip.lopDays)).toBe(3);
    expect(Number(payslip.payableDays)).toBe(28);

    const basic = payslip.lines.find((l) => l.label === 'Basic salary');
    // 86,000 × 28/31
    expect(basic?.amountMinor).toBe(rupees(77_677.42));
    expect(basic?.fullAmountMinor).toBe(rupees(86_000));
    expect(basic?.calculationNote).toContain('28 of 31');
  });

  it('records every transition in the audit trail, in order', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();
    const summary = await validate();
    await calculate(summary.eligibleEmployeeIds);
    await publish();

    const trail = await db.auditEvent.findMany({
      where: { entityType: 'payroll_cycle', entityId: cycleId },
      orderBy: { sequence: 'asc' },
      select: { fromState: true, toState: true },
    });

    expect(trail.map((t) => t.toState)).toEqual([
      'INPUTS_OPEN',
      'INPUTS_LOCKED',
      'ATTENDANCE_SUBMITTED',
      'ATTENDANCE_APPROVED',
      'VALIDATING',
      'VALIDATED',
      'CALCULATING',
      'CALCULATED',
      'APPROVED',
      'PUBLISHED',
    ]);

    // Every step links to the one before it.
    for (let i = 1; i < trail.length; i += 1) {
      expect(trail[i]!.fromState).toBe(trail[i - 1]!.toState);
    }
  });

  it('cannot be cancelled once published', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();
    const summary = await validate();
    await calculate(summary.eligibleEmployeeIds);
    await publish();

    await expect(
      withContext(() => transitionCycle(db, accounts, { cycleId, event: 'CANCEL' }, HMAC)),
    ).rejects.toThrow(/cannot be cancelled/);
  });
});

describe('validation report', () => {
  it('records a reason for every exclusion, with a remedy', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();
    await validate();

    const failures = await db.payrollValidationResult.findMany({
      where: { payrollCycleId: cycleId, passed: false },
    });

    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.message.length).toBeGreaterThan(10);
      expect(failure.remedy).not.toBeNull();
    }
  });

  it('records passing checks too, so silence is not mistaken for success', async () => {
    await uploadInputs();
    await lockInputs();
    await enterAttendance();
    await submitAttendance();
    await approveAttendance();
    await validate();

    const passed = await db.payrollValidationResult.count({
      where: { payrollCycleId: cycleId, passed: true, employeeId: priyaId },
    });
    expect(passed).toBeGreaterThan(0);
  });
});
