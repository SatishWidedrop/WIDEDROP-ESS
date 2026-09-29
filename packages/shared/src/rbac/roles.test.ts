import { describe, expect, it } from 'vitest';
import {
  DIRECTORY_FIELDS,
  PERMISSIONS,
  ROLES,
  ROLE_PERMISSIONS,
  effectivePermissions,
  hasPermission,
  hasPermissionAtScope,
  normalizeRoles,
  requiresMfa,
  scopeFor,
  scopeIncludes,
  widestScope,
  type Permission,
} from './roles.js';

describe('role normalisation', () => {
  it('gives every user the employee role implicitly', () => {
    expect(normalizeRoles(['HR'])).toEqual(['EMPLOYEE', 'HR']);
    expect(normalizeRoles([])).toEqual(['EMPLOYEE']);
  });

  it('deduplicates and orders consistently', () => {
    expect(normalizeRoles(['ACCOUNTS', 'EMPLOYEE', 'ACCOUNTS'])).toEqual(['EMPLOYEE', 'ACCOUNTS']);
  });
});

describe('scope resolution', () => {
  it('ranks scopes widest-last', () => {
    expect(widestScope(['SELF', 'ORG', 'DIRECT_REPORTS'])).toBe('ORG');
    expect(widestScope([])).toBeUndefined();
  });

  it('treats a wider grant as covering a narrower requirement', () => {
    expect(scopeIncludes('ORG', 'SELF')).toBe(true);
    expect(scopeIncludes('SELF', 'ORG')).toBe(false);
    expect(scopeIncludes('REPORTING_CHAIN', 'DIRECT_REPORTS')).toBe(true);
  });

  it('takes the widest scope across several roles', () => {
    expect(scopeFor(['EMPLOYEE'], 'leave:read')).toBe('SELF');
    expect(scopeFor(['MANAGER'], 'leave:read')).toBe('REPORTING_CHAIN');
    expect(scopeFor(['MANAGER', 'HR'], 'leave:read')).toBe('ORG');
  });
});

describe('deny by default', () => {
  it('denies an unheld permission', () => {
    expect(hasPermission(['EMPLOYEE'], 'payroll-cycle:generate')).toBe(false);
    expect(hasPermission(['MANAGER'], 'payroll-cycle:publish')).toBe(false);
    expect(hasPermission(['HR'], 'payroll-cycle:generate')).toBe(false);
    expect(hasPermission(['ACCOUNTS'], 'policy:administer')).toBe(false);
  });

  it('denies a held permission requested at too wide a scope', () => {
    expect(hasPermissionAtScope(['MANAGER'], 'leave:decide', 'DIRECT_REPORTS')).toBe(true);
    expect(hasPermissionAtScope(['MANAGER'], 'leave:decide', 'ORG')).toBe(false);
    expect(hasPermissionAtScope(['EMPLOYEE'], 'leave:read', 'DIRECT_REPORTS')).toBe(false);
  });
});

describe('separation of duties in the payroll pipeline', () => {
  it('lets only Accounts upload payroll inputs, validate, generate and publish', () => {
    const accountsOnly = [
      'payroll-input:upload',
      'payroll-cycle:validate',
      'payroll-cycle:generate',
      'payroll-cycle:publish',
      'payroll-cycle:create',
    ] as const satisfies readonly Permission[];

    for (const permission of accountsOnly) {
      expect(hasPermission(['ACCOUNTS'], permission)).toBe(true);
      expect(hasPermission(['EMPLOYEE'], permission)).toBe(false);
      expect(hasPermission(['MANAGER'], permission)).toBe(false);
      expect(hasPermission(['HR'], permission)).toBe(false);
    }
  });

  it('lets only HR submit attendance, and only a manager approve it', () => {
    expect(hasPermission(['HR'], 'attendance:submit')).toBe(true);
    expect(hasPermission(['ACCOUNTS'], 'attendance:submit')).toBe(false);
    expect(hasPermission(['MANAGER'], 'attendance:submit')).toBe(false);

    expect(hasPermission(['MANAGER'], 'attendance:approve')).toBe(true);
    expect(hasPermission(['HR'], 'attendance:approve')).toBe(false);
    expect(hasPermission(['ACCOUNTS'], 'attendance:approve')).toBe(false);
    expect(hasPermission(['EMPLOYEE'], 'attendance:approve')).toBe(false);
  });

  it('keeps a manager from approving beyond their direct reports', () => {
    expect(scopeFor(['MANAGER'], 'attendance:approve')).toBe('DIRECT_REPORTS');
    expect(scopeFor(['MANAGER'], 'expense:decide')).toBe('DIRECT_REPORTS');
  });
});

