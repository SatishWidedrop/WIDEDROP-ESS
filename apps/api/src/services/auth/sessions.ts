import { randomUUID } from 'node:crypto';
import { generateOpaqueToken, hashToken } from '../../lib/crypto.js';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';

/**
 * Refresh-token sessions.
 *
 * A session is a *family* of refresh tokens. Signing in mints the first; every
 * refresh rotates it, marking the old one used and issuing a child.
 *
 * That rotation is what makes theft detectable. A stolen token can be spent
 * once; when the legitimate client next refreshes with the token it still
 * holds, the server sees a token that was already rotated — which can only
 * happen if two parties hold tokens from one family. The whole family is
 * revoked, every access token in it dies at the next epoch check, and the
 * account owner is told.
 *
 * Only hashes are stored. A leaked database yields nothing that can be spent.
 */

export interface IssuedSession {
  /** The opaque refresh token. Returned once; only its hash is kept. */
  refreshToken: string;
  /** The family id, which is also the `sid` claim on every access token. */
  familyId: string;
  tokenId: string;
  expiresAt: Date;
}

export interface SessionContext {
  ip?: string | undefined;
  userAgent?: string | undefined;
  deviceLabel?: string | undefined;
}

export async function issueSession(
  tx: Tx,
  input: {
    organizationId: string;
    appUserId: string;
    ttlSeconds: number;
    context: SessionContext;
    /** Continues an existing family on rotation; omitted, a new one starts. */
    familyId?: string;
    parentId?: string;
  },
): Promise<IssuedSession> {
  const refreshToken = generateOpaqueToken();
  const familyId = input.familyId ?? randomUUID();
  const expiresAt = new Date(Date.now() + input.ttlSeconds * 1000);

  const created = await tx.refreshToken.create({
    data: {
      organizationId: input.organizationId,
      appUserId: input.appUserId,
      familyId,
      tokenHash: hashToken(refreshToken),
      parentId: input.parentId ?? null,
      expiresAt,
      ip: input.context.ip ?? null,
      userAgent: input.context.userAgent?.slice(0, 300) ?? null,
      deviceLabel: input.context.deviceLabel ?? null,
    },
    select: { id: true },
  });

  return { refreshToken, familyId, tokenId: created.id, expiresAt };
}

export type RefreshOutcome =
  | { kind: 'rotated'; session: IssuedSession; appUserId: string; organizationId: string }
  | { kind: 'reuse-detected'; appUserId: string; organizationId: string; familyId: string }
  | { kind: 'invalid' };

/**
 * Exchange a refresh token for a new one.
 *
 * Four outcomes, and the interesting one is the third:
 *   - unknown token            → invalid
 *   - expired or revoked token → invalid
 *   - *already rotated* token  → theft. Revoke the family.
 *   - live token               → rotate
 */
export async function rotateSession(
  tx: Tx,
  input: { refreshToken: string; ttlSeconds: number; context: SessionContext },
): Promise<RefreshOutcome> {
  const tokenHash = hashToken(input.refreshToken);

  const existing = await tx.refreshToken.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      appUserId: true,
      organizationId: true,
      familyId: true,
      expiresAt: true,
      rotatedAt: true,
      revokedAt: true,
    },
  });

  if (!existing) return { kind: 'invalid' };

  // A token that was already exchanged is being presented a second time. Either
  // it was stolen after use, or the legitimate holder is replaying the one it
  // still has after a thief used it. Both mean the family is compromised.
  if (existing.rotatedAt !== null) {
    await revokeFamily(tx, {
      familyId: existing.familyId,
      reason: 'refresh token reuse detected',
    });
    return {
      kind: 'reuse-detected',
      appUserId: existing.appUserId,
      organizationId: existing.organizationId,
      familyId: existing.familyId,
    };
  }

  if (existing.revokedAt !== null || existing.expiresAt.getTime() <= Date.now()) {
    return { kind: 'invalid' };
  }

  await tx.refreshToken.update({
    where: { id: existing.id },
    data: { rotatedAt: new Date() },
  });

  const session = await issueSession(tx, {
    organizationId: existing.organizationId,
    appUserId: existing.appUserId,
    ttlSeconds: input.ttlSeconds,
    context: input.context,
    familyId: existing.familyId,
    parentId: existing.id,
  });

  return {
    kind: 'rotated',
    session,
    appUserId: existing.appUserId,
    organizationId: existing.organizationId,
  };
}

/** Revoke every token in one family — one device signing out, or one theft. */
export async function revokeFamily(
  tx: Tx,
  input: { familyId: string; reason: string },
): Promise<number> {
  const result = await tx.refreshToken.updateMany({
    where: { familyId: input.familyId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: input.reason },
  });
  return result.count;
}

/**
 * Revoke every session a user has, everywhere.
 *
 * Bumps the token epoch in the same transaction, so access tokens already in
 * flight stop verifying immediately rather than living out their remaining
 * minutes.
 */
export async function revokeAllSessions(
  tx: Tx,
  input: { appUserId: string; organizationId: string; reason: string; hmacKey: string },
): Promise<{ revoked: number; tokenEpoch: number }> {
  const revoked = await tx.refreshToken.updateMany({
    where: { appUserId: input.appUserId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: input.reason },
  });

  const user = await tx.appUser.update({
    where: { id: input.appUserId },
    data: { tokenEpoch: { increment: 1 } },
    select: { tokenEpoch: true },
  });

  await recordAudit(
    tx,
    {
      organizationId: input.organizationId,
      action: 'LOGOUT',
      entityType: 'app_user',
      entityId: input.appUserId,
      summary: `All sessions revoked: ${input.reason}`,
      after: { revokedCount: revoked.count, tokenEpoch: user.tokenEpoch },
    },
    input.hmacKey,
  );

  return { revoked: revoked.count, tokenEpoch: user.tokenEpoch };
}

/** The sessions a user can see and sign out individually. */
export async function listSessions(
  tx: Tx,
  appUserId: string,
): Promise<
  {
    familyId: string;
    deviceLabel: string | null;
    ip: string | null;
    issuedAt: Date;
    expiresAt: Date;
  }[]
> {
  const tokens = await tx.refreshToken.findMany({
    where: { appUserId, revokedAt: null, rotatedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { issuedAt: 'desc' },
    select: { familyId: true, deviceLabel: true, ip: true, issuedAt: true, expiresAt: true },
    take: 50,
  });
  return tokens;
}

/**
 * Remove refresh tokens that expired long enough ago to be of no forensic use.
 * Run from the maintenance job, not on the request path.
 */
export async function pruneExpiredTokens(tx: Tx, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000);
  const result = await tx.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return result.count;
}

export function sessionExpiredError(): AppError {
  return new AppError(
    401,
    ERROR_CODES.SESSION_EXPIRED,
    'Your session has expired. Sign in again.',
  );
}

export function tokenReuseError(): AppError {
  return new AppError(
    401,
    ERROR_CODES.TOKEN_REUSE_DETECTED,
    'For your security, all sessions have been signed out. Sign in again.',
  );
}
