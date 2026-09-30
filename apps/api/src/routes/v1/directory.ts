import { DIRECTORY_FIELDS } from '@widedrop/shared';
import type { EmploymentStatus } from '../../generated/prisma/index.js';
import type { App } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { assertPermission } from '../../services/auth/authorization.js';

/**
 * The directory.
 *
 * Everyone holds `directory:read` at organisation scope, which is exactly why
 * the field list is narrow: work email, work phone, designation, department,
 * location and the reporting line. `DIRECTORY_FIELDS` in the shared package
 * is the list, and this route selects nothing outside it — no date of birth,
 * no personal number, no salary, no statutory identifier.
 *
 * An employee who has asked not to be listed is not returned, and is not
 * reachable by id either.
 */
export async function directoryRoutes(app: App): Promise<void> {
  const db = app.db;

  const listedEmployee = (organizationId: string) => ({
    organizationId,
    isDirectoryListed: true,
    employmentStatus: { in: ['ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD'] as EmploymentStatus[] },
  });

  /* ---------------------------------------------------------------- */
  /* GET /directory                                                    */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/v1/directory',
    { onRequest: app.authenticate(), config: { rateLimitName: 'search' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'directory:read', 'ORG');

      const { q, departmentId, locationId, limit } = request.query as {
        q?: string;
        departmentId?: string;
        locationId?: string;
        limit?: string;
      };

      const query = (q ?? '').trim();

      const employees = await db.employee.findMany({
        where: {
          ...listedEmployee(principal.organizationId),
          ...(query.length >= 2
            ? {
                OR: [
                  { fullName: { contains: query, mode: 'insensitive' } },
                  { workEmail: { contains: query, mode: 'insensitive' } },
                  { employeeNumber: { contains: query, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...(departmentId || locationId
            ? {
                employments: {
                  some: {
                    effectiveTo: null,
                    ...(departmentId ? { departmentId } : {}),
                    ...(locationId ? { locationId } : {}),
                  },
                },
              }
            : {}),
        },
        orderBy: { fullName: 'asc' },
        take: Math.min(Number(limit) || 60, 200),
        select: {
          id: true,
          fullName: true,
          initials: true,
          employeeNumber: true,
          workEmail: true,
          workPhone: true,
          photoFileObjectId: true,
          employments: {
            where: { effectiveTo: null },
            take: 1,
            select: {
              designation: { select: { title: true } },
              department: { select: { id: true, name: true } },
              location: { select: { id: true, name: true, city: true } },
            },
          },
        },
      });

      const [departments, locations, total] = await Promise.all([
        db.department.findMany({
          where: { organizationId: principal.organizationId, isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true },
        }),
        db.location.findMany({
          where: { organizationId: principal.organizationId, isActive: true },
          orderBy: { name: 'asc' },
          select: { id: true, name: true, city: true },
        }),
        db.employee.count({ where: listedEmployee(principal.organizationId) }),
      ]);

      return {
        items: employees.map((employee) => ({
          id: employee.id,
          fullName: employee.fullName,
          initials: employee.initials,
          employeeNumber: employee.employeeNumber,
          workEmail: employee.workEmail,
          workPhone: employee.workPhone,
          hasPhoto: employee.photoFileObjectId !== null,
          designation: employee.employments[0]?.designation.title ?? null,
          department: employee.employments[0]?.department.name ?? null,
          location: employee.employments[0]?.location.name ?? null,
        })),
        departments,
        locations,
        total,
        fields: DIRECTORY_FIELDS,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /directory/:id                                                */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/directory/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'directory:read', 'ORG');

      const employee = await db.employee.findFirst({
        where: { id: request.params.id, ...listedEmployee(principal.organizationId) },
        select: {
          id: true,
          fullName: true,
          initials: true,
          employeeNumber: true,
          workEmail: true,
          workPhone: true,
          photoFileObjectId: true,
          employments: {
            where: { effectiveTo: null },
            take: 1,
            select: {
              designation: { select: { title: true } },
              department: { select: { id: true, name: true } },
              location: { select: { id: true, name: true, city: true, timezone: true } },
            },
          },
          managerLinks: {
            where: { effectiveTo: null, isPrimary: true },
            take: 1,
            select: {
              manager: {
                select: {
                  id: true,
                  fullName: true,
                  initials: true,
                  isDirectoryListed: true,
                  employments: {
                    where: { effectiveTo: null },
                    take: 1,
                    select: { designation: { select: { title: true } } },
                  },
                },
              },
            },
          },
          reportLinks: {
            where: { effectiveTo: null, isPrimary: true },
            select: {
              employee: {
                select: {
                  id: true,
                  fullName: true,
                  initials: true,
                  isDirectoryListed: true,
                  employments: {
                    where: { effectiveTo: null },
                    take: 1,
                    select: { designation: { select: { title: true } } },
                  },
                },
              },
            },
          },
        },
      });

      if (!employee) throw notFound('That person');

      const employment = employee.employments[0];
      const manager = employee.managerLinks[0]?.manager;

      return {
        id: employee.id,
        fullName: employee.fullName,
        initials: employee.initials,
        employeeNumber: employee.employeeNumber,
        workEmail: employee.workEmail,
        workPhone: employee.workPhone,
        hasPhoto: employee.photoFileObjectId !== null,
        designation: employment?.designation.title ?? null,
        department: employment?.department.name ?? null,
        location: employment?.location.name ?? null,
        city: employment?.location.city ?? null,
        timezone: employment?.location.timezone ?? null,

        // The reporting line, filtered by the same listing preference: someone
        // who opted out of the directory does not reappear as a manager.
        manager:
          manager && manager.isDirectoryListed
            ? {
                id: manager.id,
                fullName: manager.fullName,
                initials: manager.initials,
                designation: manager.employments[0]?.designation.title ?? null,
              }
            : null,

        reports: employee.reportLinks
          .map((link) => link.employee)
          .filter((report) => report.isDirectoryListed)
          .map((report) => ({
            id: report.id,
            fullName: report.fullName,
            initials: report.initials,
            designation: report.employments[0]?.designation.title ?? null,
          }))
          .sort((a, b) => a.fullName.localeCompare(b.fullName)),
      };
    },
  );
}
