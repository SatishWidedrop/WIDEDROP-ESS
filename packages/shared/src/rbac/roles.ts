/**
 * Roles and permissions.
 *
 * The portal has exactly four personas. A user may hold more than one — an
 * engineering manager who is also an HR business partner is one account with two
 * roles — and their effective permissions are the union, with the scope of each
 * permission resolved independently.
 *
 * This module is shared by the API and the web app, but it is authoritative only
 * on the server. The client uses it to decide what to render; the server uses it
 * to decide what to allow. A client that lies about its roles gets a 403.
 */

export const ROLES = ['EMPLOYEE', 'MANAGER', 'HR', 'ACCOUNTS'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  EMPLOYEE: 'Employee',
  MANAGER: 'Manager',
  HR: 'HR',
  ACCOUNTS: 'Accounts',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  EMPLOYEE: 'Their own pay, leave, benefits, expenses, documents and policies.',
  MANAGER: 'Everything an employee has, plus approvals and attendance for their reporting chain.',
  HR: 'People records, attendance submission, policies, announcements and documents across the organisation.',
  ACCOUNTS: 'Payroll cycles, payroll inputs, payslip generation and reimbursements.',
};

/**
 * How far a permission reaches.
 *
 * Scope is resolved per permission, per request, against the resource actually
 * being touched. It is never taken from the request body.
 */
export const SCOPES = ['SELF', 'DIRECT_REPORTS', 'REPORTING_CHAIN', 'DEPARTMENT', 'ORG'] as const;
export type Scope = (typeof SCOPES)[number];

/** Ordered widest-last, so a wider grant absorbs a narrower one. */
const SCOPE_RANK: Record<Scope, number> = {
  SELF: 0,
  DIRECT_REPORTS: 1,
  REPORTING_CHAIN: 2,
  DEPARTMENT: 3,
  ORG: 4,
};

export function widestScope(scopes: readonly Scope[]): Scope | undefined {
  return scopes.reduce<Scope | undefined>(
    (widest, s) => (widest === undefined || SCOPE_RANK[s] > SCOPE_RANK[widest] ? s : widest),
    undefined,
  );
}

