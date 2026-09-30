/**
 * How long does payroll take?
 *
 * The calculate endpoint carries a 300-second transaction timeout. That is a
 * ceiling somebody chose, not a measurement, and the difference matters: a
 * serverless function gets ten seconds, and unlike rendering, calculation
 * cannot simply be sliced — a half-calculated run is worse than none, so it is
 * one transaction over every employee or it is a queued job.
 *
 * This builds a real organisation at a given headcount, runs the pipeline the
 * way the application does — through the same service functions the routes
 * call, not a shortcut around them — and times each stage.
 *
 *   npm run bench:payroll -w @widedrop/api            # 50, 200, 500
 *   npm run bench:payroll -w @widedrop/api -- 1000
 *
 * It runs against the **test** database and truncates it first, for the same
 * reason the suite does: seeding a thousand employees into somebody's
 * development data would be difficult to undo. `TEST_DATABASE_URL` guards it —
 * a database whose name does not end in `_test` is refused.
 */
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { loadEnv, type Env } from '../src/config/env.js';
import { createLogger } from '../src/lib/logger.js';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { migrateTestDb, resetTestDb, testDatabaseUrl } from '../src/test/db.js';
import { rebuildReportingClosure, type Principal } from '../src/services/auth/authorization.js';
import {
  decideAttendanceSlice,
  deriveAttendanceRecords,
  openAttendancePeriod,
  submitAttendancePeriod,
} from '../src/services/attendance/service.js';
import { transitionCycle } from '../src/services/payroll/pipeline.js';
import { runValidation } from '../src/services/payroll/validation.js';
import { generatePayroll } from '../src/services/payroll/generation.js';
import { renderPendingPayslips } from '../src/services/payroll/render.js';

const requested = process.argv.slice(2).map(Number).filter(Number.isFinite);
const SIZES = requested.length > 0 ? requested : [50, 200, 500];

/** The budget a serverless function has to fit inside. */
const SERVERLESS_BUDGET_MS = 10_000;

/** Long enough that the benchmark measures the work, not a timeout. */
const TRANSACTION = { timeout: 600_000, maxWait: 60_000 } as const;

/**
 * Its own client, with query events on.
 *
 * Counting statements is half the point: every one of them is a round trip,
 * and this machine's round trip is a loopback socket while production's is a
 * hop to Supabase. A timing taken here is a floor, and the statement count is
 * what turns that floor into an estimate for somewhere else.
 */
const db = new PrismaClient({
  datasourceUrl: testDatabaseUrl(),
  log: [{ emit: 'event', level: 'query' }],
});

let statements = 0;
db.$on('query', () => {
  statements += 1;
});

/** Statements issued while `fn` ran, alongside how long it took. */
async function count<T>(fn: () => Promise<T>): Promise<[T, number, number]> {
  const before = statements;
  const [value, elapsed] = await time(fn);
  return [value, elapsed, statements - before];
}

const env: Env = loadEnv({
  NODE_ENV: 'test',
  PORT: '4000',
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  API_PUBLIC_URL: 'http://127.0.0.1:4000',
  WEB_PUBLIC_URL: 'http://127.0.0.1:5173',
  CORS_ORIGINS: 'http://127.0.0.1:5173',
  DATABASE_URL: testDatabaseUrl(),
  DIRECT_DATABASE_URL: testDatabaseUrl(),
  JWT_PRIVATE_KEY: 'bench-private-key-placeholder',
  JWT_PUBLIC_KEY: 'bench-public-key-placeholder',
  JWT_KEY_ID: 'bench-key-1',
  PASSWORD_PEPPER: 'kQ7vR2mZ9xL4pB8nT6yH3wC5jF1sD0aG',
  ENCRYPTION_KEK: Buffer.alloc(32, 21).toString('base64'),
  ENCRYPTION_KEY_VERSION: 'v1',
  AUDIT_HMAC_KEY: Buffer.alloc(32, 22).toString('base64'),
  COOKIE_SECURE: 'false',
  COOKIE_SAMESITE: 'lax',
  STORAGE_DRIVER: 'filesystem',
  MAIL_DRIVER: 'noop',
  HIBP_ENABLED: 'false',
  TRUST_PROXY: 'false',
});

