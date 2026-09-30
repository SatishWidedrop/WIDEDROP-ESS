<!--
  GENERATED FILE — do not edit.

  Written by scripts/gen-rbac-doc.mjs from packages/shared/src/rbac/roles.ts,
  which is the only place these grants exist. Change the module and run
  `npm run docs:rbac`; CI fails if this file has drifted from it.
-->

# Roles and permissions

The authoritative answer to "who can do what, over whom", read out of the
module the API enforces and the SPA renders from.

> **On the design documents.** `docs/API.md`, `docs/SECURITY.md` and
> `docs/DATA-MODEL.md` were written before the implementation and use an
> earlier vocabulary, in which the scope was folded into the permission name
> — `payslip:read:any`, `approval:task:read:team`. What was built separates
> the two: a permission names an action, and each role holds it *at a scope*.
> Where they disagree, this file and `packages/shared/src/rbac/roles.ts` are
> correct, and the permission type is a literal union, so a name from the
> older scheme does not compile.

---

## 1. The four personas

| Role | What it is |
| ---- | ---------- |
| **Employee** | Their own pay, leave, benefits, expenses, documents and policies. |
| **Manager** | Everything an employee has, plus approvals and attendance for their reporting chain. |
| **HR** | People records, attendance submission, policies, announcements and documents across the organisation. |
| **Accounts** | Payroll cycles, payroll inputs, payslip generation and reimbursements. |

A person may hold more than one — an engineering manager who is also an HR
business partner is one account with two roles — and their effective
permissions are the union, with the scope of each resolved independently and
the wider grant winning.

**Everyone holds `EMPLOYEE` implicitly.** A manager, an HR partner and an
accountant all have their own payslips and leave.

**Manager, HR, Accounts must complete two-factor enrolment** before their elevated permissions do anything. These accounts can read or move other people's money and records.

## 2. Scope

Scope is resolved per permission, per request, against the resource actually
being touched. It is never taken from the request body.

| Scope | Reaches |
| ----- | ------- |
| `SELF` | The caller alone. |
| `DIRECT_REPORTS` | The people who report to them directly. |
| `REPORTING_CHAIN` | Everyone below them, at any depth. |
| `DEPARTMENT` | Everyone in their department. |
| `ORG` | Everyone in the organisation. |

Ordered widest-last: a wider grant absorbs a narrower one, which is how two
roles combine without any special case.

`DEPARTMENT` is defined and resolved but held by no role today. The resolver supports it so a future grant is a one-line change rather than a new mechanism — but nothing in the matrix below uses it.

## 3. The matrix

A blank cell is a denial. There is no implicit access and no administrator
bypass — a permission absent from a role is absent.

### Profile

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `profile:read` | `SELF` | `REPORTING_CHAIN` | `ORG` |  |
| `profile:request-change` | `SELF` |  |  |  |
| `profile:write` |  |  | `ORG` |  |

### Emergency Contact

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `emergency-contact:write` | `SELF` |  |  |  |

### Directory

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `directory:read` | `ORG` |  |  |  |

### Leave

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `leave:read` | `SELF` | `REPORTING_CHAIN` | `ORG` |  |
| `leave:request` | `SELF` |  |  |  |
| `leave:withdraw` | `SELF` |  |  |  |
| `leave:decide` |  | `DIRECT_REPORTS` |  |  |
| `leave:administer` |  |  | `ORG` |  |

### Attendance

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `attendance:read` | `SELF` | `REPORTING_CHAIN` | `ORG` | `ORG` |
| `attendance:record` |  |  | `ORG` |  |
| `attendance:submit` |  |  | `ORG` |  |
| `attendance:approve` |  | `DIRECT_REPORTS` |  |  |

### Payroll Cycle

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `payroll-cycle:read` |  |  | `ORG` | `ORG` |
| `payroll-cycle:create` |  |  |  | `ORG` |
| `payroll-cycle:validate` |  |  |  | `ORG` |
| `payroll-cycle:generate` |  |  |  | `ORG` |
| `payroll-cycle:publish` |  |  |  | `ORG` |
| `payroll-cycle:cancel` |  |  |  | `ORG` |

### Payroll Input

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `payroll-input:upload` |  |  |  | `ORG` |

### Payslip

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `payslip:read` | `SELF` |  |  |  |
| `payslip:read-any` |  |  |  | `ORG` |

### Tax

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `tax:read` | `SELF` |  |  |  |
| `tax:declare` | `SELF` |  |  |  |
| `tax:administer` |  |  |  | `ORG` |

### Benefit

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `benefit:read` | `SELF` |  | `ORG` |  |
| `benefit:enrol` | `SELF` |  |  |  |
| `benefit:administer` |  |  | `ORG` |  |

### Expense

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `expense:read` | `SELF` | `REPORTING_CHAIN` |  | `ORG` |
| `expense:submit` | `SELF` |  |  |  |
| `expense:withdraw` | `SELF` |  |  |  |
| `expense:decide` |  | `DIRECT_REPORTS` |  |  |
| `expense:reimburse` |  |  |  | `ORG` |
| `expense:administer` |  |  |  | `ORG` |

