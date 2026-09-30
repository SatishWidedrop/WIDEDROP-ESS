#!/usr/bin/env node
/**
 * Generate `docs/RBAC.md` — who can do what, over whom.
 *
 * Generated rather than written, because a permission matrix in prose is a
 * permission matrix that is wrong. This repository already carries an example:
 * the design documents were written before the implementation and describe a
 * scheme with permissions like `payslip:read:any` and `approval:task:read:team`
 * — three segments, the scope folded into the name. What was built puts the
 * scope on a separate axis (`payslip:read-any` held at `ORG`), which is a
 * better design and a different vocabulary. Both are now in the repository, and
 * only one of them is enforced.
 *
 * So this reads `packages/shared/dist` — the module the API and the SPA both
 * import — and writes the matrix it actually contains. Run it after changing
 * roles.ts; CI runs it with `--check` and fails if the committed file has
 * drifted.
 *
 *   node scripts/gen-rbac-doc.mjs           # write docs/RBAC.md
 *   node scripts/gen-rbac-doc.mjs --check   # fail if it would change
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const repoRoot = new URL('../', import.meta.url);
const target = fileURLToPath(new URL('docs/RBAC.md', repoRoot));

const shared = await import(new URL('packages/shared/dist/index.js', repoRoot).href);
const {
  ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  ROLE_PERMISSIONS,
  PERMISSIONS,
  SCOPES,
  MFA_REQUIRED_ROLES,
  DIRECTORY_FIELDS,
  PROFILE_SECTION_SCOPE,
  ALWAYS_MASKED_SECTIONS,
  effectivePermissions,
} = shared;

/** `leave:decide` → `Leave`. The grouping the matrix is read in. */
const groupOf = (permission) => {
  const resource = permission.split(':')[0];
  return resource
    .split('-')
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
};

const groups = new Map();
for (const permission of PERMISSIONS) {
  const group = groupOf(permission);
  if (!groups.has(group)) groups.set(group, []);
  groups.get(group).push(permission);
}

const lines = [];
const w = (line = '') => lines.push(line);

w('<!--');
w('  GENERATED FILE — do not edit.');
w('');
w('  Written by scripts/gen-rbac-doc.mjs from packages/shared/src/rbac/roles.ts,');
w('  which is the only place these grants exist. Change the module and run');
w('  `npm run docs:rbac`; CI fails if this file has drifted from it.');
w('-->');
w();
w('# Roles and permissions');
w();
w('The authoritative answer to "who can do what, over whom", read out of the');
w('module the API enforces and the SPA renders from.');
w();
w('> **On the design documents.** `docs/API.md`, `docs/SECURITY.md` and');
w('> `docs/DATA-MODEL.md` were written before the implementation and use an');
w('> earlier vocabulary, in which the scope was folded into the permission name');
w('> — `payslip:read:any`, `approval:task:read:team`. What was built separates');
w('> the two: a permission names an action, and each role holds it *at a scope*.');
w('> Where they disagree, this file and `packages/shared/src/rbac/roles.ts` are');
w('> correct, and the permission type is a literal union, so a name from the');
w('> older scheme does not compile.');
w();
w('---');
w();

/* ------------------------------------------------------------------ */

w('## 1. The four personas');
w();
w('| Role | What it is |');
w('| ---- | ---------- |');
for (const role of ROLES) {
  w(`| **${ROLE_LABELS[role]}** | ${ROLE_DESCRIPTIONS[role]} |`);
}
w();
w('A person may hold more than one — an engineering manager who is also an HR');
w('business partner is one account with two roles — and their effective');
w('permissions are the union, with the scope of each resolved independently and');
w('the wider grant winning.');
w();
w('**Everyone holds `EMPLOYEE` implicitly.** A manager, an HR partner and an');
w('accountant all have their own payslips and leave.');
w();
w(
  `**${MFA_REQUIRED_ROLES.map((r) => ROLE_LABELS[r]).join(', ')} must complete two-factor ` +
    'enrolment** before their elevated permissions do anything. These accounts ' +
    "can read or move other people's money and records.",
);
w();

/* ------------------------------------------------------------------ */

w('## 2. Scope');
w();
w('Scope is resolved per permission, per request, against the resource actually');
w('being touched. It is never taken from the request body.');
w();
w('| Scope | Reaches |');
w('| ----- | ------- |');
const scopeMeaning = {
  SELF: 'The caller alone.',
  DIRECT_REPORTS: 'The people who report to them directly.',
  REPORTING_CHAIN: 'Everyone below them, at any depth.',
  DEPARTMENT: 'Everyone in their department.',
  ORG: 'Everyone in the organisation.',
};
for (const scope of SCOPES) {
  w(`| \`${scope}\` | ${scopeMeaning[scope] ?? ''} |`);
}
w();
w('Ordered widest-last: a wider grant absorbs a narrower one, which is how two');
w('roles combine without any special case.');
w();

