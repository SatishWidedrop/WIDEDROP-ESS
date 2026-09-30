import {
  documentRequestMachine,
  formatDate,
  toIsoDate,
  type DocumentRequestEvent,
  type DocumentRequestState,
} from '@widedrop/shared';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import { notifyEmployee } from '../notifications.js';

/**
 * Documents and letters.
 *
 * Two kinds of thing live here. A **document** is a file that already exists —
 * an offer letter, an appraisal, a Form 16. A **letter request** is an ask for
 * one to be produced: an employment letter for a bank, an address proof.
 *
 * A request carries no file until HR issues one, and the download endpoint
 * refuses before then rather than offering a button that fails. The generated
 * text is resolved from persisted employee data through a template whose
 * placeholders are validated, so a letter cannot assert something the database
 * does not hold.
 */

export async function requestDocument(
  tx: Tx,
  principal: Principal,
  input: { documentTypeId: string; addressee?: string | null; purpose?: string | null },
  hmacKey: string,
): Promise<{ id: string }> {
  const employeeId = principal.employeeId;
  if (!employeeId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'This account is not linked to an employee.');
  }

  const type = await tx.documentType.findFirst({
    where: {
      id: input.documentTypeId,
      organizationId: principal.organizationId,
      isActive: true,
      isRequestable: true,
    },
    select: { id: true, name: true },
  });
  if (!type) throw notFound('That document type');

  // One open request per type: a second is not a second letter, it is a
  // duplicate that two people in HR would work on separately.
  const open = await tx.documentRequest.findFirst({
    where: {
      organizationId: principal.organizationId,
      employeeId,
      documentTypeId: type.id,
      status: { in: ['SUBMITTED', 'IN_REVIEW', 'PROCESSING'] },
    },
    select: { id: true },
  });
  if (open) {
    throw conflict(
      `You already have a ${type.name} request in progress. People Ops will update it.`,
      ERROR_CODES.ALREADY_EXISTS,
    );
  }

  const template = await tx.letterTemplate.findFirst({
    where: { organizationId: principal.organizationId, documentTypeId: type.id, isActive: true },
    orderBy: { version: 'desc' },
    select: { id: true },
  });

  const request = await tx.documentRequest.create({
    data: {
      organizationId: principal.organizationId,
      employeeId,
      documentTypeId: type.id,
      letterTemplateId: template?.id ?? null,
      status: 'SUBMITTED',
      addressee: input.addressee ?? null,
      purpose: input.purpose ?? null,
    },
    select: { id: true },
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'CREATE',
      entityType: 'document_request',
      entityId: request.id,
      toState: 'SUBMITTED',
      after: { documentType: type.name, addressee: input.addressee ?? null },
      summary: `Requested a ${type.name}`,
    },
    hmacKey,
  );

  return request;
}