describe('least privilege over personal data', () => {
  it('does not give Accounts org-wide profile access', () => {
    expect(scopeFor(['ACCOUNTS'], 'profile:read')).toBe('SELF');
  });

  it('limits a manager to their reporting chain, not the organisation', () => {
    expect(scopeFor(['MANAGER'], 'profile:read')).toBe('REPORTING_CHAIN');
    expect(scopeFor(['MANAGER'], 'employee:read')).toBe('REPORTING_CHAIN');
  });

  it('never lets an employee read another employee’s payslip', () => {
    expect(scopeFor(['EMPLOYEE'], 'payslip:read')).toBe('SELF');
    expect(hasPermission(['EMPLOYEE'], 'payslip:read-any')).toBe(false);
    expect(hasPermission(['MANAGER'], 'payslip:read-any')).toBe(false);
    expect(hasPermission(['HR'], 'payslip:read-any')).toBe(false);
  });

  it('keeps the directory to work contact details only', () => {
    for (const forbidden of [
      'dateOfBirth',
      'personalEmail',
      'bankAccountNumber',
      'pan',
      'salary',
    ]) {
      expect(DIRECTORY_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('does not let any role write another employee’s emergency contacts', () => {
    expect(scopeFor(['HR'], 'emergency-contact:write')).toBe('SELF');
    expect(scopeFor(['MANAGER'], 'emergency-contact:write')).toBe('SELF');
  });
});

describe('effective permissions', () => {
  it('unions across roles, widening each permission independently', () => {
    const effective = effectivePermissions(['MANAGER', 'ACCOUNTS']);
    expect(effective['leave:decide']).toBe('DIRECT_REPORTS');
    expect(effective['payroll-cycle:publish']).toBe('ORG');
    expect(effective['expense:read']).toBe('ORG');
    expect(effective['policy:administer']).toBeUndefined();
  });

  it('gives a plain employee only self-scoped permissions plus the directory', () => {
    const effective = effectivePermissions(['EMPLOYEE']);
    const wider = Object.entries(effective).filter(([, scope]) => scope !== 'SELF');
    expect(wider).toEqual([['directory:read', 'ORG']]);
  });
});

describe('MFA', () => {
  it('requires MFA for every elevated role and not for a plain employee', () => {
    expect(requiresMfa(['EMPLOYEE'])).toBe(false);
    expect(requiresMfa(['MANAGER'])).toBe(true);
    expect(requiresMfa(['HR'])).toBe(true);
    expect(requiresMfa(['ACCOUNTS'])).toBe(true);
  });
});

describe('matrix integrity', () => {
  it('only references declared permissions', () => {
    const declared = new Set<string>(PERMISSIONS);
    for (const role of ROLES) {
      for (const permission of Object.keys(ROLE_PERMISSIONS[role])) {
        expect(declared.has(permission)).toBe(true);
      }
    }
  });

  it('grants every declared permission to at least one role', () => {
    const granted = new Set<string>();
    for (const role of ROLES) {
      for (const permission of Object.keys(ROLE_PERMISSIONS[role])) granted.add(permission);
    }
    expect([...PERMISSIONS].filter((p) => !granted.has(p))).toEqual([]);
  });
});
