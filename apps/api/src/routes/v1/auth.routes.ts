import {
  loginRequest,
  mfaVerifyRequest,
  normalizeRoles,
  passwordChangeRequest,
  type Persona,
  type SessionResponse,
} from '@widedrop/shared';
import type { FastifyReply } from 'fastify';
import type { App } from '../../app.js';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import { generateOpaqueToken, hashToken } from '../../lib/crypto.js';
import {
  checkPasswordPolicy,
  hashPassword,
  isBreachedPassword,
  verifyPassword,
} from '../../lib/password.js';
import {
  generateChallengeId,
  isWellFormedRecoveryCode,
  normalizeRecoveryCode,
  verifyTotp,
  MFA_CHALLENGE_TTL_SECONDS,
} from '../../lib/mfa.js';
import { EncryptionService } from '../../services/encryption.js';
import { requirePrincipal } from '../../plugins/authenticate.js';
import { clearCsrfToken, issueCsrfToken } from '../../plugins/csrf.js';
import { recordAudit } from '../../services/audit.js';
import { attemptLogin, completeLogin, loginRejection } from '../../services/auth/login.js';
import {
  issueSession,
  listSessions,
  revokeAllSessions,
  revokeFamily,
  rotateSession,
  sessionExpiredError,
  tokenReuseError,
} from '../../services/auth/sessions.js';
import { signAccessToken, type TokenKeys } from '../../services/auth/tokens.js';

const REFRESH_COOKIE = 'ess_refresh';

/**
 * Authentication routes.
 *
 * Token placement is the design decision that shapes the rest:
 *   - the refresh token goes into an httpOnly cookie the page cannot read, so
 *     script that manages to run cannot steal a long-lived credential
 *   - the access token is returned in the body and held in memory, so it is
 *     never attached automatically and CSRF cannot reach an authenticated
 *     endpoint with it
 */
