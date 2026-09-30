import { policyVersionMachine, toIsoDate } from '@widedrop/shared';
import type { EmploymentStatus } from '../../generated/prisma/index.js';
import { AppError, ERROR_CODES, conflict, notFound } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';
import { recordAudit } from '../audit.js';
import type { Principal } from '../auth/authorization.js';
import { notifyEmployee } from '../notifications.js';

/**
 * Policies.
 *
 * The requirement: version-controlled policies that an employee can read and
 * explicitly acknowledge, with employee, policy version, status and timestamp
 * stored. Three design decisions make that honest rather than approximate.
 *
 *  1. **A published version is never edited.** A change publishes a new
 *     version and supersedes the old one, so an acknowledgement always refers
 *     to text that still exists exactly as it was read.
 *
 *  2. **Applicability is resolved into rows at publication.** "12 of 340
 *     people still owe an acknowledgement" is a count of `policy_assignment`
 *     rows, not a rule evaluated at render time that could answer differently
 *     tomorrow.
 *
 *  3. **An acknowledgement is evidence.** It records when, from which address
 *     and with which user agent. It is written once and never reset: a new
 *     version creates a new row.
 */

/* ------------------------------------------------------------------ */
/* Acknowledgement                                                     */
/* ------------------------------------------------------------------ */

export async function acknowledgePolicyVersion(
  tx: Tx,
  principal: Principal,
  input: { policyVersionId: string; ip?: string | null; userAgent?: string | null },
  hmacKey: string,
): Promise<{ acknowledgedAt: Date }> {
  const employeeId = principal.employeeId;
  if (!employeeId) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'This account is not linked to an employee.');
  }

  const version = await tx.policyVersion.findFirst({
    where: {
      id: input.policyVersionId,
      organizationId: principal.organizationId,
      status: 'PUBLISHED',
    },
    select: {
      id: true,
      versionLabel: true,
      requiresAcknowledgement: true,
      policy: { select: { name: true } },
    },
  });

  // A superseded or withdrawn version cannot be acknowledged: the answer to
  // "did you read the current policy?" must not be satisfiable by an old one.
  if (!version) {
    throw new AppError(
      422,
      ERROR_CODES.POLICY_VERSION_SUPERSEDED,
      'That policy version is no longer current. Reload and acknowledge the current version.',
    );
  }

  if (!version.requiresAcknowledgement) {
    throw conflict('This policy does not ask for an acknowledgement.');
  }

  const existing = await tx.policyAcknowledgement.findUnique({
    where: {
      policyVersionId_employeeId: { policyVersionId: version.id, employeeId },
    },
    select: { id: true, status: true, acknowledgedAt: true },
  });

  if (!existing) {
    // No assignment means the policy does not apply to this person. Refusing
    // rather than creating one keeps the assignment table the single answer to
    // who a policy covers.
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'This policy has not been assigned to you.');
  }

  // Already acknowledged: return the original timestamp rather than moving it.
  // A repeated click must not rewrite when someone actually confirmed.
  if (existing.status === 'ACKNOWLEDGED' && existing.acknowledgedAt) {
    return { acknowledgedAt: existing.acknowledgedAt };
  }

  const acknowledgedAt = new Date();

  await tx.policyAcknowledgement.update({
    where: { id: existing.id },
    data: {
      status: 'ACKNOWLEDGED',
      acknowledgedAt,
      acknowledgedIp: input.ip ?? null,
      acknowledgedUserAgent: input.userAgent?.slice(0, 512) ?? null,
    },
  });

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'ACKNOWLEDGE',
      entityType: 'policy_acknowledgement',
      entityId: existing.id,
      fromState: existing.status,
      toState: 'ACKNOWLEDGED',
      after: {
        policyVersionId: version.id,
        versionLabel: version.versionLabel,
        acknowledgedAt: acknowledgedAt.toISOString(),
      },
      summary: `Acknowledged ${version.policy.name} ${version.versionLabel}`,
    },
    hmacKey,
  );

  return { acknowledgedAt };
}

/* ------------------------------------------------------------------ */
/* Publication                                                         */
/* ------------------------------------------------------------------ */

