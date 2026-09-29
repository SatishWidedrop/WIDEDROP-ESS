import {
  hasPermissionAtScope,
  scopeFor,
  type Permission,
  type Persona,
  type Scope,
} from '@widedrop/shared';
import { AppError, ERROR_CODES } from '../../lib/errors.js';
import type { Tx } from '../../lib/prisma.js';

/**
 * Authorization.
 *
 * Two questions, asked in order, on every request:
 *
 *   1. Do these roles hold this permission at all?      — the permission matrix
 *   2. Does their scope reach this particular record?   — this module
 *
 * The second question is the one that matters. A manager holds `leave:read`;
 * that does not mean they may read *anyone's* leave. Scope is always resolved
 * against the resource being touched, never against anything the client sent.
 */

export interface Principal {
  userId: string;
  organizationId: string;
  employeeId?: string | undefined;
  personas: Persona[];
  /** Session id, for audit and for revocation. */
  sessionId: string;
  mfaSatisfied: boolean;
}

/** Deny by default: no permission, no access, no explanation of what exists. */
export function assertPermission(
  principal: Principal,
  permission: Permission,
  required: Scope = 'SELF',
): Scope {
  const granted = scopeFor(principal.personas, permission);
  if (!granted || !hasPermissionAtScope(principal.personas, permission, required)) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN, 'You do not have access to this.', {
      meta: { permission, required, personas: principal.personas },
    });
  }
  return granted;
}

export function can(principal: Principal, permission: Permission, required: Scope = 'SELF'): boolean {
  return hasPermissionAtScope(principal.personas, permission, required);
}

/**
 * The set of employees a principal may reach for one permission.
 *
 * Returned as a Prisma `where` fragment rather than a list of ids, so the scope
 * becomes part of the query the database runs. A caller cannot forget to apply
 * it after the fact, and a large organisation does not load ten thousand ids to
 * filter in memory.
 */
export type EmployeeScopeFilter =
  | { kind: 'none' }
  | { kind: 'self'; employeeId: string }
  | { kind: 'chain'; ancestorEmployeeId: string; includeSelf: boolean; maxDepth?: number }
  | { kind: 'department'; departmentIds: string[] }
  | { kind: 'organization'; organizationId: string };

export async function employeeScopeFor(
  tx: Tx,
  principal: Principal,
  permission: Permission,
): Promise<EmployeeScopeFilter> {
  const scope = scopeFor(principal.personas, permission);
  if (!scope) return { kind: 'none' };

  switch (scope) {
    case 'SELF':
      return principal.employeeId
        ? { kind: 'self', employeeId: principal.employeeId }
        : { kind: 'none' };

    case 'DIRECT_REPORTS':
      return principal.employeeId
        ? { kind: 'chain', ancestorEmployeeId: principal.employeeId, includeSelf: false, maxDepth: 1 }
        : { kind: 'none' };

    case 'REPORTING_CHAIN':
      return principal.employeeId
        ? { kind: 'chain', ancestorEmployeeId: principal.employeeId, includeSelf: true }
        : { kind: 'none' };

    case 'DEPARTMENT': {
      if (!principal.employeeId) return { kind: 'none' };
      const employment = await tx.employeeEmployment.findFirst({
        where: { employeeId: principal.employeeId, effectiveTo: null },
        select: { departmentId: true },
      });
      return employment
        ? { kind: 'department', departmentIds: [employment.departmentId] }
        : { kind: 'none' };
    }

    case 'ORG':
      return { kind: 'organization', organizationId: principal.organizationId };
  }
}

/**
 * The closure depths a chain filter covers.
 *
 * Built as one object rather than two merged fragments: spreading
 * `{ depth: {...} }` twice silently drops the first, which once let a manager
 * decide for a skip-level report because the upper bound was overwritten by the
 * lower one.
 */
function depthBounds(filter: {
  includeSelf: boolean;
  maxDepth?: number | undefined;
}): { gte: number; lte?: number } {
  const bounds: { gte: number; lte?: number } = { gte: filter.includeSelf ? 0 : 1 };
  if (filter.maxDepth !== undefined) bounds.lte = filter.maxDepth;
  return bounds;
}

/**
 * Translate a scope into a Prisma filter on `employeeId`.
 *
 * The reporting chain is resolved through the materialised closure table, so a
 * scope check is one indexed lookup rather than a recursive query on every
 * request.
 */