// A scope nobody uses should say so rather than reading as though it were in
// force somewhere in the matrix below.
const usedScopes = new Set(ROLES.flatMap((role) => Object.values(ROLE_PERMISSIONS[role])));
const unused = SCOPES.filter((scope) => !usedScopes.has(scope));
if (unused.length > 0) {
  w(
    `${unused.map((s) => `\`${s}\``).join(' and ')} ${unused.length === 1 ? 'is' : 'are'} ` +
      'defined and resolved but held by no role today. The resolver supports ' +
      `${unused.length === 1 ? 'it' : 'them'} so a future grant is a one-line change ` +
      `rather than a new mechanism — but nothing in the matrix below uses ${
        unused.length === 1 ? 'it' : 'them'
      }.`,
  );
  w();
}

/* ------------------------------------------------------------------ */

w('## 3. The matrix');
w();
w('A blank cell is a denial. There is no implicit access and no administrator');
w('bypass — a permission absent from a role is absent.');
w();

const header = `| Permission | ${ROLES.map((r) => ROLE_LABELS[r]).join(' | ')} |`;
const divider = `| ---------- | ${ROLES.map(() => '---').join(' | ')} |`;

for (const [group, permissions] of groups) {
  w(`### ${group}`);
  w();
  w(header);
  w(divider);
  for (const permission of permissions) {
    const cells = ROLES.map((role) => {
      const scope = ROLE_PERMISSIONS[role][permission];
      return scope ? `\`${scope}\`` : '';
    });
    w(`| \`${permission}\` | ${cells.join(' | ')} |`);
  }
  w();
}

/* ------------------------------------------------------------------ */

w('## 4. What each persona ends up with');
w();
w('The union above, resolved — the list a session actually carries.');
w();
for (const role of ROLES) {
  const effective = effectivePermissions([role]);
  const entries = Object.entries(effective).sort(([a], [b]) => a.localeCompare(b));
  w(`### ${ROLE_LABELS[role]} (${entries.length} permissions)`);
  w();
  w('| Permission | Scope |');
  w('| ---------- | ----- |');
  for (const [permission, scope] of entries) {
    w(`| \`${permission}\` | \`${scope}\` |`);
  }
  w();
}

/* ------------------------------------------------------------------ */

w('## 5. Field-level exposure');
w();
w('A permission says whether a record may be read. These say which parts of it');
w('come back, whatever the caller holds.');
w();
w('### The directory');
w();
w('The only employee fields the directory ever returns:');
w();
w(DIRECTORY_FIELDS.map((f) => `\`${f}\``).join(', ') + '.');
w();
w('Personal contact details, addresses, dates of birth, and bank and statutory');
w('identifiers are not in that list and are not reachable through it.');
w();
w('### Profile sections');
w();
w('| Section | Scope needed to read it |');
w('| ------- | ----------------------- |');
for (const [section, scope] of Object.entries(PROFILE_SECTION_SCOPE)) {
  const masked = ALWAYS_MASKED_SECTIONS.includes(section) ? ' · **always masked**' : '';
  w(`| \`${section}\` | \`${scope}\`${masked} |`);
}
w();
w('A section marked always masked is masked even for its owner: the value is');
w('encrypted and is only ever needed for verification, never for display.');
w();

/* ------------------------------------------------------------------ */

w('## 6. Consequences worth stating');
w();
w('Some of these read as omissions and are decisions.');
w();
w(
  '- **No role holds `payslip:read` beyond `SELF`.** A manager cannot see a ' +
    "report's payslip. Accounts reads the register through `payslip:read-any`, " +
    'which is a different permission and is audited as an export.',
);
w(
  '- **Accounts does not hold `profile:read`.** Payroll needs bank and statutory ' +
    'fields, and gets them through the payroll surfaces alone — not through the ' +
    'HR profile screens.',
);
w(
  '- **HR holds `payroll-cycle:read` and nothing else in payroll.** They can see ' +
    'that a cycle exists and where it has got to, because their attendance ' +
    'submission is what it waits on. They cannot move it.',
);
w(
  '- **`audit:read` and `audit:verify` are held by HR and Accounts; nothing ' +
    'grants a write.** Proving the trail is intact is a control precisely ' +
    'because the people who can prove it cannot alter it.',
);
w(
  '- **A manager decides at `DIRECT_REPORTS` but reads at `REPORTING_CHAIN`.** ' +
    'They can see what is happening below them and approve only for the people ' +
    'who report to them directly.',
);
w();
w('---');
w();
w('_Generated from `packages/shared/src/rbac/roles.ts`. Run `npm run docs:rbac`._');
w();

const generated = lines.join('\n');

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('docs/RBAC.md is missing. Run `npm run docs:rbac`.');
    process.exit(1);
  }
  if (current !== generated) {
    console.error(
      'docs/RBAC.md has drifted from packages/shared/src/rbac/roles.ts.\n' +
        'Run `npm run docs:rbac` and commit the result.',
    );
    process.exit(1);
  }
  console.log('docs/RBAC.md matches the permission matrix.');
  process.exit(0);
}

writeFileSync(target, generated);
console.log(
  `wrote docs/RBAC.md (${ROLES.length} roles, ${PERMISSIONS.length} permissions, ${groups.size} groups)`,
);
