import { randomUUID } from 'node:crypto';
import { formatDate, formatINRExact } from '@widedrop/shared';
import type { Env } from '../../config/env.js';
import type { Database } from '../../lib/prisma.js';
import { A4, PdfPage, renderPdf } from '../../lib/pdf.js';
import { buildStorageKey } from '../../lib/storage/types.js';
import { recordAudit } from '../audit.js';
import { storage } from '../storage.js';

/**
 * Rendering a payslip.
 *
 * The pipeline refuses to publish a cycle whose payslips have no document, and
 * that guard is right: a payslip an employee can see in a list and cannot open
 * reads as a broken portal rather than an in-progress one. This is what
 * satisfies it.
 *
 * Two call sites, one function:
 *
 *  - the calculate endpoint, right after generation, so the ordinary path needs
 *    nobody to remember a second step;
 *  - the worker's sweep, so a cycle whose render died halfway heals itself
 *    rather than waiting for somebody to notice a publish that will not go.
 *
 * It is idempotent. A payslip that already has a document is skipped, so a
 * retry converges instead of producing a second file nothing points at.
 */

/** What the document is built from. Every figure is a persisted column. */
const PAYSLIP_SELECT = {
  id: true,
  reference: true,
  version: true,
  periodStart: true,
  periodEnd: true,
  payDate: true,
  payableDays: true,
  totalDays: true,
  lopDays: true,
  grossEarningsMinor: true,
  totalDeductionsMinor: true,
  netPayMinor: true,
  employerContributionMinor: true,
  sourceDigest: true,
  employeeId: true,
  employee: {
    select: {
      fullName: true,
      employeeNumber: true,
      dateOfJoining: true,
      // The current employment row carries both. `effectiveTo: null` is the
      // open one, and an exclusion constraint guarantees there is exactly one.
      employments: {
        where: { effectiveTo: null },
        select: {
          designation: { select: { title: true } },
          department: { select: { name: true } },
        },
        take: 1,
      },
    },
  },
  cycle: { select: { label: true } },
  lines: {
    orderBy: { displayOrder: 'asc' },
    select: {
      kind: true,
      label: true,
      amountMinor: true,
      fullAmountMinor: true,
      calculationNote: true,
    },
  },
} as const;

/**
 * Exactly what the document is drawn from — the shape `PAYSLIP_SELECT` returns.
 *
 * Written out rather than inferred so the renderer's inputs are readable in one
 * place, and so a column removed from the select is a compile error here rather
 * than an undefined in a PDF.
 */
export interface PayslipForRender {
  id: string;
  reference: string;
  version: number;
  periodStart: Date;
  periodEnd: Date;
  payDate: Date;
  /** Prisma Decimal. Printed, never arithmetic'd. */
  payableDays: unknown;
  totalDays: number;
  lopDays: unknown;
  grossEarningsMinor: bigint;
  totalDeductionsMinor: bigint;
  netPayMinor: bigint;
  employerContributionMinor: bigint;
  sourceDigest: string;
  employeeId: string;
  employee: {
    fullName: string;
    employeeNumber: string;
    dateOfJoining: Date;
    /** The open employment row, or none if the record is incomplete. */
    employments: { designation: { title: string }; department: { name: string } }[];
  };
  cycle: { label: string };
  lines: {
    kind: string;
    label: string;
    amountMinor: bigint;
    fullAmountMinor: bigint | null;
    calculationNote: string | null;
  }[];
}

export interface RenderSummary {
  rendered: number;
  alreadyHad: number;
  failed: { payslipId: string; reason: string }[];
  /** True when a `limit` cut the batch short and another pass has work to do. */
  more: boolean;
}

/**
 * Render every payslip in a cycle that has no document yet.
 *
 * Each payslip is its own transaction: one that fails does not roll back the
 * rest, and the sweep picks it up next time. Returning what failed rather than
 * throwing means the caller can report "38 of 40" instead of nothing.
 */
