import { policyAcknowledge, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { assertPermission } from '../../services/auth/authorization.js';
import { acknowledgePolicyVersion } from '../../services/policies/service.js';

/**
 * Policies, as the employee sees them.
 *
 * The list is driven by assignments, so it answers "which policies apply to
 * me" from rows rather than from a rule evaluated in the browser. Each entry
 * carries the acknowledgement state for this person and this version — the
 * four facts the requirement names: employee, version, status, timestamp.
 */
export async function policyRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /policies                                                     */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/policies', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'policy:read', 'SELF');

    if (!principal.employeeId) return { items: [], pendingCount: 0 };

    const assignments = await db.policyAssignment.findMany({
      where: { organizationId: principal.organizationId, employeeId: principal.employeeId },
      select: {
        id: true,
        dueOn: true,
        assignedAt: true,
        version: {
          select: {
            id: true,
            versionLabel: true,
            versionNumber: true,
            status: true,
            summary: true,
            effectiveFrom: true,
            requiresAcknowledgement: true,
            pdfFileObjectId: true,
            policy: {
              select: {
                id: true,
                code: true,
                name: true,
                ownerTeam: true,
                contactEmail: true,
                displayOrder: true,
              },
            },
            points: { orderBy: { displayOrder: 'asc' }, select: { id: true, text: true } },
          },
        },
      },
    });

    // The acknowledgement rows for the same versions, so status and timestamp
    // come from the record rather than being inferred from the assignment.
    const acknowledgements = await db.policyAcknowledgement.findMany({
      where: {
        organizationId: principal.organizationId,
        employeeId: principal.employeeId,
        policyVersionId: { in: assignments.map((assignment) => assignment.version.id) },
      },
      select: {
        policyVersionId: true,
        status: true,
        acknowledgedAt: true,
        dueOn: true,
        waivedAt: true,
        waiveReason: true,
      },
    });
    const ackByVersion = new Map(
      acknowledgements.map((acknowledgement) => [acknowledgement.policyVersionId, acknowledgement]),
    );

    const items = assignments
      // A superseded version stays in the list — an employee should be able to
      // see that they acknowledged v3 and that v4 now applies — but only a
      // published one can be acknowledged.
      .map((assignment) => {
        const acknowledgement = ackByVersion.get(assignment.version.id);
        return {
          policyId: assignment.version.policy.id,
          code: assignment.version.policy.code,
          name: assignment.version.policy.name,
          ownerTeam: assignment.version.policy.ownerTeam,
          contactEmail: assignment.version.policy.contactEmail,
          displayOrder: assignment.version.policy.displayOrder,

          versionId: assignment.version.id,
          versionLabel: assignment.version.versionLabel,
          versionStatus: assignment.version.status,
          summary: assignment.version.summary,
          effectiveFrom: toIsoDate(assignment.version.effectiveFrom),
          points: assignment.version.points,
          hasDocument: assignment.version.pdfFileObjectId !== null,

          requiresAcknowledgement: assignment.version.requiresAcknowledgement,
          acknowledgementStatus: acknowledgement?.status ?? null,
          acknowledgedAt: acknowledgement?.acknowledgedAt?.toISOString() ?? null,
          dueOn: acknowledgement?.dueOn
            ? toIsoDate(acknowledgement.dueOn)
            : assignment.dueOn
              ? toIsoDate(assignment.dueOn)
              : null,
          waivedAt: acknowledgement?.waivedAt?.toISOString() ?? null,
          waiveReason: acknowledgement?.waiveReason ?? null,

          canAcknowledge:
            assignment.version.status === 'PUBLISHED' &&
            assignment.version.requiresAcknowledgement &&
            (acknowledgement?.status === 'PENDING' || acknowledgement?.status === 'OVERDUE'),
        };
      })
      .sort((a, b) => {
        // What needs doing first, then the rest in the order People Ops set.
        const aPending = a.canAcknowledge ? 0 : 1;
        const bPending = b.canAcknowledge ? 0 : 1;
        if (aPending !== bPending) return aPending - bPending;
        return a.displayOrder - b.displayOrder || a.name.localeCompare(b.name);
      });

    return {
      items,
      pendingCount: items.filter((item) => item.canAcknowledge).length,
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /policies/:versionId — the full text                          */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { versionId: string } }>(
    '/api/v1/policies/:versionId',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'policy:read', 'SELF');

      // Assignment is the access check: a policy that does not apply to you is
      // not yours to read, and the answer does not reveal whether it exists.
      const version = await db.policyVersion.findFirst({
        where: {
          id: request.params.versionId,
          organizationId: principal.organizationId,
          assignments: { some: { employeeId: principal.employeeId ?? '' } },
        },
        select: {
          id: true,
          versionLabel: true,
          status: true,
          summary: true,
          body: true,
          effectiveFrom: true,
          requiresAcknowledgement: true,
          publishedAt: true,
          supersededAt: true,
          pdfFileObjectId: true,
          policy: { select: { id: true, name: true, ownerTeam: true, contactEmail: true } },
          points: { orderBy: { displayOrder: 'asc' }, select: { id: true, text: true } },
          supersededBy: { select: { id: true, versionLabel: true } },
        },
      });

      if (!version) throw notFound('That policy');

      const acknowledgement = await db.policyAcknowledgement.findUnique({
        where: {
          policyVersionId_employeeId: {
            policyVersionId: version.id,
            employeeId: principal.employeeId ?? '',
          },
        },
        select: { status: true, acknowledgedAt: true, dueOn: true },
      });

      return {
        id: version.id,
        versionLabel: version.versionLabel,
        status: version.status,
        summary: version.summary,
        body: version.body,
        effectiveFrom: toIsoDate(version.effectiveFrom),
        publishedAt: version.publishedAt?.toISOString() ?? null,
        supersededAt: version.supersededAt?.toISOString() ?? null,
        supersededBy: version.supersededBy,
        requiresAcknowledgement: version.requiresAcknowledgement,
        hasDocument: version.pdfFileObjectId !== null,
        policy: version.policy,
        points: version.points,
        acknowledgement: acknowledgement
          ? {
              status: acknowledgement.status,
              acknowledgedAt: acknowledgement.acknowledgedAt?.toISOString() ?? null,
              dueOn: acknowledgement.dueOn ? toIsoDate(acknowledgement.dueOn) : null,
            }
          : null,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /policies/:versionId/acknowledge                             */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { versionId: string } }>(
    '/api/v1/policies/:versionId/acknowledge',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'policy:acknowledge', 'SELF');

      // The body echoes the version the person actually read. If it does not
      // match the path, the page was stale and the acknowledgement would be
      // recorded against text they never saw.
      const body = policyAcknowledge.parse(request.body);
      if (body.policyVersionId !== request.params.versionId) {
        throw notFound('That policy version');
      }

      const result = await db.$transaction((tx) =>
        acknowledgePolicyVersion(
          tx,
          principal,
          {
            policyVersionId: request.params.versionId,
            ip: request.context.ip ?? null,
            userAgent: request.headers['user-agent'] ?? null,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return { acknowledgedAt: result.acknowledgedAt.toISOString() };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /policies/:versionId/document                                 */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { versionId: string } }>(
    '/api/v1/policies/:versionId/document',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'policy:read', 'SELF');

      const version = await db.policyVersion.findFirst({
        where: {
          id: request.params.versionId,
          organizationId: principal.organizationId,
          assignments: { some: { employeeId: principal.employeeId ?? '' } },
        },
        select: { pdfFileObjectId: true },
      });

      if (!version?.pdfFileObjectId) throw notFound('That policy document');

      const file = await db.fileObject.findUniqueOrThrow({
        where: { id: version.pdfFileObjectId },
        select: { storageKey: true, displayFilename: true },
      });

      const { storage } = await import('../../services/storage.js');
      const signed = await storage(env).signedDownloadUrl(file.storageKey, {
        expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
        downloadFilename: file.displayFilename,
      });

      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );
}
