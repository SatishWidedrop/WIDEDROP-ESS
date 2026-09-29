import type { Persona } from '@widedrop/shared';
import type { ActorKind, AuditAction, Prisma } from '../generated/prisma/index.js';
import { GENESIS_HASH, sealAuditRow, verifyAuditChain } from '../lib/crypto.js';
import { redactValue } from '../lib/logger.js';
import { currentContext } from '../lib/request-context.js';
import type { Tx } from '../lib/prisma.js';

/**
 * The audit trail.
 *
 * Two properties make it worth having:
 *
 *  1. It is written in the same transaction as the change it records. If the
 *     audit row cannot be written, the change does not happen. There is no
 *     window in which something occurred and was not recorded.
 *
 *  2. It is hash-chained with a key the database never sees. Someone with write
 *     access can alter a row, but cannot recompute a valid chain, so the
 *     tampering is detectable by anyone who can run the verifier.
 *
 * Append-only is enforced by database triggers against UPDATE, DELETE and
 * TRUNCATE alike — see the integrity migration.
 */

export interface AuditInput {
  organizationId: string;
  action: AuditAction;
  entityType: string;
  entityId?: string | undefined;
  /** For a state transition: where it moved from and to. */
  fromState?: string | undefined;
  toState?: string | undefined;
  /** Before and after images. Sensitive fields are redacted before storage. */
  before?: unknown;
  after?: unknown;
  /** One line a person can read in the audit log. */
  summary?: string | undefined;
  /** Overrides the ambient request context, for system and scheduled work. */
  actor?: {
    kind: ActorKind;
    userId?: string | undefined;
    employeeId?: string | undefined;
    persona?: Persona | undefined;
  };
}

/**
 * Fields never written to the audit trail, even inside a before/after image.
 *
 * The trail records that a bank account changed and who changed it; it does not
 * become a second, unencrypted copy of the account number. Recording the value
 * would defeat the encryption it sits beside.
 */
const NEVER_AUDITED = new Set(
  [
    'passwordHash', 'password', 'currentPassword', 'newPassword',
    'secretCt', 'secretIv', 'secretTag', 'mfaSecret', 'totp', 'recoveryCode', 'codeHash',
    'tokenHash', 'refreshToken', 'accessToken',
    'accountNumberCt', 'accountNumberIv', 'accountNumberTag',
    'ifscCt', 'ifscIv', 'ifscTag',
    'valueCt', 'valueIv', 'valueTag',
    'personalEmailCt', 'personalEmailIv', 'personalEmailTag',
    'mobileCt', 'mobileIv', 'mobileTag',
    'currentAddressCt', 'currentAddressIv', 'currentAddressTag',
    'permanentAddressCt', 'permanentAddressIv', 'permanentAddressTag',
    'phoneCt', 'phoneIv', 'phoneTag',
    'wrappedKey', 'wrapIv', 'wrapTag',
  ].map((k) => k.toLowerCase()),
);

function auditSafe(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === undefined || value === null) return undefined;
  const stripped = strip(value, 0);
  return redactValue(stripped) as Prisma.InputJsonValue;
}

function strip(value: unknown, depth: number): unknown {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => strip(v, depth + 1));
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (NEVER_AUDITED.has(key.toLowerCase())) {
      // Record that the field was involved, never what it held.
      out[key] = '[not recorded]';
      continue;
    }
    if (Buffer.isBuffer(inner)) {
      out[key] = `[${inner.byteLength} bytes]`;
      continue;
    }
    out[key] = strip(inner, depth + 1);
  }
  return out;
}

/**
 * Write one audit row, linked to the previous one.
 *
 * `tx` must be the same transaction as the change being recorded. The row's
 * sequence comes from a database sequence and its `previousHash` from the last
 * row in the organisation, read `FOR UPDATE` so two concurrent writers cannot
 * both chain onto the same predecessor and fork the chain.
 */