export async function renderPendingPayslips(
  db: Database,
  env: Env,
  input: { organizationId: string; cycleId: string; limit?: number },
): Promise<RenderSummary> {
  const payslips = await db.payslip.findMany({
    where: {
      organizationId: input.organizationId,
      payrollCycleId: input.cycleId,
      pdfFileObjectId: null,
      // A revoked payslip is history; it is not given a document it never had.
      status: { in: ['GENERATED', 'PUBLISHED'] },
    },
    select: PAYSLIP_SELECT,
    // A caller with a deadline — a serverless function with ten seconds, say —
    // asks for a slice it can finish and calls again. Rendering is idempotent
    // and claims each payslip conditionally, so calling again is safe and two
    // callers overlapping is safe.
    ...(input.limit !== undefined ? { take: input.limit } : {}),
  });

  const summary: RenderSummary = {
    rendered: 0,
    alreadyHad: 0,
    failed: [],
    more: input.limit !== undefined && payslips.length === input.limit,
  };

  // A bounded number at a time.
  //
  // Building the document costs about a quarter of a millisecond; writing it to
  // object storage costs a network round trip, which is two to three orders of
  // magnitude more. Rendered one after another, a cycle's cost is therefore
  // (employees x round trip) — about 26 seconds for two hundred people against
  // a remote bucket, which is the difference between fitting inside a request
  // and not.
  //
  // Eight, not eight hundred: each one holds a database transaction while it
  // writes its rows, and a pooled connection with it. The limit is there to
  // keep a large cycle from exhausting the pool rather than to squeeze out the
  // last millisecond.
  const CONCURRENCY = 8;

  for (let start = 0; start < payslips.length; start += CONCURRENCY) {
    const slice = payslips.slice(start, start + CONCURRENCY);
    const outcomes = await Promise.allSettled(
      slice.map((payslip) => renderOne(db, env, input.organizationId, payslip)),
    );

    outcomes.forEach((outcome, index) => {
      if (outcome.status === 'fulfilled') {
        if (outcome.value === 'rendered') summary.rendered += 1;
        else summary.alreadyHad += 1;
        return;
      }
      // Settled, not raced: one payslip failing must not abandon the seven
      // beside it, and the caller gets told which one it was.
      summary.failed.push({
        payslipId: slice[index]!.id,
        reason: outcome.reason instanceof Error ? outcome.reason.message : 'unknown',
      });
    });
  }

  return summary;
}

async function renderOne(
  db: Database,
  env: Env,
  organizationId: string,
  payslip: PayslipForRender,
): Promise<'rendered' | 'already-had'> {
  const organization = await db.organization.findUniqueOrThrow({
    where: { id: organizationId },
    select: { legalName: true, displayName: true },
  });

  const bytes = buildPayslipPdf(payslip, organization);

  const objectId = randomUUID();
  const storageKey = buildStorageKey({
    purpose: 'PAYSLIP_PDF',
    scopeId: payslip.employeeId,
    objectId,
    extension: 'pdf',
    // The pay date, not today: the key of a given payslip is then the same
    // whenever it is rendered, which is what makes a re-render idempotent in
    // storage as well as in the database.
    date: payslip.payDate,
  });

  const stored = await storage(env).put({
    key: storageKey,
    body: bytes,
    contentType: 'application/pdf',
    downloadFilename: documentFilename(payslip),
    metadata: { organization: organizationId, purpose: 'PAYSLIP_PDF', payslip: payslip.reference },
  });

  try {
    await db.$transaction(async (tx) => {
      const file = await tx.fileObject.create({
        data: {
          organizationId,
          purpose: 'PAYSLIP_PDF',
          storageKey: stored.key,
          displayFilename: documentFilename(payslip),
          contentType: 'application/pdf',
          sizeBytes: stored.size,
          sha256: stored.sha256,
          // Generated by this process from database rows. There is nothing to
          // scan for: no byte in it came from outside.
          scanStatus: 'SKIPPED',
          subjectEmployeeId: payslip.employeeId,
        },
        select: { id: true },
      });

      // Claimed conditionally, and with the real value — an `updateMany` whose
      // `data` is empty issues no statement and reports nothing changed, which
      // silently turns every render into a no-op.
      //
      // The condition matters because two renders can race: the calculate
      // endpoint runs one and the worker's sweep may already have started
      // another. The loser writes no column, rolls its own rows back, and is
      // counted as "already had one" rather than as a failure.
      const claimed = await tx.payslip.updateMany({
        where: { id: payslip.id, pdfFileObjectId: null },
        data: { pdfFileObjectId: file.id },
      });
      if (claimed.count === 0) throw new LostRace();

      await recordAudit(
        tx,
        {
          organizationId,
          action: 'CREATE',
          entityType: 'FileObject',
          entityId: file.id,
          summary: `Rendered payslip ${payslip.reference}`,
          // The digest ties the document to the inputs it was produced from,
          // so a dispute can be answered by re-rendering and comparing.
          after: {
            payslip: payslip.reference,
            sourceDigest: payslip.sourceDigest,
            sha256: stored.sha256,
          },
          actor: { kind: 'SYSTEM' },
        },
        env.AUDIT_HMAC_KEY,
      );
    });
  } catch (error) {
    // The rollback has already undone the FileObject row and the audit entry.
    // The object in storage is left: deleting it would race the render that
    // won, and an unreferenced object is what the bucket's lifecycle rule is
    // for.
    if (error instanceof LostRace) return 'already-had';
    throw error;
  }

  return 'rendered';
}

