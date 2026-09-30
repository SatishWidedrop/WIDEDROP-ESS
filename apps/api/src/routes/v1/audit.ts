import type { App } from '../../app.js';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit, verifyChain } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';

/**
 * The audit trail.
 *
 * Two things this screen does that a log viewer does not:
 *
 *  1. It shows the **chain position** of every row. The trail is hash-chained
 *     with a key the database never sees, so a row altered in place no longer
 *     reproduces its own digest.
 *
 *  2. It can **prove the chain is intact**, on demand, and say exactly where
 *     it broke if it is not. That is the difference between a log somebody
 *     could have edited and evidence.
 *
 * Reading the trail is itself audited. An auditor who searches for one
 * person's payslip reads leaves a record of having done so.
 */
export async function auditRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /audit                                                        */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/audit', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'audit:read', 'ORG');

    const { action, entityType, entityId, actorUserId, from, to, cursor, limit } =
      request.query as {
        action?: string;
        entityType?: string;
        entityId?: string;
        actorUserId?: string;
        from?: string;
        to?: string;
        cursor?: string;
        limit?: string;
      };

    const take = Math.min(Number(limit) || 50, 200);

    const events = await db.auditEvent.findMany({
      where: {
        organizationId: principal.organizationId,
        ...(action ? { action: action as never } : {}),
        ...(entityType ? { entityType } : {}),
        ...(entityId ? { entityId } : {}),
        ...(actorUserId ? { actorUserId } : {}),
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: new Date(from) } : {}),
                ...(to ? { lte: new Date(`${to}T23:59:59.999Z`) } : {}),
              },
            }
          : {}),
        ...(cursor ? { sequence: { lt: BigInt(cursor) } } : {}),
      },
      orderBy: { sequence: 'desc' },
      take: take + 1,
      select: {
        id: true,
        sequence: true,
        action: true,
        entityType: true,
        entityId: true,
        fromState: true,
        toState: true,
        summary: true,
        actorKind: true,
        actorPersona: true,
        actorUserId: true,
        actorEmployeeId: true,
        ip: true,
        requestId: true,
        occurredAt: true,
      },
    });

    const hasMore = events.length > take;
    const page = hasMore ? events.slice(0, take) : events;

    // Actor names, resolved in one query rather than a join per row.
    const userIds = [
      ...new Set(page.map((event) => event.actorUserId).filter((id): id is string => id !== null)),
    ];
    const actors = userIds.length
      ? await db.appUser.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, employee: { select: { fullName: true } } },
        })
      : [];
    const actorById = new Map(actors.map((actor) => [actor.id, actor]));

    await db.$transaction((tx) =>
      recordAudit(
        tx,
        {
          organizationId: principal.organizationId,
          action: 'READ_SENSITIVE',
          entityType: 'audit_event',
          // The filter, so a later reader knows what was looked at, not just
          // that the trail was opened.
          after: {
            filters: { action, entityType, entityId, actorUserId, from, to },
            returned: page.length,
          },
          summary: 'Searched the audit trail',
        },
        env.AUDIT_HMAC_KEY,
      ),
    );

    return {
      items: page.map((event) => ({
        id: event.id,
        sequence: event.sequence.toString(),
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        fromState: event.fromState,
        toState: event.toState,
        summary: event.summary,
        actor: {
          kind: event.actorKind,
          persona: event.actorPersona,
          userId: event.actorUserId,
          employeeId: event.actorEmployeeId,
          name: event.actorUserId
            ? (actorById.get(event.actorUserId)?.employee?.fullName ??
              actorById.get(event.actorUserId)?.email ??
              null)
            : null,
        },
        ip: event.ip,
        requestId: event.requestId,
        occurredAt: event.occurredAt.toISOString(),
      })),
      nextCursor: hasMore ? page[page.length - 1]?.sequence.toString() : null,
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /audit/verify                                                 */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/v1/audit/verify',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'audit:verify', 'ORG');

      const { from, limit } = request.query as { from?: string; limit?: string };

      const result = await db.$transaction((tx) =>
        verifyChain(
          tx,
          {
            organizationId: principal.organizationId,
            ...(from ? { fromSequence: BigInt(from) } : {}),
            limit: Math.min(Number(limit) || 1_000, 10_000),
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      // Verifying is itself an event, written after the check so it does not
      // change the range it just verified.
      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'READ_SENSITIVE',
            entityType: 'audit_event',
            after: {
              valid: result.valid,
              checked: result.checked,
              brokenAt: result.brokenAt ?? null,
              gaps: result.gaps.length,
            },
            summary: result.valid
              ? `Verified ${result.checked} audit entries: chain intact`
              : `Verified ${result.checked} audit entries: chain BROKEN`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return {
        valid: result.valid,
        checked: result.checked,
        from: result.from ?? null,
        to: result.to ?? null,
        brokenAt: result.brokenAt ?? null,
        gaps: result.gaps,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /audit/entity/:type/:id — the history of one record           */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { type: string; id: string } }>(
    '/api/v1/audit/entity/:type/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'audit:read', 'ORG');

      if (!/^[a-z_]{3,64}$/.test(request.params.type)) {
        throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'That is not an entity type.');
      }

      const events = await db.auditEvent.findMany({
        where: {
          organizationId: principal.organizationId,
          entityType: request.params.type,
          entityId: request.params.id,
        },
        orderBy: { sequence: 'asc' },
        take: 500,
        select: {
          id: true,
          sequence: true,
          action: true,
          fromState: true,
          toState: true,
          summary: true,
          // The before/after images. Sensitive fields were redacted before
          // storage, so what comes back is what was safe to keep.
          beforeData: true,
          afterData: true,
          actorKind: true,
          actorPersona: true,
          actorEmployeeId: true,
          occurredAt: true,
        },
      });

      return {
        items: events.map((event) => ({
          id: event.id,
          sequence: event.sequence.toString(),
          action: event.action,
          fromState: event.fromState,
          toState: event.toState,
          summary: event.summary,
          before: event.beforeData,
          after: event.afterData,
          actor: {
            kind: event.actorKind,
            persona: event.actorPersona,
            employeeId: event.actorEmployeeId,
          },
          occurredAt: event.occurredAt.toISOString(),
        })),
      };
    },
  );
}