export async function recordAudit(
  tx: Tx,
  input: AuditInput,
  hmacKey: string,
): Promise<{ id: string; sequence: bigint; rowHash: string }> {
  const context = currentContext();

  const actorKind: ActorKind = input.actor?.kind ?? (context?.userId ? 'USER' : 'SYSTEM');
  const actorUserId = input.actor?.userId ?? context?.userId;
  const actorEmployeeId = input.actor?.employeeId ?? context?.employeeId;
  const actorPersona = input.actor?.persona ?? context?.personas[0];

  // Serialise chain appends for this organisation for the rest of the
  // transaction. Without it, two transactions could read the same tail and
  // produce two rows claiming the same predecessor — forking the chain.
  //
  // The lock is transaction-scoped, so it is released on commit or rollback
  // without any cleanup path to forget.
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${'audit:' + input.organizationId}))
  `;

  const previous = await tx.auditEvent.findFirst({
    where: { organizationId: input.organizationId },
    orderBy: { sequence: 'desc' },
    select: { sequence: true, rowHash: true },
  });

  // The sequence is per organisation and contiguous, computed from the row
  // before it rather than from a database sequence. A database sequence would
  // leave a gap whenever a transaction rolled back or another tenant wrote a
  // row, and a gap has to mean something: it is how the deletion of the tail of
  // a chain is detected, which the hash links alone cannot catch.
  const sequence = (previous?.sequence ?? 0n) + 1n;

  const previousHash = previous?.rowHash ?? GENESIS_HASH;
  const occurredAt = new Date();

  const payload = {
    organizationId: input.organizationId,
    sequence: sequence.toString(),
    actorKind,
    actorUserId: actorUserId ?? null,
    actorEmployeeId: actorEmployeeId ?? null,
    actorPersona: actorPersona ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    fromState: input.fromState ?? null,
    toState: input.toState ?? null,
    beforeData: auditSafe(input.before) ?? null,
    afterData: auditSafe(input.after) ?? null,
    summary: input.summary ?? null,
    ip: context?.ip ?? null,
    userAgent: context?.userAgent ?? null,
    requestId: context?.requestId ?? null,
    occurredAt: occurredAt.toISOString(),
  };

  const rowHash = sealAuditRow({ previousHash, payload }, hmacKey);

  const created = await tx.auditEvent.create({
    data: {
      organizationId: input.organizationId,
      sequence,
      actorKind,
      actorUserId: actorUserId ?? null,
      actorEmployeeId: actorEmployeeId ?? null,
      actorPersona: actorPersona ?? null,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      fromState: input.fromState ?? null,
      toState: input.toState ?? null,
      beforeData: auditSafe(input.before),
      afterData: auditSafe(input.after),
      summary: input.summary ?? null,
      ip: context?.ip ?? null,
      userAgent: context?.userAgent ?? null,
      requestId: context?.requestId ?? null,
      occurredAt,
      previousHash,
      rowHash,
    },
    select: { id: true, sequence: true, rowHash: true },
  });

  return created;
}

/**
 * Rebuild the payload a stored row was sealed over.
 *
 * Kept next to `recordAudit` on purpose: if the two ever disagree about the
 * shape, verification fails loudly rather than silently passing.
 */
function payloadOf(row: {
  organizationId: string;
  sequence: bigint;
  actorKind: ActorKind;
  actorUserId: string | null;
  actorEmployeeId: string | null;
  actorPersona: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string | null;
  fromState: string | null;
  toState: string | null;
  beforeData: unknown;
  afterData: unknown;
  summary: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  occurredAt: Date;
}): unknown {
  return {
    organizationId: row.organizationId,
    sequence: row.sequence.toString(),
    actorKind: row.actorKind,
    actorUserId: row.actorUserId,
    actorEmployeeId: row.actorEmployeeId,
    actorPersona: row.actorPersona,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    fromState: row.fromState,
    toState: row.toState,
    beforeData: row.beforeData ?? null,
    afterData: row.afterData ?? null,
    summary: row.summary,
    ip: row.ip,
    userAgent: row.userAgent,
    requestId: row.requestId,
    occurredAt: row.occurredAt.toISOString(),
  };
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  from?: string;
  to?: string;
  brokenAt?: { id: string; sequence: string; reason: 'hash-mismatch' | 'link-mismatch' };
  /** Sequence numbers the chain skips. A gap means rows were removed. */
  gaps: string[];
}

/**
 * Verify a contiguous run of the chain.
 *
 * Checks three things: that each row's hash reproduces from its own content,
 * that each row links to its predecessor, and that the sequence has no gaps —
 * because deleting the tail of a chain leaves a valid-looking chain behind.
 */
export async function verifyChain(
  tx: Tx,
  input: { organizationId: string; fromSequence?: bigint; limit?: number },
  hmacKey: string,
): Promise<ChainVerification> {
  const limit = Math.min(input.limit ?? 1_000, 10_000);

  const rows = await tx.auditEvent.findMany({
    where: {
      organizationId: input.organizationId,
      ...(input.fromSequence !== undefined ? { sequence: { gte: input.fromSequence } } : {}),
    },
    orderBy: { sequence: 'asc' },
    take: limit,
  });

  if (rows.length === 0) return { valid: true, checked: 0, gaps: [] };

  const first = rows[0]!;
  // Starting mid-chain, the expected predecessor is the row before the first.
  const predecessor =
    input.fromSequence === undefined
      ? GENESIS_HASH
      : ((
          await tx.auditEvent.findFirst({
            where: { organizationId: input.organizationId, sequence: { lt: first.sequence } },
            orderBy: { sequence: 'desc' },
            select: { rowHash: true },
          })
        )?.rowHash ?? GENESIS_HASH);

  const result = verifyAuditChain(
    rows.map((row) => ({
      id: row.id,
      previousHash: row.previousHash,
      rowHash: row.rowHash,
      payload: payloadOf(row),
    })),
    hmacKey,
    predecessor,
  );

  const gaps: string[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const expected = rows[i - 1]!.sequence + 1n;
    for (let missing = expected; missing < rows[i]!.sequence; missing += 1n) {
      gaps.push(missing.toString());
      if (gaps.length >= 100) break;
    }
    if (gaps.length >= 100) break;
  }

  return {
    valid: result.valid && gaps.length === 0,
    checked: rows.length,
    from: first.sequence.toString(),
    to: rows[rows.length - 1]!.sequence.toString(),
    ...(result.brokenAt
      ? {
          brokenAt: {
            id: result.brokenAt.id,
            sequence: rows[result.brokenAt.index]!.sequence.toString(),
            reason: result.brokenAt.reason,
          },
        }
      : {}),
    gaps,
  };
}