/** Another render got there first. Not a failure — the document exists. */
class LostRace extends Error {
  constructor() {
    super('another render already claimed this payslip');
    this.name = 'LostRace';
  }
}

/** `WDT-01102-Payslip-October-2026.pdf` — sortable and self-describing. */
function documentFilename(payslip: {
  reference: string;
  employee: { employeeNumber: string };
  cycle: { label: string };
  version: number;
}): string {
  const label = payslip.cycle.label.replace(/[^A-Za-z0-9]+/g, '-');
  const revision = payslip.version > 1 ? `-v${payslip.version}` : '';
  return `${payslip.employee.employeeNumber}-Payslip-${label}${revision}.pdf`;
}

/* ------------------------------------------------------------------ */
/* The document                                                        */
/* ------------------------------------------------------------------ */

const MARGIN = 48;
const RIGHT = A4.width - MARGIN;

/**
 * The payslip itself.
 *
 * Laid out as the statutory form is read: who and for what at the top,
 * earnings and deductions as two columns of the same table, then net pay, then
 * the derivations. Every figure comes from a column; nothing is recomputed
 * here, so the document cannot disagree with the row it was made from.
 *
 * Exported for the test, which renders a known payslip and checks the file
 * rather than the intent.
 */
export function buildPayslipPdf(
  payslip: PayslipForRender,
  organization: { legalName: string; displayName: string },
): Buffer {
  const page = new PdfPage();
  let y = MARGIN + 6;

  /* ── Masthead ─────────────────────────────────────────────────── */

  page.text(MARGIN, y, organization.legalName, { size: 14, weight: 'bold' });
  page.text(RIGHT, y, 'PAYSLIP', { size: 14, weight: 'bold', align: 'right' });
  y += 16;
  page.text(MARGIN, y, `Pay period: ${payslip.cycle.label}`, { size: 9, grey: 0.35 });
  page.text(RIGHT, y, payslip.reference, { size: 9, grey: 0.35, align: 'right' });
  y += 8;
  page.rule(MARGIN, y, RIGHT, { grey: 0.3, width: 1 });
  y += 22;

  // A revision says so on its face, so a superseded copy in somebody's
  // downloads folder is recognisable as one.
  if (payslip.version > 1) {
    page.text(MARGIN, y, `Revision ${payslip.version} — supersedes the earlier payslip`, {
      size: 9,
      weight: 'bold',
    });
    y += 18;
  }

  /* ── Who, and for what ────────────────────────────────────────── */

  const column = (A4.width - MARGIN * 2) / 2;
  const left: [string, string][] = [
    ['Employee', payslip.employee.fullName],
    ['Employee number', payslip.employee.employeeNumber],
    ['Designation', payslip.employee.employments[0]?.designation.title ?? '-'],
    ['Department', payslip.employee.employments[0]?.department.name ?? '-'],
  ];
  const right: [string, string][] = [
    ['Period', `${formatDate(payslip.periodStart)} to ${formatDate(payslip.periodEnd)}`],
    ['Pay date', formatDate(payslip.payDate)],
    ['Days paid', `${decimal(payslip.payableDays)} of ${payslip.totalDays}`],
    ['Loss of pay', `${decimal(payslip.lopDays)} ${plural(decimal(payslip.lopDays), 'day')}`],
  ];

  const detailTop = y;
  for (const [label, value] of left) {
    page.text(MARGIN, y, label, { size: 8, grey: 0.45 });
    page.text(MARGIN, y + 11, value, { size: 10 });
    y += 26;
  }
  y = detailTop;
  for (const [label, value] of right) {
    page.text(MARGIN + column, y, label, { size: 8, grey: 0.45 });
    page.text(MARGIN + column, y + 11, value, { size: 10 });
    y += 26;
  }

  y += 6;
  page.rule(MARGIN, y, RIGHT, { grey: 0.85 });
  y += 24;

  /* ── Earnings and deductions ──────────────────────────────────── */

  const earnings = payslip.lines.filter((line) => line.kind === 'EARNING');
  const deductions = payslip.lines.filter((line) => line.kind === 'DEDUCTION');
  const employer = payslip.lines.filter((line) => line.kind === 'EMPLOYER_CONTRIBUTION');

  const midpoint = MARGIN + column;
  const leftAmountAt = midpoint - 14;
  const rightAmountAt = RIGHT;

  page.band(MARGIN, y - 11, A4.width - MARGIN * 2, 18, 0.93);
  page.text(MARGIN + 6, y, 'Earnings', { size: 9, weight: 'bold' });
  page.text(leftAmountAt, y, 'Amount', { size: 9, weight: 'bold', align: 'right' });
  page.text(midpoint + 6, y, 'Deductions', { size: 9, weight: 'bold' });
  page.text(rightAmountAt, y, 'Amount', { size: 9, weight: 'bold', align: 'right' });
  y += 20;

  const rows = Math.max(earnings.length, deductions.length);
  for (let index = 0; index < rows; index += 1) {
    const earning = earnings[index];
    const deduction = deductions[index];

    if (earning) {
      page.text(MARGIN + 6, y, earning.label, { size: 9 });
      page.text(leftAmountAt, y, formatINRExact(Number(earning.amountMinor)), {
        size: 9,
        align: 'right',
      });
    }
    if (deduction) {
      page.text(midpoint + 6, y, deduction.label, { size: 9 });
      page.text(rightAmountAt, y, formatINRExact(Number(deduction.amountMinor)), {
        size: 9,
        align: 'right',
      });
    }
    y += 15;
  }

  // An employee with no deductions is a real case, and a blank column with a
  // heading reads as a rendering failure. Say so instead.
  if (deductions.length === 0) {
    page.text(midpoint + 6, y - rows * 15, 'None', { size: 9, grey: 0.5 });
  }
  if (earnings.length === 0) {
    page.text(MARGIN + 6, y - rows * 15, 'None', { size: 9, grey: 0.5 });
  }

  y += 4;
  page.rule(MARGIN, y, RIGHT, { grey: 0.85 });
  y += 16;

  page.text(MARGIN + 6, y, 'Gross earnings', { size: 9, weight: 'bold' });
  page.text(leftAmountAt, y, formatINRExact(Number(payslip.grossEarningsMinor)), {
    size: 9,
    weight: 'bold',
    align: 'right',
  });
  page.text(midpoint + 6, y, 'Total deductions', { size: 9, weight: 'bold' });
  page.text(rightAmountAt, y, formatINRExact(Number(payslip.totalDeductionsMinor)), {
    size: 9,
    weight: 'bold',
    align: 'right',
  });
  y += 26;

  /* ── Net pay ──────────────────────────────────────────────────── */

  page.band(MARGIN, y - 13, A4.width - MARGIN * 2, 30, 0.9);
  page.text(MARGIN + 8, y + 3, 'Net pay', { size: 12, weight: 'bold' });
  page.text(RIGHT - 8, y + 3, formatINRExact(Number(payslip.netPayMinor)), {
    size: 12,
    weight: 'bold',
    align: 'right',
  });
  y += 38;

  /* ── Employer contributions, which are not pay ────────────────── */

  if (employer.length > 0) {
    page.text(MARGIN, y, 'Employer contributions', { size: 9, weight: 'bold' });
    y += 8;
    page.text(
      MARGIN,
      y + 6,
      'Paid by the employer in addition to the above; not deducted from pay.',
      {
        size: 8,
        grey: 0.45,
      },
    );
    y += 20;
    for (const line of employer) {
      page.text(MARGIN + 6, y, line.label, { size: 9 });
      page.text(leftAmountAt, y, formatINRExact(Number(line.amountMinor)), {
        size: 9,
        align: 'right',
      });
      y += 15;
    }
    y += 10;
  }

  /* ── How each figure was reached ──────────────────────────────── */

  const derived = payslip.lines.filter((line) => line.calculationNote);
  if (derived.length > 0) {
    page.rule(MARGIN, y, RIGHT, { grey: 0.85 });
    y += 16;
    page.text(MARGIN, y, 'How these figures were reached', { size: 9, weight: 'bold' });
    y += 16;
    for (const line of derived) {
      // The same note the portal shows. Printing it means the document can
      // answer a question about itself without anybody opening the system.
      page.text(MARGIN + 6, y, `${line.label}: ${line.calculationNote}`, { size: 8, grey: 0.35 });
      y += 12;
    }
    y += 6;
  }

  /* ── Provenance ───────────────────────────────────────────────── */

  const footer = A4.height - MARGIN;
  page.rule(MARGIN, footer - 26, RIGHT, { grey: 0.85 });
  page.text(
    MARGIN,
    footer - 14,
    'Computer-generated from payroll records. Every figure above is stored and auditable.',
    { size: 7.5, grey: 0.45 },
  );
  // Short form, because the whole digest is in the database and this is here to
  // let somebody match a printed copy to the run that produced it.
  page.text(RIGHT, footer - 14, `Source ${payslip.sourceDigest.slice(0, 16)}`, {
    size: 7.5,
    grey: 0.45,
    align: 'right',
  });

  return renderPdf([page]);
}

/** A Prisma Decimal, as a plain string. `2.00` reads better as `2`. */
function decimal(value: unknown): string {
  const text = String(value);
  return text.includes('.') ? text.replace(/\.?0+$/, '') || '0' : text;
}

function plural(count: string, noun: string): string {
  return count === '1' ? noun : `${noun}s`;
}
