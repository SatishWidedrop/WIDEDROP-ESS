import {
  formatDateTime,
  ticketMachine,
  type TicketEvent,
  type TicketState,
} from '@widedrop/shared';
import type { TicketPriority } from '../../generated/prisma/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import { enqueueEmail } from '../email/outbox.js';
import { notifyEmployee } from '../notifications.js';
import { nextTicketReference } from '../reference.js';

/**
 * The help desk.
 *
 * The requirement is explicit: a ticket raised in the portal must be persisted
 * **and** the corresponding notification sent to the organisation's help-desk
 * address. Both happen in one transaction through the outbox — the ticket and
 * the queued message commit together, so a mail outage delays the email and
 * never loses the ticket, and a rolled-back ticket cannot leave an email
 * promising one exists.
 *
 * SLA times are computed from the category's configured hours and the ticket's
 * own timestamps. Nothing on the screen is a guess: a due time exists because
 * a category says how long it has, and the clock pauses while the ticket waits
 * on the requester.
 */

export interface CreateTicketInput {
  ticketCategoryId: string;
  subject: string;
  description: string;
  priority?: TicketPriority;
  /** Set when another record raised this ticket, e.g. a profile change. */
  sourceType?: string | null;
  sourceId?: string | null;
}

export interface CreatedTicket {
  id: string;
  reference: string;
  status: TicketState;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  /** True when the help-desk notification was queued for delivery. */
  notificationQueued: boolean;
}

export async function createTicket(
  tx: Tx,
  principal: Principal,
  input: CreateTicketInput,
  options: { helpdeskEmail: string; webUrl: string; hmacKey: string },
): Promise<CreatedTicket> {
  const employeeId = principal.employeeId;
  if (!employeeId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'This account is not linked to an employee.');
  }

  const category = await tx.ticketCategory.findFirst({
    where: {
      id: input.ticketCategoryId,
      organizationId: principal.organizationId,
      isActive: true,
    },
    select: {
      id: true,
      name: true,
      routingEmail: true,
      firstResponseHours: true,
      resolutionHours: true,
    },
  });
  if (!category) throw notFound('That help-desk category');

  const [organization, requester] = await Promise.all([
    tx.organization.findUniqueOrThrow({
      where: { id: principal.organizationId },
      select: { displayName: true, helpdeskEmail: true },
    }),
    tx.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { fullName: true, employeeNumber: true, workEmail: true },
    }),
  ]);

  const createdAt = new Date();
  const reference = await nextTicketReference(tx, principal.organizationId);

  const ticket = await tx.helpdeskTicket.create({
    data: {
      organizationId: principal.organizationId,
      reference,
      ticketCategoryId: category.id,
      requesterEmployeeId: employeeId,
      subject: input.subject,
      description: input.description,
      status: 'OPEN',
      priority: input.priority ?? 'NORMAL',
      // Set explicitly rather than left to the column default, so the row's
      // own timestamp and the due times below are the same instant. Otherwise
      // "8 hours from creation" is 8 hours minus however long the insert took.
      createdAt,
      // Derived from the category's SLA and this ticket's creation time, so a
      // due time is always explainable from two persisted numbers.
      firstResponseDueAt: addHours(createdAt, category.firstResponseHours),
      resolutionDueAt: addHours(createdAt, category.resolutionHours),
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
    },
    select: {
      id: true,
      reference: true,
      status: true,
      firstResponseDueAt: true,
      resolutionDueAt: true,
    },
  });

  // The notification the requirement names. The organisation's own address is
  // authoritative; the category may add a specialist queue alongside it.
  const helpdeskAddress = organization.helpdeskEmail || options.helpdeskEmail;
  const recipients = [helpdeskAddress, category.routingEmail].filter(
    (address): address is string => typeof address === 'string' && address.length > 0,
  );

  const queued = await enqueueEmail(tx, {
    organizationId: principal.organizationId,
    kind: 'HELPDESK_TICKET_CREATED',
    to: recipients,
    // A reply goes back to the person who raised it, not into a void.
    replyTo: requester.workEmail,
    subject: `[${ticket.reference}] ${input.subject}`,
    bodyText: ticketEmailBody({
      organizationName: organization.displayName,
      reference: ticket.reference,
      category: category.name,
      priority: input.priority ?? 'NORMAL',
      requesterName: requester.fullName,
      requesterNumber: requester.employeeNumber,
      requesterEmail: requester.workEmail,
      subject: input.subject,
      description: input.description,
      raisedAt: createdAt,
      firstResponseDueAt: ticket.firstResponseDueAt,
      resolutionDueAt: ticket.resolutionDueAt,
      link: `${options.webUrl}/help?ticket=${ticket.id}`,
    }),
    sourceType: 'helpdesk_ticket',
    sourceId: ticket.id,
    variant: 'created',
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'CREATE',
      entityType: 'helpdesk_ticket',
      entityId: ticket.id,
      toState: 'OPEN',
      after: {
        reference: ticket.reference,
        category: category.name,
        subject: input.subject,
        notifiedAddresses: recipients,
      },
      summary: `Raised help-desk ticket ${ticket.reference}`,
    },
    options.hmacKey,
  );

  return {
    id: ticket.id,
    reference: ticket.reference,
    status: ticket.status as TicketState,
    firstResponseDueAt: ticket.firstResponseDueAt,
    resolutionDueAt: ticket.resolutionDueAt,
    notificationQueued: queued !== null,
  };
}

