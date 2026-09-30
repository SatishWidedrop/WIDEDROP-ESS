import { emergencyContactWrite, profileChangeRequestCreate, toIsoDate } from '@widedrop/shared';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES, notFound } from '../../lib/errors.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { recordAudit } from '../../services/audit.js';
import { assertEmployeeInScope, assertPermission, can } from '../../services/auth/authorization.js';
import { EncryptionService } from '../../services/encryption.js';
import { createTicket } from '../../services/helpdesk/service.js';

/**
 * The profile.
 *
 * Almost nothing here is directly editable, and that is the design rather than
 * a limitation: a bank account or a PAN that an employee can change unilaterally
 * is a payroll fraud waiting to happen. Those go through a change request HR
 * verifies, and applying one writes a before/after audit entry.
 *
 * What is editable directly — emergency contacts — is data nobody is paid from.
 *
 * Encrypted fields are returned masked. The plaintext is decrypted only for the
 * employee themselves, only on the fields they are allowed to see in full, and
 * the read is audited.
 */
export async function profileRoutes(app: App): Promise<void> {
  const db = app.db;
  const env = app.env;
  const encryption = new EncryptionService(env);

  /* ---------------------------------------------------------------- */
  /* GET /profile                                                      */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/profile', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'profile:read', 'SELF');

    const employeeId =
      (request.query as { employeeId?: string }).employeeId ?? principal.employeeId;
    if (!employeeId) throw notFound('That profile');

    const isSelf = employeeId === principal.employeeId;
    if (!isSelf) {
      // A manager or HR reading someone else's profile is checked against that
      // person, and gets the reduced view below.
      await assertEmployeeInScope(db, principal, 'profile:read', employeeId);
    }

    const employee = await db.employee.findFirst({
      where: { id: employeeId, organizationId: principal.organizationId },
      select: {
        id: true,
        employeeNumber: true,
        firstName: true,
        middleName: true,
        lastName: true,
        fullName: true,
        preferredName: true,
        initials: true,
        workEmail: true,
        workPhone: true,
        dateOfJoining: true,
        probationEndDate: true,
        employmentStatus: true,
        photoFileObjectId: true,
        employments: {
          where: { effectiveTo: null },
          take: 1,
          select: {
            employmentType: true,
            noticePeriodDays: true,
            effectiveFrom: true,
            designation: { select: { title: true, grade: true } },
            department: { select: { id: true, name: true } },
            location: { select: { id: true, name: true, city: true, stateCode: true } },
            costCentre: { select: { code: true, name: true } },
          },
        },
        managerLinks: {
          where: { effectiveTo: null, isPrimary: true },
          take: 1,
          select: { manager: { select: { id: true, fullName: true, initials: true } } },
        },
        personalDetail: {
          select: {
            dateOfBirth: true,
            gender: true,
            maritalStatus: true,
            bloodGroup: true,
            nationality: true,
            personalEmailCt: true,
            personalEmailIv: true,
            personalEmailTag: true,
            mobileCt: true,
            mobileIv: true,
            mobileTag: true,
            currentAddressCt: true,
            currentAddressIv: true,
            currentAddressTag: true,
            permanentAddressCt: true,
            permanentAddressIv: true,
            permanentAddressTag: true,
            encryptionKeyVersion: true,
          },
        },
        statutoryIds: {
          select: { id: true, kind: true, maskedValue: true, verifiedAt: true },
        },
        bankAccounts: {
          where: { isActive: true },
          select: {
            id: true,
            bankName: true,
            accountNumberMasked: true,
            ifscMasked: true,
            accountHolderName: true,
            isPrimary: true,
            verifiedAt: true,
          },
        },
        emergencyContacts: {
          select: {
            id: true,
            name: true,
            relationship: true,
            phoneMasked: true,
            isPrimary: true,
          },
          orderBy: { isPrimary: 'desc' },
        },
      },
    });

    if (!employee) throw notFound('That profile');

    const employment = employee.employments[0];

    const base = {
      id: employee.id,
      employeeNumber: employee.employeeNumber,
      fullName: employee.fullName,
      preferredName: employee.preferredName,
      initials: employee.initials,
      workEmail: employee.workEmail,
      workPhone: employee.workPhone,
      hasPhoto: employee.photoFileObjectId !== null,
      dateOfJoining: toIsoDate(employee.dateOfJoining),
      probationEndDate: employee.probationEndDate ? toIsoDate(employee.probationEndDate) : null,
      employmentStatus: employee.employmentStatus,
      manager: employee.managerLinks[0]?.manager ?? null,
      employment: employment
        ? {
            type: employment.employmentType,
            noticePeriodDays: employment.noticePeriodDays,
            effectiveFrom: toIsoDate(employment.effectiveFrom),
            designation: employment.designation.title,
            grade: employment.designation.grade,
            department: employment.department.name,
            location: employment.location.name,
            city: employment.location.city,
            stateCode: employment.location.stateCode,
            costCentre: employment.costCentre?.name ?? null,
          }
        : null,
    };

    // What a manager or HR sees: the employment facts they need to manage
    // someone, and nothing that would let them impersonate or pay them.
    if (!isSelf) {
      return {
        ...base,
        viewerIsSelf: false,
        personal: null,
        statutoryIds: [],
        bankAccounts: [],
        emergencyContacts: [],
      };
    }

    const detail = employee.personalDetail;
    const decrypt = (
      ct: Uint8Array | null,
      iv: Uint8Array | null,
      tag: Uint8Array | null,
      column: string,
    ): string | null => {
      if (!ct || !iv || !tag || !detail) return null;
      return encryption.decrypt(
        { ct, iv, tag, keyVersion: detail.encryptionKeyVersion },
        EncryptionService.context('employee_personal_detail', column, employee.id),
      );
    };

    // Reading one's own personal record is still a sensitive read. It is
    // recorded so that an account takeover leaves a trail.
    await db.$transaction((tx) =>
      recordAudit(
        tx,
        {
          organizationId: principal.organizationId,
          action: 'READ_SENSITIVE',
          entityType: 'employee_personal_detail',
          entityId: employee.id,
          summary: 'Viewed own personal details',
        },
        env.AUDIT_HMAC_KEY,
      ),
    );

    return {
      ...base,
      viewerIsSelf: true,

      personal: detail
        ? {
            dateOfBirth: detail.dateOfBirth ? toIsoDate(detail.dateOfBirth) : null,
            gender: detail.gender,
            maritalStatus: detail.maritalStatus,
            bloodGroup: detail.bloodGroup,
            nationality: detail.nationality,
            personalEmail: decrypt(
              detail.personalEmailCt,
              detail.personalEmailIv,
              detail.personalEmailTag,
              'personal_email',
            ),
            mobile: decrypt(detail.mobileCt, detail.mobileIv, detail.mobileTag, 'mobile'),
            currentAddress: decrypt(
              detail.currentAddressCt,
              detail.currentAddressIv,
              detail.currentAddressTag,
              'current_address',
            ),
            permanentAddress: decrypt(
              detail.permanentAddressCt,
              detail.permanentAddressIv,
              detail.permanentAddressTag,
              'permanent_address',
            ),
          }
        : null,

      // Statutory identifiers and bank details stay masked even for their
      // owner. Seeing the last four digits confirms which account it is; the
      // full number serves no purpose on a screen and is one screenshot away
      // from being a problem.
      statutoryIds: employee.statutoryIds.map((statutory) => ({
        id: statutory.id,
        kind: statutory.kind,
        masked: statutory.maskedValue,
        verified: statutory.verifiedAt !== null,
      })),

      bankAccounts: employee.bankAccounts.map((account) => ({
        id: account.id,
        bankName: account.bankName,
        accountNumberMasked: account.accountNumberMasked,
        ifscMasked: account.ifscMasked,
        accountHolderName: account.accountHolderName,
        isPrimary: account.isPrimary,
        verified: account.verifiedAt !== null,
      })),

      emergencyContacts: employee.emergencyContacts,
    };
  });

  /* ---------------------------------------------------------------- */
  /* Emergency contacts — the one section an employee owns outright    */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/profile/emergency-contacts',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'emergency-contact:write', 'SELF');

      const employeeId = principal.employeeId;
      if (!employeeId) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          'This account is not linked to an employee.',
        );
      }

      const body = emergencyContactWrite.parse(request.body);

      const created = await db.$transaction(async (tx) => {
        // The row id has to exist before the ciphertext can be bound to it, so
        // the record is created and then sealed in the same transaction.
        const contact = await tx.employeeEmergencyContact.create({
          data: {
            organizationId: principal.organizationId,
            employeeId,
            name: body.name,
            relationship: body.relationship,
            phoneCt: Buffer.alloc(0),
            phoneIv: Buffer.alloc(0),
            phoneTag: Buffer.alloc(0),
            phoneMasked: encryption.mask(body.phone, 'phone'),
            isPrimary: body.isPrimary,
          },
          select: { id: true },
        });

        const sealed = encryption.encrypt(
          body.phone,
          EncryptionService.context('employee_emergency_contact', 'phone', contact.id),
        );

        await tx.employeeEmergencyContact.update({
          where: { id: contact.id },
          data: {
            phoneCt: sealed.ct,
            phoneIv: sealed.iv,
            phoneTag: sealed.tag,
            encryptionKeyVersion: sealed.keyVersion,
          },
        });

        // Only one primary contact: the previous one steps down rather than
        // two rows both claiming to be who gets called.
        if (body.isPrimary) {
          await tx.employeeEmergencyContact.updateMany({
            where: { employeeId, id: { not: contact.id } },
            data: { isPrimary: false },
          });
        }

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'employee_emergency_contact',
            entityId: contact.id,
            after: { name: body.name, relationship: body.relationship },
            summary: `Added emergency contact ${body.name}`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return contact;
      });

      return reply.status(201).send(created);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/v1/profile/emergency-contacts/:id',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'emergency-contact:write', 'SELF');

      const contact = await db.employeeEmergencyContact.findFirst({
        where: {
          id: request.params.id,
          organizationId: principal.organizationId,
          employeeId: principal.employeeId ?? '',
        },
        select: { id: true, name: true },
      });
      if (!contact) throw notFound('That contact');

      await db.$transaction(async (tx) => {
        await tx.employeeEmergencyContact.delete({ where: { id: contact.id } });
        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'DELETE',
            entityType: 'employee_emergency_contact',
            entityId: contact.id,
            before: { name: contact.name },
            summary: `Removed emergency contact ${contact.name}`,
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* Change requests — everything else                                 */
  /* ---------------------------------------------------------------- */

  /** What each section is allowed to ask to change. Anything else is refused. */
  const ALLOWED_FIELDS: Record<string, readonly string[]> = {
    personal: ['personalEmail', 'mobile', 'currentAddress', 'permanentAddress', 'maritalStatus'],
    bank: ['bankName', 'accountNumber', 'ifsc', 'accountHolderName'],
    statutory: ['PAN', 'AADHAAR', 'UAN'],
    emergency: ['name', 'relationship', 'phone'],
  };

  app.get('/api/v1/profile/change-requests', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    assertPermission(principal, 'profile:request-change', 'SELF');

    const requests = await db.profileChangeRequest.findMany({
      where: {
        organizationId: principal.organizationId,
        ...(can(principal, 'profile:write', 'ORG')
          ? {}
          : { employeeId: principal.employeeId ?? '' }),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        section: true,
        status: true,
        decisionNote: true,
        createdAt: true,
        reviewedAt: true,
        appliedAt: true,
        ticketId: true,
        employee: { select: { id: true, fullName: true, initials: true } },
      },
    });

    return {
      items: requests.map((changeRequest) => ({
        ...changeRequest,
        createdAt: changeRequest.createdAt.toISOString(),
        reviewedAt: changeRequest.reviewedAt?.toISOString() ?? null,
        appliedAt: changeRequest.appliedAt?.toISOString() ?? null,
      })),
    };
  });

  app.post(
    '/api/v1/profile/change-requests',
    { onRequest: app.authenticate(), config: { rateLimitName: 'write' } },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      assertPermission(principal, 'profile:request-change', 'SELF');

      const employeeId = principal.employeeId;
      if (!employeeId) {
        throw new AppError(
          403,
          ERROR_CODES.FORBIDDEN,
          'This account is not linked to an employee.',
        );
      }

      const body = profileChangeRequestCreate.parse(request.body);
      const allowed = ALLOWED_FIELDS[body.section] ?? [];

      const unknown = Object.keys(body.changes).filter((key) => !allowed.includes(key));
      if (unknown.length > 0) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          `Those fields cannot be changed through the ${body.section} section.`,
          { details: unknown.map((field) => ({ path: field, message: 'Not a changeable field' })) },
        );
      }

      const created = await db.$transaction(async (tx) => {
        const changeRequest = await tx.profileChangeRequest.create({
          data: {
            organizationId: principal.organizationId,
            employeeId,
            section: body.section,
            // Sealed: a change request holds a new bank account number until
            // someone verifies it, and it should be no more readable at rest
            // than the column it will eventually update.
            requestedChanges: Object.fromEntries(
              Object.entries(body.changes).map(([field, value]) => [
                field,
                encryption.serialize(
                  value,
                  EncryptionService.context('profile_change_request', field, employeeId),
                ),
              ]),
            ),
            status: 'SUBMITTED',
          },
          select: { id: true },
        });

        // The employee follows one thread: the help-desk ticket is the visible
        // half of the change request, and both are created together.
        const category = await tx.ticketCategory.findFirst({
          where: { organizationId: principal.organizationId, isActive: true },
          orderBy: { displayOrder: 'asc' },
          select: { id: true },
        });

        let ticketId: string | null = null;
        if (category) {
          const ticket = await createTicket(
            tx,
            principal,
            {
              ticketCategoryId: category.id,
              subject: `Profile change: ${body.section}`,
              description:
                `A change to my ${body.section} details was requested through the portal.\n\n` +
                `Fields: ${Object.keys(body.changes).join(', ')}\n` +
                (body.reason ? `\nReason: ${body.reason}\n` : '') +
                `\nThe requested values are held encrypted against change request ${changeRequest.id} ` +
                `and are visible to People Ops in the portal. They are deliberately not repeated in this email.`,
              sourceType: 'profile_change_request',
              sourceId: changeRequest.id,
            },
            {
              helpdeskEmail: env.HELPDESK_EMAIL,
              webUrl: env.WEB_PUBLIC_URL,
              hmacKey: env.AUDIT_HMAC_KEY,
            },
          );
          ticketId = ticket.id;
          await tx.profileChangeRequest.update({
            where: { id: changeRequest.id },
            data: { ticketId },
          });
        }

        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'CREATE',
            entityType: 'profile_change_request',
            entityId: changeRequest.id,
            toState: 'SUBMITTED',
            // The field names, never the values: an audit row is not a second
            // copy of the data it describes.
            after: { section: body.section, fields: Object.keys(body.changes) },
            summary: `Requested a change to ${body.section} details`,
          },
          env.AUDIT_HMAC_KEY,
        );

        return { id: changeRequest.id, ticketId };
      });

      return reply.status(201).send(created);
    },
  );
}
