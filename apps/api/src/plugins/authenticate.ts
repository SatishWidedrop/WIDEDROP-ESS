import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  normalizeRoles,
  requiresMfa,
  type Permission,
  type Persona,
  type Scope,
} from '@widedrop/shared';
import { AppError, ERROR_CODES } from '../lib/errors.js';
import { STATES_ALLOWING_SIGN_IN } from '@widedrop/shared';
import type { PrismaClient } from '../generated/prisma/index.js';
import { assertPermission, type Principal } from '../services/auth/authorization.js';
import { bearerToken, verifyAccessToken, type TokenKeys } from '../services/auth/tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present once `authenticate` has run. Absent on public routes. */
    principal?: Principal;
  }
  interface FastifyInstance {
    /** Route guard: requires a valid session, and optionally a permission. */
    authenticate: (options?: {
      permission?: Permission;
      scope?: Scope;
      /** Routes that may run before the second factor is satisfied. */
      allowPendingMfa?: boolean;
    }) => (request: FastifyRequest) => Promise<void>;
  }
  interface FastifyContextConfig {
    /** Marks a route as reachable without a session. */
    public?: boolean;
  }
}

/**
 * Authentication.
 *
 * A valid signature is not enough. Every request re-checks, against the
 * database, that:
 *
 *   - the token's epoch still matches the user's, so a password change, role
 *     change or "sign out everywhere" takes effect at once rather than when the
 *     token would have expired
 *   - the account is still active and not locked
 *   - the employment still permits sign-in
 *   - the roles in the token still exist and have not been revoked
 *
 * That is one indexed read per request, and it is what makes revocation real.
 */
export const authenticatePlugin = fp(
  async (app: FastifyInstance, options: { keys: TokenKeys; db: PrismaClient }) => {
    app.decorate('authenticate', (guard: Parameters<FastifyInstance['authenticate']>[0] = {}) => {
      return async (request: FastifyRequest): Promise<void> => {
        const principal = await resolvePrincipal(request, options);

        if (requiresMfa(principal.personas) && !principal.mfaSatisfied && !guard.allowPendingMfa) {
          throw new AppError(
            403,
            ERROR_CODES.MFA_ENROLMENT_REQUIRED,
            'Set up two-factor authentication to continue.',
            { meta: { personas: principal.personas } },
          );
        }

        request.principal = principal;
        request.context.userId = principal.userId;
        request.context.organizationId = principal.organizationId;
        request.context.employeeId = principal.employeeId;
        request.context.personas = principal.personas;
        request.log = request.log.child({ userId: principal.userId });

        if (guard.permission) {
          assertPermission(principal, guard.permission, guard.scope ?? 'SELF');
        }
      };
    });
  },
  { name: 'authenticate' },
);

async function resolvePrincipal(
  request: FastifyRequest,
  options: { keys: TokenKeys; db: PrismaClient },
): Promise<Principal> {
  const token = bearerToken(request.headers.authorization);
  if (!token) {
    throw new AppError(401, ERROR_CODES.AUTHENTICATION_REQUIRED, 'Sign in to continue.');
  }

  const claims = await verifyAccessToken(token, options.keys);

  const user = await options.db.appUser.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      organizationId: true,
      status: true,
      tokenEpoch: true,
      lockedUntil: true,
      isServiceAccount: true,
      employee: { select: { id: true, employmentStatus: true } },
      roles: {
        where: { revokedAt: null },
        select: { role: { select: { persona: true } }, expiresAt: true },
      },
    },
  });

  // Every failure below produces the same error. A caller must not be able to
  // tell a disabled account from a deleted one, or a stale epoch from a forged
  // signature.
  if (!user) throw sessionEnded();
  if (user.organizationId !== claims.org) throw sessionEnded();
  if (user.tokenEpoch !== claims.epc) throw sessionEnded();
  if (user.status !== 'ACTIVE') throw sessionEnded();
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) throw sessionEnded();

  // A service account holds no employee record and cannot use interactive routes.
  if (!user.isServiceAccount) {
    if (!user.employee) throw sessionEnded();
    if (!STATES_ALLOWING_SIGN_IN.includes(user.employee.employmentStatus as never)) {
      throw sessionEnded();
    }
  }

  const now = Date.now();
  const personas = normalizeRoles(
    user.roles
      .filter((grant) => !grant.expiresAt || grant.expiresAt.getTime() > now)
      .map((grant) => grant.role.persona as Persona),
  );

  return {
    userId: user.id,
    organizationId: user.organizationId,
    employeeId: user.employee?.id,
    personas,
    sessionId: claims.sid,
    mfaSatisfied: claims.mfa,
  };
}

/**
 * One error for every reason a session is no longer valid. The client's only
 * correct response to any of them is the same: sign in again.
 */
function sessionEnded(): AppError {
  return new AppError(401, ERROR_CODES.SESSION_EXPIRED, 'Your session has expired. Sign in again.');
}

/** The principal, or a throw. For handlers that run behind `authenticate`. */
export function requirePrincipal(request: FastifyRequest): Principal {
  if (!request.principal) {
    throw new Error('Route is missing the authenticate guard');
  }
  return request.principal;
}