export interface PublicationResult {
  assigned: number;
  supersededVersionId: string | null;
}

/**
 * Publish a draft version.
 *
 * Resolves who it applies to, creates one assignment and one pending
 * acknowledgement per person, supersedes the previous published version, and
 * tells everyone affected. All in one transaction: a half-published policy
 * that some people can see and others cannot is worse than an unpublished one.
 */
export async function publishPolicyVersion(
  tx: Tx,
  principal: Principal,
  input: { policyVersionId: string },
  hmacKey: string,
): Promise<PublicationResult> {
  const version = await tx.policyVersion.findFirst({
    where: { id: input.policyVersionId, organizationId: principal.organizationId },
    select: {
      id: true,
      policyId: true,
      status: true,
      versionLabel: true,
      versionNumber: true,
      requiresAcknowledgement: true,
      acknowledgementDueDays: true,
      effectiveFrom: true,
      policy: { select: { id: true, name: true } },
      applicability: {
        select: { dimension: true, targetId: true, targetValue: true, isExclusion: true },
      },
    },
  });
  if (!version) throw notFound('That policy version');

  if (!policyVersionMachine.can(version.status, 'PUBLISH')) {
    throw conflict(
      `A ${version.status.toLowerCase().replace(/_/g, ' ')} version cannot be published.`,
      ERROR_CODES.INVALID_STATE_TRANSITION,
      { from: version.status },
    );
  }

  const audience = await resolveAudience(tx, principal.organizationId, version.applicability);

  if (audience.length === 0) {
    throw new AppError(
      422,
      ERROR_CODES.BUSINESS_RULE_VIOLATION,
      'This version applies to nobody. Add an applicability rule before publishing.',
    );
  }

  const publishedAt = new Date();
  const dueOn =
    version.requiresAcknowledgement && version.acknowledgementDueDays !== null
      ? new Date(
          Math.max(publishedAt.getTime(), version.effectiveFrom.getTime()) +
            version.acknowledgementDueDays * 86_400_000,
        )
      : null;

  // Supersede the version this one replaces, so exactly one version of a
  // policy is current at a time.
  const previous = await tx.policyVersion.findFirst({
    where: {
      policyId: version.policyId,
      status: 'PUBLISHED',
      id: { not: version.id },
    },
    select: { id: true },
  });

  if (previous) {
    await tx.policyVersion.update({
      where: { id: previous.id },
      data: {
        status: 'SUPERSEDED',
        supersededAt: publishedAt,
        supersededByVersionId: version.id,
        rowVersion: { increment: 1 },
      },
    });
  }

  await tx.policyVersion.update({
    where: { id: version.id },
    data: {
      status: 'PUBLISHED',
      publishedAt,
      publishedByUserId: principal.userId,
      rowVersion: { increment: 1 },
    },
  });

  await tx.policy.update({
    where: { id: version.policyId },
    data: { status: 'PUBLISHED' },
  });

  // `createMany` with `skipDuplicates` so republishing after a partial failure
  // converges rather than erroring on the rows that already exist.
  await tx.policyAssignment.createMany({
    data: audience.map((employeeId) => ({
      organizationId: principal.organizationId,
      policyVersionId: version.id,
      employeeId,
      assignedAt: publishedAt,
      dueOn,
    })),
    skipDuplicates: true,
  });

  if (version.requiresAcknowledgement) {
    await tx.policyAcknowledgement.createMany({
      data: audience.map((employeeId) => ({
        organizationId: principal.organizationId,
        policyVersionId: version.id,
        employeeId,
        status: 'PENDING' as const,
        dueOn,
      })),
      skipDuplicates: true,
    });

    for (const employeeId of audience) {
      await notifyEmployee(tx, {
        organizationId: principal.organizationId,
        employeeId,
        kind: 'POLICY_ASSIGNED',
        tone: 'AMBER',
        title: `${version.policy.name} ${version.versionLabel} needs your acknowledgement`,
        body: dueOn ? `Due ${toIsoDate(dueOn)}` : null,
        targetModule: 'policies',
        targetId: version.id,
        sourceType: 'policy_version',
        sourceId: version.id,
      });
    }
  }

  await recordAudit(
    tx,
    {
      organizationId: principal.organizationId,
      action: 'STATE_TRANSITION',
      entityType: 'policy_version',
      entityId: version.id,
      fromState: version.status,
      toState: 'PUBLISHED',
      after: {
        versionLabel: version.versionLabel,
        assigned: audience.length,
        supersededVersionId: previous?.id ?? null,
        dueOn: dueOn ? toIsoDate(dueOn) : null,
      },
      summary: `Published ${version.policy.name} ${version.versionLabel} to ${audience.length} ${audience.length === 1 ? 'person' : 'people'}`,
    },
    hmacKey,
  );

  return { assigned: audience.length, supersededVersionId: previous?.id ?? null };
}

