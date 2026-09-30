import { documentRequestCreate, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertPermission } from '../../services/auth/authorization.js';
import { requestDocument, transitionDocumentRequest } from '../../services/documents/service.js';

/**
 * Documents and letter requests.
 *
 * A document is downloadable because a file exists. A request offers no
 * download until HR issues one — the button is absent rather than present and
 * broken, and the endpoint refuses rather than signing a URL for nothing.
 */
export async function documentRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;

  /* ---------------------------------------------------------------- */
  /* GET /documents                                                    */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/documents', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'document:read', 'SELF');

    if (!principal.employeeId) return { documents: [], requests: [], requestableTypes: [] };

    const [documents, requests, requestableTypes] = await Promise.all([
      db.employeeDocument.findMany({
        where: {
          organizationId: principal.organizationId,
          employeeId: principal.employeeId,
          // A document HR marked as internal is not the employee's to see.
          type: { visibility: 'EMPLOYEE_AND_HR' },
        },
        orderBy: { documentDate: 'desc' },
        select: {
          id: true,
          title: true,
          documentDate: true,
          createdAt: true,
          type: { select: { id: true, name: true, category: true } },
          file: { select: { id: true, displayFilename: true, sizeBytes: true, contentType: true } },
        },
      }),

      db.documentRequest.findMany({
        where: { organizationId: principal.organizationId, employeeId: principal.employeeId },
        orderBy: { requestedAt: 'desc' },
        take: 40,
        select: {
          id: true,
          status: true,
          addressee: true,
          purpose: true,
          requestedAt: true,
          issuedAt: true,
          rejectionReason: true,
          fileObjectId: true,
          type: { select: { id: true, name: true } },
        },
      }),

      db.documentType.findMany({
        where: {
          organizationId: principal.organizationId,
          isActive: true,
          isRequestable: true,
        },
        orderBy: { displayOrder: 'asc' },
        select: { id: true, code: true, name: true, category: true },
      }),
    ]);

    return {
      documents: documents.map((document) => ({
        id: document.id,
        title: document.title,
        documentDate: toIsoDate(document.documentDate),
        uploadedAt: document.createdAt.toISOString(),
        type: document.type,
        filename: document.file.displayFilename,
        sizeBytes: Number(document.file.sizeBytes),
        contentType: document.file.contentType,
      })),

      requests: requests.map((documentRequest) => ({
        id: documentRequest.id,
        status: documentRequest.status,
        typeName: documentRequest.type.name,
        typeId: documentRequest.type.id,
        addressee: documentRequest.addressee,
        purpose: documentRequest.purpose,
        requestedAt: documentRequest.requestedAt.toISOString(),
        issuedAt: documentRequest.issuedAt?.toISOString() ?? null,
        rejectionReason: documentRequest.rejectionReason,
        // The single source of the download button's existence.
        hasDocument: documentRequest.fileObjectId !== null,
        canCancel: ['SUBMITTED', 'IN_REVIEW'].includes(documentRequest.status),
      })),

      requestableTypes,
    };
  });

  /* ---------------------------------------------------------------- */
  /* POST /documents/requests                                          */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/documents/requests',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'document:request', 'SELF');

      const body = documentRequestCreate.parse(request.body);

      const created = await db.$transaction((tx) =>
        requestDocument(
          tx,
          principal,
          {
            documentTypeId: body.documentTypeId,
            addressee: body.addressee ?? null,
            purpose: body.purpose ?? null,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return reply.status(201).send(created);
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /documents/requests/:id/cancel                               */
  /* ---------------------------------------------------------------- */

  app.post<{ Params: { id: string } }>(
    '/api/v1/documents/requests/:id/cancel',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'document:request', 'SELF');

      await db.$transaction((tx) =>
        transitionDocumentRequest(
          tx,
          principal,
          { requestId: request.params.id, event: 'CANCEL' },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /documents/:id/download                                       */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/documents/:id/download',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'document:read', 'SELF');

      const document = await db.employeeDocument.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          employeeId: principal.employeeId ?? '',
          type: { visibility: 'EMPLOYEE_AND_HR' },
        },
        select: {
          id: true,
          title: true,
          file: { select: { storageKey: true, displayFilename: true } },
        },
      });

      if (!document) throw notFound('That document');

      // A personnel document is a sensitive read, and who fetched which one is
      // exactly what an access review asks about later.
      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'DOWNLOAD',
            entityType: 'employee_document',
            entityId: document.id,
            summary: `Downloaded ${document.title}`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      const { storage } = await import('../../services/storage.js');
      const signed = await storage(env).signedDownloadUrl(document.file.storageKey, {
        expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
        downloadFilename: document.file.displayFilename,
      });

      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /documents/requests/:id/download                              */
  /* ---------------------------------------------------------------- */

  app.get<{ Params: { id: string } }>(
    '/api/v1/documents/requests/:id/download',
    { onRequest: app.authenticate(), config: { rateLimitName: 'export' } },
    async (request) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'document:read', 'SELF');

      const documentRequest = await db.documentRequest.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          employeeId: principal.employeeId ?? '',
          status: 'ISSUED',
        },
        select: {
          id: true,
          type: { select: { name: true } },
          file: { select: { storageKey: true, displayFilename: true } },
        },
      });

      if (!documentRequest?.file) throw notFound('That letter');

      await db.$transaction((tx) =>
        recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'DOWNLOAD',
            entityType: 'document_request',
            entityId: documentRequest.id,
            summary: `Downloaded ${documentRequest.type.name}`,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      const { storage } = await import('../../services/storage.js');
      const signed = await storage(env).signedDownloadUrl(documentRequest.file.storageKey, {
        expiresInSeconds: env.SIGNED_URL_TTL_SECONDS,
        downloadFilename: documentRequest.file.displayFilename,
      });

      return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
    },
  );
}