export function scopeIncludes(granted: Scope, required: Scope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* ------------------------------------------------------------------ */

/**
 * Permission strings are `resource:action`. Every route declares the permission
 * it needs; there is no implicit access and no "admin bypass".
 */
export const PERMISSIONS = [
  // Profile & personal records
  'profile:read',
  'profile:request-change',
  'profile:write',
  'emergency-contact:write',

  // Directory
  'directory:read',

  // Leave
  'leave:read',
  'leave:request',
  'leave:withdraw',
  'leave:decide',
  'leave:administer',

  // Attendance
  'attendance:read',
  'attendance:record',
  'attendance:submit',
  'attendance:approve',

  // Payroll (Accounts)
  'payroll-cycle:read',
  'payroll-cycle:create',
  'payroll-input:upload',
  'payroll-cycle:validate',
  'payroll-cycle:generate',
  'payroll-cycle:publish',
  'payroll-cycle:cancel',

  // Payslips
  'payslip:read',
  'payslip:read-any',

  // Tax
  'tax:read',
  'tax:declare',
  'tax:administer',

  // Benefits
  'benefit:read',
  'benefit:enrol',
  'benefit:administer',

  // Expenses
  'expense:read',
  'expense:submit',
  'expense:withdraw',
  'expense:decide',
  'expense:reimburse',
  'expense:administer',

  // Documents & letters
  'document:read',
  'document:request',
  'document:issue',
  'document:administer',

  // Policies
  'policy:read',
  'policy:acknowledge',
  'policy:administer',

  // Announcements
  'announcement:read',
  'announcement:administer',

  // Help desk
  'ticket:read',
  'ticket:create',
  'ticket:comment',
  'ticket:administer',

  // Notifications
  'notification:read',

  // People administration
  'employee:read',
  'employee:write',
  'employee:invite',
  'employee:offboard',
  'role:assign',
  'org-structure:read',
  'org-structure:write',

  // Audit
  'audit:read',
  'audit:verify',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/**
 * The permission matrix. Each role maps a permission to the scope at which it
 * holds it. A permission absent from a role's map is denied — deny by default.
 *
 * Read this as the authoritative answer to "who can do what, over whom".
 */
export const ROLE_PERMISSIONS: Record<Role, Partial<Record<Permission, Scope>>> = {
  /* ---------------------------------------------------------------- */
  EMPLOYEE: {
    'profile:read': 'SELF',
    'profile:request-change': 'SELF',
    'emergency-contact:write': 'SELF',

    // The directory exposes only work contact details — see DIRECTORY_FIELDS.
    'directory:read': 'ORG',

    'leave:read': 'SELF',
    'leave:request': 'SELF',
    'leave:withdraw': 'SELF',

    'attendance:read': 'SELF',

    'payslip:read': 'SELF',
    'tax:read': 'SELF',
    'tax:declare': 'SELF',

    'benefit:read': 'SELF',
    'benefit:enrol': 'SELF',

    'expense:read': 'SELF',
    'expense:submit': 'SELF',
    'expense:withdraw': 'SELF',

    'document:read': 'SELF',
    'document:request': 'SELF',

    'policy:read': 'SELF',
    'policy:acknowledge': 'SELF',

    'announcement:read': 'SELF',

    'ticket:read': 'SELF',
    'ticket:create': 'SELF',
    'ticket:comment': 'SELF',

    'notification:read': 'SELF',
  },

  /* ---------------------------------------------------------------- */
  /* A manager holds every employee permission over themselves, plus   */
  /* these over the people who report to them.                         */
  MANAGER: {
    // Enough of a report's profile to manage them — never their bank,
    // statutory identifiers or pay. Field-level masking enforces this.
    'profile:read': 'REPORTING_CHAIN',

    'leave:read': 'REPORTING_CHAIN',
    'leave:decide': 'DIRECT_REPORTS',

    'attendance:read': 'REPORTING_CHAIN',
    'attendance:approve': 'DIRECT_REPORTS',

    'expense:read': 'REPORTING_CHAIN',
    'expense:decide': 'DIRECT_REPORTS',

    'employee:read': 'REPORTING_CHAIN',
  },

  /* ---------------------------------------------------------------- */
  HR: {
    'profile:read': 'ORG',
    'profile:write': 'ORG',

    'employee:read': 'ORG',
    'employee:write': 'ORG',
    'employee:invite': 'ORG',
    'employee:offboard': 'ORG',
    'role:assign': 'ORG',
    'org-structure:read': 'ORG',
    'org-structure:write': 'ORG',

    'leave:read': 'ORG',
    'leave:administer': 'ORG',

    'attendance:read': 'ORG',
    'attendance:record': 'ORG',
    'attendance:submit': 'ORG',

    'benefit:read': 'ORG',
    'benefit:administer': 'ORG',

    'document:read': 'ORG',
    'document:issue': 'ORG',
    'document:administer': 'ORG',

    'policy:administer': 'ORG',
    'announcement:administer': 'ORG',

    'ticket:read': 'ORG',
    'ticket:administer': 'ORG',

    // HR sees that a cycle exists and where it is, so they know when their
    // attendance submission is due. They cannot move it.
    'payroll-cycle:read': 'ORG',

    // Reading the trail and proving it has not been tampered with are the
    // compliance half of HR's job; neither permits writing to it.
    'audit:read': 'ORG',
    'audit:verify': 'ORG',
  },

  /* ---------------------------------------------------------------- */
  /* Accounts drives payroll. They deliberately do NOT get             */
  /* `profile:read` at org scope — payroll needs bank and statutory    */
  /* fields, which are exposed through the payroll surfaces alone, not */
  /* through the HR profile screens.                                   */
  ACCOUNTS: {
    'payroll-cycle:read': 'ORG',
    'payroll-cycle:create': 'ORG',
    'payroll-input:upload': 'ORG',
    'payroll-cycle:validate': 'ORG',
    'payroll-cycle:generate': 'ORG',
    'payroll-cycle:publish': 'ORG',
    'payroll-cycle:cancel': 'ORG',

    'payslip:read-any': 'ORG',

    'attendance:read': 'ORG',

    'tax:administer': 'ORG',

    'expense:read': 'ORG',
    'expense:reimburse': 'ORG',
    'expense:administer': 'ORG',

    'employee:read': 'ORG',
    'org-structure:read': 'ORG',

    // A financial control: Accounts can prove the payroll trail is intact
    // without being able to alter it.
    'audit:read': 'ORG',
    'audit:verify': 'ORG',
  },
};

/**
 * Roles that must complete MFA enrolment before they can use their elevated
 * permissions. These accounts can read or move other people's money and records.
 */
export const MFA_REQUIRED_ROLES: readonly Role[] = ['MANAGER', 'HR', 'ACCOUNTS'];

export function requiresMfa(roles: readonly Role[]): boolean {
  return roles.some((r) => MFA_REQUIRED_ROLES.includes(r));
}

/* ------------------------------------------------------------------ */
/* Resolution                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every user holds EMPLOYEE implicitly: a manager, an HR partner and an
 * accountant are all employees with their own payslips and leave.
 */
export function normalizeRoles(roles: readonly Role[]): Role[] {
  const set = new Set<Role>(roles);
  set.add('EMPLOYEE');
  return ROLES.filter((r) => set.has(r));
}

/**
 * The widest scope at which `roles` hold `permission`, or `undefined` when none
 * of them hold it at all.
 */
export function scopeFor(roles: readonly Role[], permission: Permission): Scope | undefined {
  const granted: Scope[] = [];
  for (const role of normalizeRoles(roles)) {
    const scope = ROLE_PERMISSIONS[role][permission];
    if (scope) granted.push(scope);
  }
  return widestScope(granted);
}

export function hasPermission(roles: readonly Role[], permission: Permission): boolean {
  return scopeFor(roles, permission) !== undefined;
}

/** True when `roles` hold `permission` at least as widely as `required`. */
export function hasPermissionAtScope(
  roles: readonly Role[],
  permission: Permission,
  required: Scope,
): boolean {
  const granted = scopeFor(roles, permission);
  return granted !== undefined && scopeIncludes(granted, required);
}

/** Every permission the roles hold, with its widest scope. Used to build a session. */
export function effectivePermissions(roles: readonly Role[]): Partial<Record<Permission, Scope>> {
  const out: Partial<Record<Permission, Scope>> = {};
  for (const role of normalizeRoles(roles)) {
    for (const [permission, scope] of Object.entries(ROLE_PERMISSIONS[role]) as [
      Permission,
      Scope,
    ][]) {
      const current = out[permission];
      out[permission] = current ? (widestScope([current, scope]) ?? scope) : scope;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Field-level exposure                                                */
/* ------------------------------------------------------------------ */

/**
 * The only employee fields the directory ever returns, whatever the caller's
 * role. Personal contact details, addresses, dates of birth, bank and statutory
 * identifiers are not in this list and are not reachable through it.
 */
export const DIRECTORY_FIELDS = [
  'id',
  'employeeCode',
  'fullName',
  'designation',
  'department',
  'location',
  'workEmail',
  'workPhone',
  'managerId',
  'avatarInitials',
] as const;

/** Profile sections, and the scope a caller needs to read each one. */
export const PROFILE_SECTION_SCOPE = {
  /** Name, date of birth, personal contact details, addresses. */
  personal: 'SELF',
  /** Designation, department, manager, joining date, work contact. */
  employment: 'REPORTING_CHAIN',
  /** Bank account, PAN, Aadhaar, UAN, PF, tax regime — always masked on read. */
  bank: 'SELF',
  /** Emergency contacts: the employee, their manager and HR. */
  emergency: 'REPORTING_CHAIN',
} as const satisfies Record<string, Scope>;

export type ProfileSection = keyof typeof PROFILE_SECTION_SCOPE;

/**
 * Sections that are returned masked even to the owner, because the underlying
 * value is encrypted and only ever needed for verification, not for display.
 */
export const ALWAYS_MASKED_SECTIONS: readonly ProfileSection[] = ['bank'];