/**
 * Who a version applies to.
 *
 * Inclusions union, then exclusions subtract. An empty rule set means nobody,
 * not everybody — a policy published by accident with no rules should reach no
 * one rather than the whole organisation.
 */
async function resolveAudience(
  tx: Tx,
  organizationId: string,
  rules: {
    dimension: string;
    targetId: string | null;
    targetValue: string | null;
    isExclusion: boolean;
  }[],
): Promise<string[]> {
  const included = new Set<string>();
  const excluded = new Set<string>();

  for (const rule of rules) {
    const matches = await employeesMatching(tx, organizationId, rule);
    const target = rule.isExclusion ? excluded : included;
    for (const id of matches) target.add(id);
  }

  return [...included].filter((id) => !excluded.has(id));
}

async function employeesMatching(
  tx: Tx,
  organizationId: string,
  rule: { dimension: string; targetId: string | null; targetValue: string | null },
): Promise<string[]> {
  // Only people who can actually read the policy are assigned one: a
  // pre-joining or exited record would inflate every "still to acknowledge"
  // count with people who cannot sign in.
  const base = {
    organizationId,
    employmentStatus: { in: ['ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD'] as EmploymentStatus[] },
  };

  switch (rule.dimension) {
    case 'ALL': {
      const rows = await tx.employee.findMany({ where: base, select: { id: true } });
      return rows.map((row) => row.id);
    }

    case 'DEPARTMENT': {
      if (!rule.targetId) return [];
      const rows = await tx.employee.findMany({
        where: {
          ...base,
          employments: { some: { departmentId: rule.targetId, effectiveTo: null } },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    case 'LOCATION': {
      if (!rule.targetId) return [];
      const rows = await tx.employee.findMany({
        where: {
          ...base,
          employments: { some: { locationId: rule.targetId, effectiveTo: null } },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    case 'EMPLOYMENT_TYPE': {
      if (!rule.targetValue) return [];
      const rows = await tx.employee.findMany({
        where: {
          ...base,
          employments: {
            some: {
              employmentType: rule.targetValue as never,
              effectiveTo: null,
            },
          },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    case 'DESIGNATION': {
      if (!rule.targetId) return [];
      const rows = await tx.employee.findMany({
        where: {
          ...base,
          employments: { some: { designationId: rule.targetId, effectiveTo: null } },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    case 'COST_CENTRE': {
      if (!rule.targetId) return [];
      const rows = await tx.employee.findMany({
        where: {
          ...base,
          employments: { some: { costCentreId: rule.targetId, effectiveTo: null } },
        },
        select: { id: true },
      });
      return rows.map((row) => row.id);
    }

    case 'EMPLOYEE':
      return rule.targetId ? [rule.targetId] : [];

    default:
      return [];
  }
}

/**
 * Mark overdue acknowledgements.
 *
 * A scheduled job rather than a render-time comparison: the Home screen's red
 * "overdue" tone reads a stored status, so what an employee sees and what a
 * compliance report counts cannot disagree.
 */
export async function markOverdueAcknowledgements(tx: Tx, organizationId: string): Promise<number> {
  const result = await tx.policyAcknowledgement.updateMany({
    where: {
      organizationId,
      status: 'PENDING',
      dueOn: { lt: new Date(toIsoDate(new Date())) },
    },
    data: { status: 'OVERDUE' },
  });
  return result.count;
}