### Document

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `document:read` | `SELF` |  | `ORG` |  |
| `document:request` | `SELF` |  |  |  |
| `document:issue` |  |  | `ORG` |  |
| `document:administer` |  |  | `ORG` |  |

### Policy

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `policy:read` | `SELF` |  |  |  |
| `policy:acknowledge` | `SELF` |  |  |  |
| `policy:administer` |  |  | `ORG` |  |

### Announcement

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `announcement:read` | `SELF` |  |  |  |
| `announcement:administer` |  |  | `ORG` |  |

### Ticket

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `ticket:read` | `SELF` |  | `ORG` |  |
| `ticket:create` | `SELF` |  |  |  |
| `ticket:comment` | `SELF` |  |  |  |
| `ticket:administer` |  |  | `ORG` |  |

### Notification

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `notification:read` | `SELF` |  |  |  |

### Employee

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `employee:read` |  | `REPORTING_CHAIN` | `ORG` | `ORG` |
| `employee:write` |  |  | `ORG` |  |
| `employee:invite` |  |  | `ORG` |  |
| `employee:offboard` |  |  | `ORG` |  |

### Role

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `role:assign` |  |  | `ORG` |  |

### Org Structure

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `org-structure:read` |  |  | `ORG` | `ORG` |
| `org-structure:write` |  |  | `ORG` |  |

### Audit

| Permission | Employee | Manager | HR | Accounts |
| ---------- | --- | --- | --- | --- |
| `audit:read` |  |  | `ORG` | `ORG` |
| `audit:verify` |  |  | `ORG` | `ORG` |

## 4. What each persona ends up with

The union above, resolved — the list a session actually carries.

### Employee (25 permissions)

| Permission | Scope |
| ---------- | ----- |
| `announcement:read` | `SELF` |
| `attendance:read` | `SELF` |
| `benefit:enrol` | `SELF` |
| `benefit:read` | `SELF` |
| `directory:read` | `ORG` |
| `document:read` | `SELF` |
| `document:request` | `SELF` |
| `emergency-contact:write` | `SELF` |
| `expense:read` | `SELF` |
| `expense:submit` | `SELF` |
| `expense:withdraw` | `SELF` |
| `leave:read` | `SELF` |
| `leave:request` | `SELF` |
| `leave:withdraw` | `SELF` |
| `notification:read` | `SELF` |
| `payslip:read` | `SELF` |
| `policy:acknowledge` | `SELF` |
| `policy:read` | `SELF` |
| `profile:read` | `SELF` |
| `profile:request-change` | `SELF` |
| `tax:declare` | `SELF` |
| `tax:read` | `SELF` |
| `ticket:comment` | `SELF` |
| `ticket:create` | `SELF` |
| `ticket:read` | `SELF` |

### Manager (29 permissions)

| Permission | Scope |
| ---------- | ----- |
| `announcement:read` | `SELF` |
| `attendance:approve` | `DIRECT_REPORTS` |
| `attendance:read` | `REPORTING_CHAIN` |
| `benefit:enrol` | `SELF` |
| `benefit:read` | `SELF` |
| `directory:read` | `ORG` |
| `document:read` | `SELF` |
| `document:request` | `SELF` |
| `emergency-contact:write` | `SELF` |
| `employee:read` | `REPORTING_CHAIN` |
| `expense:decide` | `DIRECT_REPORTS` |
| `expense:read` | `REPORTING_CHAIN` |
| `expense:submit` | `SELF` |
| `expense:withdraw` | `SELF` |
| `leave:decide` | `DIRECT_REPORTS` |
| `leave:read` | `REPORTING_CHAIN` |
| `leave:request` | `SELF` |
| `leave:withdraw` | `SELF` |
| `notification:read` | `SELF` |
| `payslip:read` | `SELF` |
| `policy:acknowledge` | `SELF` |
| `policy:read` | `SELF` |
| `profile:read` | `REPORTING_CHAIN` |
| `profile:request-change` | `SELF` |
| `tax:declare` | `SELF` |
| `tax:read` | `SELF` |
| `ticket:comment` | `SELF` |
| `ticket:create` | `SELF` |
| `ticket:read` | `SELF` |

### HR (45 permissions)

