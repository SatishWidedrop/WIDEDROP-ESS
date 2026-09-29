/**
 * Reference data.
 *
 * This is *configuration*, not operational data: roles, permissions, leave
 * types, expense categories, ticket categories, document types, pay components,
 * tax slabs and the explanatory copy the UI shows. None of it carries a count,
 * an amount, a date or a status belonging to any person.
 *
 * It is safe — and necessary — to run in production. Everything operational
 * starts empty and stays empty until someone does the work that creates it.
 *
 *   npm run db:seed:reference -w @widedrop/api
 *
 * Idempotent: running it twice changes nothing.
 */
import {
  PERMISSIONS,
  ROLES,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
} from '@widedrop/shared';
import { PrismaClient } from '../src/generated/prisma/index.js';

const prisma = new PrismaClient();

const ORGANIZATION_DOMAIN = process.env.SEED_ORG_DOMAIN ?? 'widedrop.com';
const ORGANIZATION_NAME = process.env.SEED_ORG_NAME ?? 'Widedrop Technologies';
const ORGANIZATION_LEGAL_NAME =
  process.env.SEED_ORG_LEGAL_NAME ?? 'Widedrop Technologies Private Limited';
const HELPDESK_EMAIL = process.env.HELPDESK_EMAIL ?? 'helpdesk@widedroptech.com';

async function main(): Promise<void> {
  console.log('Seeding reference data…');

  const organization = await seedOrganization();
  await seedRolesAndPermissions();
  await seedFiscalYears(organization.id);
  await seedTaxRegimes();
  await seedPayComponents(organization.id);
  await seedLeaveTypes(organization.id);
  await seedExpenseCategories(organization.id);
  await seedDocumentTypes(organization.id);
  await seedTicketCategories(organization.id);
  await seedUiCopy(organization.id);

  console.log('\nReference data seeded.');
  console.log('Every operational table is still empty, which is correct:');
  console.log('  - no employees, no payslips, no leave, no tickets');
  console.log('  - the portal will show its empty states until real work creates data');
  console.log('\nNext: npm run bootstrap:admin -w @widedrop/api');
}

async function seedOrganization() {
  const organization = await prisma.organization.upsert({
    where: { domain: ORGANIZATION_DOMAIN },
    update: { helpdeskEmail: HELPDESK_EMAIL },
    create: {
      legalName: ORGANIZATION_LEGAL_NAME,
      displayName: ORGANIZATION_NAME,
      domain: ORGANIZATION_DOMAIN,
      helpdeskEmail: HELPDESK_EMAIL,
      employeeNumberPrefix: process.env.SEED_EMPLOYEE_PREFIX ?? 'WDT',
      timezone: 'Asia/Kolkata',
      currencyCode: 'INR',
      locale: 'en-IN',
      fiscalYearStartMonth: 4,
    },
  });
  console.log(`  organization: ${organization.displayName}`);
  return organization;
}

async function seedRolesAndPermissions(): Promise<void> {
  for (const key of PERMISSIONS) {
    const [resource, action] = key.split(':') as [string, string];
    await prisma.permission.upsert({
      where: { key },
      update: { resource, action },
      create: { key, resource, action, description: describePermission(key) },
    });
  }

  for (const persona of ROLES) {
    const role = await prisma.role.upsert({
      where: { persona },
      update: { name: ROLE_LABELS[persona], description: ROLE_DESCRIPTIONS[persona] },
      create: { persona, name: ROLE_LABELS[persona], description: ROLE_DESCRIPTIONS[persona] },
    });

    const matrix = ROLE_PERMISSIONS[persona];
    for (const [key, scope] of Object.entries(matrix)) {
      const permission = await prisma.permission.findUniqueOrThrow({ where: { key } });
      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } },
        update: { scope: scope as string },
        create: { roleId: role.id, permissionId: permission.id, scope: scope as string },
      });
    }

    // A grant removed from the matrix must disappear from the database too,
    // or a permission could outlive the decision to withdraw it.
    const declared = new Set(Object.keys(matrix));
    const stored = await prisma.rolePermission.findMany({
      where: { roleId: role.id },
      select: { permissionId: true, permission: { select: { key: true } } },
    });
    const stale = stored.filter((row) => !declared.has(row.permission.key));
    if (stale.length > 0) {
      await prisma.rolePermission.deleteMany({
        where: { roleId: role.id, permissionId: { in: stale.map((s) => s.permissionId) } },
      });
      console.log(`  ${persona}: removed ${stale.length} grant(s) no longer in the matrix`);
    }
  }

  console.log(`  roles: ${ROLES.length}, permissions: ${PERMISSIONS.length}`);
}

