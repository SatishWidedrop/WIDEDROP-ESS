import { benefitEnrol, dependentWrite, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';

/**
 * Benefits.
 *
 * A card shows the coverage resolved for this employee — not the plan's
 * generic figure — because a sum insured that is a multiple of CTC differs per
 * person, and showing the plan's headline number to everyone would be wrong
 * for almost all of them.
 *
 * The action button reflects what is actually possible: a plan with no
 * enrolment window open renders no button rather than one that fails.
 */
export async function benefitRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /benefits                                                     */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/benefits', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'benefit:read', 'SELF');

    if (!principal.employeeId) return { plans: [], dependents: [], nominees: [] };

    const today = new Date(toIsoDate(new Date()));

    const [plans, enrolments, dependents, nominees] = await Promise.all([
      db.benefitPlan.findMany({
        where: { organizationId: principal.organizationId, isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          category: true,
          coverageKind: true,
          coverageValueMinor: true,
          coverageMultiplier: true,
          provider: true,
          policyNumber: true,
          action: true,
          description: true,
          documentFileObjectId: true,
          planYears: {
            where: { startDate: { lte: today }, endDate: { gte: today } },
            take: 1,
            select: {
              id: true,
              startDate: true,
              endDate: true,
              enrolmentOpensOn: true,
              enrolmentClosesOn: true,
              employerContributionMinor: true,
              employeeContributionMinor: true,
            },
          },
        },
      }),

      db.benefitEnrolment.findMany({
        where: { organizationId: principal.organizationId, employeeId: principal.employeeId },
        select: {
          id: true,
          benefitPlanId: true,
          benefitPlanYearId: true,
          status: true,
          coverageValueMinor: true,
          enrolledAt: true,
          effectiveFrom: true,
          effectiveTo: true,
          cardFileObjectId: true,
          dependents: {
            select: {
              dependent: {
                select: { id: true, fullName: true, relationship: true, initials: true },
              },
            },
          },
        },
      }),

      db.dependent.findMany({
        where: {
          organizationId: principal.organizationId,
          employeeId: principal.employeeId,
          isActive: true,
        },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          fullName: true,
          relationship: true,
          dateOfBirth: true,
          gender: true,
          initials: true,
        },
      }),

      db.nominee.findMany({
        where: { organizationId: principal.organizationId, employeeId: principal.employeeId },
        orderBy: [{ purpose: 'asc' }, { sharePercent: 'desc' }],
        select: {
          id: true,
          fullName: true,
          relationship: true,
          sharePercent: true,
          purpose: true,
        },
      }),
    ]);

    const enrolmentByPlan = new Map(
      enrolments.map((enrolment) => [enrolment.benefitPlanId, enrolment]),
    );

    return {
      plans: plans.map((plan) => {
        const planYear = plan.planYears[0];
        const enrolment = enrolmentByPlan.get(plan.id);

        const windowOpen =
          planYear !== undefined &&
          (planYear.enrolmentOpensOn === null || planYear.enrolmentOpensOn <= today) &&
          (planYear.enrolmentClosesOn === null || planYear.enrolmentClosesOn >= today);

        return {
          id: plan.id,
          code: plan.code,
          name: plan.name,
          category: plan.category,
          provider: plan.provider,
          policyNumber: plan.policyNumber,
          description: plan.description,
          hasDocument: plan.documentFileObjectId !== null,

          coverageKind: plan.coverageKind,
          // The employee's own figure where they are enrolled, the plan's
          // where they are not yet. Never a made-up number for either.
          coverageValueMinor:
            enrolment?.coverageValueMinor?.toString() ??
            plan.coverageValueMinor?.toString() ??
            null,
          coverageMultiplier: plan.coverageMultiplier ? Number(plan.coverageMultiplier) : null,

          planYear: planYear
            ? {
                id: planYear.id,
                startDate: toIsoDate(planYear.startDate),
                endDate: toIsoDate(planYear.endDate),
                enrolmentOpensOn: planYear.enrolmentOpensOn
                  ? toIsoDate(planYear.enrolmentOpensOn)
                  : null,
                enrolmentClosesOn: planYear.enrolmentClosesOn
                  ? toIsoDate(planYear.enrolmentClosesOn)
                  : null,
                employerContributionMinor: planYear.employerContributionMinor?.toString() ?? null,
                employeeContributionMinor: planYear.employeeContributionMinor?.toString() ?? null,
              }
            : null,

          enrolment: enrolment
            ? {
                id: enrolment.id,
                status: enrolment.status,
                enrolledAt: enrolment.enrolledAt?.toISOString() ?? null,
                effectiveFrom: enrolment.effectiveFrom ? toIsoDate(enrolment.effectiveFrom) : null,
                effectiveTo: enrolment.effectiveTo ? toIsoDate(enrolment.effectiveTo) : null,
                hasCard: enrolment.cardFileObjectId !== null,
                dependents: enrolment.dependents.map((link) => link.dependent),
              }
            : null,

          // The button the card renders, or none at all.
          action: windowOpen ? plan.action : 'NONE',
          enrolmentWindowOpen: windowOpen,
        };
      }),

      dependents: dependents.map((dependent) => ({
        ...dependent,
        dateOfBirth: dependent.dateOfBirth ? toIsoDate(dependent.dateOfBirth) : null,
      })),

      nominees: nominees.map((nominee) => ({
        ...nominee,
        sharePercent: Number(nominee.sharePercent),
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /benefits/dependents                                         */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/benefits/dependents',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'benefit:enrol', 'SELF');

      const employeeId = principal.employeeId;
      if (!employeeId) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          'This account is not linked to an employee.',
        );
      }

      const body = dependentWrite.parse(request.body);

      const created = await db.$transaction(async (tx) => {
        const dependent = await tx.dependent.create({
          data: {
            organizationId: principal.organizationId,
            employeeId,
            fullName: body.fullName,
            relationship: body.relationship,
            dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
            gender: body.gender,
          },
          select: { id: true, fullName: true, initials: true },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'dependent',
            entityId: dependent.id,
            after: { fullName: body.fullName, relationship: body.relationship },
            summary: `Added dependent ${body.fullName}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return dependent;
      });

      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /benefits/enrol                                              */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/benefits/enrol',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'benefit:enrol', 'SELF');

      const employeeId = principal.employeeId;
      if (!employeeId) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          'This account is not linked to an employee.',
        );
      }

      const body = benefitEnrol.parse(request.body);
      const today = new Date(toIsoDate(new Date()));

      const planYear = await db.benefitPlanYear.findFirst({
        where: { id: body.benefitPlanYearId, organizationId: principal.organizationId },
        select: {
          id: true,
          benefitPlanId: true,
          startDate: true,
          endDate: true,
          enrolmentOpensOn: true,
          enrolmentClosesOn: true,
          plan: { select: { name: true, coverageValueMinor: true } },
        },
      });
      if (!planYear) throw notFound('That benefit plan year');

      // The window is checked on the server. A client that renders the button
      // when it should not still gets a refusal.
      const open =
        (planYear.enrolmentOpensOn === null || planYear.enrolmentOpensOn <= today) &&
        (planYear.enrolmentClosesOn === null || planYear.enrolmentClosesOn >= today);
      if (!open) {
        throw conflict(
          `Enrolment for ${planYear.plan.name} is not open. People Ops announces the window each year.`,
        );
      }

      // Only this employee's own dependents may be covered.
      const dependents = await db.dependent.findMany({
        where: {
          id: { in: body.dependentIds },
          employeeId,
          organizationId: principal.organizationId,
          isActive: true,
        },
        select: { id: true },
      });
      if (dependents.length !== body.dependentIds.length) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          'One of those dependents is not on your record.',
        );
      }

      const result = await db.$transaction(async (tx) => {
        const enrolment = await tx.benefitEnrolment.upsert({
          where: {
            employeeId_benefitPlanYearId: { employeeId, benefitPlanYearId: planYear.id },
          },
          update: {
            status: 'ENROLLED',
            enrolledAt: new Date(),
            effectiveFrom: planYear.startDate,
            effectiveTo: planYear.endDate,
          },
          create: {
            organizationId: principal.organizationId,
            employeeId,
            benefitPlanId: planYear.benefitPlanId,
            benefitPlanYearId: planYear.id,
            status: 'ENROLLED',
            // The plan's figure stands until payroll resolves a
            // multiple-of-CTC into this employee's own sum insured.
            coverageValueMinor: planYear.plan.coverageValueMinor,
            enrolledAt: new Date(),
            effectiveFrom: planYear.startDate,
            effectiveTo: planYear.endDate,
          },
          select: { id: true, status: true },
        });

        await tx.benefitEnrolmentDependent.deleteMany({
          where: { benefitEnrolmentId: enrolment.id },
        });

        if (dependents.length > 0) {
          await tx.benefitEnrolmentDependent.createMany({
            data: dependents.map((dependent) => ({
              benefitEnrolmentId: enrolment.id,
              dependentId: dependent.id,
              coveredFrom: planYear.startDate,
              coveredTo: planYear.endDate,
            })),
          });
        }

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'UPDATE',
            entityType: 'benefit_enrolment',
            entityId: enrolment.id,
            toState: 'ENROLLED',
            after: { plan: planYear.plan.name, dependentCount: dependents.length },
            summary: `Enrolled in ${planYear.plan.name} with ${dependents.length} ${dependents.length === 1 ? 'dependent' : 'dependents'}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return enrolment;
      });

      return result;
    },
  );
}
