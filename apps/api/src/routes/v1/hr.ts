import { announcementCreate, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';
import { transitionDocumentRequest } from '../../services/documents/service.js';
import { publishPolicyVersion } from '../../services/policies/service.js';

/**
 * The People Ops surfaces.
 *
 * Every list here counts rows. "12 of 340 people still owe an
 * acknowledgement" is a query against `policy_acknowledgement`, not a number
 * someone maintains; the employee list's status counts are a grouped query,
 * not four hand-written filters that could disagree with each other.
 */
export async function hrRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /hr/employees                                                 */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/v1/hr/employees',
    { onRequest: app.authenticate(), config: { rateLimitName: 'search' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'employee:read', 'ORG');

      const { q, status, departmentId, limit } = request.query as {
        q?: string;
        status?: string;
        departmentId?: string;
        limit?: string;
      };

      const query = (q ?? '').trim();

      const where = {
        organizationId: principal.organizationId,
        ...(status ? { employmentStatus: status as never } : {}),
        ...(query.length >= 2
          ? {
              OR: [
                { fullName: { contains: query, mode: 'insensitive' as const } },
                { workEmail: { contains: query, mode: 'insensitive' as const } },
                { employeeNumber: { contains: query, mode: 'insensitive' as const } },
              ],
            }
          : {}),
        ...(departmentId ? { employments: { some: { departmentId, effectiveTo: null } } } : {}),
      };

      const [employees, byStatus, departments] = await Promise.all([
        db.employee.findMany({
          where,
          orderBy: { fullName: 'asc' },
          take: Math.min(Number(limit) || 100, 300),
          select: {
            id: true,
            employeeNumber: true,
            fullName: true,
            initials: true,
            workEmail: true,
            dateOfJoining: true,
            dateOfExit: true,
            employmentStatus: true,
            appUserId: true,
            employments: {
              where: { effectiveTo: null },
              take: 1,
              select: {
                employmentType: true,
                designation: { select: { title: true } },
                department: { select: { id: true, name: true } },
                location: { select: { name: true } },
              },
            },
            managerLinks: {
              where: { effectiveTo: null, isPrimary: true },
              take: 1,
              select: { manager: { select: { id: true, fullName: true } } },
            },
          },
        }),

        db.employee.groupBy({
          by: ['employmentStatus'],
          where: { organizationId: principal.organizationId },
          _count: { _all: true },
        }),

        db.department.findMany({
          where: { organizationId: principal.organizationId, isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
      ]);

      return {
        items: employees.map((employee) => ({
          id: employee.id,
          employeeNumber: employee.employeeNumber,
          fullName: employee.fullName,
          initials: employee.initials,
          workEmail: employee.workEmail,
          dateOfJoining: toIsoDate(employee.dateOfJoining),
          dateOfExit: employee.dateOfExit ? toIsoDate(employee.dateOfExit) : null,
          employmentStatus: employee.employmentStatus,
          // Whether they can sign in, which is a different question from
          // whether they are employed.
          hasPortalAccount: employee.appUserId !== null,
          employmentType: employee.employments[0]?.employmentType ?? null,
          designation: employee.employments[0]?.designation.title ?? null,
          department: employee.employments[0]?.department.name ?? null,
          location: employee.employments[0]?.location.name ?? null,
          manager: employee.managerLinks[0]?.manager ?? null,
        })),

        counts: Object.fromEntries(byStatus.map((row) => [row.employmentStatus, row._count._all])),
        total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
        departments,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Policy administration                                             */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/hr/policies', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'policy:administer', 'ORG');

    const policies = await db.policy.findMany({
      where: { organizationId: principal.organizationId },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        code: true,
        name: true,
        ownerTeam: true,
        contactEmail: true,
        status: true,
        versions: {
          orderBy: { versionNumber: 'desc' },
          select: {
            id: true,
            versionLabel: true,
            versionNumber: true,
            status: true,
            summary: true,
            effectiveFrom: true,
            publishedAt: true,
            requiresAcknowledgement: true,
            _count: { select: { assignments: true } },
          },
        },
      },
    });

    // Acknowledgement progress, grouped in one query rather than per version.
    const progress = await db.policyAcknowledgement.groupBy({
      by: ['policyVersionId', 'status'],
      where: { organizationId: principal.organizationId },
      _count: { _all: true },
    });

    const byVersion = new Map<string, Record<string, number>>();
    for (const row of progress) {
      const entry = byVersion.get(row.policyVersionId) ?? {};
      entry[row.status] = row._count._all;
      byVersion.set(row.policyVersionId, entry);
    }

    return {
      items: policies.map((policy) => ({
        id: policy.id,
        code: policy.code,
        name: policy.name,
        ownerTeam: policy.ownerTeam,
        contactEmail: policy.contactEmail,
        status: policy.status,
        versions: policy.versions.map((version) => {
          const counts = byVersion.get(version.id) ?? {};
          const acknowledged = counts.ACKNOWLEDGED ?? 0;
          const pending = (counts.PENDING ?? 0) + (counts.OVERDUE ?? 0);

          return {
            id: version.id,
            versionLabel: version.versionLabel,
            versionNumber: version.versionNumber,
            status: version.status,
            summary: version.summary,
            effectiveFrom: toIsoDate(version.effectiveFrom),
            publishedAt: version.publishedAt?.toISOString() ?? null,
            requiresAcknowledgement: version.requiresAcknowledgement,
            assignedCount: version._count.assignments,
            acknowledgedCount: acknowledged,
            pendingCount: pending,
            overdueCount: counts.OVERDUE ?? 0,
            canPublish: version.status === 'DRAFT' || version.status === 'IN_REVIEW',
          };
        }),
      })),
    };
  });

  app.post<{ Params: { versionId: string } }>(
    '/api/v1/hr/policies/versions/:versionId/publish',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'policy:administer', 'ORG');

      return db.$transaction(
        (tx) =>
          publishPolicyVersion(
            tx,
            principal,
            { policyVersionId: request.params.versionId },
            env.AUDIT_HMAC_KEY,
          ),
        // Publication writes one row per affected employee.
        { timeout: 60_000 },
      );
    },
  );

  app.get<{ Params: { versionId: string } }>(
    '/api/v1/hr/policies/versions/:versionId/acknowledgements',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'policy:administer', 'ORG');

      const acknowledgements = await db.policyAcknowledgement.findMany({
        where: {
          organizationId: principal.organizationId,
          policyVersionId: request.params.versionId,
        },
        orderBy: [{ status: 'asc' }, { employee: { fullName: 'asc' } }],
        select: {
          id: true,
          status: true,
          acknowledgedAt: true,
          dueOn: true,
          employee: {
            select: { id: true, fullName: true, initials: true, employeeNumber: true },
          },
        },
      });

      return {
        items: acknowledgements.map((acknowledgement) => ({
          id: acknowledgement.id,
          status: acknowledgement.status,
          acknowledgedAt: acknowledgement.acknowledgedAt?.toISOString() ?? null,
          dueOn: acknowledgement.dueOn ? toIsoDate(acknowledgement.dueOn) : null,
          employee: acknowledgement.employee,
        })),
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Announcements                                                     */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/hr/announcements', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'announcement:administer', 'ORG');

    const announcements = await db.announcement.findMany({
      where: { organizationId: principal.organizationId },
      orderBy: [{ status: 'asc' }, { publishedAt: 'desc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        id: true,
        title: true,
        departmentLabel: true,
        byline: true,
        status: true,
        isPinned: true,
        publishedAt: true,
        expiresAt: true,
        createdAt: true,
        _count: { select: { reads: true, audiences: true } },
      },
    });

    return {
      items: announcements.map((announcement) => ({
        id: announcement.id,
        title: announcement.title,
        department: announcement.departmentLabel,
        byline: announcement.byline,
        status: announcement.status,
        isPinned: announcement.isPinned,
        publishedAt: announcement.publishedAt?.toISOString() ?? null,
        expiresAt: announcement.expiresAt?.toISOString() ?? null,
        createdAt: announcement.createdAt.toISOString(),
        readCount: announcement._count.reads,
        audienceRuleCount: announcement._count.audiences,
      })),
    };
  });

  app.post(
    '/api/v1/hr/announcements',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'announcement:administer', 'ORG');

      const body = announcementCreate.parse(request.body);

      const created = await db.$transaction(async (tx) => {
        // The byline is resolved from the author's record at creation, so it
        // stays correct if they later change team — and so it can never say
        // something the directory does not.
        const author = principal.employeeId
          ? await tx.employee.findUnique({
              where: { id: principal.employeeId },
              select: { id: true, fullName: true },
            })
          : null;

        const announcement = await tx.announcement.create({
          data: {
            organizationId: principal.organizationId,
            title: body.title,
            body: body.paragraphs.join('\n\n'),
            departmentLabel: body.departmentLabel,
            authorEmployeeId: author?.id ?? null,
            byline: author ? `${author.fullName} · ${body.departmentLabel}` : null,
            status: 'DRAFT',
            isPinned: body.isPinned,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
            paragraphs: {
              create: body.paragraphs.map((text, index) => ({
                text,
                displayOrder: index,
              })),
            },
            audiences: {
              create: body.audience.map((rule) => ({
                organizationId: principal.organizationId,
                kind: rule.kind,
                targetId: rule.targetId ?? null,
                targetValue: rule.targetValue ?? null,
              })),
            },
          },
          select: { id: true },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'announcement',
            entityId: announcement.id,
            toState: 'DRAFT',
            after: { title: body.title, audienceRules: body.audience.length },
            summary: `Drafted announcement "${body.title}"`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return announcement;
      });

      return reply.status(201).send(created);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/v1/hr/announcements/:id/publish',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'announcement:administer', 'ORG');

      const announcement = await db.announcement.findFirst({
        where: { id: request.params.id, organizationId: principal.organizationId },
        select: { id: true, title: true, status: true, _count: { select: { audiences: true } } },
      });
      if (!announcement) throw notFound('That announcement');

      if (announcement.status !== 'DRAFT' && announcement.status !== 'SCHEDULED') {
        throw new AppError(
          409,
          ERROR_CODES.INVALID_STATE_TRANSITION,
          'This announcement has already been published.',
        );
      }
      if (announcement._count.audiences === 0) {
        throw new AppError(
          422,
          ERROR_CODES.BUSINESS_RULE_VIOLATION,
          'This announcement has no audience, so nobody would see it.',
        );
      }

      const publishedAt = new Date();

      await db.$transaction(async (tx) => {
        await tx.announcement.update({
          where: { id: announcement.id },
          data: {
            status: 'PUBLISHED',
            publishedAt,
            publishedByUserId: principal.userId,
            rowVersion: { increment: 1 },
          },
        });

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'STATE_TRANSITION',
            entityType: 'announcement',
            entityId: announcement.id,
            fromState: announcement.status,
            toState: 'PUBLISHED',
            summary: `Published announcement "${announcement.title}"`,
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      return { id: announcement.id, publishedAt: publishedAt.toISOString() };
    },
  );

  /* ---------------------------------------------------------------- */
  /* Letter requests                                                   */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/hr/documents/requests', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'document:issue', 'ORG');

    const { status } = request.query as { status?: string };

    const requests = await db.documentRequest.findMany({
      where: {
        organizationId: principal.organizationId,
        ...(status === 'open'
          ? { status: { in: ['SUBMITTED', 'IN_REVIEW', 'PROCESSING'] } }
          : status
            ? { status: status as never }
            : {}),
      },
      orderBy: { requestedAt: 'asc' },
      take: 200,
      select: {
        id: true,
        status: true,
        addressee: true,
        purpose: true,
        requestedAt: true,
        startedAt: true,
        issuedAt: true,
        rejectionReason: true,
        fileObjectId: true,
        type: { select: { id: true, name: true } },
        employee: {
          select: { id: true, fullName: true, initials: true, employeeNumber: true },
        },
        template: { select: { id: true, name: true, version: true } },
      },
    });

    return {
      items: requests.map((documentRequest) => ({
        id: documentRequest.id,
        status: documentRequest.status,
        typeName: documentRequest.type.name,
        addressee: documentRequest.addressee,
        purpose: documentRequest.purpose,
        requestedAt: documentRequest.requestedAt.toISOString(),
        startedAt: documentRequest.startedAt?.toISOString() ?? null,
        issuedAt: documentRequest.issuedAt?.toISOString() ?? null,
        rejectionReason: documentRequest.rejectionReason,
        hasDocument: documentRequest.fileObjectId !== null,
        employee: documentRequest.employee,
        template: documentRequest.template,
      })),
    };
  });

  app.post<{ Params: { id: string } }>(
    '/api/v1/hr/documents/requests/:id/transition',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'document:issue', 'ORG');

      const body = request.body as {
        event?: 'REVIEW' | 'START' | 'ISSUE' | 'REJECT';
        fileObjectId?: string;
        rejectionReason?: string;
      };

      if (!body.event) {
        throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'Name the action to take.');
      }

      const status = await db.$transaction((tx) =>
        transitionDocumentRequest(
          tx,
          principal,
          {
            requestId: request.params.id,
            event: body.event!,
            fileObjectId: body.fileObjectId ?? null,
            rejectionReason: body.rejectionReason ?? null,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return { status };
    },
  );

  /* ---------------------------------------------------------------- */
  /* The letter's text, resolved from persisted data                   */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/hr/documents/requests/:id/preview',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'document:issue', 'ORG');

      const documentRequest = await db.documentRequest.findFirst({
        where: { id: request.params.id, organizationId: principal.organizationId },
        select: {
          id: true,
          employeeId: true,
          addressee: true,
          template: { select: { bodyTemplate: true, name: true } },
        },
      });
      if (!documentRequest) throw notFound('That request');

      if (!documentRequest.template) {
        return {
          body: null,
          missing: [],
          // Said plainly rather than rendering an empty preview: there is no
          // template for this document type, so nothing can be generated.
          reason: 'No letter template is configured for this document type.',
        };
      }

      const { letterPlaceholders, renderLetter } =
        await import('../../services/documents/service.js');

      const values = await letterPlaceholders(
        db,
        principal.organizationId,
        documentRequest.employeeId,
      );
      if (documentRequest.addressee) values['request.addressee'] = documentRequest.addressee;

      const rendered = renderLetter(documentRequest.template.bodyTemplate, values);

      return {
        body: rendered.body,
        // Named rather than silently blank: a placeholder with no value means
        // the database does not hold the fact the letter would assert.
        missing: rendered.missing,
        reason: null,
      };
    },
  );
}