function describePermission(key: string): string {
  const [resource, action] = key.split(':') as [string, string];
  const noun = resource.replace(/-/g, ' ');
  const verb = action.replace(/-/g, ' ');
  return `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${noun}`;
}

/** Financial years, so no code computes one ad hoc. */
async function seedFiscalYears(organizationId: string): Promise<void> {
  const startYear = Number(process.env.SEED_FY_START ?? new Date().getUTCFullYear() - 2);
  const years = 6;

  const MONTH_SHORT = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const quarterMonths: [number, number][] = [
    [3, 5],
    [6, 8],
    [9, 11],
    [0, 2],
  ];

  for (let i = 0; i < years; i += 1) {
    const year = startYear + i;
    const endShort = String((year + 1) % 100).padStart(2, '0');

    const fiscalYear = await prisma.fiscalYear.upsert({
      where: { organizationId_startYear: { organizationId, startYear: year } },
      update: {},
      create: {
        organizationId,
        startYear: year,
        label: `FY ${year}–${endShort}`,
        startDate: new Date(Date.UTC(year, 3, 1)),
        endDate: new Date(Date.UTC(year + 1, 2, 31)),
      },
    });

    for (let q = 1; q <= 4; q += 1) {
      const [fromMonth, toMonth] = quarterMonths[q - 1]!;
      const calendarYear = q === 4 ? year + 1 : year;
      await prisma.fiscalQuarter.upsert({
        where: { fiscalYearId_quarter: { fiscalYearId: fiscalYear.id, quarter: q } },
        update: {},
        create: {
          fiscalYearId: fiscalYear.id,
          quarter: q,
          label: `Q${q} · ${MONTH_SHORT[fromMonth]} – ${MONTH_SHORT[toMonth]} ${calendarYear}`,
          startDate: new Date(Date.UTC(calendarYear, fromMonth, 1)),
          endDate: new Date(Date.UTC(calendarYear, toMonth + 1, 0)),
        },
      });
    }
  }

  console.log(`  fiscal years: ${years}, from FY ${startYear}`);
}

/**
 * Income-tax slabs.
 *
 * Held as data so a Finance Act change is a seed update rather than a deploy.
 * Amounts are paise. These are the FY 2025-26 figures, carried forward; verify
 * them against the current Finance Act before running a real payroll.
 */
