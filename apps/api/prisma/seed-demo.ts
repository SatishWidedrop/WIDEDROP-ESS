/**
 * Demonstration data.
 *
 * Explicitly separate from the reference seed and refuses to run in production,
 * because everything it creates is *operational* data — people, attendance,
 * payroll, leave — and inventing that in a live system is exactly what the
 * requirement forbids.
 *
 * It exists for one reason: to exercise the real pipeline end to end. It does
 * not insert payslips. It uploads payroll inputs as Accounts, submits
 * attendance as HR, approves it as each manager, runs validation, runs the
 * calculation engine and publishes the cycle — the same code paths the portal
 * uses. A payslip only appears because the workflow produced one.
 *
 *   npm run db:seed:demo -w @widedrop/api
 */
import { randomUUID } from 'node:crypto';
import { daysInMonth } from '@widedrop/shared';
import { PrismaClient } from '../src/generated/prisma/index.js';
import { loadEnv } from '../src/config/env.js';
import { hashPassword } from '../src/lib/password.js';
import { EncryptionService } from '../src/services/encryption.js';
import { runAsSystem } from '../src/lib/request-context.js';
import { transitionCycle } from '../src/services/payroll/pipeline.js';
import { runValidation } from '../src/services/payroll/validation.js';
import { refreshPayslipRollups } from '../src/services/payroll/rollups.js';
import { generatePayroll } from '../src/services/payroll/generation.js';
import { renderPendingPayslips } from '../src/services/payroll/render.js';
import { rebuildReportingClosure, type Principal } from '../src/services/auth/authorization.js';

const prisma = new PrismaClient();
const rupees = (amount: number) => BigInt(Math.round(amount * 100));

/** The demonstration password. Every account shares it; none can reach production. */
const DEMO_PASSWORD = 'widedrop demo passphrase 2026';