export async function authRoutes(app: App, options: { keys: TokenKeys }): Promise<void> {
  const env = app.env;
  const db = app.db;

  const cookieOptions = {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: '/api/v1/auth',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  } as const;

  const csrfOptions = {
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    domain: env.COOKIE_DOMAIN,
    allowedOrigins: env.CORS_ORIGINS,
    maxAgeSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
  };

  /** Build the session response and set the refresh cookie. */
  async function establishSession(
    reply: FastifyReply,
    input: {
      userId: string;
      organizationId: string;
      employeeId?: string | undefined;
      personas: string[];
      mfaSatisfied: boolean;
      ip?: string | undefined;
      userAgent?: string | undefined;
      deviceLabel?: string | undefined;
    },
  ): Promise<SessionResponse> {
    const session = await db.$transaction((tx) =>
      issueSession(tx, {
        organizationId: input.organizationId,
        appUserId: input.userId,
        ttlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
        context: {
          ip: input.ip,
          userAgent: input.userAgent,
          deviceLabel: input.deviceLabel,
        },
      }),
    );

    const user = await db.appUser.findUniqueOrThrow({
      where: { id: input.userId },
      select: {
        id: true,
        email: true,
        tokenEpoch: true,
        passwordMustChange: true,
        employee: {
          select: { id: true, fullName: true, initials: true, employeeNumber: true },
        },
        mfaCredentials: {
          where: { disabledAt: null, confirmedAt: { not: null } },
          select: { id: true },
        },
      },
    });

    const accessToken = await signAccessToken(
      {
        sub: user.id,
        org: input.organizationId,
        ...(input.employeeId ? { emp: input.employeeId } : {}),
        roles: input.personas as never,
        sid: session.familyId,
        epc: user.tokenEpoch,
        mfa: input.mfaSatisfied,
      },
      options.keys,
      env.ACCESS_TOKEN_TTL_SECONDS,
    );

    void reply.setCookie(REFRESH_COOKIE, session.refreshToken, {
      ...cookieOptions,
      maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
    });

    const csrfToken = issueCsrfToken(reply, csrfOptions);

    return {
      accessToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      csrfToken,
      user: {
        id: user.id,
        email: user.email,
        employeeId: user.employee?.id ?? null,
        displayName: user.employee?.fullName ?? user.email,
        initials: user.employee?.initials ?? user.email.slice(0, 2).toUpperCase(),
        employeeNumber: user.employee?.employeeNumber ?? null,
        personas: input.personas,
        mustChangePassword: user.passwordMustChange,
        mfaEnrolled: user.mfaCredentials.length > 0,
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* POST /auth/login                                                  */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/login',
    {
      config: {
        public: true,
        rateLimitName: 'auth:login',
        // Also bound per email, so one account cannot be hammered from many
        // addresses. Deliberately generous — lockout is the real control.
        rateLimitByBodyField: 'email',
      },
    },
    async (request, reply) => {
      const body = loginRequest.parse(request.body);

      const organization = await db.organization.findFirst({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      if (!organization) throw loginRejection('UNKNOWN_USER');

      const result = await db.$transaction((tx) =>
        attemptLogin(
          tx,
          {
            organizationId: organization.id,
            email: body.email,
            password: body.password,
            pepper: env.PASSWORD_PEPPER,
            ip: request.context.ip,
            userAgent: request.context.userAgent,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      if (result.kind === 'rejected') {
        throw loginRejection(result.reason);
      }

      if (result.kind === 'mfa-required' || result.kind === 'mfa-enrolment-required') {
        const challengeId = generateChallengeId();
        // The challenge is a short-lived, single-use record: a partially
        // authenticated state that cannot be used for anything else.
        await db.passwordResetToken.create({
          data: {
            appUserId: result.userId,
            tokenHash: hashToken(`mfa:${challengeId}`),
            expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_SECONDS * 1000),
            ip: request.context.ip ?? null,
          },
        });

        return reply.status(200).send({
          status: 'mfa-required',
          challengeId,
          expiresIn: MFA_CHALLENGE_TTL_SECONDS,
          enrolmentRequired: result.kind === 'mfa-enrolment-required',
        });
      }

      await db.$transaction((tx) =>
        completeLogin(
          tx,
          {
            userId: result.userId,
            organizationId: organization.id,
            ip: request.context.ip,
            mfaUsed: false,
          },
          env.AUDIT_HMAC_KEY,
        ),
      );

      return reply.status(200).send(
        await establishSession(reply, {
          userId: result.userId,
          organizationId: organization.id,
          employeeId: result.employeeId,
          personas: result.personas,
          mfaSatisfied: false,
          ip: request.context.ip,
          userAgent: request.context.userAgent,
          deviceLabel: body.deviceLabel,
        }),
      );
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /auth/refresh                                                */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/refresh',
    { config: { public: true, rateLimitName: 'auth:refresh' } },
    async (request, reply) => {
      const token = request.cookies?.[REFRESH_COOKIE];
      if (!token) throw sessionExpiredError();

      const outcome = await db.$transaction((tx) =>
        rotateSession(tx, {
          refreshToken: token,
          ttlSeconds: env.REFRESH_TOKEN_TTL_SECONDS,
          context: {
            ip: request.context.ip,
            userAgent: request.context.userAgent,
          },
        }),
      );

      if (outcome.kind === 'invalid') {
        void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        throw sessionExpiredError();
      }

      if (outcome.kind === 'reuse-detected') {
        // A token that was already exchanged has been presented again. Two
        // parties hold tokens from one family, so the family is gone and the
        // owner is told.
        await db.$transaction(async (tx) => {
          await revokeAllSessions(tx, {
            appUserId: outcome.appUserId,
            organizationId: outcome.organizationId,
            reason: 'refresh token reuse detected',
            hmacKey: env.AUDIT_HMAC_KEY,
          });
          await tx.notification.create({
            data: {
              organizationId: outcome.organizationId,
              appUserId: outcome.appUserId,
              kind: 'SECURITY_ALERT',
              tone: 'RED',
              title: 'All sessions were signed out',
              body: 'A sign-in token was used twice, which can mean it was copied. Every session has been signed out as a precaution. If this was not you, change your password.',
              sourceType: 'refresh_token_family',
              sourceId: outcome.familyId,
            },
          });
        });

        void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        throw tokenReuseError();
      }

      const user = await db.appUser.findUniqueOrThrow({
        where: { id: outcome.appUserId },
        select: {
          id: true,
          status: true,
          employee: { select: { id: true, employmentStatus: true } },
          roles: {
            where: { revokedAt: null },
            select: { role: { select: { persona: true } }, expiresAt: true },
          },
          mfaCredentials: {
            where: { disabledAt: null, confirmedAt: { not: null } },
            select: { id: true },
          },
        },
      });

      if (user.status !== 'ACTIVE') {
        void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
        throw sessionExpiredError();
      }

      const now = Date.now();
      const personas = user.roles
        .filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now)
        .map((grant) => grant.role.persona as string);
      if (!personas.includes('EMPLOYEE')) personas.unshift('EMPLOYEE');

      void reply.setCookie(REFRESH_COOKIE, outcome.session.refreshToken, {
        ...cookieOptions,
        maxAge: env.REFRESH_TOKEN_TTL_SECONDS,
      });

      const csrfToken = issueCsrfToken(reply, csrfOptions);

      const accessToken = await signAccessToken(
        {
          sub: user.id,
          org: outcome.organizationId,
          ...(user.employee ? { emp: user.employee.id } : {}),
          roles: personas as never,
          sid: outcome.session.familyId,
          epc: (
            await db.appUser.findUniqueOrThrow({
              where: { id: user.id },
              select: { tokenEpoch: true },
            })
          ).tokenEpoch,
          mfa: user.mfaCredentials.length > 0,
        },
        options.keys,
        env.ACCESS_TOKEN_TTL_SECONDS,
      );

      return reply.status(200).send({
        accessToken,
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
        csrfToken,
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /auth/logout                                                 */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/logout',
    { onRequest: app.authenticate({ allowPendingMfa: true }) },
    async (request, reply) => {
      const principal = requirePrincipal(request);

      await db.$transaction(async (tx) => {
        await revokeFamily(tx, { familyId: principal.sessionId, reason: 'signed out' });
        await recordAudit(
          tx,
          {
            organizationId: principal.organizationId,
            action: 'LOGOUT',
            entityType: 'app_user',
            entityId: principal.userId,
            summary: 'Signed out of this device',
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      clearCsrfToken(reply, csrfOptions);
      return reply.status(204).send();
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /auth/logout-all                                             */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/logout-all',
    { onRequest: app.authenticate({ allowPendingMfa: true }) },
    async (request, reply) => {
      const principal = requirePrincipal(request);

      const result = await db.$transaction((tx) =>
        revokeAllSessions(tx, {
          appUserId: principal.userId,
          organizationId: principal.organizationId,
          reason: 'signed out everywhere by the account owner',
          hmacKey: env.AUDIT_HMAC_KEY,
        }),
      );

      void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      clearCsrfToken(reply, csrfOptions);
      return reply.status(200).send({ sessionsRevoked: result.revoked });
    },
  );

  /* ---------------------------------------------------------------- */
  /* GET /auth/sessions                                                */
  /* ---------------------------------------------------------------- */

  app.get('/api/v1/auth/sessions', { onRequest: app.authenticate() }, async (request) => {
    const principal = requirePrincipal(request);
    const sessions = await listSessions(db, principal.userId);
    return {
      items: sessions.map((session) => ({
        familyId: session.familyId,
        deviceLabel: session.deviceLabel,
        ip: session.ip,
        issuedAt: session.issuedAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        current: session.familyId === principal.sessionId,
      })),
    };
  });

  /* ---------------------------------------------------------------- */
  /* GET /auth/me                                                      */
  /* ---------------------------------------------------------------- */

  app.get(
    '/api/v1/auth/me',
    { onRequest: app.authenticate({ allowPendingMfa: true }) },
    async (request) => {
      const principal = requirePrincipal(request);

      const user = await db.appUser.findUniqueOrThrow({
        where: { id: principal.userId },
        select: {
          id: true,
          email: true,
          passwordMustChange: true,
          employee: {
            select: {
              id: true,
              fullName: true,
              initials: true,
              employeeNumber: true,
              employments: {
                where: { effectiveTo: null },
                select: {
                  department: { select: { name: true, accentColor: true } },
                  designation: { select: { title: true } },
                  location: { select: { name: true, city: true } },
                },
                take: 1,
              },
            },
          },
          mfaCredentials: {
            where: { disabledAt: null, confirmedAt: { not: null } },
            select: { id: true },
          },
        },
      });

      const employment = user.employee?.employments[0];

      return {
        id: user.id,
        email: user.email,
        employeeId: user.employee?.id ?? null,
        displayName: user.employee?.fullName ?? user.email,
        initials: user.employee?.initials ?? user.email.slice(0, 2).toUpperCase(),
        employeeNumber: user.employee?.employeeNumber ?? null,
        designation: employment?.designation.title ?? null,
        department: employment?.department.name ?? null,
        departmentAccent: employment?.department.accentColor ?? null,
        location: employment?.location.name ?? null,
        personas: principal.personas,
        mustChangePassword: user.passwordMustChange,
        mfaEnrolled: user.mfaCredentials.length > 0,
        mfaSatisfied: principal.mfaSatisfied,
      };
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /auth/password/change                                        */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/password/change',
    {
      onRequest: app.authenticate({ allowPendingMfa: true }),
      config: { rateLimitName: 'auth:password-change' },
    },
    async (request, reply) => {
      const principal = requirePrincipal(request);
      const body = passwordChangeRequest.parse(request.body);

      const user = await db.appUser.findUniqueOrThrow({
        where: { id: principal.userId },
        select: {
          passwordHash: true,
          email: true,
          employee: { select: { fullName: true, employeeNumber: true } },
        },
      });

      if (
        !user.passwordHash ||
        !(await verifyPassword(body.currentPassword, user.passwordHash, env.PASSWORD_PEPPER))
      ) {
        throw new AppError(
          401,
          ERROR_CODES.INVALID_CREDENTIALS,
          'Your current password is incorrect.',
        );
      }

      if (body.newPassword === body.currentPassword) {
        throw new AppError(
          422,
          ERROR_CODES.BUSINESS_RULE_VIOLATION,
          'Choose a password you have not used here before.',
        );
      }

      const personalData = [
        user.email,
        user.email.split('@')[0] ?? '',
        user.employee?.fullName ?? '',
        user.employee?.employeeNumber ?? '',
      ].filter(Boolean);

      const problems = checkPasswordPolicy(body.newPassword, personalData);
      if (problems.length > 0) {
        throw new AppError(422, ERROR_CODES.BUSINESS_RULE_VIOLATION, problems[0]!.message, {
          details: problems.map((p) => ({ path: 'newPassword', message: p.message, rule: p.rule })),
        });
      }

      if (
        env.HIBP_ENABLED &&
        (await isBreachedPassword(body.newPassword, { timeoutMs: env.HIBP_TIMEOUT_MS }))
      ) {
        throw new AppError(
          422,
          ERROR_CODES.BUSINESS_RULE_VIOLATION,
          'This password has appeared in a known data breach. Choose a different one.',
          {
            details: [
              { path: 'newPassword', message: 'Found in a breach corpus', rule: 'breached' },
            ],
          },
        );
      }

      const passwordHash = await hashPassword(body.newPassword, env.PASSWORD_PEPPER);

      await db.$transaction(async (tx) => {
        await tx.appUser.update({
          where: { id: principal.userId },
          data: {
            passwordHash,
            passwordUpdatedAt: new Date(),
            passwordMustChange: false,
          },
        });

        // Changing a password signs out everywhere. If it was changed because
        // it may have leaked, leaving other sessions alive would defeat it.
        await revokeAllSessions(tx, {
          appUserId: principal.userId,
          organizationId: principal.organizationId,
          reason: 'password changed',
          hmacKey: env.AUDIT_HMAC_KEY,
        });

        await tx.notification.create({
          data: {
            organizationId: principal.organizationId,
            appUserId: principal.userId,
            kind: 'SECURITY_ALERT',
            tone: 'AMBER',
            title: 'Your password was changed',
            body: 'Every session has been signed out. If this was not you, contact the help desk immediately.',
            sourceType: 'app_user',
            sourceId: principal.userId,
          },
        });
      });

      void reply.clearCookie(REFRESH_COOKIE, cookieOptions);
      clearCsrfToken(reply, csrfOptions);

      return reply.status(200).send({
        changed: true,
        message: 'Password changed. Sign in again with your new password.',
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /auth/password/reset/request                                 */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/password/reset/request',
    {
      config: { public: true, rateLimitName: 'auth:password-reset', rateLimitByBodyField: 'email' },
    },
    async (request, reply) => {
      const { email: address } = (request.body ?? {}) as { email?: string };

      if (typeof address === 'string' && address.includes('@')) {
        const user = await db.appUser.findFirst({
          where: { email: address.trim().toLowerCase(), status: 'ACTIVE' },
          select: { id: true, organizationId: true },
        });

        if (user) {
          const token = generateOpaqueToken();
          await db.$transaction(async (tx) => {
            await tx.passwordResetToken.create({
              data: {
                appUserId: user.id,
                tokenHash: hashToken(token),
                expiresAt: new Date(Date.now() + 30 * 60 * 1000),
                ip: request.context.ip ?? null,
              },
            });

            await tx.emailOutbox.create({
              data: {
                organizationId: user.organizationId,
                kind: 'PASSWORD_RESET',
                toAddresses: [address.trim().toLowerCase()],
                subject: 'Reset your Widedrop portal password',
                bodyText:
                  `Someone asked to reset the password for your Widedrop employee portal account.\n\n` +
                  `Open this link within 30 minutes to choose a new one:\n` +
                  `${env.WEB_PUBLIC_URL}/reset-password?token=${token}\n\n` +
                  `If this was not you, you can ignore this message — your password has not changed.\n` +
                  `If you get these repeatedly, contact ${env.HELPDESK_EMAIL}.`,
                sourceType: 'app_user',
                sourceId: user.id,
                idempotencyKey: `password-reset:${hashToken(token)}`,
              },
            });
          });
        }
      }

      // The same answer whether or not the address matched. Anything else turns
      // this endpoint into a directory of who works here.
      return reply.status(202).send({
        message: 'If that address belongs to an account, a reset link is on its way.',
      });
    },
  );

  /* ---------------------------------------------------------------- */
  /* POST /auth/mfa/verify                                             */
  /* ---------------------------------------------------------------- */

  app.post(
    '/api/v1/auth/mfa/verify',
    { config: { public: true, rateLimitName: 'auth:mfa' } },
    async (request, reply) => {
      const body = mfaVerifyRequest.parse(request.body);
      const challengeHash = hashToken(`mfa:${body.challengeId}`);

      const challenge = await db.passwordResetToken.findUnique({
        where: { tokenHash: challengeHash },
        select: {
          id: true,
          appUserId: true,
          expiresAt: true,
          usedAt: true,
          user: {
            select: {
              id: true,
              email: true,
              organizationId: true,
              status: true,
              employee: { select: { id: true, employmentStatus: true } },
              roles: {
                where: { revokedAt: null },
                select: { role: { select: { persona: true } }, expiresAt: true },
              },
              mfaCredentials: {
                where: { disabledAt: null, confirmedAt: { not: null } },
                select: {
                  id: true,
                  secretCt: true,
                  secretIv: true,
                  secretTag: true,
                  encryptionKeyVersion: true,
                  lastUsedTimeStep: true,
                },
              },
              recoveryCodes: {
                where: { usedAt: null },
                select: { id: true, codeHash: true },
              },
            },
          },
        },
      });

      // One error for every reason this can fail, so a caller cannot probe for
      // a valid challenge id or learn which accounts have MFA enrolled.
      const rejected = () =>
        new AppError(
          401,
          ERROR_CODES.INVALID_MFA_CODE,
          'That code could not be verified. Sign in again.',
        );

      if (
        !challenge ||
        challenge.usedAt ||
        challenge.expiresAt.getTime() <= Date.now() ||
        challenge.user.status !== 'ACTIVE'
      ) {
        throw rejected();
      }

      const credential = challenge.user.mfaCredentials[0];
      if (!credential) throw rejected();

      const encryption = new EncryptionService(env);
      let secret: string;
      try {
        secret = encryption.decrypt(
          {
            ct: credential.secretCt,
            iv: credential.secretIv,
            tag: credential.secretTag,
            keyVersion: credential.encryptionKeyVersion,
          },
          EncryptionService.context('mfa_credential', 'secret', credential.id),
        );
      } catch {
        request.log.error({ credentialId: credential.id }, 'mfa secret failed to decrypt');
        throw rejected();
      }

      const normalized = normalizeRecoveryCode(body.code);
      let usedRecoveryCode: string | undefined;
      let verified = false;
      let timeStep: number | undefined;

      if (/^\d{6}$/.test(body.code.replace(/\s+/g, ''))) {
        const result = verifyTotp(body.code, secret, challenge.user.email);
        // A code accepted once must not be accepted again inside its window:
        // otherwise an intercepted code stays usable for up to 30 seconds.
        if (
          result.valid &&
          result.timeStep !== undefined &&
          (credential.lastUsedTimeStep === null ||
            BigInt(result.timeStep) > credential.lastUsedTimeStep)
        ) {
          verified = true;
          timeStep = result.timeStep;
        }
      } else if (isWellFormedRecoveryCode(body.code)) {
        for (const stored of challenge.user.recoveryCodes) {
          if (await verifyPassword(normalized, stored.codeHash, env.PASSWORD_PEPPER)) {
            verified = true;
            usedRecoveryCode = stored.id;
            break;
          }
        }
      }

      if (!verified) {
        await db.loginAttempt.create({
          data: {
            organizationId: challenge.user.organizationId,
            appUserId: challenge.user.id,
            emailAttempted: challenge.user.email,
            outcome: 'MFA_FAILED',
            ip: request.context.ip ?? null,
            userAgent: request.context.userAgent?.slice(0, 300) ?? null,
          },
        });
        throw rejected();
      }

      const personas = normalizeRoles(
        challenge.user.roles
          .filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > Date.now())
          .map((grant) => grant.role.persona as Persona),
      );

      await db.$transaction(async (tx) => {
        // The challenge is single-use.
        await tx.passwordResetToken.update({
          where: { id: challenge.id },
          data: { usedAt: new Date() },
        });

        if (timeStep !== undefined) {
          await tx.mfaCredential.update({
            where: { id: credential.id },
            data: { lastUsedTimeStep: BigInt(timeStep) },
          });
        }

        if (usedRecoveryCode) {
          await tx.mfaRecoveryCode.update({
            where: { id: usedRecoveryCode },
            data: { usedAt: new Date(), usedIp: request.context.ip ?? null },
          });

          const remaining = challenge.user.recoveryCodes.length - 1;
          await tx.notification.create({
            data: {
              organizationId: challenge.user.organizationId,
              appUserId: challenge.user.id,
              kind: 'SECURITY_ALERT',
              tone: remaining <= 2 ? 'RED' : 'AMBER',
              title: 'A recovery code was used to sign in',
              body:
                remaining === 0
                  ? 'That was your last recovery code. Generate a new set from your security settings.'
                  : `${remaining} recovery ${remaining === 1 ? 'code remains' : 'codes remain'}. If this was not you, change your password now.`,
              sourceType: 'mfa_recovery_code',
              sourceId: usedRecoveryCode,
            },
          });
        }

        await tx.loginAttempt.create({
          data: {
            organizationId: challenge.user.organizationId,
            appUserId: challenge.user.id,
            emailAttempted: challenge.user.email,
            outcome: 'SUCCESS',
            ip: request.context.ip ?? null,
            userAgent: request.context.userAgent?.slice(0, 300) ?? null,
          },
        });

        await completeLogin(
          tx,
          {
            userId: challenge.user.id,
            organizationId: challenge.user.organizationId,
            ip: request.context.ip,
            mfaUsed: true,
          },
          env.AUDIT_HMAC_KEY,
        );
      });

      return reply.status(200).send(
        await establishSession(reply, {
          userId: challenge.user.id,
          organizationId: challenge.user.organizationId,
          employeeId: challenge.user.employee?.id,
          personas,
          mfaSatisfied: true,
          ip: request.context.ip,
          userAgent: request.context.userAgent,
        }),
      );
    },
  );
}