async function seedTaxRegimes(): Promise<void> {
  const rupees = (amount: number) => BigInt(amount * 100);
  const startYear = Number(process.env.SEED_FY_START ?? new Date().getUTCFullYear() - 2);

  for (let i = 0; i < 6; i += 1) {
    const year = startYear + i;

    await prisma.taxRegime.upsert({
      where: { code_fiscalYearStartYear: { code: 'NEW', fiscalYearStartYear: year } },
      update: {},
      create: {
        code: 'NEW',
        fiscalYearStartYear: year,
        name: 'New regime',
        slabs: [
          { upToMinor: 300_000_00, rate: 0 },
          { upToMinor: 700_000_00, rate: 0.05 },
          { upToMinor: 1_000_000_00, rate: 0.1 },
          { upToMinor: 1_200_000_00, rate: 0.15 },
          { upToMinor: 1_500_000_00, rate: 0.2 },
          { upToMinor: null, rate: 0.3 },
        ],
        standardDeductionMinor: rupees(75_000),
        rebateThresholdMinor: rupees(700_000),
        rebateMaxMinor: rupees(25_000),
        cessRate: 0.04,
        // Chapter VI-A deductions are not available under the new regime.
        allowsDeductions: false,
      },
    });

    await prisma.taxRegime.upsert({
      where: { code_fiscalYearStartYear: { code: 'OLD', fiscalYearStartYear: year } },
      update: {},
      create: {
        code: 'OLD',
        fiscalYearStartYear: year,
        name: 'Old regime',
        slabs: [
          { upToMinor: 250_000_00, rate: 0 },
          { upToMinor: 500_000_00, rate: 0.05 },
          { upToMinor: 1_000_000_00, rate: 0.2 },
          { upToMinor: null, rate: 0.3 },
        ],
        standardDeductionMinor: rupees(50_000),
        rebateThresholdMinor: rupees(500_000),
        rebateMaxMinor: rupees(12_500),
        cessRate: 0.04,
        allowsDeductions: true,
      },
    });
  }

  console.log('  tax regimes: old and new, per financial year');
}

/** The payslip's components, in the order the prototype prints them. */
async function seedPayComponents(organizationId: string): Promise<void> {
  const components = [
    {
      code: 'BASIC',
      name: 'Basic salary',
      kind: 'EARNING',
      calc: 'PRORATED_FIXED',
      order: 1,
      prorated: true,
      taxable: true,
      pf: true,
    },
    {
      code: 'HRA',
      name: 'House rent allowance',
      kind: 'EARNING',
      calc: 'PERCENT_OF_BASIC',
      rate: 0.5,
      order: 2,
      prorated: true,
      taxable: true,
      pf: false,
    },
    {
      code: 'SPECIAL',
      name: 'Special allowance',
      kind: 'EARNING',
      calc: 'PRORATED_FIXED',
      order: 3,
      prorated: true,
      taxable: true,
      pf: false,
    },
    {
      code: 'LTA',
      name: 'Leave travel allowance',
      kind: 'EARNING',
      calc: 'PRORATED_FIXED',
      order: 4,
      prorated: true,
      taxable: true,
      pf: false,
    },
    {
      code: 'CONVEYANCE',
      name: 'Conveyance allowance',
      kind: 'EARNING',
      calc: 'FIXED',
      order: 5,
      prorated: false,
      taxable: true,
      pf: false,
    },
    {
      code: 'PF_EMPLOYEE',
      name: 'Provident fund (employee)',
      kind: 'DEDUCTION',
      calc: 'STATUTORY_ENGINE',
      rate: 0.12,
      ceiling: 1_500_000,
      order: 200,
      prorated: false,
      taxable: false,
      pf: false,
    },
    {
      code: 'ESI_EMPLOYEE',
      name: 'Employees’ State Insurance',
      kind: 'DEDUCTION',
      calc: 'STATUTORY_ENGINE',
      rate: 0.0075,
      order: 210,
      prorated: false,
      taxable: false,
      pf: false,
    },
    {
      code: 'PROFESSIONAL_TAX',
      name: 'Professional tax',
      kind: 'DEDUCTION',
      calc: 'SLAB',
      order: 220,
      prorated: false,
      taxable: false,
      pf: false,
    },
    {
      code: 'TDS',
      name: 'Income tax (TDS)',
      kind: 'DEDUCTION',
      calc: 'STATUTORY_ENGINE',
      order: 230,
      prorated: false,
      taxable: false,
      pf: false,
    },
    {
      code: 'PF_EMPLOYER',
      name: 'Provident fund (employer)',
      kind: 'EMPLOYER_CONTRIBUTION',
      calc: 'STATUTORY_ENGINE',
      rate: 0.12,
      ceiling: 1_500_000,
      order: 400,
      prorated: false,
      taxable: false,
      pf: false,
    },
    {
      code: 'ESI_EMPLOYER',
      name: 'Employees’ State Insurance (employer)',
      kind: 'EMPLOYER_CONTRIBUTION',
      calc: 'STATUTORY_ENGINE',
      rate: 0.0325,
      order: 410,
      prorated: false,
      taxable: false,
      pf: false,
    },
  ] as const;

  for (const component of components) {
    await prisma.payComponent.upsert({
      where: { organizationId_code: { organizationId, code: component.code } },
      update: { name: component.name, displayOrder: component.order },
      create: {
        organizationId,
        code: component.code,
        name: component.name,
        kind: component.kind,
        calc: component.calc,
        rate: 'rate' in component ? component.rate : null,
        ceilingMinor: 'ceiling' in component ? BigInt(component.ceiling) : null,
        isProrated: component.prorated,
        isTaxable: component.taxable,
        isPfApplicable: component.pf,
        displayOrder: component.order,
      },
    });
  }

  console.log(`  pay components: ${components.length}`);
}

