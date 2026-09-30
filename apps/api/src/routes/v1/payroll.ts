import {
  PAYROLL_CHECKS,
  daysInMonth,
  formatMonth,
  payrollCycleEvent,
  payrollCycleCreate,
  payrollInputBatchCreate,
  toIsoDate,
  type PayrollCycleState,
} from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';
import { generatePayroll } from '../../services/payroll/generation.js';
import {
  availableEvents,
  eligibleCount,
  transitionCycle,
} from '../../services/payroll/pipeline.js';
import { runValidation } from '../../services/payroll/validation.js';
import { notifyEmployee } from '../../services/notifications.js';
import { refreshPayslipRollups } from '../../services/payroll/rollups.js';

/**
 * Payroll, as Accounts drives it.
 *
 * The pipeline the requirement states runs here end to end:
 *
 *   inputs uploaded → inputs locked → attendance submitted (HR) →
 *   attendance approved (managers) → validated → calculated → approved →
 *   published → the payslip becomes visible.
 *
 * Nothing on this screen skips a step. The buttons a cycle offers come from
 * `availableEvents`, which asks the same state machine the server enforces, so
 * the UI cannot show an action the API would refuse. Validation and generation
 * are the two steps the system performs rather than a person: they are raised
 * as system events, and a caller who asks for them directly is refused.
 */
