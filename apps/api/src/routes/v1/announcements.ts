import { toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { assertPermission } from '../../services/auth/authorization.js';

/**
 * Announcements.
 *
 * Audience is resolved in the query rather than after the fetch, so an
 * announcement aimed at one department is not loaded and then hidden. The read
 * marker is a row, which is what makes "3 unread" a count rather than a guess.
 */
export async function announcementRoutes(app: App): Promise<void> {
  const db = app.db;

  /**
   * The audience filter for one employee.
   *
   * An announcement with no audience row reaches nobody — the same rule as
   * policies, and for the same reason: a publication with no stated audience
   * is a mistake, and reaching everyone is the worst way to resolve it.
   */
  async function audienceFilter(organizationId: string, employeeId: string) {
    const employment = await db.employeeEmployment.findFirst({
      where: { employeeId, effectiveTo: null },
      select: { departmentId: true, locationId: true, employmentType: true },
    });

    return {
      organizationId,
      status: 'PUBLISHED' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      audiences: {
        some: {
          OR: [
            { kind: 'ALL' as const },
            { kind: 'EMPLOYEE' as const, targetId: employeeId },
            ...(employment
              ? [
                  { kind: 'DEPARTMENT' as const, targetId: employment.departmentId },
                  { kind: 'LOCATION' as const, targetId: employment.locationId },
                  {
                    kind: 'EMPLOYMENT_TYPE' as const,
                    targetValue: employment.employmentType,
                  },
                ]
              : []),
          ],
        },
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* GET /announcements                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/announcements', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'announcement:read', 'SELF');

    if (!principal.employeeId) return { items: [], unreadCount: 0 };

    const where = await audienceFilter(principal.organizationId, principal.employeeId);

    const announcements = await db.announcement.findMany({
      where,
      orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
      take: 60,
      select: {
        id: true,
        title: true,
        departmentLabel: true,
        byline: true,
        isPinned: true,
        publishedAt: true,
        expiresAt: true,
        paragraphs: {
          orderBy: { displayOrder: 'asc' },
          take: 1,
          select: { text: true },
        },
        reads: {
          where: { employeeId: principal.employeeId },
          take: 1,
          select: { readAt: true },
        },
      },
    });

    return {
      items: announcements.map((announcement) => ({
        id: announcement.id,
        title: announcement.title,
        department: announcement.departmentLabel,
        byline: announcement.byline,
        isPinned: announcement.isPinned,
        publishedAt: announcement.publishedAt?.toISOString() ?? null,
        expiresAt: announcement.expiresAt?.toISOString() ?? null,
        // The first paragraph, as the list preview. Never a truncation of
        // rendered HTML, which is how a preview ends up showing markup.
        excerpt: announcement.paragraphs[0]?.text ?? null,
        readAt: announcement.reads[0]?.readAt.toISOString() ?? null,
      })),
      unreadCount: announcements.filter((announcement) => announcement.reads.length === 0).length,
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /announcements/:id — reading it marks it read                 */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/announcements/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'announcement:read', 'SELF');

      if (!principal.employeeId) throw notFound('That announcement');

      const where = await audienceFilter(principal.organizationId, principal.employeeId);

      const announcement = await db.announcement.findFirst({
        where: { ...where, id: request.params.id },
        select: {
          id: true,
          title: true,
          departmentLabel: true,
          byline: true,
          isPinned: true,
          publishedAt: true,
          expiresAt: true,
          paragraphs: {
            orderBy: { displayOrder: 'asc' },
            select: { id: true, text: true },
          },
        },
      });

      if (!announcement) throw notFound('That announcement');

      // Idempotent, and the first read's timestamp is kept: "read at" should
      // mean the first time, not the last.
      await db.announcementRead.upsert({
        where: {
          announcementId_employeeId: {
            announcementId: announcement.id,
            employeeId: principal.employeeId,
          },
        },
        update: {},
        create: {
          organizationId: principal.organizationId,
          announcementId: announcement.id,
          employeeId: principal.employeeId,
        },
      });

      return {
        id: announcement.id,
        title: announcement.title,
        department: announcement.departmentLabel,
        byline: announcement.byline,
        isPinned: announcement.isPinned,
        publishedAt: announcement.publishedAt?.toISOString() ?? null,
        expiresAt: announcement.expiresAt ? toIsoDate(announcement.expiresAt) : null,
        paragraphs: announcement.paragraphs,
      };
    },
  );
}