async function seedLeaveTypes(organizationId: string): Promise<void> {
  const types = [
    {
      code: 'EL',
      name: 'Earned leave',
      accrual: 'MONTHLY',
      accrualDays: 1.5,
      carry: 30,
      paid: true,
      notice: 3,
      order: 1,
    },
    {
      code: 'CL',
      name: 'Casual leave',
      accrual: 'ANNUAL',
      accrualDays: 12,
      carry: 0,
      paid: true,
      notice: 1,
      order: 2,
    },
    {
      code: 'SL',
      name: 'Sick leave',
      accrual: 'ANNUAL',
      accrualDays: 10,
      carry: 0,
      paid: true,
      notice: 0,
      order: 3,
      docAfter: 2,
    },
    {
      code: 'COMP',
      name: 'Comp-off',
      accrual: 'NONE',
      accrualDays: 0,
      carry: 0,
      paid: true,
      notice: 1,
      order: 4,
    },
    {
      code: 'RH',
      name: 'Restricted holiday',
      accrual: 'ANNUAL',
      accrualDays: 2,
      carry: 0,
      paid: true,
      notice: 3,
      order: 5,
    },
    {
      code: 'LWP',
      name: 'Leave without pay',
      accrual: 'NONE',
      accrualDays: 0,
      carry: 0,
      paid: false,
      notice: 3,
      order: 6,
    },
    {
      code: 'MAT',
      name: 'Maternity leave',
      accrual: 'NONE',
      accrualDays: 0,
      carry: 0,
      paid: true,
      notice: 30,
      order: 7,
    },
    {
      code: 'PAT',
      name: 'Paternity leave',
      accrual: 'NONE',
      accrualDays: 0,
      carry: 0,
      paid: true,
      notice: 7,
      order: 8,
    },
    {
      code: 'BRV',
      name: 'Bereavement leave',
      accrual: 'NONE',
      accrualDays: 0,
      carry: 0,
      paid: true,
      notice: 0,
      order: 9,
    },
  ] as const;

  for (const type of types) {
    await prisma.leaveType.upsert({
      where: { organizationId_code: { organizationId, code: type.code } },
      update: { name: type.name, displayOrder: type.order },
      create: {
        organizationId,
        code: type.code,
        name: type.name,
        accrualFrequency: type.accrual,
        accrualDays: type.accrualDays,
        maxCarryForwardDays: type.carry,
        isPaid: type.paid,
        minNoticeDays: type.notice,
        documentRequiredAfterDays: 'docAfter' in type ? type.docAfter : null,
        displayOrder: type.order,
      },
    });
  }

  console.log(`  leave types: ${types.length}`);
}