/* ------------------------------------------------------------------ */
/* Comments                                                            */
/* ------------------------------------------------------------------ */

export async function addTicketComment(
  tx: Tx,
  principal: Principal,
  input: { ticketId: string; body: string; internal: boolean },
  options: { helpdeskEmail: string; webUrl: string; hmacKey: string },
): Promise<{ id: string; status: TicketState }> {
  const ticket = await lockTicket(tx, principal.organizationId, input.ticketId);

  const isRequester = ticket.requesterEmployeeId === principal.employeeId;

  // An internal note is for the help desk. The requester cannot write one, and
  // the read path never returns one to them.
  if (input.internal && isRequester) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'You cannot add an internal note.');
  }

  const comment = await tx.ticketComment.create({
    data: {
      organizationId: principal.organizationId,
      ticketId: ticket.id,
      authorEmployeeId: principal.employeeId ?? null,
      authorUserId: principal.userId,
      body: input.body,
      visibility: input.internal ? 'INTERNAL' : 'PUBLIC',
    },
    select: { id: true },
  });

  let status = ticket.status;

  // A reply from the requester resumes the clock; the paused time is banked so
  // the SLA is measured against the time the help desk actually had.
  if (isRequester && ticket.status === 'WAITING_ON_EMPLOYEE') {
    const pausedFor = ticket.pausedAt
      ? Math.round((Date.now() - ticket.pausedAt.getTime()) / 1000)
      : 0;
    await tx.helpdeskTicket.update({
      where: { id: ticket.id },
      data: {
        status: 'IN_PROGRESS',
        pausedAt: null,
        pausedSeconds: { increment: pausedFor },
        rowVersion: { increment: 1 },
      },
    });
    status = 'IN_PROGRESS';
  }

  // The first public reply from anyone but the requester stops the
  // first-response clock — recorded, not inferred at render time.
  if (!isRequester && !input.internal && ticket.firstResponseAt === null) {
    await tx.helpdeskTicket.update({
      where: { id: ticket.id },
      data: { firstResponseAt: new Date(), rowVersion: { increment: 1 } },
    });
  }

  if (!input.internal) {
    const audience = isRequester ? 'helpdesk' : 'requester';

    if (audience === 'requester') {
      await notifyEmployee(tx, {
        organizationId: principal.organizationId,
        employeeId: ticket.requesterEmployeeId,
        kind: 'TICKET_UPDATED',
        tone: 'BLUE',
        title: `${ticket.reference} has a reply`,
        body: ticket.subject,
        targetModule: 'help',
        targetId: ticket.id,
        sourceType: 'ticket_comment',
        sourceId: comment.id,
      });
    } else {
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: principal.organizationId },
        select: { helpdeskEmail: true },
      });
      await enqueueEmail(tx, {
        organizationId: principal.organizationId,
        kind: 'HELPDESK_TICKET_UPDATED',
        to: [organization.helpdeskEmail || options.helpdeskEmail],
        subject: `[${ticket.reference}] ${ticket.subject}`,
        bodyText:
          `${ticket.requester.fullName} replied to ${ticket.reference}.\n\n` +
          `${input.body}\n\n` +
          `Open the ticket: ${options.webUrl}/hr/tickets?ticket=${ticket.id}\n`,
        sourceType: 'ticket_comment',
        sourceId: comment.id,
        variant: 'comment',
      });
    }
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'CREATE',
      entityType: 'ticket_comment',
      entityId: comment.id,
      summary: `Commented on ${ticket.reference}`,
      after: { visibility: input.internal ? 'INTERNAL' : 'PUBLIC', ticketId: ticket.id },
    },
    options.hmacKey,
  );

  return { id: comment.id, status };
}

/* ------------------------------------------------------------------ */
/* Transitions                                                         */
/* ------------------------------------------------------------------ */

