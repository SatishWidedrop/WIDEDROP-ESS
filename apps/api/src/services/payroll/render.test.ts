import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testEnv } from '../../test/app.js';
import { closeTestDb, resetTestDb, testDb } from '../../test/db.js';
import { buildFixture, type Fixture } from '../../test/fixtures.js';
import { resetStorage, storage } from '../storage.js';
import { buildPayslipPdf, renderPendingPayslips } from './render.js';

/**
 * Rendering payslip documents.
 *
 * The pipeline will not publish a cycle whose payslips have no document, so
 * this is the step between "payroll has been calculated" and "an employee can
 * open their payslip". Before it existed, that step was fabricated in the
 * end-to-end test and absent in production.
 */

const db = testDb();

let fixture: Fixture;
let root: string;
let env: ReturnType<typeof testEnv>;
let cycleId: string;
let runId: string;
let month = 0;

/** A payslip with the lines a real one carries, written straight to the table. */
async function seedPayslip(
  employeeId: string,
  overrides: { reference?: string; version?: number } = {},
): Promise<string> {
  const payslip = await db.payslip.create({
    data: {
      organizationId: fixture.organizationId,
      payrollCycleId: cycleId,
      payrollRunId: runId,
      employeeId,
      status: 'GENERATED',
      reference: overrides.reference ?? `PS-2026-10-${Math.random().toString().slice(2, 8)}`,
      version: overrides.version ?? 1,
      periodStart: new Date('2026-10-01'),
      periodEnd: new Date('2026-10-31'),
      payDate: new Date('2026-10-31'),
      payableDays: 30,
      totalDays: 31,
      lopDays: 1,
      grossEarningsMinor: 15_000_000n,
      totalDeductionsMinor: 2_340_000n,
      netPayMinor: 12_660_000n,
      employerContributionMinor: 180_000n,
      sourceDigest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      lines: {
        create: [
          {
            organizationId: fixture.organizationId,
            kind: 'EARNING',
            label: 'Basic',
            amountMinor: 7_500_000n,
            displayOrder: 1,
            calculationNote: '50% of monthly CTC, prorated for 30 of 31 days',
          },
          {
            organizationId: fixture.organizationId,
            kind: 'DEDUCTION',
            label: 'Provident fund (employee)',
            amountMinor: 180_000n,
            displayOrder: 2,
            calculationNote: '12% of basic, capped at the PF ceiling',
          },
        ],
      },
    },
    select: { id: true },
  });
  return payslip.id;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ess-render-'));
  resetStorage();
  env = testEnv({ STORAGE_LOCAL_PATH: root });
  await resetTestDb(db);
  fixture = await buildFixture();
});

/**
 * A fresh cycle per test.
 *
 * `payslip_line` is append-only in the database — a trigger refuses DELETE —
 * so a test cannot clean up after itself. Giving each one its own cycle is the
 * isolation that respects that, and it is what production looks like anyway:
 * rendering is always scoped to one cycle.
 */
beforeEach(async () => {
  month += 1;
  const cycle = await db.payrollCycle.create({
    data: {
      organizationId: fixture.organizationId,
      year: 2026 + Math.floor((month - 1) / 12),
      month: ((month - 1) % 12) + 1,
      label: `Cycle ${month}`,
      periodStart: new Date('2026-10-01'),
      periodEnd: new Date('2026-10-31'),
      payDate: new Date('2026-10-31'),
      status: 'CALCULATED',
    },
    select: { id: true },
  });
  cycleId = cycle.id;

  const run = await db.payrollRun.create({
    data: {
      organizationId: fixture.organizationId,
      payrollCycleId: cycleId,
      attempt: 1,
      status: 'SUCCEEDED',
      engineVersion: 'test',
      inputDigest: 'd'.repeat(64),
      triggeredByUserId: fixture.users.ananya,
    },
    select: { id: true },
  });
  runId = run.id;
});

afterAll(async () => {
  await closeTestDb();
  await rm(root, { recursive: true, force: true });
  resetStorage();
});

const render = () =>
  renderPendingPayslips(db, env, { organizationId: fixture.organizationId, cycleId });