async function seedExpenseCategories(organizationId: string): Promise<void> {
  const categories = [
    { code: 'TRAVEL', name: 'Travel', order: 1, cap: null },
    { code: 'MEALS', name: 'Meals & entertainment', order: 2, cap: 500_000 },
    { code: 'EQUIPMENT', name: 'Equipment', order: 3, cap: 2_500_000 },
    { code: 'REMOTE', name: 'Remote work', order: 4, cap: 150_000 },
    { code: 'LEARNING', name: 'Learning', order: 5, cap: 5_000_000 },
    { code: 'CLIENT', name: 'Client hospitality', order: 6, cap: 1_000_000 },
    { code: 'OTHER', name: 'Other', order: 7, cap: null },
  ] as const;

  for (const category of categories) {
    const created = await prisma.expenseCategory.upsert({
      where: { organizationId_code: { organizationId, code: category.code } },
      update: { name: category.name, displayOrder: category.order },
      create: {
        organizationId,
        code: category.code,
        name: category.name,
        displayOrder: category.order,
      },
      select: { id: true },
    });

    if (category.cap !== null) {
      const existing = await prisma.expenseLimit.findFirst({
        where: { expenseCategoryId: created.id, basis: 'PER_CLAIM' },
      });
      if (!existing) {
        await prisma.expenseLimit.create({
          data: {
            organizationId,
            expenseCategoryId: created.id,
            basis: 'PER_CLAIM',
            capMinor: BigInt(category.cap),
            effectiveFrom: new Date(Date.UTC(2020, 3, 1)),
          },
        });
      }
    }
  }

  console.log(`  expense categories: ${categories.length}`);
}

async function seedDocumentTypes(organizationId: string): Promise<void> {
  const types = [
    { code: 'OFFER', name: 'Offer letter', category: 'Onboarding', requestable: false, order: 1 },
    {
      code: 'APPOINTMENT',
      name: 'Appointment letter',
      category: 'Onboarding',
      requestable: false,
      order: 2,
    },
    {
      code: 'SALARY_REVISION',
      name: 'Salary revision letter',
      category: 'Compensation',
      requestable: false,
      order: 3,
    },
    {
      code: 'APPRAISAL',
      name: 'Appraisal letter',
      category: 'Performance',
      requestable: false,
      order: 4,
    },
    {
      code: 'PROMOTION',
      name: 'Promotion letter',
      category: 'Career',
      requestable: false,
      order: 5,
    },
    {
      code: 'SALARY_CERTIFICATE',
      name: 'Salary certificate',
      category: 'Letters',
      requestable: true,
      order: 6,
    },
    {
      code: 'EMPLOYMENT_VERIFICATION',
      name: 'Employment verification letter',
      category: 'Letters',
      requestable: true,
      order: 7,
    },
    {
      code: 'ADDRESS_PROOF',
      name: 'Address proof letter',
      category: 'Letters',
      requestable: true,
      order: 8,
    },
    {
      code: 'EXPERIENCE',
      name: 'Experience letter',
      category: 'Letters',
      requestable: true,
      order: 9,
    },
    {
      code: 'RELIEVING',
      name: 'Relieving letter',
      category: 'Offboarding',
      requestable: false,
      order: 10,
    },
  ] as const;

  for (const type of types) {
    await prisma.documentType.upsert({
      where: { organizationId_code: { organizationId, code: type.code } },
      update: { name: type.name, displayOrder: type.order },
      create: {
        organizationId,
        code: type.code,
        name: type.name,
        category: type.category,
        isRequestable: type.requestable,
        displayOrder: type.order,
      },
    });
  }

  console.log(`  document types: ${types.length}`);
}