| Permission | Scope |
| ---------- | ----- |
| `announcement:administer` | `ORG` |
| `announcement:read` | `SELF` |
| `attendance:read` | `ORG` |
| `attendance:record` | `ORG` |
| `attendance:submit` | `ORG` |
| `audit:read` | `ORG` |
| `audit:verify` | `ORG` |
| `benefit:administer` | `ORG` |
| `benefit:enrol` | `SELF` |
| `benefit:read` | `ORG` |
| `directory:read` | `ORG` |
| `document:administer` | `ORG` |
| `document:issue` | `ORG` |
| `document:read` | `ORG` |
| `document:request` | `SELF` |
| `emergency-contact:write` | `SELF` |
| `employee:invite` | `ORG` |
| `employee:offboard` | `ORG` |
| `employee:read` | `ORG` |
| `employee:write` | `ORG` |
| `expense:read` | `SELF` |
| `expense:submit` | `SELF` |
| `expense:withdraw` | `SELF` |
| `leave:administer` | `ORG` |
| `leave:read` | `ORG` |
| `leave:request` | `SELF` |
| `leave:withdraw` | `SELF` |
| `notification:read` | `SELF` |
| `org-structure:read` | `ORG` |
| `org-structure:write` | `ORG` |
| `payroll-cycle:read` | `ORG` |
| `payslip:read` | `SELF` |
| `policy:acknowledge` | `SELF` |
| `policy:administer` | `ORG` |
| `policy:read` | `SELF` |
| `profile:read` | `ORG` |
| `profile:request-change` | `SELF` |
| `profile:write` | `ORG` |
| `role:assign` | `ORG` |
| `tax:declare` | `SELF` |
| `tax:read` | `SELF` |
| `ticket:administer` | `ORG` |
| `ticket:comment` | `SELF` |
| `ticket:create` | `SELF` |
| `ticket:read` | `ORG` |

### Accounts (40 permissions)

| Permission | Scope |
| ---------- | ----- |
| `announcement:read` | `SELF` |
| `attendance:read` | `ORG` |
| `audit:read` | `ORG` |
| `audit:verify` | `ORG` |
| `benefit:enrol` | `SELF` |
| `benefit:read` | `SELF` |
| `directory:read` | `ORG` |
| `document:read` | `SELF` |
| `document:request` | `SELF` |
| `emergency-contact:write` | `SELF` |
| `employee:read` | `ORG` |
| `expense:administer` | `ORG` |
| `expense:read` | `ORG` |
| `expense:reimburse` | `ORG` |
| `expense:submit` | `SELF` |
| `expense:withdraw` | `SELF` |
| `leave:read` | `SELF` |
| `leave:request` | `SELF` |
| `leave:withdraw` | `SELF` |
| `notification:read` | `SELF` |
| `org-structure:read` | `ORG` |
| `payroll-cycle:cancel` | `ORG` |
| `payroll-cycle:create` | `ORG` |
| `payroll-cycle:generate` | `ORG` |
| `payroll-cycle:publish` | `ORG` |
| `payroll-cycle:read` | `ORG` |
| `payroll-cycle:validate` | `ORG` |
| `payroll-input:upload` | `ORG` |
| `payslip:read` | `SELF` |
| `payslip:read-any` | `ORG` |
| `policy:acknowledge` | `SELF` |
| `policy:read` | `SELF` |
| `profile:read` | `SELF` |
| `profile:request-change` | `SELF` |
| `tax:administer` | `ORG` |
| `tax:declare` | `SELF` |
| `tax:read` | `SELF` |
| `ticket:comment` | `SELF` |
| `ticket:create` | `SELF` |
| `ticket:read` | `SELF` |

## 5. Field-level exposure

A permission says whether a record may be read. These say which parts of it
come back, whatever the caller holds.

### The directory

The only employee fields the directory ever returns:

`id`, `employeeCode`, `fullName`, `designation`, `department`, `location`, `workEmail`, `workPhone`, `managerId`, `avatarInitials`.

Personal contact details, addresses, dates of birth, and bank and statutory
identifiers are not in that list and are not reachable through it.

### Profile sections

| Section | Scope needed to read it |
| ------- | ----------------------- |
| `personal` | `SELF` |
| `employment` | `REPORTING_CHAIN` |
| `bank` | `SELF` · **always masked** |
| `emergency` | `REPORTING_CHAIN` |

A section marked always masked is masked even for its owner: the value is
encrypted and is only ever needed for verification, never for display.

## 6. Consequences worth stating

Some of these read as omissions and are decisions.

- **No role holds `payslip:read` beyond `SELF`.** A manager cannot see a report's payslip. Accounts reads the register through `payslip:read-any`, which is a different permission and is audited as an export.
- **Accounts does not hold `profile:read`.** Payroll needs bank and statutory fields, and gets them through the payroll surfaces alone — not through the HR profile screens.
- **HR holds `payroll-cycle:read` and nothing else in payroll.** They can see that a cycle exists and where it has got to, because their attendance submission is what it waits on. They cannot move it.
- **`audit:read` and `audit:verify` are held by HR and Accounts; nothing grants a write.** Proving the trail is intact is a control precisely because the people who can prove it cannot alter it.
- **A manager decides at `DIRECT_REPORTS` but reads at `REPORTING_CHAIN`.** They can see what is happening below them and approve only for the people who report to them directly.

---

_Generated from `packages/shared/src/rbac/roles.ts`. Run `npm run docs:rbac`._