export async function transitionDocumentRequest(
  tx: Tx,
  principal: Principal,
  input: {
    requestId: string;
    event: DocumentRequestEvent;
    fileObjectId?: string | null;
    rejectionReason?: string | null;
  },
  hmacKey: string,
): Promise<DocumentRequestState> {
  const request = await tx.documentRequest.findFirst({
    where: { id: input.requestId, organizationId: principal.organizationId },
    select: {
      id: true,
      employeeId: true,
      status: true,
      type: { select: { name: true } },
    },
  });
  if (!request) throw notFound('That document request');

  const from = request.status as DocumentRequestState;
  const next = documentRequestMachine.next(from, input.event);
  if (!next) {
    throw conflict(
      `A request that is ${from.toLowerCase().replace(/_/g, ' ')} cannot be ${input.event.toLowerCase()}d.`,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { from, event: input.event },
    );
  }

  // Cancelling is the employee's, everything else is HR's. Checked here rather
  // than only on the route so the rule cannot be bypassed by a second caller.
  if (input.event === 'CANCEL') {
    if (request.employeeId !== principal.employeeId) {
      throw new AppError(403, ERROR_CODES.OUT_OF_SCOPE, 'That request is not yours.');
    }
  }

  if (input.event === 'ISSUE' && !input.fileObjectId) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'A letter cannot be issued without the document itself.',
    );
  }
  if (input.event === 'REJECT' && !input.rejectionReason?.trim()) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      'Give a reason so the employee knows what to do next.',
    );
  }

  const now = new Date();

  await tx.documentRequest.update({
    where: { id: request.id },
    data: {
      status: next,
      ...(input.event === 'START' ? { startedAt: now } : {}),
      ...(input.event === 'ISSUE'
        ? { issuedAt: now, issuedByUserId: principal.userId, fileObjectId: input.fileObjectId }
        : {}),
      ...(input.event === 'REJECT' ? { rejectionReason: input.rejectionReason } : {}),
      ...(input.event === 'CANCEL' ? { cancelledAt: now } : {}),
      rowVersion: { increment: 1 },
    },
  });

  if (input.event === 'ISSUE' || input.event === 'REJECT') {
    await notifyEmployee(tx, {
      organizationId: principal.organizationId,
      employeeId: request.employeeId,
      kind: 'DOCUMENT_ISSUED',
      tone: input.event === 'ISSUE' ? 'GREEN' : 'RED',
      title:
        input.event === 'ISSUE'
          ? `Your ${request.type.name} is ready`
          : `Your ${request.type.name} request was declined`,
      body:
        input.event === 'REJECT' ? (input.rejectionReason ?? null) : 'Download it from Documents.',
      targetModule: 'documents',
      targetId: request.id,
      sourceType: `document_request_${input.event.toLowerCase()}`,
      sourceId: request.id,
    });
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'document_request',
      entityId: request.id,
      fromState: from,
      toState: next,
      summary: `${request.type.name} request moved to ${next.toLowerCase().replace(/_/g, ' ')}`,
      after: { rejectionReason: input.rejectionReason ?? null },
    },
    hmacKey,
  );

  return next;
}

/* ------------------------------------------------------------------ */
/* Letter rendering                                                    */
/* ------------------------------------------------------------------ */

/**
 * The values a letter template may reference.
 *
 * Every one comes from a persisted row. A template that asks for a field not
 * in this map is rejected at render time rather than rendering an empty gap —
 * a letter with a blank where a salary should be is worse than no letter.
 */
export async function letterPlaceholders(
  tx: Tx,
  organizationId: string,
  employeeId: string,
): Promise<Record<string, string>> {
  const [organization, employee] = await Promise.all([
    tx.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { legalName: true, displayName: true },
    }),
    tx.employee.findFirstOrThrow({
      where: { id: employeeId, organizationId },
      select: {
        fullName: true,
        employeeNumber: true,
        workEmail: true,
        dateOfJoining: true,
        employments: {
          where: { effectiveTo: null },
          select: {
            employmentType: true,
            designation: { select: { title: true } },
            department: { select: { name: true } },
            location: { select: { name: true, city: true } },
          },
          take: 1,
        },
      },
    }),
  ]);

  const employment = employee.employments[0];

  const values: Record<string, string | null> = {
    'organization.legalName': organization.legalName,
    'organization.displayName': organization.displayName,
    'employee.fullName': employee.fullName,
    'employee.employeeNumber': employee.employeeNumber,
    'employee.workEmail': employee.workEmail,
    'employee.dateOfJoining': formatDate(toIsoDate(employee.dateOfJoining)),
    'employment.designation': employment?.designation.title ?? null,
    'employment.department': employment?.department.name ?? null,
    'employment.location': employment?.location.name ?? null,
    'employment.city': employment?.location.city ?? null,
    'employment.type': employment?.employmentType.replace(/_/g, ' ').toLowerCase() ?? null,
    today: formatDate(toIsoDate(new Date())),
  };

  return Object.fromEntries(
    Object.entries(values).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

/**
 * Fill a template.
 *
 * Refuses rather than substituting a blank: a placeholder with no value means
 * the database does not hold the fact the letter would assert.
 */
export function renderLetter(
  template: string,
  values: Record<string, string>,
): { body: string; missing: string[] } {
  const missing: string[] = [];

  const body = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) {
      missing.push(key);
      return `{{${key}}}`;
    }
    return value;
  });

  return { body, missing: [...new Set(missing)] };
}