async function main(): Promise<void> {
  const env = loadEnv();

  if (env.NODE_ENV === 'production') {
    console.error(
      'Refusing to run: this seed creates operational data (people, attendance, payroll).\n' +
        'Production starts empty and fills only through real work.',
    );
    process.exitCode = 1;
    return;
  }

  // Resolved by domain, the way the reference seed creates it. Taking whichever
  // organisation happens to be oldest once picked up a leftover test fixture
  // and then failed deep inside the salary structures, because that
  // organisation had no pay components.
  const domain = process.env.SEED_ORG_DOMAIN ?? 'widedrop.com';
  const organization = await prisma.organization.findUnique({ where: { domain } });
  if (!organization) {
    console.error(
      `No organisation with domain ${domain}. Run the reference seed first:\n` +
        '  npm run db:seed:reference -w @widedrop/api',
    );
    process.exitCode = 1;
    return;
  }

  const componentCount = await prisma.payComponent.count({
    where: { organizationId: organization.id },
  });
  if (componentCount === 0) {
    console.error(
      `${organization.displayName} has no pay components, so payroll cannot run.\n` +
        'Run the reference seed first: npm run db:seed:reference -w @widedrop/api',
    );
    process.exitCode = 1;
    return;
  }

  const encryption = new EncryptionService(env);
  console.log(`Seeding demonstration data into ${organization.displayName}…\n`);

  /* ---------------------------------------------------------------- */
  /* Organisation structure                                            */
  /* ---------------------------------------------------------------- */

  const departments = await upsertMany(
    [
      { code: 'PLAT', name: 'Platform Engineering', accentColor: '#1B365D' },
      { code: 'DESIGN', name: 'Design', accentColor: '#3B2A5C' },
      { code: 'PEOPLE', name: 'People Ops', accentColor: '#14332A' },
      { code: 'FIN', name: 'Finance', accentColor: '#3A2D12' },
      { code: 'QA', name: 'Quality', accentColor: '#1F3A45' },
      { code: 'LEAD', name: 'Leadership', accentColor: '#3B1E1E' },
    ],
    (row) =>
      prisma.department.upsert({
        where: { organizationId_code: { organizationId: organization.id, code: row.code } },
        update: { accentColor: row.accentColor },
        create: { organizationId: organization.id, ...row },
      }),
  );

  const locations = await upsertMany(
    [
      { code: 'BLR', name: 'Bengaluru · Ecospace Campus', city: 'Bengaluru', stateCode: 'KA' },
      { code: 'PNQ', name: 'Pune', city: 'Pune', stateCode: 'MH' },
      { code: 'HYD', name: 'Hyderabad', city: 'Hyderabad', stateCode: 'TS' },
      { code: 'MAA', name: 'Chennai', city: 'Chennai', stateCode: 'TN' },
      { code: 'GGN', name: 'Gurugram', city: 'Gurugram', stateCode: 'HR' },
    ],
    (row) =>
      prisma.location.upsert({
        where: { organizationId_code: { organizationId: organization.id, code: row.code } },
        update: {},
        create: { organizationId: organization.id, ...row },
      }),
  );

  const designations = await upsertMany(
    [
      { code: 'CTO', title: 'Chief Technology Officer', grade: 10 },
      { code: 'EM', title: 'Engineering Manager', grade: 7 },
      { code: 'SSE', title: 'Senior Software Engineer', grade: 5 },
      { code: 'SE2', title: 'Software Engineer II', grade: 4 },
      { code: 'SE', title: 'Software Engineer', grade: 3 },
      { code: 'DEVOPS', title: 'DevOps Engineer', grade: 4 },
      { code: 'PD', title: 'Product Designer', grade: 4 },
      { code: 'HOP', title: 'Head of People', grade: 8 },
      { code: 'HRBP', title: 'HR Business Partner', grade: 5 },
      { code: 'FM', title: 'Finance Manager', grade: 7 },
      { code: 'PAY', title: 'Payroll Specialist', grade: 4 },
      { code: 'QAL', title: 'QA Lead', grade: 6 },
    ],
    (row) =>
      prisma.designation.upsert({
        where: { organizationId_code: { organizationId: organization.id, code: row.code } },
        update: {},
        create: { organizationId: organization.id, ...row },
      }),
  );

  const costCentre = await prisma.costCentre.upsert({
    where: { organizationId_code: { organizationId: organization.id, code: 'CC-4120' } },
    update: {},
    create: { organizationId: organization.id, code: 'CC-4120', name: 'Platform' },
  });

  console.log(
    `  structure: ${departments.size} departments, ${locations.size} locations, ${designations.size} designations`,
  );

  /* ---------------------------------------------------------------- */
  /* Holiday calendar                                                  */
  /* ---------------------------------------------------------------- */

  const year = new Date().getUTCFullYear();
  const calendar = await prisma.holidayCalendar.upsert({
    where: {
      organizationId_name_year: { organizationId: organization.id, name: 'India', year },
    },
    update: {},
    create: {
      organizationId: organization.id,
      name: 'India',
      year,
      weekOffDays: [6, 7],
    },
  });

  for (const [month, day, name, kind] of [
    [1, 26, 'Republic Day', 'PUBLIC'],
    [3, 14, 'Holi', 'PUBLIC'],
    [8, 15, 'Independence Day', 'PUBLIC'],
    [10, 2, 'Gandhi Jayanti', 'PUBLIC'],
    [10, 20, 'Dussehra · Vijaya Dashami', 'PUBLIC'],
    [11, 9, 'Diwali (observed)', 'PUBLIC'],
    [11, 8, 'Diwali', 'RESTRICTED'],
    [12, 25, 'Christmas', 'PUBLIC'],
  ] as const) {
    await prisma.holiday.upsert({
      where: {
        holidayCalendarId_date_name: {
          holidayCalendarId: calendar.id,
          date: new Date(Date.UTC(year, month - 1, day)),
          name,
        },
      },
      update: {},
      create: {
        organizationId: organization.id,
        holidayCalendarId: calendar.id,
        date: new Date(Date.UTC(year, month - 1, day)),
        name,
        kind,
      },
    });
  }

  await prisma.location.updateMany({
    where: { organizationId: organization.id },
    data: { holidayCalendarId: calendar.id },
  });

  console.log('  holiday calendar: 8 holidays');

  /* ---------------------------------------------------------------- */
  /* People                                                            */
  /* ---------------------------------------------------------------- */

  interface PersonSpec {
    code: string;
    first: string;
    last: string;
    designation: string;
    department: string;
    location: string;
    manager?: string;
    personas: ('EMPLOYEE' | 'MANAGER' | 'HR' | 'ACCOUNTS')[];
    ctc: number;
    basic: number;
    joined: string;
  }

  const people: PersonSpec[] = [
    {
      code: '00001',
      first: 'Sameer',
      last: 'Joshi',
      designation: 'CTO',
      department: 'LEAD',
      location: 'BLR',
      personas: ['EMPLOYEE', 'MANAGER'],
      ctc: 9_600_000,
      basic: 320_000,
      joined: '2019-02-04',
    },
    {
      code: '01001',
      first: 'Arjun',
      last: 'Malhotra',
      designation: 'EM',
      department: 'PLAT',
      location: 'BLR',
      manager: '00001',
      personas: ['EMPLOYEE', 'MANAGER'],
      ctc: 4_800_000,
      basic: 160_000,
      joined: '2020-01-06',
    },
    {
      code: '01847',
      first: 'Priya',
      last: 'Raghavan',
      designation: 'SSE',
      department: 'PLAT',
      location: 'BLR',
      manager: '01001',
      personas: ['EMPLOYEE', 'MANAGER'],
      ctc: 2_640_000,
      basic: 86_000,
      joined: '2022-07-11',
    },
    {
      code: '02104',
      first: 'Neha',
      last: 'Kulkarni',
      designation: 'SE2',
      department: 'PLAT',
      location: 'BLR',
      manager: '01847',
      personas: ['EMPLOYEE'],
      ctc: 1_800_000,
      basic: 60_000,
      joined: '2023-03-13',
    },
    {
      code: '02210',
      first: 'Rahul',
      last: 'Verma',
      designation: 'SE',
      department: 'PLAT',
      location: 'PNQ',
      manager: '01847',
      personas: ['EMPLOYEE'],
      ctc: 1_380_000,
      basic: 46_000,
      joined: '2023-09-04',
    },
    {
      code: '02318',
      first: 'Farhan',
      last: 'Qureshi',
      designation: 'DEVOPS',
      department: 'PLAT',
      location: 'HYD',
      manager: '01847',
      personas: ['EMPLOYEE'],
      ctc: 1_680_000,
      basic: 56_000,
      joined: '2024-01-15',
    },
    {
      code: '03011',
      first: 'Sneha',
      last: 'Nair',
      designation: 'PD',
      department: 'DESIGN',
      location: 'BLR',
      manager: '00001',
      personas: ['EMPLOYEE'],
      ctc: 1_920_000,
      basic: 64_000,
      joined: '2022-11-07',
    },
    {
      code: '04001',
      first: 'Vikram',
      last: 'Shetty',
      designation: 'HOP',
      department: 'PEOPLE',
      location: 'BLR',
      manager: '00001',
      personas: ['EMPLOYEE', 'MANAGER', 'HR'],
      ctc: 4_200_000,
      basic: 140_000,
      joined: '2020-06-01',
    },
    {
      code: '04102',
      first: 'Ananya',
      last: 'Bose',
      designation: 'HRBP',
      department: 'PEOPLE',
      location: 'BLR',
      manager: '04001',
      personas: ['EMPLOYEE', 'HR'],
      ctc: 2_160_000,
      basic: 72_000,
      joined: '2021-08-23',
    },
    {
      code: '05001',
      first: 'Karan',
      last: 'Gill',
      designation: 'FM',
      department: 'FIN',
      location: 'GGN',
      manager: '00001',
      personas: ['EMPLOYEE', 'MANAGER', 'ACCOUNTS'],
      ctc: 3_960_000,
      basic: 132_000,
      joined: '2021-02-15',
    },
    {
      code: '05114',
      first: 'Meera',
      last: 'Krishnan',
      designation: 'PAY',
      department: 'FIN',
      location: 'BLR',
      manager: '05001',
      personas: ['EMPLOYEE', 'ACCOUNTS'],
      ctc: 1_560_000,
      basic: 52_000,
      joined: '2023-05-08',
    },
    {
      code: '06001',
      first: 'Divya',
      last: 'Menon',
      designation: 'QAL',
      department: 'QA',
      location: 'MAA',
      manager: '00001',
      personas: ['EMPLOYEE', 'MANAGER'],
      ctc: 2_280_000,
      basic: 76_000,
      joined: '2021-11-29',
    },
  ];

  const roles = new Map(
    (await prisma.role.findMany({ select: { id: true, persona: true } })).map((r) => [
      r.persona,
      r.id,
    ]),
  );

  const passwordHash = await hashPassword(DEMO_PASSWORD, env.PASSWORD_PEPPER);
  const employeeIds = new Map<string, string>();
  const fiscalYear = await prisma.fiscalYear.findFirstOrThrow({
    where: { organizationId: organization.id, startYear: currentFiscalYearStart() },
  });
  const newRegime = await prisma.taxRegime.findFirstOrThrow({
    where: { code: 'NEW', fiscalYearStartYear: fiscalYear.startYear },
  });

  for (const person of people) {
    const employeeNumber = `${organization.employeeNumberPrefix}-${person.code}`;
    const email = `${person.first.toLowerCase()}.${person.last.toLowerCase()}@${organization.domain}`;

    const existing = await prisma.employee.findFirst({
      where: { organizationId: organization.id, employeeNumber },
      select: { id: true },
    });
    if (existing) {
      employeeIds.set(person.code, existing.id);
      continue;
    }

    const user = await prisma.appUser.create({
      data: {
        organizationId: organization.id,
        email,
        status: 'ACTIVE',
        passwordHash,
        passwordUpdatedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });

    const employee = await prisma.employee.create({
      data: {
        organizationId: organization.id,
        appUserId: user.id,
        employeeNumber,
        firstName: person.first,
        lastName: person.last,
        workEmail: email,
        workPhone: `+9198${person.code}0000`.slice(0, 15),
        dateOfJoining: new Date(person.joined),
        employmentStatus: 'ACTIVE',
      },
      select: { id: true },
    });
    employeeIds.set(person.code, employee.id);

    await prisma.employeeEmployment.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        departmentId: departments.get(person.department)!,
        designationId: designations.get(person.designation)!,
        locationId: locations.get(person.location)!,
        costCentreId: person.department === 'PLAT' ? costCentre.id : null,
        employmentType: 'FULL_TIME_PERMANENT',
        noticePeriodDays: 60,
        effectiveFrom: new Date(person.joined),
      },
    });

    for (const persona of person.personas) {
      await prisma.userRole.create({ data: { appUserId: user.id, roleId: roles.get(persona)! } });
    }

    // Everything payroll validates on.
    const bankAccountId = randomUUID();
    const account = `5010041234${person.code}`;
    const accountSealed = encryption.encrypt(
      account,
      EncryptionService.context('employee_bank_account', 'account_number', bankAccountId),
    );
    const ifscSealed = encryption.encrypt(
      'HDFC0000523',
      EncryptionService.context('employee_bank_account', 'ifsc', bankAccountId),
    );

    await prisma.employeeBankAccount.create({
      data: {
        id: bankAccountId,
        organizationId: organization.id,
        employeeId: employee.id,
        bankName: 'HDFC Bank',
        accountNumberCt: accountSealed.ct,
        accountNumberIv: accountSealed.iv,
        accountNumberTag: accountSealed.tag,
        accountNumberMasked: encryption.mask(account, 'account'),
        accountNumberFingerprint: encryption.fingerprint(account),
        ifscCt: ifscSealed.ct,
        ifscIv: ifscSealed.iv,
        ifscTag: ifscSealed.tag,
        ifscMasked: 'HDFC000••••',
        accountHolderName: `${person.first} ${person.last}`,
        encryptionKeyVersion: accountSealed.keyVersion,
        verifiedAt: new Date(person.joined),
      },
    });

    for (const [kind, value] of [
      ['PAN', panFor(person.first, person.last, person.code)],
      ['UAN', `10${person.code}${person.code.slice(0, 5)}`.slice(0, 12).padEnd(12, '0')],
    ] as const) {
      const statutoryId = randomUUID();
      const sealed = encryption.encrypt(
        value,
        EncryptionService.context('employee_statutory_id', 'value', statutoryId),
      );
      await prisma.employeeStatutoryId.create({
        data: {
          id: statutoryId,
          organizationId: organization.id,
          employeeId: employee.id,
          kind,
          valueCt: sealed.ct,
          valueIv: sealed.iv,
          valueTag: sealed.tag,
          maskedValue: encryption.mask(value, kind === 'PAN' ? 'pan' : 'uan'),
          fingerprint: encryption.fingerprint(value),
          encryptionKeyVersion: sealed.keyVersion,
          verifiedAt: new Date(person.joined),
        },
      });
    }

    await prisma.employeeTaxRegimeElection.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        fiscalYearId: fiscalYear.id,
        taxRegimeId: newRegime.id,
      },
    });

    // Salary structure: basic, half of basic as house rent allowance, a fixed
    // conveyance allowance, and the remainder of the monthly CTC as special
    // allowance — so the structure actually adds up to the stated package.
    const monthlyCtc = person.ctc / 12;
    const hra = person.basic * 0.5;
    const conveyance = 1_600;
    const special = Math.max(0, monthlyCtc - person.basic - hra - conveyance);

    const structure = await prisma.salaryStructure.create({
      data: {
        organizationId: organization.id,
        employeeId: employee.id,
        effectiveFrom: new Date(`${fiscalYear.startYear}-04-01`),
        annualCtcMinor: rupees(person.ctc),
      },
      select: { id: true },
    });

    const components = await prisma.payComponent.findMany({
      where: {
        organizationId: organization.id,
        code: { in: ['BASIC', 'HRA', 'SPECIAL', 'CONVEYANCE'] },
      },
      select: { id: true, code: true },
    });
    const byCode = new Map(components.map((c) => [c.code, c.id]));

    await prisma.salaryStructureComponent.createMany({
      data: [
        {
          organizationId: organization.id,
          salaryStructureId: structure.id,
          payComponentId: byCode.get('BASIC')!,
          monthlyAmountMinor: rupees(person.basic),
        },
        {
          organizationId: organization.id,
          salaryStructureId: structure.id,
          payComponentId: byCode.get('HRA')!,
        },
        {
          organizationId: organization.id,
          salaryStructureId: structure.id,
          payComponentId: byCode.get('SPECIAL')!,
          monthlyAmountMinor: rupees(special),
        },
        {
          organizationId: organization.id,
          salaryStructureId: structure.id,
          payComponentId: byCode.get('CONVEYANCE')!,
          monthlyAmountMinor: rupees(conveyance),
        },
      ],
    });
  }

  // Reporting lines, then the closure the authorization checks read.
  for (const person of people) {
    if (!person.manager) continue;
    const employeeId = employeeIds.get(person.code)!;
    const managerId = employeeIds.get(person.manager)!;
    const existing = await prisma.employeeManager.findFirst({
      where: { employeeId, effectiveTo: null },
    });
    if (existing) continue;
    await prisma.employeeManager.create({
      data: {
        organizationId: organization.id,
        employeeId,
        managerEmployeeId: managerId,
        isPrimary: true,
        effectiveFrom: new Date(person.joined),
      },
    });
  }
  await rebuildReportingClosure(prisma, organization.id);

  console.log(
    `  people: ${people.length}, each with a verified bank account, PAN, UAN, tax election and salary structure`,
  );

  /* ---------------------------------------------------------------- */
  /* Leave entitlements                                                */
  /* ---------------------------------------------------------------- */

  const leavePeriod = await prisma.leavePeriod.upsert({
    where: {
      organizationId_startDate: {
        organizationId: organization.id,
        startDate: new Date(Date.UTC(year, 0, 1)),
      },
    },
    update: {},
    create: {
      organizationId: organization.id,
      name: String(year),
      startDate: new Date(Date.UTC(year, 0, 1)),
      endDate: new Date(Date.UTC(year, 11, 31)),
    },
  });

  const leaveTypes = await prisma.leaveType.findMany({
    where: { organizationId: organization.id, code: { in: ['EL', 'CL', 'SL', 'COMP', 'RH'] } },
  });

  const entitlements: Record<string, number> = { EL: 18, CL: 12, SL: 10, COMP: 1, RH: 2 };

  for (const [code, employeeId] of employeeIds) {
    void code;
    for (const leaveType of leaveTypes) {
      const entitlement = entitlements[leaveType.code] ?? 0;
      const existing = await prisma.leaveBalance.findFirst({
        where: { employeeId, leaveTypeId: leaveType.id, leavePeriodId: leavePeriod.id },
      });
      if (existing) continue;

      // The ledger is the record; the balance is its projection. Both are
      // written, so a balance can always be explained by its movements.
      await prisma.leaveBalanceLedger.create({
        data: {
          organizationId: organization.id,
          employeeId,
          leaveTypeId: leaveType.id,
          leavePeriodId: leavePeriod.id,
          kind: 'OPENING',
          deltaDays: entitlement,
          effectiveOn: new Date(Date.UTC(year, 0, 1)),
          note: 'Opening entitlement for the leave year',
        },
      });

      await prisma.leaveBalance.create({
        data: {
          organizationId: organization.id,
          employeeId,
          leaveTypeId: leaveType.id,
          leavePeriodId: leavePeriod.id,
          openingDays: entitlement,
          entitlementDays: entitlement,
        },
      });
    }
  }

  console.log(`  leave: entitlements opened for ${employeeIds.size} people`);

  /* ---------------------------------------------------------------- */
  /* Payroll, through the real pipeline                                */
  /* ---------------------------------------------------------------- */

  const accountsEmployeeId = employeeIds.get('05001')!;
  const hrEmployeeId = employeeIds.get('04102')!;

  const accountsUserId = (
    await prisma.employee.findUniqueOrThrow({
      where: { id: accountsEmployeeId },
      select: { appUserId: true },
    })
  ).appUserId!;
  const hrUserId = (
    await prisma.employee.findUniqueOrThrow({
      where: { id: hrEmployeeId },
      select: { appUserId: true },
    })
  ).appUserId!;

  const actor = (
    userId: string,
    employeeId: string,
    personas: Principal['personas'],
  ): Principal => ({
    userId,
    organizationId: organization.id,
    employeeId,
    personas,
    sessionId: randomUUID(),
    mfaSatisfied: true,
  });

  const accounts = actor(accountsUserId, accountsEmployeeId, ['EMPLOYEE', 'MANAGER', 'ACCOUNTS']);
  const hr = actor(hrUserId, hrEmployeeId, ['EMPLOYEE', 'HR']);

  // Three consecutive months, each driven through the whole workflow.
  const now = new Date();
  for (let monthsBack = 3; monthsBack >= 1; monthsBack -= 1) {
    const period = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsBack, 1));
    await runOneCycle({
      organizationId: organization.id,
      year: period.getUTCFullYear(),
      month: period.getUTCMonth() + 1,
      employeeIds: [...employeeIds.values()],
      people,
      employeeIdByCode: employeeIds,
      accounts,
      hr,
      hmacKey: env.AUDIT_HMAC_KEY,
    });
  }

  console.log('\nDemonstration data seeded.');
  console.log(`Every account signs in with: ${DEMO_PASSWORD}`);
  console.log('  priya.raghavan@' + organization.domain + '  employee and manager');
  console.log('  ananya.bose@' + organization.domain + '      HR');
  console.log('  karan.gill@' + organization.domain + '       Accounts');
  console.log('\nPayslips exist because the pipeline produced them, not because');
  console.log('this script wrote them: inputs uploaded, attendance submitted and');
  console.log('approved, validation run, payroll calculated, cycle published.');
}