describe('renderPendingPayslips', () => {
  it('gives a payslip a document, and puts the bytes where the row says', async () => {
    const payslipId = await seedPayslip(fixture.people.priya, { reference: 'PS-2026-10-0001' });

    const summary = await render();
    expect(summary).toMatchObject({ rendered: 1, alreadyHad: 0, failed: [] });

    const payslip = await db.payslip.findUniqueOrThrow({
      where: { id: payslipId },
      select: { pdfFileObjectId: true, pdf: true },
    });

    expect(payslip.pdfFileObjectId).not.toBeNull();
    expect(payslip.pdf?.contentType).toBe('application/pdf');
    expect(payslip.pdf?.purpose).toBe('PAYSLIP_PDF');
    expect(payslip.pdf?.subjectEmployeeId).toBe(fixture.people.priya);
    // Generated here from database rows; there is no outside byte to scan.
    expect(payslip.pdf?.scanStatus).toBe('SKIPPED');
    expect(payslip.pdf?.sizeBytes).toBeGreaterThan(1000);

    // The row is not a promise: the object is really in storage.
    expect(await storage(env).exists(payslip.pdf!.storageKey)).toBe(true);
    const object = await storage(env).get(payslip.pdf!.storageKey);
    expect(object.size).toBe(payslip.pdf!.sizeBytes);
  });

  it('is idempotent — a second pass renders nothing and changes nothing', async () => {
    const payslipId = await seedPayslip(fixture.people.priya);

    await render();
    const first = await db.payslip.findUniqueOrThrow({
      where: { id: payslipId },
      select: { pdfFileObjectId: true },
    });

    const second = await render();

    // Nothing to do, so nothing done — not a second file nothing points at.
    expect(second).toMatchObject({ rendered: 0, alreadyHad: 0, failed: [] });
    expect(
      (
        await db.payslip.findUniqueOrThrow({
          where: { id: payslipId },
          select: { pdfFileObjectId: true },
        })
      ).pdfFileObjectId,
    ).toBe(first.pdfFileObjectId);
    expect(
      await db.fileObject.count({
        where: { purpose: 'PAYSLIP_PDF', payslipPdfs: { some: { payrollCycleId: cycleId } } },
      }),
    ).toBe(1);
  });

  it('renders every payslip in the cycle and reports the count', async () => {
    await seedPayslip(fixture.people.priya);
    await seedPayslip(fixture.people.arjun);
    await seedPayslip(fixture.people.divya);

    expect(await render()).toMatchObject({ rendered: 3, failed: [] });
    expect(
      await db.payslip.count({ where: { payrollCycleId: cycleId, pdfFileObjectId: null } }),
    ).toBe(0);
  });

  it('leaves a payslip that already has a document alone', async () => {
    const payslipId = await seedPayslip(fixture.people.priya);
    await render();

    await seedPayslip(fixture.people.arjun);
    const summary = await render();

    // Only the new one is work.
    expect(summary.rendered).toBe(1);
    expect(
      (
        await db.payslip.findUniqueOrThrow({
          where: { id: payslipId },
          select: { pdf: { select: { createdAt: true } } },
        })
      ).pdf,
    ).toBeDefined();
  });

  it('bounds a batch when given a limit, and says there is more', async () => {
    for (const employeeId of [fixture.people.priya, fixture.people.arjun, fixture.people.divya]) {
      await seedPayslip(employeeId);
    }

    // What a caller with a deadline does — a serverless function with ten
    // seconds asks for as much as it can finish and calls again.
    const first = await renderPendingPayslips(db, env, {
      organizationId: fixture.organizationId,
      cycleId,
      limit: 2,
    });
    expect(first.rendered).toBe(2);
    expect(first.more).toBe(true);

    const second = await renderPendingPayslips(db, env, {
      organizationId: fixture.organizationId,
      cycleId,
      limit: 2,
    });
    expect(second.rendered).toBe(1);
    // Fewer came back than the limit, so the work is done.
    expect(second.more).toBe(false);

    expect(
      await db.payslip.count({ where: { payrollCycleId: cycleId, pdfFileObjectId: null } }),
    ).toBe(0);
  });

  it('renders a batch concurrently without losing or duplicating one', async () => {
    // More than the concurrency limit, so at least two slices run.
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(
        await seedPayslip(
          [fixture.people.priya, fixture.people.arjun, fixture.people.divya][i % 3]!,
          { version: Math.floor(i / 3) + 1 },
        ),
      );
    }

    const summary = await render();

    expect(summary.rendered).toBe(10);
    expect(summary.failed).toEqual([]);
    // One document each, not nine or eleven.
    expect(
      await db.fileObject.count({
        where: { purpose: 'PAYSLIP_PDF', payslipPdfs: { some: { payrollCycleId: cycleId } } },
      }),
    ).toBe(10);
    // And every one of them is distinct.
    const files = await db.payslip.findMany({
      where: { id: { in: ids } },
      select: { pdfFileObjectId: true },
    });
    expect(new Set(files.map((f) => f.pdfFileObjectId)).size).toBe(10);
  });

  it('records the render in the audit trail, tied to the source digest', async () => {
    await seedPayslip(fixture.people.priya, { reference: 'PS-2026-10-0042' });
    await render();

    const event = await db.auditEvent.findFirstOrThrow({
      where: { entityType: 'FileObject' },
      orderBy: { occurredAt: 'desc' },
      select: { action: true, summary: true, actorKind: true, afterData: true },
    });

    expect(event.action).toBe('CREATE');
    expect(event.summary).toContain('PS-2026-10-0042');
    // Nobody asked for it; the system did it.
    expect(event.actorKind).toBe('SYSTEM');
    // The digest is what lets a disputed figure be answered by re-rendering.
    expect(JSON.stringify(event.afterData)).toContain(
      'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    );
  });

  it('keys the storage object on the pay date, not on today', async () => {
    await seedPayslip(fixture.people.priya);
    await render();

    const file = await db.fileObject.findFirstOrThrow({
      where: { purpose: 'PAYSLIP_PDF', payslipPdfs: { some: { payrollCycleId: cycleId } } },
      select: { storageKey: true },
    });

    // October 2026, because that is the payslip's own month. Keyed on today's
    // date instead, the same payslip would land somewhere different depending
    // on when a re-render happened.
    expect(file.storageKey).toMatch(/^PAYSLIP_PDF\/2026\/10\//);
  });

  it('names a revision so a superseded copy is recognisable', async () => {
    await seedPayslip(fixture.people.priya, { reference: 'PS-2026-10-0009', version: 2 });
    await render();

    const file = await db.fileObject.findFirstOrThrow({
      where: { purpose: 'PAYSLIP_PDF', payslipPdfs: { some: { payrollCycleId: cycleId } } },
      select: { displayFilename: true },
    });
    expect(file.displayFilename).toContain('-v2');
    // The cycle's own label, so the file is identifiable without opening it.
    const label = (
      await db.payrollCycle.findUniqueOrThrow({
        where: { id: cycleId },
        select: { label: true },
      })
    ).label;
    expect(file.displayFilename).toContain(label.replace(/[^A-Za-z0-9]+/g, '-'));
  });
});

describe('buildPayslipPdf', () => {
  const payslip = {
    id: 'p1',
    reference: 'PS-2026-10-0007',
    version: 1,
    periodStart: new Date('2026-10-01'),
    periodEnd: new Date('2026-10-31'),
    payDate: new Date('2026-10-31'),
    payableDays: '30.00',
    totalDays: 31,
    lopDays: '1.00',
    grossEarningsMinor: 15_000_000n,
    totalDeductionsMinor: 2_340_000n,
    netPayMinor: 12_660_000n,
    employerContributionMinor: 180_000n,
    sourceDigest: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
    employeeId: 'e1',
    employee: {
      fullName: 'Priya Ramaswamy',
      employeeNumber: 'WDT-01102',
      dateOfJoining: new Date('2024-07-11'),
      employments: [
        { designation: { title: 'Senior Engineer' }, department: { name: 'Engineering' } },
      ],
    },
    cycle: { label: 'October 2026' },
    lines: [
      {
        kind: 'EARNING',
        label: 'Basic',
        amountMinor: 7_500_000n,
        fullAmountMinor: 7_741_935n,
        calculationNote: '50% of monthly CTC, prorated for 30 of 31 days',
      },
      {
        kind: 'DEDUCTION',
        label: 'Provident fund (employee)',
        amountMinor: 180_000n,
        fullAmountMinor: null,
        calculationNote: '12% of basic, capped at the PF ceiling',
      },
    ],
  };

  const organization = {
    legalName: 'Widedrop Technologies Private Limited',
    displayName: 'Widedrop',
  };

  const text = (bytes: Buffer) => bytes.toString('latin1');

  it('prints the figures the payslip carries', () => {
    const rendered = text(buildPayslipPdf(payslip, organization));

    // The standard fonts have no rupee glyph, so amounts read `INR`.
    expect(rendered).toContain('INR 1,50,000.00'); // gross
    expect(rendered).toContain('INR 23,400.00'); // deductions
    expect(rendered).toContain('INR 1,26,600.00'); // net
    expect(rendered).toContain('Priya Ramaswamy');
    expect(rendered).toContain('WDT-01102');
    expect(rendered).toContain('Senior Engineer');
    expect(rendered).toContain('PS-2026-10-0007');
  });

  it("prints each line's derivation, so the document answers for itself", () => {
    const rendered = text(buildPayslipPdf(payslip, organization));
    expect(rendered).toContain('50% of monthly CTC, prorated for 30 of 31 days');
    expect(rendered).toContain('12% of basic, capped at the PF ceiling');
    // And the digest that ties it to the run.
    expect(rendered).toContain('a1b2c3d4e5f6');
  });

  it('is byte-identical when the same payslip is rendered again', () => {
    // The claim the whole system rests on: the same inputs reproduce the same
    // output. A document that differed between renders would undermine it.
    expect(
      buildPayslipPdf(payslip, organization).equals(buildPayslipPdf(payslip, organization)),
    ).toBe(true);
  });

  it('says so rather than leaving a column blank when there are no deductions', () => {
    const rendered = text(
      buildPayslipPdf(
        { ...payslip, lines: payslip.lines.filter((line) => line.kind === 'EARNING') },
        organization,
      ),
    );
    // A heading over empty space reads as a rendering failure.
    expect(rendered).toContain('(None) Tj');
  });

  it('marks a revision on its face', () => {
    const rendered = text(buildPayslipPdf({ ...payslip, version: 3 }, organization));
    expect(rendered).toContain('Revision 3');
    expect(rendered).toContain('supersedes');
  });

  it('renders an employee whose employment record is incomplete', () => {
    // A dash, not a crash and not a blank: the field genuinely has no value.
    const rendered = text(
      buildPayslipPdf(
        { ...payslip, employee: { ...payslip.employee, employments: [] } },
        organization,
      ),
    );
    expect(rendered).toContain('(-) Tj');
  });
});