export function employeeWhere(filter: EmployeeScopeFilter): Record<string, unknown> {
  switch (filter.kind) {
    case 'none':
      // Matches nothing. Deliberately a filter rather than a throw, so a list
      // endpoint returns an empty page instead of confirming that rows exist.
      return { employeeId: { in: [] } };

    case 'self':
      return { employeeId: filter.employeeId };

    case 'chain':
      return {
        employee: {
          ancestorClosure: {
            some: {
              ancestorEmployeeId: filter.ancestorEmployeeId,
              depth: depthBounds(filter),
            },
          },
        },
      };

    case 'department':
      return {
        employee: {
          employments: { some: { departmentId: { in: filter.departmentIds }, effectiveTo: null } },
        },
      };

    case 'organization':
      return { organizationId: filter.organizationId };
  }
}

/**
 * Confirm a principal may act on one named employee.
 *
 * Used before a single-record read or write, where a `where` fragment is not
 * enough. Raises the uniform "out of scope" error, which does not reveal
 * whether the employee exists.
 */
export async function assertEmployeeInScope(
  tx: Tx,
  principal: Principal,
  permission: Permission,
  employeeId: string,
): Promise<void> {
  const filter = await employeeScopeFor(tx, principal, permission);

  switch (filter.kind) {
    case 'none':
      throw new AppError(403, ERROR_CODES.FORBIDDEN, 'You do not have access to this.', {
        meta: { permission },
      });

    case 'self':
      if (filter.employeeId !== employeeId) throw outOfScope(permission, employeeId);
      return;

    case 'chain': {
      const link = await tx.employeeReportingClosure.findFirst({
        where: {
          ancestorEmployeeId: filter.ancestorEmployeeId,
          descendantEmployeeId: employeeId,
          depth: depthBounds(filter),
        },
        select: { depth: true },
      });
      if (!link) throw outOfScope(permission, employeeId);
      return;
    }

    case 'department': {
      const employment = await tx.employeeEmployment.findFirst({
        where: {
          employeeId,
          effectiveTo: null,
          departmentId: { in: filter.departmentIds },
        },
        select: { id: true },
      });
      if (!employment) throw outOfScope(permission, employeeId);
      return;
    }

    case 'organization': {
      const employee = await tx.employee.findFirst({
        where: { id: employeeId, organizationId: filter.organizationId },
        select: { id: true },
      });
      if (!employee) throw outOfScope(permission, employeeId);
      return;
    }
  }
}

function outOfScope(permission: Permission, employeeId: string): AppError {
  return new AppError(
    403,
    ERROR_CODES.OUT_OF_SCOPE,
    'This record is outside the people you manage.',
    { meta: { permission, employeeId } },
  );
}

/**
 * Confirm a record belongs to the principal's organisation.
 *
 * Every query is already scoped by organisation; this is the check that catches
 * an id from another tenant arriving in a path parameter — the classic
 * insecure-direct-object-reference. It reports "not found", not "forbidden",
 * because the caller should not learn that the record exists elsewhere.
 */
export function assertSameOrganization(
  principal: Principal,
  record: { organizationId: string } | null,
  what = 'The requested record',
): asserts record is { organizationId: string } {
  if (!record || record.organizationId !== principal.organizationId) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, `${what} could not be found.`);
  }
}

/**
 * Rebuild the reporting closure for an organisation.
 *
 * Called in the same transaction as any change to `employee_manager`, so the
 * table that authorization depends on is never stale. A cycle in the reporting
 * graph would make this loop forever, so depth is bounded and a cycle is an
 * error rather than a hang.
 */
export async function rebuildReportingClosure(
  tx: Tx,
  organizationId: string,
  maxDepth = 20,
): Promise<number> {
  await tx.$executeRaw`
    DELETE FROM ess.employee_reporting_closure WHERE organization_id = ${organizationId}::uuid
  `;

  const inserted = await tx.$executeRaw`
    WITH RECURSIVE chain AS (
      SELECT e.organization_id,
             e.id AS ancestor_employee_id,
             e.id AS descendant_employee_id,
             0::smallint AS depth
        FROM ess.employee e
       WHERE e.organization_id = ${organizationId}::uuid

      UNION ALL

      SELECT c.organization_id,
             c.ancestor_employee_id,
             m.employee_id AS descendant_employee_id,
             (c.depth + 1)::smallint AS depth
        FROM chain c
        JOIN ess.employee_manager m
          ON m.manager_employee_id = c.descendant_employee_id
         AND m.organization_id = c.organization_id
         AND m.is_primary
         AND m.effective_to IS NULL
       WHERE c.depth < ${maxDepth}
    )
    INSERT INTO ess.employee_reporting_closure
      (organization_id, ancestor_employee_id, descendant_employee_id, depth)
    SELECT DISTINCT ON (ancestor_employee_id, descendant_employee_id)
           organization_id, ancestor_employee_id, descendant_employee_id, depth
      FROM chain
     ORDER BY ancestor_employee_id, descendant_employee_id, depth
  `;

  return inserted;
}