async function seedTicketCategories(organizationId: string): Promise<void> {
  const categories = [
    { code: 'PAYROLL_TAX', name: 'Payroll & tax', firstResponse: 8, resolution: 48, order: 1 },
    { code: 'IT_ACCESS', name: 'IT & access', firstResponse: 4, resolution: 24, order: 2 },
    { code: 'BENEFITS', name: 'Benefits', firstResponse: 8, resolution: 72, order: 3 },
    {
      code: 'LEAVE_ATTENDANCE',
      name: 'Leave & attendance',
      firstResponse: 8,
      resolution: 48,
      order: 4,
    },
    { code: 'FACILITIES', name: 'Facilities', firstResponse: 8, resolution: 72, order: 5 },
    { code: 'DOCUMENTS', name: 'Documents & letters', firstResponse: 8, resolution: 48, order: 6 },
    { code: 'PROFILE', name: 'Profile changes', firstResponse: 8, resolution: 48, order: 7 },
    { code: 'TOWN_HALL', name: 'Town hall', firstResponse: 24, resolution: 168, order: 8 },
    { code: 'OTHER', name: 'Something else', firstResponse: 8, resolution: 72, order: 9 },
  ] as const;

  for (const category of categories) {
    await prisma.ticketCategory.upsert({
      where: { organizationId_code: { organizationId, code: category.code } },
      update: { name: category.name, displayOrder: category.order },
      create: {
        organizationId,
        code: category.code,
        name: category.name,
        firstResponseHours: category.firstResponse,
        resolutionHours: category.resolution,
        displayOrder: category.order,
      },
    });
  }

  console.log(`  ticket categories: ${categories.length}`);
}

/**
 * Explanatory copy the prototype hardcoded.
 *
 * Stored so HR can change wording without a deploy, and so every empty state
 * has honest text rather than a blank panel. None of it carries a value.
 */