/** One payroll month, through the same service calls the portal makes. */
async function runOneCycle(input: {
  organizationId: string;
  year: number;
  month: number;
  employeeIds: string[];
  people: { code: string; manager?: string }[];
  employeeIdByCode: Map<string, string>;
  accounts: Principal;
  hr: Principal;
  hmacKey: string;
}): Promise<void> {
  const { organizationId, year, month, hmacKey } = input;
  const label = new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)));

  const existing = await prisma.payrollCycle.findFirst({
    where: { organizationId, year, month, runType: 'REGULAR' },
  });
  if (existing) {
    // Already run. The pipeline is not repeated — a published cycle is a
    // business record, not something a seed may redo — but the projections
    // are refreshed, so re-running the seed after a change to how a rollup is
    // computed converges rather than leaving stale totals behind.
    await updateRollups(organizationId, existing.id);
    console.log(`  payroll ${label}: already present (${existing.status})`);
    return;
  }

  const total = daysInMonth(year, month);
  const periodStart = new Date(Date.UTC(year, month - 1, 1));
  const periodEnd = new Date(Date.UTC(year, month - 1, total));

  const attendancePeriod = await prisma.attendancePeriod.upsert({
    where: { organizationId_year_month: { organizationId, year, month } },
    update: {},
    create: {
      organizationId,
      year,
      month,
      startDate: periodStart,
      endDate: periodEnd,
      totalDays: total,
      status: 'OPEN',
    },
    select: { id: true },
  });

  const cycle = await prisma.payrollCycle.create({
    data: {
      organizationId,
      year,
      month,
      label,
      periodStart,
      periodEnd,
      payDate: periodEnd,
      status: 'DRAFT',
      attendancePeriodId: attendancePeriod.id,
    },
    select: { id: true },
  });

  await runAsSystem(
    { requestId: `seed-${year}-${month}`, organizationId, job: 'demo-seed' },
    async () => {
      /* 1. Accounts uploads payroll inputs. */
      const batch = await prisma.payrollInputBatch.create({
        data: {
          organizationId,
          payrollCycleId: cycle.id,
          status: 'COMMITTED',
          originalFilename: `payroll-inputs-${year}-${String(month).padStart(2, '0')}.csv`,
          rowCount: 1,
          acceptedCount: 1,
          uploadedByUserId: input.accounts.userId,
          committedAt: new Date(),
        },
        select: { id: true },
      });

      // One incentive, so a payslip shows a line that came from the upload
      // rather than from the salary structure.
      const priyaId = input.employeeIdByCode.get('01847');
      if (priyaId && month % 2 === 1) {
        await prisma.payrollInputItem.create({
          data: {
            organizationId,
            payrollInputBatchId: batch.id,
            employeeId: priyaId,
            kind: 'INCENTIVE',
            amountMinor: rupees(6_420),
            note: 'Quarterly performance incentive',
            sourceRowNumber: 1,
          },
        });
      }

      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'UPLOAD_INPUTS' },
        hmacKey,
      );
      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'LOCK_INPUTS' },
        hmacKey,
      );

      /* 2. HR records and submits attendance. */
      const managerByEmployee = new Map<string, string>();
      for (const person of input.people) {
        if (!person.manager) continue;
        const employeeId = input.employeeIdByCode.get(person.code);
        const managerId = input.employeeIdByCode.get(person.manager);
        if (employeeId && managerId) managerByEmployee.set(employeeId, managerId);
      }

      let weekOff = 0;
      for (let day = 1; day <= total; day += 1) {
        const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
        if (weekday === 0 || weekday === 6) weekOff += 1;
      }

      const holidayCount = await prisma.holiday.count({
        where: { organizationId, date: { gte: periodStart, lte: periodEnd } },
      });

      for (const employeeId of input.employeeIds) {
        // One person takes a day of unpaid leave in the middle month, so a
        // payslip visibly shows proration rather than every line being whole.
        const lop = employeeId === input.employeeIdByCode.get('02210') && month % 3 === 2 ? 1 : 0;

        await prisma.attendanceRecord.upsert({
          where: {
            attendancePeriodId_employeeId: { attendancePeriodId: attendancePeriod.id, employeeId },
          },
          update: {},
          create: {
            organizationId,
            attendancePeriodId: attendancePeriod.id,
            employeeId,
            managerEmployeeId: managerByEmployee.get(employeeId) ?? null,
            status: 'SUBMITTED',
            source: 'HR_BULK_UPLOAD',
            presentDays: total - weekOff - holidayCount - lop,
            paidLeaveDays: 0,
            unpaidLeaveDays: lop,
            holidayDays: holidayCount,
            weekOffDays: weekOff,
            absentDays: 0,
            employedDays: total,
          },
        });
      }

      for (const managerId of new Set(managerByEmployee.values())) {
        const recordCount = [...managerByEmployee.entries()].filter(
          ([, m]) => m === managerId,
        ).length;
        await prisma.attendanceApproval.upsert({
          where: {
            attendancePeriodId_managerEmployeeId: {
              attendancePeriodId: attendancePeriod.id,
              managerEmployeeId: managerId,
            },
          },
          update: {},
          create: {
            organizationId,
            attendancePeriodId: attendancePeriod.id,
            managerEmployeeId: managerId,
            status: 'PENDING',
            recordCount,
          },
        });
      }

      await prisma.attendancePeriod.update({
        where: { id: attendancePeriod.id },
        data: {
          status: 'HR_SUBMITTED',
          submittedAt: new Date(),
          submittedByUserId: input.hr.userId,
        },
      });

      await prisma.attendanceSubmission.create({
        data: {
          organizationId,
          attendancePeriodId: attendancePeriod.id,
          submittedByUserId: input.hr.userId,
          recordCount: input.employeeIds.length,
        },
      });

      await transitionCycle(
        prisma,
        input.hr,
        { cycleId: cycle.id, event: 'SUBMIT_ATTENDANCE' },
        hmacKey,
        {
          data: { attendanceSubmittedAt: new Date() },
        },
      );

      /* 3. Each manager approves their own slice. */
      const approvals = await prisma.attendanceApproval.findMany({
        where: { attendancePeriodId: attendancePeriod.id, status: 'PENDING' },
        select: { id: true, managerEmployeeId: true },
      });

      for (const approval of approvals) {
        const manager = await prisma.employee.findUniqueOrThrow({
          where: { id: approval.managerEmployeeId },
          select: { appUserId: true },
        });
        await prisma.attendanceApproval.update({
          where: { id: approval.id },
          data: {
            status: 'APPROVED',
            decidedAt: new Date(),
            decidedByUserId: manager.appUserId,
          },
        });
      }

      await prisma.attendanceRecord.updateMany({
        where: { attendancePeriodId: attendancePeriod.id },
        data: { status: 'APPROVED' },
      });
      await prisma.attendancePeriod.update({
        where: { id: attendancePeriod.id },
        data: { status: 'APPROVED', approvedAt: new Date() },
      });

      const lastManager = approvals[approvals.length - 1]!;
      const lastManagerEmployee = await prisma.employee.findUniqueOrThrow({
        where: { id: lastManager.managerEmployeeId },
        select: { appUserId: true },
      });

      await transitionCycle(
        prisma,
        {
          userId: lastManagerEmployee.appUserId!,
          organizationId,
          employeeId: lastManager.managerEmployeeId,
          personas: ['EMPLOYEE', 'MANAGER'],
          sessionId: randomUUID(),
          mfaSatisfied: true,
        },
        { cycleId: cycle.id, event: 'APPROVE_ATTENDANCE' },
        hmacKey,
        { data: { attendanceApprovedAt: new Date() } },
      );

      /* 4. Validation. */
      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'VALIDATE' },
        hmacKey,
      );
      const summary = await runValidation(prisma, { organizationId, payrollCycleId: cycle.id });

      await transitionCycle(
        prisma,
        input.accounts,
        {
          cycleId: cycle.id,
          event: summary.employeesPassing > 0 ? 'VALIDATION_PASSED' : 'VALIDATION_REJECTED',
        },
        hmacKey,
        {
          systemRaised: true,
          data: summary.employeesPassing > 0 ? { validatedAt: new Date() } : {},
        },
      );

      if (summary.employeesPassing === 0) {
        console.log(
          `  payroll ${label}: validation excluded everyone; cycle left at VALIDATION_FAILED`,
        );
        return;
      }

      /* 5. Generation. */
      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'CALCULATE' },
        hmacKey,
      );
      const generated = await generatePayroll(
        prisma,
        input.accounts,
        { cycleId: cycle.id, eligibleEmployeeIds: summary.eligibleEmployeeIds },
        hmacKey,
      );
      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'CALCULATION_SUCCEEDED' },
        hmacKey,
        { systemRaised: true, data: { calculatedAt: new Date() } },
      );

      /* 6. Documents, then sign-off and publication. */
      // The real renderer, not a row that says a document exists. A seed that
      // fabricated them produced demo payslips nobody could open — which is
      // exactly the failure the pipeline's publish guard is there to prevent,
      // reintroduced by the thing meant to demonstrate it working.
      const documents = await renderPendingPayslips(prisma, env, {
        organizationId,
        cycleId: cycle.id,
      });
      if (documents.failed.length > 0) {
        throw new Error(
          `${documents.failed.length} payslip documents could not be rendered: ` +
            documents.failed.map((f) => f.reason).join('; '),
        );
      }

      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'APPROVE' },
        hmacKey,
        {
          data: { approvedAt: new Date(), approvedByUserId: input.accounts.userId },
        },
      );
      await transitionCycle(
        prisma,
        input.accounts,
        { cycleId: cycle.id, event: 'PUBLISH' },
        hmacKey,
        {
          data: { publishedAt: new Date(), publishedByUserId: input.accounts.userId },
        },
      );

      // Publication is what makes a payslip visible, and is recorded per payslip.
      const publishedAt = new Date();
      for (const payslip of await prisma.payslip.findMany({
        where: { payrollCycleId: cycle.id, status: 'GENERATED' },
        select: { id: true },
      })) {
        await prisma.payslip.update({
          where: { id: payslip.id },
          data: { status: 'PUBLISHED', publishedAt },
        });
        await prisma.payslipPublication.create({
          data: {
            organizationId,
            payslipId: payslip.id,
            publishedByUserId: input.accounts.userId,
            publishedAt,
          },
        });
      }

      await updateRollups(organizationId, cycle.id);

      console.log(
        `  payroll ${label}: ${generated.payslipsCreated} payslips generated and published` +
          (generated.skipped.length > 0 ? `, ${generated.skipped.length} excluded` : ''),
      );
    },
  );
}