const logger = createLogger(env);
const HMAC = env.AUDIT_HMAC_KEY;

const rupees = (amount: number): bigint => BigInt(Math.round(amount * 100));
const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`.padStart(8);
const out = (line: string): void => void process.stdout.write(`${line}\n`);

/** Wall-clock around one stage. */
async function time<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, performance.now() - started];
}

interface BenchOrg {
  organizationId: string;
  cycleId: string;
  head: Principal;
  hr: Principal;
  manager: Principal;
  accounts: Principal;
}

/**
 * An organisation of `headcount` people, with everything payroll insists on.
 *
 * Built with `createMany` rather than through the onboarding endpoints: the
 * point is to measure the pipeline, and several thousand round-trips of setup
 * would dominate the number being looked for.
 *
 * The reporting line is deliberately two-level — one head, everybody else
 * reporting to them — because the shape of the tree does not change what
 * calculation costs, and a flat slice keeps attendance approval to one
 * decision per manager.
 */
async function seed(headcount: number): Promise<BenchOrg> {
  await resetTestDb(db);

  const organization = await db.organization.create({
    data: {
      legalName: 'Benchmark Industries Pvt Ltd',
      displayName: 'Benchmark',
      domain: 'benchmark.test',
      helpdeskEmail: 'helpdesk@widedroptech.com',
      employeeNumberPrefix: 'BM',
    },
    select: { id: true },
  });
  const organizationId = organization.id;

  const fiscalYear = await db.fiscalYear.create({
    data: {
      organizationId,
      startYear: 2026,
      label: 'FY 2026–27',
      startDate: new Date('2026-04-01'),
      endDate: new Date('2027-03-31'),
    },
    select: { id: true },
  });

  const calendar = await db.holidayCalendar.create({
    data: { organizationId, name: 'India 2026', year: 2026, weekOffDays: [6, 7] },
    select: { id: true },
  });

  await db.holiday.create({
    data: {
      organizationId,
      holidayCalendarId: calendar.id,
      date: new Date('2026-10-02'),
      name: 'Gandhi Jayanti',
      kind: 'PUBLIC',
    },
  });

  const [department, designation, location] = await Promise.all([
    db.department.create({
      data: { organizationId, code: 'PLAT', name: 'Platform Engineering' },
      select: { id: true },
    }),
    db.designation.create({
      data: { organizationId, code: 'SSE', title: 'Senior Software Engineer', grade: 5 },
      select: { id: true },
    }),
    db.location.create({
      data: {
        organizationId,
        code: 'BLR',
        name: 'Bengaluru',
        city: 'Bengaluru',
        stateCode: 'KA',
        holidayCalendarId: calendar.id,
      },
      select: { id: true },
    }),
  ]);

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
    select: { id: true },
  });

  const componentIds: Record<string, string> = {};
  for (const spec of [
    { code: 'BASIC', name: 'Basic salary', calc: 'PRORATED_FIXED', order: 1, pf: true },
    { code: 'HRA', name: 'House rent allowance', calc: 'PERCENT_OF_BASIC', order: 2, rate: 0.5 },
    { code: 'SPECIAL', name: 'Special allowance', calc: 'PRORATED_FIXED', order: 3 },
  ] as const) {
    const created = await db.payComponent.create({
      data: {
        organizationId,
        code: spec.code,
        name: spec.name,
        kind: 'EARNING',
        calc: spec.calc,
        rate: 'rate' in spec ? spec.rate : null,
        isProrated: true,
        isPfApplicable: 'pf' in spec ? spec.pf : false,
        displayOrder: spec.order,
      },
      select: { id: true },
    });
    componentIds[spec.code] = created.id;
  }

  /* People. Created one at a time because `employeeNumber` and the generated
     `fullName` both come back from the insert and are needed below. */
  const employeeIds: string[] = [];
  for (let i = 0; i < headcount; i += 1) {
    const employee = await db.employee.create({
      data: {
        organizationId,
        employeeNumber: `BM-${String(10_000 + i)}`,
        firstName: 'Person',
        lastName: String(i).padStart(5, '0'),
        workEmail: `person${i}@benchmark.test`,
        dateOfJoining: new Date('2024-07-11'),
        employmentStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    employeeIds.push(employee.id);
  }

  const headId = employeeIds[0]!;
  const reports = employeeIds.slice(1);

  await db.employeeEmployment.createMany({
    data: employeeIds.map((employeeId) => ({
      organizationId,
      employeeId,
      departmentId: department.id,
      designationId: designation.id,
      locationId: location.id,
      employmentType: 'FULL_TIME_PERMANENT' as const,
      effectiveFrom: new Date('2024-07-11'),
    })),
  });

  await db.employeeManager.createMany({
    data: reports.map((employeeId) => ({
      organizationId,
      employeeId,
      managerEmployeeId: headId,
      isPrimary: true,
      effectiveFrom: new Date('2024-07-11'),
    })),
  });

  await rebuildReportingClosure(db, organizationId);

  /* What validation insists on before it will let a cycle be calculated. */
  await db.employeeBankAccount.createMany({
    data: employeeIds.map((employeeId, i) => ({
      organizationId,
      employeeId,
      bankName: 'HDFC Bank',
      accountNumberCt: Buffer.from('ct'),
      accountNumberIv: Buffer.from('iv'),
      accountNumberTag: Buffer.from('tag'),
      accountNumberMasked: '•• •••• •••• 4412',
      accountNumberFingerprint: `fp-acct-${i}`,
      ifscCt: Buffer.from('ct'),
      ifscIv: Buffer.from('iv'),
      ifscTag: Buffer.from('tag'),
      ifscMasked: 'HDFC000••••',
      accountHolderName: `Person ${i}`,
      verifiedAt: new Date('2024-07-20'),
    })),
  });

  await db.employeeStatutoryId.createMany({
    data: employeeIds.flatMap((employeeId, i) =>
      (['PAN', 'UAN'] as const).map((kind) => ({
        organizationId,
        employeeId,
        kind,
        valueCt: Buffer.from('ct'),
        valueIv: Buffer.from('iv'),
        valueTag: Buffer.from('tag'),
        maskedValue: kind === 'PAN' ? 'AXYPR••••K' : '•••• 7890',
        fingerprint: `fp-${kind}-${i}`,
        verifiedAt: new Date('2024-07-20'),
      })),
    ),
  });

  await db.employeeTaxRegimeElection.createMany({
    data: employeeIds.map((employeeId) => ({
      organizationId,
      employeeId,
      fiscalYearId: fiscalYear.id,
      taxRegimeId: regime.id,
    })),
  });

  /* Salary structures, then their components: the components need the ids
     back, so this is two passes rather than one. */
  await db.salaryStructure.createMany({
    data: employeeIds.map((employeeId) => ({
      organizationId,
      employeeId,
      effectiveFrom: new Date('2026-04-01'),
      annualCtcMinor: rupees(1_800_000),
    })),
  });

  const structures = await db.salaryStructure.findMany({
    where: { organizationId },
    select: { id: true },
  });

  await db.salaryStructureComponent.createMany({
    data: structures.flatMap((structure) => [
      {
        organizationId,
        salaryStructureId: structure.id,
        payComponentId: componentIds.BASIC!,
        monthlyAmountMinor: rupees(60_000),
      },
      { organizationId, salaryStructureId: structure.id, payComponentId: componentIds.HRA! },
      {
        organizationId,
        salaryStructureId: structure.id,
        payComponentId: componentIds.SPECIAL!,
        monthlyAmountMinor: rupees(30_000),
      },
    ]),
  });

  const cycle = await db.payrollCycle.create({
    data: {
      organizationId,
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

  /* Sign-in accounts for the people who act in the pipeline. Real rows,
     because an approval records the user who made it and that column carries
     a foreign key. */
  const [headUser, hrUser, accountsUser] = await Promise.all([
    db.appUser.create({
      data: { organizationId, email: 'head@benchmark.test', status: 'ACTIVE', passwordHash: 'x' },
      select: { id: true },
    }),
    db.appUser.create({
      data: { organizationId, email: 'hr@benchmark.test', status: 'ACTIVE', passwordHash: 'x' },
      select: { id: true },
    }),
    db.appUser.create({
      data: {
        organizationId,
        email: 'accounts@benchmark.test',
        status: 'ACTIVE',
        passwordHash: 'x',
      },
      select: { id: true },
    }),
  ]);

  const hrEmployeeId = employeeIds[1] ?? headId;
  await db.employee.update({ where: { id: headId }, data: { appUserId: headUser.id } });
  await db.employee.update({ where: { id: hrEmployeeId }, data: { appUserId: hrUser.id } });

  /* Who approves the head's attendance. The head reports to nobody, so
     without this the period cannot be submitted at all — which is exactly
     what an organisation has to configure before its first payroll run. */
  await db.organization.update({
    where: { id: organizationId },
    data: { attendanceApproverEmployeeId: hrEmployeeId },
  });

  const principal = (
    userId: string,
    employeeId: string,
    personas: Principal['personas'],
  ): Principal => ({
    userId,
    organizationId,
    employeeId,
    personas,
    sessionId: '00000000-0000-4000-8000-0000000000ff',
    mfaSatisfied: true,
  });

  return {
    organizationId,
    cycleId: cycle.id,
    head: principal(headUser.id, headId, ['EMPLOYEE', 'MANAGER']),
    hr: principal(hrUser.id, hrEmployeeId, ['EMPLOYEE', 'HR']),
    manager: principal(headUser.id, headId, ['EMPLOYEE', 'MANAGER']),
    accounts: principal(accountsUser.id, hrEmployeeId, ['EMPLOYEE', 'ACCOUNTS']),
  };
}

async function measure(headcount: number): Promise<void> {
  out(`\n${'─'.repeat(74)}\n  ${headcount} employees\n${'─'.repeat(74)}`);

  const [org, seedMs] = await time(() => seed(headcount));
  out(`  seed              ${seconds(seedMs)}   setup, not part of the measurement`);

  const { organizationId, cycleId, hr, accounts } = org;

  /* Attendance: open, derive, submit, approve every slice. */
  const [, attendanceMs] = await time(async () => {
    const period = await db.$transaction(
      (tx) => openAttendancePeriod(tx, hr, { year: 2026, month: 10 }, HMAC),
      TRANSACTION,
    );

    await db.payrollCycle.update({
      where: { id: cycleId },
      data: { attendancePeriodId: period.id },
    });

    await db.$transaction(
      (tx) => deriveAttendanceRecords(tx, hr, { periodId: period.id }, HMAC),
      TRANSACTION,
    );
    await db.$transaction(
      (tx) => submitAttendancePeriod(tx, hr, { periodId: period.id }, HMAC),
      TRANSACTION,
    );

    /* One decision per manager with a pending slice — the same call the
       manager's own review screen makes. */
    const pending = await db.attendanceApproval.findMany({
      where: { attendancePeriodId: period.id, status: 'PENDING' },
      select: { managerEmployeeId: true, manager: { select: { appUserId: true } } },
    });

    for (const slice of pending) {
      const decider: Principal = {
        userId: slice.manager.appUserId ?? org.head.userId,
        organizationId,
        employeeId: slice.managerEmployeeId,
        personas: ['EMPLOYEE', 'MANAGER'],
        sessionId: org.head.sessionId,
        mfaSatisfied: true,
      };
      await db.$transaction(
        (tx) => decideAttendanceSlice(tx, decider, { periodId: period.id, approve: true }, HMAC),
        TRANSACTION,
      );
    }
  });
  out(`  attendance        ${seconds(attendanceMs)}   open, derive, submit, approve`);

  /* Walk the cycle up to the point of validation. These are the state
     transitions the Accounts and HR screens raise; none of them touches an
     employee row, so they are setup rather than measurement. */
  await db.$transaction(async (tx) => {
    await transitionCycle(tx, accounts, { cycleId, event: 'UPLOAD_INPUTS' }, HMAC, {
      systemRaised: true,
    });

    // The cycle will not lock its inputs until a batch has been committed
    // against it, which is the guard that makes "Accounts uploads payroll
    // data" the first step of the pipeline rather than an optional one.
    await tx.payrollInputBatch.create({
      data: {
        organizationId,
        payrollCycleId: cycleId,
        status: 'COMMITTED',
        originalFilename: 'october-2026-inputs.csv',
        rowCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        uploadedByUserId: accounts.userId,
        committedAt: new Date(),
      },
    });

    for (const event of ['LOCK_INPUTS', 'SUBMIT_ATTENDANCE', 'APPROVE_ATTENDANCE'] as const) {
      await transitionCycle(tx, accounts, { cycleId, event }, HMAC, { systemRaised: true });
    }
  }, TRANSACTION);

  const [validation, validateMs, validateQueries] = await count(() =>
    db.$transaction(async (tx) => {
      await transitionCycle(tx, accounts, { cycleId, event: 'VALIDATE' }, HMAC);
      return runValidation(tx, { organizationId, payrollCycleId: cycleId });
    }, TRANSACTION),
  );
  out(
    `  validate          ${seconds(validateMs)}   ${validation.employeesPassing} of ` +
      `${validation.employeesInScope} eligible, ${validation.failures.length} failed checks` +
      `, ${validateQueries} statements`,
  );

  await db.$transaction(
    (tx) =>
      transitionCycle(tx, accounts, { cycleId, event: 'VALIDATION_PASSED' }, HMAC, {
        systemRaised: true,
      }),
    TRANSACTION,
  );

  /* The one that matters. One transaction over every employee, because a
     half-calculated run is worse than none — so unlike rendering it cannot be
     split across invocations. */
  const [generated, calculateMs, calculateQueries] = await count(() =>
    db.$transaction(async (tx) => {
      await transitionCycle(tx, accounts, { cycleId, event: 'CALCULATE' }, HMAC);
      return generatePayroll(
        tx,
        accounts,
        { cycleId, eligibleEmployeeIds: validation.eligibleEmployeeIds },
        HMAC,
      );
    }, TRANSACTION),
  );

  const verdict =
    calculateMs > SERVERLESS_BUDGET_MS
      ? '  ← OVER a 10s function'
      : calculateMs > SERVERLESS_BUDGET_MS * 0.6
        ? '  ← close to a 10s function'
        : '';
  out(
    `  calculate         ${seconds(calculateMs)}   ${generated.payslipsCreated} payslips, ` +
      `${calculateQueries} statements${verdict}`,
  );

  const [rendered, renderMs] = await time(() =>
    renderPendingPayslips(db, env, { organizationId, cycleId, limit: headcount }),
  );
  const each = renderMs / Math.max(rendered.rendered, 1);
  out(
    `  render            ${seconds(renderMs)}   ${rendered.rendered} documents, ` +
      `${each.toFixed(0)}ms each (local disk)`,
  );

  const paid = Math.max(generated.payslipsCreated, 1);
  const per = calculateMs / paid;
  const trips = calculateQueries / paid;
  out(
    `\n  calculation costs ${per.toFixed(1)}ms and ${trips.toFixed(1)} statements per ` +
      `employee; a 10s function fits about ${Math.floor(SERVERLESS_BUDGET_MS / per)} here.`,
  );

  // What the same work costs once each statement crosses a network. Supabase
  // in the same region is roughly 1–3ms; the pooler adds to that.
  for (const latency of [1, 2]) {
    const fits = Math.floor(SERVERLESS_BUDGET_MS / (per + trips * latency));
    out(`    at ${latency}ms per statement, about ${fits}.`);
  }
}

async function main(): Promise<void> {
  out('Payroll timings, against the test database.');
  out(
    'Storage is local here, so rendering is faster than it will be against ' +
      'Supabase; see docs/GO-LIVE.md §1.',
  );

  migrateTestDb();
  for (const headcount of SIZES) await measure(headcount);
  out('');
}

main()
  .catch((error: unknown) => {
    logger.error({ err: error }, 'benchmark failed');
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
