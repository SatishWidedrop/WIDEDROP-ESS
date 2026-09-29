import { financialYearOf, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { requirePrincipal } from '../../plugins/authenticate.js';

/**
 * The dashboard and the counts the shell shows.
 *
 * Every figure here is a count of rows or a sum over rows. Nothing is
 * estimated, and a figure that does not exist yet comes back as null so the UI
 * can render an em dash rather than a zero that asserts something untrue.
 */
export async function meRoutes(app: App): Promise<void> {
  const db = app.db;

  /* ---------------------------------------------------------------- */
  /* GET /me/badges — the counts beside nav items                      */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/me/badges', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    const { organizationId, employeeId, personas } = principal;

    if (!employeeId) return {};

    const [policies, tickets] = await Promise.all([
      db.policyAcknowledgement.count({
        where: { organizationId, employeeId, status: { in: ['PENDING', 'OVERDUE'] } },
      }),
      db.helpdeskTicket.count({
        where: {
          organizationId,
          requesterEmployeeId: employeeId,
          status: { in: ['WAITING_ON_EMPLOYEE'] },
        },
      }),
    ]);

    const badges: Record<string, number> = {};
    if (policies > 0) badges.policies = policies;
    if (tickets > 0) badges.tickets = tickets;

    if (personas.includes('MANAGER')) {
      const [approvals, attendance] = await Promise.all([
        db.approvalTask.count({
          where: { organizationId, assigneeEmployeeId: employeeId, status: 'PENDING' },
        }),
        db.attendanceApproval.count({
          where: { organizationId, managerEmployeeId: employeeId, status: 'PENDING' },
        }),
      ]);
      if (approvals > 0) badges.approvals = approvals;
      if (attendance > 0) badges.attendanceActions = attendance;
    }

    if (personas.includes('HR')) {
      const [queue, openPeriods] = await Promise.all([
        db.helpdeskTicket.count({
          where: { organizationId, status: { in: ['OPEN', 'ASSIGNED'] } },
        }),
        db.attendancePeriod.count({
          where: { organizationId, status: { in: ['OPEN', 'REOPENED'] } },
        }),
      ]);
      if (queue > 0) badges.tickets = (badges.tickets ?? 0) + queue;
      if (openPeriods > 0) badges.attendanceActions = (badges.attendanceActions ?? 0) + openPeriods;
    }

    if (personas.includes('ACCOUNTS')) {
      // A cycle waiting on Accounts, rather than every open cycle: a badge
      // should mean "you", not "something exists".
      const waiting = await db.payrollCycle.count({
        where: {
          organizationId,
          status: {
            in: [
              'DRAFT',
              'INPUTS_OPEN',
              'ATTENDANCE_APPROVED',
              'VALIDATION_FAILED',
              'VALIDATED',
              'CALCULATED',
            ],
          },
        },
      });
      if (waiting > 0) badges.payrollActions = waiting;
    }

    return badges;
  });

  /* ---------------------------------------------------------------- */
  /* GET /me/home — everything the Home screen shows                   */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/me/home', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    const { organizationId, employeeId, personas } = principal;

    if (!employeeId) {
      return {
        latestPayslip: null,
        leaveBalances: [],
        todos: [],
        announcements: [],
        holidays: [],
        team: [],
        pendingApprovals: 0,
      };
    }

    const today = toIsoDate(new Date());

    const [latestPayslip, balances, pendingPolicies, announcements, holidays] = await Promise.all([
      // Only a published payslip. A generated-but-unpublished one exists in the
      // database and must not reach the employee.
      db.payslip.findFirst({
        where: { organizationId, employeeId, status: 'PUBLISHED' },
        orderBy: { periodStart: 'desc' },
        select: {
          id: true,
          reference: true,
          periodStart: true,
          periodEnd: true,
          payDate: true,
          netPayMinor: true,
          pdfFileObjectId: true,
          cycle: { select: { label: true } },
        },
      }),

      db.leaveBalance.findMany({
        where: {
          organizationId,
          employeeId,
          period: { startDate: { lte: new Date(today) }, endDate: { gte: new Date(today) } },
        },
        select: {
          availableDays: true,
          entitlementDays: true,
          leaveType: { select: { name: true, code: true, displayOrder: true } },
        },
        orderBy: { leaveType: { displayOrder: 'asc' } },
      }),

      db.policyAcknowledgement.findMany({
        where: { organizationId, employeeId, status: { in: ['PENDING', 'OVERDUE'] } },
        select: {
          id: true,
          status: true,
          dueOn: true,
          version: {
            select: {
              id: true,
              versionLabel: true,
              policy: { select: { name: true, ownerTeam: true } },
            },
          },
        },
        orderBy: { dueOn: 'asc' },
        take: 10,
      }),

      db.announcement.findMany({
        where: { organizationId, status: 'PUBLISHED' },
        orderBy: [{ isPinned: 'desc' }, { publishedAt: 'desc' }],
        take: 3,
        select: {
          id: true,
          title: true,
          departmentLabel: true,
          byline: true,
          publishedAt: true,
          isPinned: true,
        },
      }),

      db.holiday.findMany({
        where: { organizationId, date: { gte: new Date(today) } },
        orderBy: { date: 'asc' },
        take: 4,
        select: { id: true, name: true, date: true, kind: true },
      }),
    ]);

    const pendingApprovals = personas.includes('MANAGER')
      ? await db.approvalTask.count({
          where: { organizationId, assigneeEmployeeId: employeeId, status: 'PENDING' },
        })
      : 0;

    const team = personas.includes('MANAGER')
      ? await db.employeeReportingClosure.findMany({
          where: { organizationId, ancestorEmployeeId: employeeId, depth: 1 },
          select: {
            descendant: {
              select: {
                id: true,
                fullName: true,
                initials: true,
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
          },
          take: 12,
        })
      : [];

    // Who on the team is on approved leave today. Derived from leave records,
    // not from a status field anyone sets by hand.
    const teamIds = team.map((row) => row.descendant.id);
    const onLeaveToday =
      teamIds.length > 0
        ? await db.leaveRequestDay.findMany({
            where: {
              organizationId,
              date: new Date(today),
              request: { employeeId: { in: teamIds }, status: 'APPROVED' },
            },
            select: { request: { select: { employeeId: true } } },
          })
        : [];
    const onLeave = new Set(onLeaveToday.map((row) => row.request.employeeId));

    return {
      latestPayslip: latestPayslip
        ? {
            id: latestPayslip.id,
            reference: latestPayslip.reference,
            label: latestPayslip.cycle.label,
            payDate: toIsoDate(latestPayslip.payDate),
            netPayMinor: latestPayslip.netPayMinor.toString(),
            hasDocument: latestPayslip.pdfFileObjectId !== null,
          }
        : null,

      leaveBalances: balances.map((balance) => ({
        code: balance.leaveType.code,
        name: balance.leaveType.name,
        availableDays: Number(balance.availableDays),
        entitlementDays: Number(balance.entitlementDays),
      })),

      todos: [
        ...pendingPolicies.map((ack) => ({
          kind: 'policy' as const,
          id: ack.id,
          title: `Acknowledge ${ack.version.policy.name} ${ack.version.versionLabel}`,
          sub: [ack.dueOn ? `Due ${toIsoDate(ack.dueOn)}` : null, ack.version.policy.ownerTeam]
            .filter(Boolean)
            .join(' · '),
          tone: ack.status === 'OVERDUE' ? ('red' as const) : ('amber' as const),
          path: `/policies?policy=${ack.version.id}`,
        })),
        ...(pendingApprovals > 0
          ? [
              {
                kind: 'approvals' as const,
                id: 'approvals',
                title: `${pendingApprovals} ${pendingApprovals === 1 ? 'request' : 'requests'} waiting on you`,
                sub: 'Leave and expense requests from your team',
                tone: 'blue' as const,
                path: '/approvals',
              },
            ]
          : []),
      ],

      announcements: announcements.map((announcement) => ({
        id: announcement.id,
        title: announcement.title,
        department: announcement.departmentLabel,
        byline: announcement.byline,
        publishedAt: announcement.publishedAt?.toISOString() ?? null,
        isPinned: announcement.isPinned,
      })),

      holidays: holidays.map((holiday) => ({
        id: holiday.id,
        name: holiday.name,
        date: toIsoDate(holiday.date),
        kind: holiday.kind,
      })),

      team: team.map((row) => ({
        id: row.descendant.id,
        name: row.descendant.fullName,
        initials: row.descendant.initials,
        title: row.descendant.employments[0]?.designation.title ?? null,
        department: row.descendant.employments[0]?.department.name ?? null,
        onLeaveToday: onLeave.has(row.descendant.id),
      })),

      pendingApprovals,
      fiscalYear: financialYearOf(today).label,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Notifications                                                     */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/v1/notifications/unread-count',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      const unread = await db.notification.count({
        where: {
          organizationId: principal.organizationId,
          appUserId: principal.userId,
          readAt: null,
        },
      });
      return { unread };
    },
  );

  app.get('/api/v1/notifications', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    const { limit = 20 } = request.query as { limit?: number };

    const items = await db.notification.findMany({
      where: { organizationId: principal.organizationId, appUserId: principal.userId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Number(limit) || 20, 50),
      select: {
        id: true,
        kind: true,
        tone: true,
        title: true,
        body: true,
        targetModule: true,
        targetId: true,
        readAt: true,
        createdAt: true,
      },
    });

    return {
      items: items.map((item) => ({
        ...item,
        readAt: item.readAt?.toISOString() ?? null,
        createdAt: item.createdAt.toISOString(),
      })),
    };
  });

  app.post(
    '/api/v1/notifications/read',
    { onRequest: app.authenticate() },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const { ids } = (request.body ?? {}) as { ids?: string[] };

      await db.notification.updateMany({
        where: {
          organizationId: principal.organizationId,
          appUserId: principal.userId,
          readAt: null,
          ...(Array.isArray(ids) && ids.length > 0 ? { id: { in: ids.slice(0, 100) } } : {}),
        },
        data: { readAt: new Date() },
      });

      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /ui-copy — the explanatory strings, from the database         */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/ui-copy', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    const rows = await db.uiCopy.findMany({
      where: { organizationId: principal.organizationId, isActive: true, locale: 'en-IN' },
      select: { key: true, value: true },
    });
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  });
}