export async function transitionTicket(
  tx: Tx,
  principal: Principal,
  input: {
    ticketId: string;
    event: TicketEvent;
    assigneeEmployeeId?: string | null;
    resolutionNote?: string | null;
  },
  options: { hmacKey: string },
): Promise<TicketState> {
  const ticket = await lockTicket(tx, principal.organizationId, input.ticketId);

  const next = ticketMachine.next(ticket.status, input.event);
  if (!next) {
    throw conflict(
      `A ticket that is ${ticket.status.toLowerCase().replace(/_/g, ' ')} cannot be ${input.event.toLowerCase().replace(/_/g, ' ')}.`,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { from: ticket.status, event: input.event },
    );
  }

  const now = new Date();
  const data: Record<string, unknown> = { status: next, rowVersion: { increment: 1 } };

  switch (input.event) {
    case 'ASSIGN':
      if (!input.assigneeEmployeeId) {
        throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, 'Name who the ticket goes to.');
      }
      data.assigneeEmployeeId = input.assigneeEmployeeId;
      data.assignedAt = now;
      break;

    case 'REQUEST_INFO':
      // Pausing the clock is a stored timestamp, so the elapsed SLA can be
      // recomputed later rather than trusted from a running total.
      data.pausedAt = now;
      break;

    case 'RESOLVE':
      data.resolvedAt = now;
      data.resolutionNote = input.resolutionNote ?? null;
      if (ticket.firstResponseAt === null) data.firstResponseAt = now;
      break;

    case 'CLOSE':
      data.closedAt = now;
      break;

    case 'REOPEN':
      data.reopenedAt = now;
      data.resolvedAt = null;
      data.closedAt = null;
      break;

    default:
      break;
  }

  await tx.helpdeskTicket.update({ where: { id: ticket.id }, data });

  if (input.event === 'ASSIGN' && input.assigneeEmployeeId) {
    await notifyEmployee(tx, {
      organizationId: principal.organizationId,
      employeeId: input.assigneeEmployeeId,
      kind: 'TICKET_UPDATED',
      tone: 'BLUE',
      title: `${ticket.reference} assigned to you`,
      body: ticket.subject,
      targetModule: 'help',
      targetId: ticket.id,
      sourceType: 'ticket_assignment',
      sourceId: ticket.id,
    });
  }

  if (input.event === 'RESOLVE' || input.event === 'REQUEST_INFO') {
    await notifyEmployee(tx, {
      organizationId: principal.organizationId,
      employeeId: ticket.requesterEmployeeId,
      kind: input.event === 'RESOLVE' ? 'TICKET_RESOLVED' : 'TICKET_UPDATED',
      tone: input.event === 'RESOLVE' ? 'GREEN' : 'AMBER',
      title:
        input.event === 'RESOLVE'
          ? `${ticket.reference} resolved`
          : `${ticket.reference} needs more detail from you`,
      body: input.resolutionNote ?? ticket.subject,
      targetModule: 'help',
      targetId: ticket.id,
      sourceType: `ticket_${input.event.toLowerCase()}`,
      sourceId: ticket.id,
    });
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'helpdesk_ticket',
      entityId: ticket.id,
      fromState: ticket.status,
      toState: next,
      summary: `${ticket.reference} moved to ${next.toLowerCase().replace(/_/g, ' ')}`,
    },
    options.hmacKey,
  );

  return next;
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 3_600_000);
}

type LockedTicket = {
  id: string;
  reference: string;
  subject: string;
  status: TicketState;
  requesterEmployeeId: string;
  assigneeEmployeeId: string | null;
  firstResponseAt: Date | null;
  pausedAt: Date | null;
  requester: { fullName: string; workEmail: string };
};

async function lockTicket(tx: Tx, organizationId: string, ticketId: string): Promise<LockedTicket> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM ess.helpdesk_ticket
    WHERE id = ${ticketId}::uuid AND organization_id = ${organizationId}::uuid
    FOR UPDATE
  `;
  if (locked.length === 0) throw notFound('That ticket');

  const ticket = await tx.helpdeskTicket.findUniqueOrThrow({
    where: { id: ticketId },
    select: {
      id: true,
      reference: true,
      subject: true,
      status: true,
      requesterEmployeeId: true,
      assigneeEmployeeId: true,
      firstResponseAt: true,
      pausedAt: true,
      requester: { select: { fullName: true, workEmail: true } },
    },
  });

  return ticket as LockedTicket;
}

/**
 * The body of the help-desk notification.
 *
 * Plain text on purpose: it reaches a shared mailbox and a ticketing system
 * alike, quotes the reference in the subject so replies thread, and carries
 * everything needed to act without opening the portal.
 */
function ticketEmailBody(input: {
  organizationName: string;
  reference: string;
  category: string;
  priority: string;
  requesterName: string;
  requesterNumber: string;
  requesterEmail: string;
  subject: string;
  description: string;
  raisedAt: Date;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
  link: string;
}): string {
  return [
    `A new help-desk ticket was raised in the ${input.organizationName} employee portal.`,
    '',
    `Reference    ${input.reference}`,
    `Category     ${input.category}`,
    `Priority     ${input.priority}`,
    `Raised by    ${input.requesterName} (${input.requesterNumber}) <${input.requesterEmail}>`,
    `Raised at    ${formatDateTime(input.raisedAt)}`,
    ...(input.firstResponseDueAt
      ? [`First reply  due ${formatDateTime(input.firstResponseDueAt)}`]
      : []),
    ...(input.resolutionDueAt ? [`Resolution   due ${formatDateTime(input.resolutionDueAt)}`] : []),
    '',
    `Subject      ${input.subject}`,
    '',
    input.description,
    '',
    `Open the ticket: ${input.link}`,
    '',
    'Replying to this message reaches the person who raised it.',
  ].join('\n');
}