async function seedUiCopy(organizationId: string): Promise<void> {
  const copy: [key: string, value: string, description?: string][] = [
    // Profile tab notes
    [
      'profile.tab_note.personal',
      'Name and date of birth changes need a government ID. Address and contact details update after HR review.',
      'Under the Personal tab on My profile',
    ],
    [
      'profile.tab_note.employment',
      'Employment details are maintained by People Ops. Raise a ticket if anything here is out of date.',
      'Under the Employment tab',
    ],
    [
      'profile.tab_note.bank',
      'Masked for your security. Bank and statutory changes need a cancelled cheque or ID proof and are verified by Payroll within 2 working days.',
      'Under the Bank & statutory tab',
    ],
    [
      'profile.tab_note.emergency',
      'Emergency contacts are visible only to People Ops and your manager.',
      'Under the Emergency contacts tab',
    ],

    // Empty states — every screen, so none is ever a blank panel
    ['empty.payslips.title', 'No payslips yet', 'Payslips screen, before any cycle is published'],
    [
      'empty.payslips.body',
      'Your payslip appears here once payroll for the period has been processed and published.',
      'Payslips screen',
    ],
    ['empty.tax.title', 'Nothing to show for this financial year', 'Tax slips screen'],
    [
      'empty.tax.body',
      'Quarterly tax figures are drawn from published payslips. They appear as each quarter is processed.',
      'Tax slips screen',
    ],
    ['empty.form16.title', 'No Form 16 issued yet', 'Tax slips, Form 16 section'],
    [
      'empty.form16.body',
      'Form 16 is issued after the financial year closes, usually by mid-June.',
      'Tax slips',
    ],
    ['empty.leave.requests.title', 'No leave requests', 'Leave screen'],
    [
      'empty.leave.requests.body',
      'Requests you submit appear here with their status.',
      'Leave screen',
    ],
    ['empty.leave.balances.title', 'No leave balances set up', 'Leave screen, balance cards'],
    [
      'empty.leave.balances.body',
      'People Ops sets your entitlement when the leave year opens.',
      'Leave screen',
    ],
    ['empty.holidays.title', 'No holidays published', 'Leave screen, holiday list'],
    [
      'empty.holidays.body',
      'The holiday calendar for your location appears here once People Ops publishes it.',
      'Leave screen',
    ],
    ['empty.benefits.title', 'No benefits enrolled', 'Benefits screen'],
    [
      'empty.benefits.body',
      'Your enrolments appear here once People Ops has set them up.',
      'Benefits screen',
    ],
    ['empty.dependents.title', 'No dependents added', 'Benefits screen, dependents'],
    [
      'empty.dependents.body',
      'Dependents can be added during the enrolment window.',
      'Benefits screen',
    ],
    ['empty.expenses.title', 'No claims yet', 'Expenses screen'],
    [
      'empty.expenses.body',
      'Submit a claim and it appears here with its approval status.',
      'Expenses screen',
    ],
    ['empty.documents.title', 'No documents yet', 'Documents screen'],
    [
      'empty.documents.body',
      'Letters and documents issued to you appear here.',
      'Documents screen',
    ],
    ['empty.letters.title', 'No letter requests', 'Documents screen, letters'],
    ['empty.letters.body', 'Request a letter and track it here.', 'Documents screen'],
    ['empty.policies.title', 'No policies published', 'Policies screen'],
    [
      'empty.policies.body',
      'Company policies appear here once they are published.',
      'Policies screen',
    ],
    ['empty.directory.title', 'Nobody to show', 'Directory screen'],
    [
      'empty.directory.body',
      'The directory lists colleagues who have opted to be listed.',
      'Directory screen',
    ],
    ['empty.directory.search', 'No matches', 'Directory search with no results'],
    ['empty.announcements.title', 'No announcements', 'Announcements screen'],
    [
      'empty.announcements.body',
      'Company announcements appear here as they are published.',
      'Announcements screen',
    ],
    ['empty.tickets.title', 'No tickets raised', 'Help desk screen'],
    ['empty.tickets.body', 'Raise a ticket and follow it here.', 'Help desk screen'],
    ['empty.approvals.title', 'Nothing waiting on you', 'Approvals screen, pending tab'],
    [
      'empty.approvals.body',
      'Leave and expense requests from your team appear here when they need a decision.',
      'Approvals screen',
    ],
    ['empty.approvals.history.title', 'No decisions yet', 'Approvals screen, history tab'],
    ['empty.approvals.history.body', 'Requests you have decided appear here.', 'Approvals screen'],
    ['empty.notifications.title', 'You are up to date', 'Notifications popover'],
    [
      'empty.notifications.body',
      'Notifications appear here when something needs your attention.',
      'Notifications popover',
    ],
    ['empty.home.todo.title', 'Nothing needs your attention', 'Home screen, to-do card'],
    [
      'empty.home.todo.body',
      'Policy acknowledgements and approvals waiting on you appear here.',
      'Home screen',
    ],
    ['empty.attendance.title', 'No attendance period open', 'HR attendance screen'],
    [
      'empty.attendance.body',
      'Open a period for the month to record attendance.',
      'HR attendance screen',
    ],
    ['empty.payroll.cycles.title', 'No payroll cycles', 'Accounts payroll screen'],
    [
      'empty.payroll.cycles.body',
      'Create a cycle for the month to begin.',
      'Accounts payroll screen',
    ],
    ['empty.payroll.validation.title', 'Validation has not run yet', 'Accounts validation report'],
    [
      'empty.payroll.validation.body',
      'Run validation once every manager has approved their team’s attendance.',
      'Accounts validation report',
    ],
    ['empty.search.title', 'No matches', 'Global search'],

    // Captions that explain a value rather than assert one
    ['payslips.ytd.gross.sub', 'Across published payslips this financial year'],
    ['payslips.ytd.net.sub', 'Credited to your bank account'],
    ['payslips.ytd.tds.sub', 'Reflected in Form 26AS'],
    ['payslips.ytd.pf.sub', 'Employee and employer contributions'],
    [
      'documents.letterhead_note',
      'Letters are issued on company letterhead and digitally signed.',
      'Documents screen',
    ],
    ['value.none', '—', 'Shown wherever a value does not exist yet'],
  ];

  for (const [key, value, description] of copy) {
    await prisma.uiCopy.upsert({
      where: { organizationId_key_locale: { organizationId, key, locale: 'en-IN' } },
      update: { value, description: description ?? null },
      create: { organizationId, key, locale: 'en-IN', value, description: description ?? null },
    });
  }

  console.log(`  interface copy: ${copy.length} strings`);
}

main()
  .catch((error: unknown) => {
    console.error('Seeding failed:', error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
