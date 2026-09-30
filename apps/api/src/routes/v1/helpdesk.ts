import { ticketComment, ticketCreate, ticketTransition } from '@widedrop/shared';
import type { App } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { assertPermission, can } from '../../services/auth/authorization.js';
import {
  addTicketComment,
  createTicket,
  transitionTicket,
} from '../../services/helpdesk/service.js';

/**
 * The help desk.
 *
 * A requester sees their own tickets and the public conversation on them. HR
 * sees the queue and the internal notes. The distinction is enforced in the
 * query, not by hiding a tab: an internal comment is never selected for a
 * caller who does not hold `ticket:administer`.
 */
export async function helpdeskRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /help — categories, FAQs and my tickets                       */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/help', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'ticket:read', 'SELF');

    const [categories, faqs, tickets, organization] = await Promise.all([
      db.ticketCategory.findMany({
        where: { organizationId: principal.organizationId, isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: {
          id: true,
          code: true,
          name: true,
          description: true,
          firstResponseHours: true,
          resolutionHours: true,
        },
      }),

      db.faqArticle.findMany({
        where: { organizationId: principal.organizationId, isActive: true },
        orderBy: { displayOrder: 'asc' },
        select: { id: true, question: true, answer: true, ticketCategoryId: true },
      }),

      principal.employeeId
        ? db.helpdeskTicket.findMany({
            where: {
              organizationId: principal.organizationId,
              requesterEmployeeId: principal.employeeId,
            },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              reference: true,
              subject: true,
              status: true,
              priority: true,
              createdAt: true,
              firstResponseDueAt: true,
              firstResponseAt: true,
              resolutionDueAt: true,
              resolvedAt: true,
              category: { select: { name: true } },
              assignee: { select: { fullName: true, initials: true } },
              _count: { select: { comments: true } },
            },
          })
        : [],

      db.organization.findUniqueOrThrow({
        where: { id: principal.organizationId },
        select: { helpdeskEmail: true },
      }),
    ]);

    return {
      categories,
      faqs,
      helpdeskEmail: organization.helpdeskEmail,
      tickets: tickets.map((ticket) => ({
        id: ticket.id,
        reference: ticket.reference,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category.name,
        assignee: ticket.assignee,
        createdAt: ticket.createdAt.toISOString(),
        firstResponseDueAt: ticket.firstResponseDueAt?.toISOString() ?? null,
        firstResponseAt: ticket.firstResponseAt?.toISOString() ?? null,
        resolutionDueAt: ticket.resolutionDueAt?.toISOString() ?? null,
        resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
        commentCount: ticket._count.comments,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /help/tickets/:id                                             */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/help/tickets/:id',
    { onRequest: app.authenticate() },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'ticket:read', 'SELF');

      const isAgent = can(principal, 'ticket:administer', 'ORG');

      const ticket = await db.helpdeskTicket.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          // A requester reaches only their own; an agent reaches the queue.
          ...(isAgent ? {} : { requesterEmployeeId: principal.employeeId ?? '' }),
        },
        select: {
          id: true,
          reference: true,
          subject: true,
          description: true,
          status: true,
          priority: true,
          createdAt: true,
          firstResponseDueAt: true,
          firstResponseAt: true,
          resolutionDueAt: true,
          resolvedAt: true,
          closedAt: true,
          resolutionNote: true,
          pausedSeconds: true,
          category: { select: { id: true, name: true } },
          requester: { select: { id: true, fullName: true, initials: true, employeeNumber: true } },
          assignee: { select: { id: true, fullName: true, initials: true } },
          comments: {
            // The visibility filter is the access control. An internal note is
            // not fetched and then hidden — it is never selected.
            where: isAgent ? {} : { visibility: 'PUBLIC' },
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              body: true,
              visibility: true,
              createdAt: true,
              author: { select: { id: true, fullName: true, initials: true } },
            },
          },
          attachments: {
            select: {
              id: true,
              file: { select: { id: true, displayFilename: true, sizeBytes: true } },
            },
          },
        },
      });

      if (!ticket) throw notFound('That ticket');

      return {
        ...ticket,
        createdAt: ticket.createdAt.toISOString(),
        firstResponseDueAt: ticket.firstResponseDueAt?.toISOString() ?? null,
        firstResponseAt: ticket.firstResponseAt?.toISOString() ?? null,
        resolutionDueAt: ticket.resolutionDueAt?.toISOString() ?? null,
        resolvedAt: ticket.resolvedAt?.toISOString() ?? null,
        closedAt: ticket.closedAt?.toISOString() ?? null,
        comments: ticket.comments.map((comment) => ({
          ...comment,
          createdAt: comment.createdAt.toISOString(),
        })),
        attachments: ticket.attachments.map((attachment) => ({
          id: attachment.id,
          fileId: attachment.file.id,
          filename: attachment.file.displayFilename,
          sizeBytes: Number(attachment.file.sizeBytes),
        })),
        viewerIsAgent: isAgent,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /help/tickets — persist and notify, in one transaction       */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/help/tickets',
    { onRequest: app.authenticate(), config: { rateLimitName: 'ticket:create' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'ticket:create', 'SELF');

      const body = ticketCreate.parse(request.body);

      const created = await db.$transaction((tx) =>
        createTicket(tx, principal, body, {
          helpdeskEmail: env.HELPDESK_EMAIL,
          webUrl: env.WEB_PUBLIC_URL,
          hmacKey: env.AUDIT_HMAC_KEY,
        }),
      );

      return reply.status(201).send({
        id: created.id,
        reference: created.reference,
        status: created.status,
        firstResponseDueAt: created.firstResponseDueAt?.toISOString() ?? null,
        resolutionDueAt: created.resolutionDueAt?.toISOString() ?? null,
        // Reported rather than assumed: the UI says the notification is queued,
        // which is what is true at this moment, not that it was delivered.
        notificationQueued: created.notificationQueued,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /help/tickets/:id/comments                                   */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/help/tickets/:id/comments',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'ticket:comment', 'SELF');

      const body = ticketComment.parse(request.body);
      const isAgent = can(principal, 'ticket:administer', 'ORG');

      // Reachability before anything else: a requester may comment on their
      // own ticket, an agent on any in the organisation.
      const reachable = await db.helpdeskTicket.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          ...(isAgent ? {} : { requesterEmployeeId: principal.employeeId ?? '' }),
        },
        select: { id: true },
      });
      if (!reachable) throw notFound('That ticket');

      const created = await db.$transaction((tx) =>
        addTicketComment(
          tx,
          principal,
          { ticketId: request.params.id, body: body.body, internal: body.internal },
          {
            helpdeskEmail: env.HELPDESK_EMAIL,
            webUrl: env.WEB_PUBLIC_URL,
            hmacKey: env.AUDIT_HMAC_KEY,
          },
        ),
      );

      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /help/tickets/:id/transition                                 */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/help/tickets/:id/transition',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request) => {
      const principal = requirePrincipal(request);
      const body = ticketTransition.parse(request.body);

      // A requester may cancel their own unstarted ticket and close a resolved
      // one. Everything else belongs to the help desk.
      const requesterEvents = ['CANCEL', 'CLOSE', 'REOPEN'];
      if (requesterEvents.includes(body.event)) {
        assertPermission(principal, 'ticket:comment', 'SELF');
        const own = await db.helpdeskTicket.findFirst({
          where: {
            id: request.params.id,
            organizationId: principal.organizationId,
            requesterEmployeeId: principal.employeeId ?? '',
          },
          select: { id: true },
        });
        if (!own && !can(principal, 'ticket:administer', 'ORG')) throw notFound('That ticket');
      } else {
        assertPermission(principal, 'ticket:administer', 'ORG');
      }

      const status = await db.$transaction((tx) =>
        transitionTicket(
          tx,
          principal,
          {
            ticketId: request.params.id,
            event: body.event,
            assigneeEmployeeId: body.assigneeEmployeeId ?? null,
            resolutionNote: body.resolutionNote ?? null,
          },
          { hmacKey: env.AUDIT_HMAC_KEY },
        ),
      );

      return { status };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /hr/tickets — the queue                                       */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/hr/tickets', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'ticket:administer', 'ORG');

    const { status } = request.query as { status?: string };

    const tickets = await db.helpdeskTicket.findMany({
      where: {
        organizationId: principal.organizationId,
        ...(status === 'open'
          ? { status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'REOPENED'] } }
          : status
            ? { status: status as never }
            : {}),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: 200,
      select: {
        id: true,
        reference: true,
        subject: true,
        status: true,
        priority: true,
        createdAt: true,
        firstResponseDueAt: true,
        firstResponseAt: true,
        resolutionDueAt: true,
        resolvedAt: true,
        pausedSeconds: true,
        category: { select: { name: true } },
        requester: { select: { id: true, fullName: true, initials: true, employeeNumber: true } },
        assignee: { select: { id: true, fullName: true, initials: true } },
      },
    });

    const now = Date.now();

    return {
      items: tickets.map((ticket) => ({
        id: ticket.id,
        reference: ticket.reference,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category.name,
        requester: ticket.requester,
        assignee: ticket.assignee,
        createdAt: ticket.createdAt.toISOString(),
        firstResponseDueAt: ticket.firstResponseDueAt?.toISOString() ?? null,
        resolutionDueAt: ticket.resolutionDueAt?.toISOString() ?? null,
        // Breach is derived from the stored due time and the time paused, so
        // it means the same thing on every screen that shows it.
        firstResponseBreached:
          ticket.firstResponseAt === null &&
          ticket.firstResponseDueAt !== null &&
          ticket.firstResponseDueAt.getTime() + ticket.pausedSeconds * 1000 < now,
        resolutionBreached:
          ticket.resolvedAt === null &&
          ticket.resolutionDueAt !== null &&
          ticket.resolutionDueAt.getTime() + ticket.pausedSeconds * 1000 < now,
      })),
    };
  });
}