/** Year-to-date totals, maintained as payslips publish. */
/**
 * The projections the portal reads: year-to-date totals and quarterly TDS.
 *
 * Delegated to the same service the publish endpoint uses, so the seed cannot
 * produce a rollup the application would compute differently — which is the
 * whole point of a seed that drives the real pipeline.
 */
async function updateRollups(organizationId: string, cycleId: string): Promise<void> {
  const payslips = await prisma.payslip.findMany({
    where: { payrollCycleId: cycleId, status: 'PUBLISHED' },
    select: { employeeId: true, periodEnd: true },
  });
  if (payslips.length === 0) return;

  await refreshPayslipRollups(prisma, {
    organizationId,
    employeeIds: payslips.map((payslip) => payslip.employeeId),
    onDate: payslips[0]!.periodEnd.toISOString().slice(0, 10),
  });
}

function currentFiscalYearStart(): number {
  const now = new Date();
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

/** A PAN-shaped identifier derived from the name, valid in format only. */
function panFor(first: string, last: string, code: string): string {
  const letters = (last.slice(0, 3) + first.slice(0, 2)).toUpperCase().padEnd(5, 'X');
  return `${letters}${code.slice(-4).padStart(4, '0')}K`;
}

async function upsertMany<T extends { code: string }>(
  rows: T[],
  create: (row: T) => Promise<{ id: string }>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const row of rows) {
    const created = await create(row);
    result.set(row.code, created.id);
  }
  return result;
}

main()
  .catch((error: unknown) => {
    console.error('\nSeeding failed:', error instanceof Error ? error.message : error);
    if (error instanceof Error && error.stack) console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