export async function payrollRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /payroll/cycles                                               */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/payroll/cycles', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'payroll-cycle:read', 'ORG');

    const cycles = await db.payrollCycle.findMany({
      where: { organizationId: principal.organizationId },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 36,
      select: {
        id: true,
        year: true,
        month: true,
        label: true,
        status: true,
        runType: true,
        periodStart: true,
        periodEnd: true,
        payDate: true,
        employeeCount: true,
        excludedCount: true,
        totalGrossMinor: true,
        totalNetMinor: true,
        inputsLockedAt: true,
        attendanceSubmittedAt: true,
        attendanceApprovedAt: true,
        validatedAt: true,
        calculatedAt: true,
        approvedAt: true,
        publishedAt: true,
        attendancePeriod: { select: { id: true, status: true } },
        _count: { select: { payslips: true, inputBatches: true } },
      },
    });

    return {
      items: cycles.map((cycle) => ({
        id: cycle.id,
        label: cycle.label,
        year: cycle.year,
        month: cycle.month,
        status: cycle.status,
        runType: cycle.runType,
        periodStart: toIsoDate(cycle.periodStart),
        periodEnd: toIsoDate(cycle.periodEnd),
        payDate: toIsoDate(cycle.payDate),

        // Null until the run that computes them has happened. A cycle that has
        // not been calculated shows an em dash, not ₹0.
        employeeCount: cycle.employeeCount,
        excludedCount: cycle.excludedCount,
        totalGrossMinor: cycle.totalGrossMinor?.toString() ?? null,
        totalNetMinor: cycle.totalNetMinor?.toString() ?? null,

        payslipCount: cycle._count.payslips,
        inputBatchCount: cycle._count.inputBatches,
        attendancePeriod: cycle.attendancePeriod,

        // The stage timeline the screen draws, each entry a stored timestamp.
        stages: {
          inputsLockedAt: cycle.inputsLockedAt?.toISOString() ?? null,
          attendanceSubmittedAt: cycle.attendanceSubmittedAt?.toISOString() ?? null,
          attendanceApprovedAt: cycle.attendanceApprovedAt?.toISOString() ?? null,
          validatedAt: cycle.validatedAt?.toISOString() ?? null,
          calculatedAt: cycle.calculatedAt?.toISOString() ?? null,
          approvedAt: cycle.approvedAt?.toISOString() ?? null,
          publishedAt: cycle.publishedAt?.toISOString() ?? null,
        },

        availableEvents: availableEvents(cycle.status as PayrollCycleState, principal.personas),
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /payroll/cycles/:id                                           */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/payroll/cycles/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-cycle:read', 'ORG');

      const cycle = await db.payrollCycle.findFirst({
        where: { id: request.params.id, organizationId: principal.organizationId },
        select: {
          id: true,
          year: true,
          month: true,
          label: true,
          status: true,
          runType: true,
          periodStart: true,
          periodEnd: true,
          payDate: true,
          employeeCount: true,
          excludedCount: true,
          totalGrossMinor: true,
          totalDeductionMinor: true,
          totalNetMinor: true,
          inputsLockedAt: true,
          attendanceSubmittedAt: true,
          attendanceApprovedAt: true,
          validatedAt: true,
          calculatedAt: true,
          approvedAt: true,
          publishedAt: true,
          cancelReason: true,
          attendancePeriod: {
            select: {
              id: true,
              year: true,
              month: true,
              status: true,
              _count: { select: { records: true } },
              approvals: {
                select: {
                  status: true,
                  recordCount: true,
                  manager: { select: { fullName: true } },
                },
              },
            },
          },
          inputBatches: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              originalFilename: true,
              rowCount: true,
              acceptedCount: true,
              rejectedCount: true,
              createdAt: true,
              committedAt: true,
              _count: { select: { items: true } },
            },
          },
          runs: {
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              attempt: true,
              status: true,
              engineVersion: true,
              inputDigest: true,
              employeeCount: true,
              errorMessage: true,
              startedAt: true,
              finishedAt: true,
              createdAt: true,
            },
          },
        },
      });

      if (!cycle) throw notFound('That payroll cycle');

      // What the validation pass found, grouped by check so the screen can
      // say "3 people have no verified bank account" rather than listing 3
      // unexplained failures.
      const validation = await db.payrollValidationResult.findMany({
        where: { payrollCycleId: cycle.id },
        orderBy: [{ attempt: 'desc' }, { check: 'asc' }],
        select: {
          id: true,
          attempt: true,
          check: true,
          severity: true,
          passed: true,
          message: true,
          remedy: true,
          employee: { select: { id: true, fullName: true, employeeNumber: true } },
        },
      });

      const latestAttempt = validation[0]?.attempt ?? null;
      const latest = validation.filter((row) => row.attempt === latestAttempt && !row.passed);

      const grouped = new Map<
        string,
        {
          check: string;
          severity: string;
          label: string;
          remedy: string | null;
          employees: { id: string; fullName: string; employeeNumber: string; message: string }[];
        }
      >();

      for (const row of latest) {
        if (!row.employee) continue;
        const definition = PAYROLL_CHECKS.find((check) => check.check === row.check);
        const entry = grouped.get(row.check) ?? {
          check: row.check,
          severity: row.severity,
          label: definition?.label ?? row.check,
          remedy: definition?.remedy ?? row.remedy,
          employees: [],
        };
        entry.employees.push({
          id: row.employee.id,
          fullName: row.employee.fullName,
          employeeNumber: row.employee.employeeNumber,
          message: row.message,
        });
        grouped.set(row.check, entry);
      }

      return {
        id: cycle.id,
        label: cycle.label,
        status: cycle.status,
        runType: cycle.runType,
        periodStart: toIsoDate(cycle.periodStart),
        periodEnd: toIsoDate(cycle.periodEnd),
        payDate: toIsoDate(cycle.payDate),
        cancelReason: cycle.cancelReason,

        totals: {
          employeeCount: cycle.employeeCount,
          excludedCount: cycle.excludedCount,
          grossMinor: cycle.totalGrossMinor?.toString() ?? null,
          deductionsMinor: cycle.totalDeductionMinor?.toString() ?? null,
          netMinor: cycle.totalNetMinor?.toString() ?? null,
        },

        stages: {
          inputsLockedAt: cycle.inputsLockedAt?.toISOString() ?? null,
          attendanceSubmittedAt: cycle.attendanceSubmittedAt?.toISOString() ?? null,
          attendanceApprovedAt: cycle.attendanceApprovedAt?.toISOString() ?? null,
          validatedAt: cycle.validatedAt?.toISOString() ?? null,
          calculatedAt: cycle.calculatedAt?.toISOString() ?? null,
          approvedAt: cycle.approvedAt?.toISOString() ?? null,
          publishedAt: cycle.publishedAt?.toISOString() ?? null,
        },

        attendance: cycle.attendancePeriod
          ? {
              id: cycle.attendancePeriod.id,
              label: formatMonth(cycle.attendancePeriod.year, cycle.attendancePeriod.month),
              status: cycle.attendancePeriod.status,
              recordCount: cycle.attendancePeriod._count.records,
              approvals: cycle.attendancePeriod.approvals.map((approval) => ({
                manager: approval.manager.fullName,
                status: approval.status,
                recordCount: approval.recordCount,
              })),
              pendingApprovals: cycle.attendancePeriod.approvals.filter(
                (approval) => approval.status === 'PENDING',
              ).length,
            }
          : null,

        inputBatches: cycle.inputBatches.map((batch) => ({
          id: batch.id,
          status: batch.status,
          filename: batch.originalFilename,
          rowCount: batch.rowCount,
          acceptedCount: batch.acceptedCount,
          rejectedCount: batch.rejectedCount,
          itemCount: batch._count.items,
          createdAt: batch.createdAt.toISOString(),
          committedAt: batch.committedAt?.toISOString() ?? null,
        })),

        runs: cycle.runs.map((run) => ({
          id: run.id,
          attempt: run.attempt,
          status: run.status,
          engineVersion: run.engineVersion,
          inputDigest: run.inputDigest,
          employeeCount: run.employeeCount,
          errorMessage: run.errorMessage,
          createdAt: run.createdAt.toISOString(),
          startedAt: run.startedAt?.toISOString() ?? null,
          finishedAt: run.finishedAt?.toISOString() ?? null,
        })),

        validation: {
          attempt: latestAttempt,
          blocking: [...grouped.values()].filter((group) => group.severity === 'ERROR'),
          warnings: [...grouped.values()].filter((group) => group.severity !== 'ERROR'),
        },

        availableEvents: availableEvents(cycle.status as PayrollCycleState, principal.personas),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /payroll/cycles                                              */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/payroll/cycles',
    { onRequest: app.authenticate(), config: { rateLimitName: 'payroll:mutate' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-cycle:create', 'ORG');

      const body = payrollCycleCreate.parse(request.body);
      const total = daysInMonth(body.year, body.month);

      const existing = await db.payrollCycle.findFirst({
        where: {
          organizationId: principal.organizationId,
          year: body.year,
          month: body.month,
          runType: 'REGULAR',
        },
        select: { id: true, status: true },
      });
      if (existing) {
        throw conflict(
          `A payroll cycle for ${formatMonth(body.year, body.month)} already exists.`,
          ERROR_CODES.ALREADY_EXISTS,
        );
      }

      // The attendance period the cycle will consume. Linked at creation so
      // the two are never mismatched later.
      const attendancePeriod = await db.attendancePeriod.findUnique({
        where: {
          organizationId_year_month: {
            organizationId: principal.organizationId,
            year: body.year,
            month: body.month,
          },
        },
        select: { id: true, payrollCycle: { select: { id: true } } },
      });

      if (attendancePeriod?.payrollCycle) {
        throw conflict('That attendance period is already attached to another cycle.');
      }

      const created = await db.$transaction(async (tx) => {
        const cycle = await tx.payrollCycle.create({
          data: {
            organizationId: principal.organizationId,
            year: body.year,
            month: body.month,
            label: formatMonth(body.year, body.month),
            periodStart: new Date(Date.UTC(body.year, body.month - 1, 1)),
            periodEnd: new Date(Date.UTC(body.year, body.month - 1, total)),
            payDate: new Date(body.payDate),
            status: 'DRAFT',
            runType: 'REGULAR',
            attendancePeriodId: attendancePeriod?.id ?? null,
          },
          select: { id: true, label: true, status: true },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'payroll_cycle',
            entityId: cycle.id,
            toState: 'DRAFT',
            after: { label: cycle.label, payDate: body.payDate },
            summary: `Created the ${cycle.label} payroll cycle`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return cycle;
      });

      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /payroll/cycles/:id/transition                               */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/payroll/cycles/:id/transition',
    { onRequest: app.authenticate(), config: { rateLimitName: 'payroll:mutate' } },
    async (request) => {
      const principal = requirePrincipal(request);
      const body = payrollCycleEvent.parse(request.body);

      // The extra columns each event writes. Kept here rather than in the
      // state machine so the machine stays a description of what may happen
      // and this stays the record of what happened.
      const now = new Date();
      const data: Record<string, unknown> =
        body.event === 'LOCK_INPUTS'
          ? { inputsLockedAt: now }
          : body.event === 'APPROVE'
            ? { approvedAt: now, approvedByUserId: principal.userId }
            : body.event === 'PUBLISH'
              ? { publishedAt: now, publishedByUserId: principal.userId }
              : body.event === 'CLOSE'
                ? { closedAt: now }
                : body.event === 'CANCEL'
                  ? { cancelledAt: now, cancelReason: body.note ?? null }
                  : {};

      const result = await db.$transaction((tx) =>
        transitionCycle(
          tx,
          principal,
          { cycleId: request.params.id, event: body.event },
          env.AUDIT_HMAC_KEY,
          { data, ...(body.note ? { summary: body.note } : {}) },
        ),
      );

      // Publishing is what makes payslips visible, so it is also what tells
      // each employee. One notification per payslip actually published.
      if (body.event === 'PUBLISH') {
        await publishPayslips(db, env.AUDIT_HMAC_KEY, {
          organizationId: principal.organizationId,
          cycleId: request.params.id,
          userId: principal.userId,
        });
      }

      return result;
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /payroll/cycles/:id/validate                                 */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/payroll/cycles/:id/validate',
    { onRequest: app.authenticate(), config: { rateLimitName: 'payroll:mutate' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-cycle:validate', 'ORG');

      return db.$transaction(
        async (tx) => {
          // VALIDATE is the person's act; the pass and fail events that follow
          // are the system's, raised from what the checks actually found.
          await transitionCycle(
            tx,
            principal,
            { cycleId: request.params.id, event: 'VALIDATE' },
            env.AUDIT_HMAC_KEY,
          );

          const summary = await runValidation(tx, {
            organizationId: principal.organizationId,
            payrollCycleId: request.params.id,
          });

          const passed =
            summary.eligibleEmployeeIds.length > 0 &&
            summary.failures.every((failure) => failure.passed);

          await transitionCycle(
            tx,
            principal,
            {
              cycleId: request.params.id,
              event: passed ? 'VALIDATION_PASSED' : 'VALIDATION_REJECTED',
            },
            env.AUDIT_HMAC_KEY,
            {
              systemRaised: true,
              data: passed ? { validatedAt: new Date() } : {},
              summary: passed
                ? `${summary.employeesPassing} of ${summary.employeesInScope} employees cleared validation`
                : `${summary.employeesExcluded} of ${summary.employeesInScope} employees were excluded`,
            },
          );

          return {
            attempt: summary.attempt,
            employeesInScope: summary.employeesInScope,
            employeesPassing: summary.employeesPassing,
            employeesExcluded: summary.employeesExcluded,
            passed,
            failures: summary.failures.filter((failure) => !failure.passed),
          };
        },
        { timeout: 120_000 },
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /payroll/cycles/:id/calculate                                */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/payroll/cycles/:id/calculate',
    { onRequest: app.authenticate(), config: { rateLimitName: 'payroll:mutate' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-cycle:generate', 'ORG');

      return db.$transaction(
        async (tx) => {
          await transitionCycle(
            tx,
            principal,
            { cycleId: request.params.id, event: 'CALCULATE' },
            env.AUDIT_HMAC_KEY,
          );

          // Who the latest validation pass cleared. Generation is given that
          // list rather than deriving its own, so the run pays exactly the
          // people validation said were payable.
          const latest = await tx.payrollValidationResult.aggregate({
            where: { payrollCycleId: request.params.id },
            _max: { attempt: true },
          });

          const results = await tx.payrollValidationResult.findMany({
            where: {
              payrollCycleId: request.params.id,
              attempt: latest._max.attempt ?? 0,
            },
            select: { employeeId: true, passed: true, severity: true },
          });

          const blocked = new Set(
            results
              .filter((row) => !row.passed && row.severity === 'ERROR')
              .map((row) => row.employeeId),
          );
          const eligibleEmployeeIds = [
            ...new Set(
              results
                .map((row) => row.employeeId)
                // A check that is not about one employee — a cycle-level
                // prerequisite — carries no employee id and names nobody to pay.
                .filter((employeeId): employeeId is string => employeeId !== null),
            ),
          ].filter((employeeId) => !blocked.has(employeeId));

          if (eligibleEmployeeIds.length === 0) {
            throw new AppError(
              422,
              ERROR_CODES.PAYROLL_PREREQUISITE_NOT_MET,
              'No employee cleared validation, so there is nothing to calculate.',
            );
          }

          const generated = await generatePayroll(
            tx,
            principal,
            { cycleId: request.params.id, eligibleEmployeeIds },
            env.AUDIT_HMAC_KEY,
          );

          await transitionCycle(
            tx,
            principal,
            { cycleId: request.params.id, event: 'CALCULATION_SUCCEEDED' },
            env.AUDIT_HMAC_KEY,
            {
              systemRaised: true,
              data: {
                calculatedAt: new Date(),
                employeeCount: eligibleEmployeeIds.length,
                excludedCount: blocked.size,
                totalGrossMinor: generated.totalGrossMinor,
                totalDeductionMinor: generated.totalDeductionsMinor,
                totalNetMinor: generated.totalNetMinor,
              },
              summary: `Calculated ${generated.payslipsCreated} payslips`,
            },
          );

          return {
            payrollRunId: generated.payrollRunId,
            payslipsCreated: generated.payslipsCreated,
            totalGrossMinor: generated.totalGrossMinor.toString(),
            totalNetMinor: generated.totalNetMinor.toString(),
            skipped: generated.skipped,
          };
        },
        { timeout: 300_000 },
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* Payroll inputs                                                    */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/payroll/inputs',
    { onRequest: app.authenticate(), config: { rateLimitName: 'payroll:mutate' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-input:upload', 'ORG');

      const body = payrollInputBatchCreate.parse(request.body);

      const cycle = await db.payrollCycle.findFirst({
        where: { id: body.payrollCycleId, organizationId: principal.organizationId },
        select: { id: true, status: true, label: true },
      });
      if (!cycle) throw notFound('That payroll cycle');

      if (!['DRAFT', 'INPUTS_OPEN'].includes(cycle.status)) {
        throw conflict(
          `Inputs for ${cycle.label} are locked. Reopen them before uploading more.`,
          ERROR_CODES.INVALID_STATE_TRANSITION,
        );
      }

      // Every employee named must exist in this organisation. A row naming
      // someone who does not is rejected rather than silently dropped, so an
      // uploaded file's row count and the accepted count can be reconciled.
      const employeeIds = [...new Set(body.items.map((item) => item.employeeId))];
      const known = await db.employee.findMany({
        where: { id: { in: employeeIds }, organizationId: principal.organizationId },
        select: { id: true },
      });
      const knownIds = new Set(known.map((employee) => employee.id));
      const unknown = employeeIds.filter((employeeId) => !knownIds.has(employeeId));

      if (unknown.length > 0) {
        throw new AppError(
          422,
          ERROR_CODES.VALIDATION_FAILED,
          `${unknown.length} ${unknown.length === 1 ? 'row names someone' : 'rows name people'} who do not work here.`,
          {
            details: unknown.slice(0, 20).map((id) => ({ path: id, message: 'Unknown employee' })),
          },
        );
      }

      const created = await db.$transaction(async (tx) => {
        const batch = await tx.payrollInputBatch.create({
          data: {
            organizationId: principal.organizationId,
            payrollCycleId: cycle.id,
            status: 'COMMITTED',
            originalFilename: body.sourceFilename ?? 'entered-in-portal',
            rowCount: body.items.length,
            acceptedCount: body.items.length,
            rejectedCount: 0,
            uploadedByUserId: principal.userId,
            committedAt: new Date(),
          },
          select: { id: true, rowCount: true },
        });

        // Written after the batch rather than nested, so each row carries the
        // batch id explicitly and the row number matches the file's ordering.
        await tx.payrollInputItem.createMany({
          data: body.items.map((item, index) => ({
            organizationId: principal.organizationId,
            payrollInputBatchId: batch.id,
            employeeId: item.employeeId,
            kind: item.kind,
            amountMinor: BigInt(item.amountMinor),
            note: item.note ?? null,
            sourceRowNumber: index + 1,
          })),
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'payroll_input_batch',
            entityId: batch.id,
            after: {
              cycle: cycle.label,
              rowCount: batch.rowCount,
              totalMinor: body.items
                .reduce((total, item) => total + BigInt(item.amountMinor), 0n)
                .toString(),
            },
            summary: `Uploaded ${batch.rowCount} payroll input ${batch.rowCount === 1 ? 'row' : 'rows'} for ${cycle.label}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        // Uploading is itself what opens the cycle for inputs: the machine
        // takes DRAFT and INPUTS_OPEN to INPUTS_OPEN on the same event, so a
        // first batch and a corrected one are the same action.
        await transitionCycle(
          tx,
          principal,
          { cycleId: cycle.id, event: 'UPLOAD_INPUTS' },
          env.AUDIT_HMAC_KEY,
        );

        return batch;
      });

      return reply.status(201).send(created);
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/v1/payroll/inputs/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-cycle:read', 'ORG');

      const batch = await db.payrollInputBatch.findFirst({
        where: { id: request.params.id, organizationId: principal.organizationId },
        select: {
          id: true,
          status: true,
          originalFilename: true,
          rowCount: true,
          acceptedCount: true,
          rejectedCount: true,
          createdAt: true,
          committedAt: true,
          cycle: { select: { id: true, label: true, status: true } },
          items: {
            orderBy: { sourceRowNumber: 'asc' },
            select: {
              id: true,
              kind: true,
              amountMinor: true,
              days: true,
              note: true,
              sourceRowNumber: true,
              employee: {
                select: { id: true, fullName: true, employeeNumber: true, initials: true },
              },
            },
          },
        },
      });

      if (!batch) throw notFound('That input batch');

      return {
        id: batch.id,
        status: batch.status,
        filename: batch.originalFilename,
        rowCount: batch.rowCount,
        acceptedCount: batch.acceptedCount,
        rejectedCount: batch.rejectedCount,
        createdAt: batch.createdAt.toISOString(),
        committedAt: batch.committedAt?.toISOString() ?? null,
        cycle: batch.cycle,
        items: batch.items.map((item) => ({
          id: item.id,
          kind: item.kind,
          // Null for a kind that carries days rather than money, such as a
          // loss-of-pay override.
          amountMinor: item.amountMinor?.toString() ?? null,
          days: item.days === null ? null : Number(item.days),
          note: item.note,
          rowNumber: item.sourceRowNumber,
          employee: item.employee,
        })),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* The payslip register — Accounts' view of what a cycle produced    */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/payroll/cycles/:id/payslips',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      // A distinct permission from `payslip:read`: Accounts reads the register
      // for every employee, which no other role may do.
      assertPermission(principal, 'payslip:read-any', 'ORG');

      const payslips = await db.payslip.findMany({
        where: {
          organizationId: principal.organizationId,
          payrollCycleId: request.params.id,
        },
        orderBy: { employee: { fullName: 'asc' } },
        select: {
          id: true,
          reference: true,
          status: true,
          payableDays: true,
          totalDays: true,
          lopDays: true,
          grossEarningsMinor: true,
          totalDeductionsMinor: true,
          netPayMinor: true,
          tdsMinor: true,
          pfEmployeeMinor: true,
          employee: {
            select: { id: true, fullName: true, employeeNumber: true, initials: true },
          },
        },
      });

      // Reading the whole register is a bulk read of everyone's pay. It is
      // recorded once per read, naming how many rows were seen.
      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'EXPORT',
            entityType: 'payroll_cycle',
            entityId: request.params.id,
            after: { payslipCount: payslips.length },
            summary: `Read the payslip register for ${payslips.length} ${payslips.length === 1 ? 'employee' : 'employees'}`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return {
        items: payslips.map((payslip) => ({
          id: payslip.id,
          reference: payslip.reference,
          status: payslip.status,
          employee: payslip.employee,
          payableDays: Number(payslip.payableDays),
          totalDays: payslip.totalDays,
          lopDays: Number(payslip.lopDays),
          grossEarningsMinor: payslip.grossEarningsMinor.toString(),
          totalDeductionsMinor: payslip.totalDeductionsMinor.toString(),
          netPayMinor: payslip.netPayMinor.toString(),
          tdsMinor: payslip.tdsMinor.toString(),
          pfEmployeeMinor: payslip.pfEmployeeMinor.toString(),
        })),
        totals: {
          count: payslips.length,
          grossMinor: payslips
            .reduce((total, payslip) => total + payslip.grossEarningsMinor, 0n)
            .toString(),
          netMinor: payslips.reduce((total, payslip) => total + payslip.netPayMinor, 0n).toString(),
        },
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Eligible headcount, for the screen's "ready to run" line          */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/payroll/cycles/:id/eligible-count',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'payroll-cycle:read', 'ORG');

      return { count: await eligibleCount(db, request.params.id) };
    },
  );
}

/**
 * Publish the payslips a cycle produced.
 *
 * Separate from the cycle transition because it writes one row per payslip and
 * one notification per employee: the transition is the decision, this is its
 * consequence. Idempotent, so a retry after a partial failure converges.
 */
async function publishPayslips(
  db: App['db'],
  hmacKey: string,
  input: { organizationId: string; cycleId: string; userId: string },
): Promise<void> {
  const publishedAt = new Date();

  const payslips = await db.payslip.findMany({
    where: {
      organizationId: input.organizationId,
      payrollCycleId: input.cycleId,
      status: 'GENERATED',
    },
    select: {
      id: true,
      employeeId: true,
      reference: true,
      netPayMinor: true,
      periodEnd: true,
      cycle: { select: { label: true } },
    },
  });

  for (const payslip of payslips) {
    await db.$transaction(async (tx) => {
      await tx.payslip.update({
        where: { id: payslip.id },
        data: { status: 'PUBLISHED', publishedAt },
      });

      await tx.payslipPublication.create({
        data: {
          organizationId: input.organizationId,
          payslipId: payslip.id,
          publishedByUserId: input.userId,
          publishedAt,
        },
      });

      await notifyEmployee(tx, {
        organizationId: input.organizationId,
        employeeId: payslip.employeeId,
        kind: 'PAYSLIP_PUBLISHED',
        tone: 'GREEN',
        title: `Your ${payslip.cycle.label} payslip is available`,
        body: null,
        targetModule: 'payslips',
        targetId: payslip.id,
        sourceType: 'payslip',
        sourceId: payslip.id,
      });
    });
  }

  if (payslips.length > 0) {
    // The year-to-date tiles and the quarterly TDS table, recomputed from the
    // payslips that are now visible. Done after publication rather than with
    // it, so a total can never describe a payslip the employee cannot see.
    await db.$transaction(
      (tx) =>
        refreshPayslipRollups(tx, {
          organizationId: input.organizationId,
          employeeIds: payslips.map((payslip) => payslip.employeeId),
          onDate: toIsoDate(payslips[0]!.periodEnd),
        }),
      { timeout: 120_000 },
    );

    await db.$transaction((tx) =>
      recordAudit(
        tx,
        {
          organizationId: input.organizationId,
          action: 'STATE_TRANSITION',
          entityType: 'payslip',
          entityId: input.cycleId,
          fromState: 'GENERATED',
          toState: 'PUBLISHED',
          after: { payslipCount: payslips.length },
          summary: `Published ${payslips.length} ${payslips.length === 1 ? 'payslip' : 'payslips'}`,
        },
        hmacKey,
      ),
    );
  }
}
