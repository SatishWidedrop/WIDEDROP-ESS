# Widedrop ESS — Business Workflows & State Machines

**Status:** authoritative implementation spec.
**Companions:** `docs/DATA-MODEL.md` (tables, columns, constraints, enums, guard
catalogue), `docs/SECURITY.md` (authn/authz, crypto, audit, rate limiting),
`design/DESIGN-SYSTEM.md` (visual language), `design/prototype/*` (UI/UX source of
truth).

This document defines **every state machine and business workflow** in the system:
the states, the legal transitions, who may trigger each one, the guard predicates, the
side effects, the audit event, the notifications, the invariants and the
failure/compensation paths.

Where this document and `DATA-MODEL.md` describe the same thing, `DATA-MODEL.md` is
authoritative for **schema** (table and column names, types, constraints) and this
document is authoritative for **behaviour** (order, guards, effects, compensation).
The nine additions/refinements this document originally demanded of `DATA-MODEL.md`
(`A-1`…`A-6`, `R-1`…`R-4`) **have since been absorbed into it**; §0.6 now records where each
one landed and is a reconciliation record, not a work list. A further set of refinements
(`R-5`…`R-16`) is required by corrections made in this revision and is listed in **§0.6.2**;
those _are_ a work list and must be applied to `DATA-MODEL.md` before implementation.

**Precedence, stated once.** Where this document names a table, column, enum value,
permission code, guard key or constraint name, `DATA-MODEL.md` is authoritative and this
document is an alias to be corrected; where the two describe a _rule_, the stricter one
wins. Any name in this document that `db:verify-schema` cannot resolve is a bug in this
document, not licence to invent a column.

---

## 0. Conventions

### 0.1 Reading a transition table

Every workflow section carries a table with these columns:

| Column      | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `#`         | Stable transition number, referenced elsewhere as e.g. `PAY-13`                    |
| `from → to` | `NULL` as `from` means the creation transition                                     |
| `Trigger`   | The API route or job that performs it                                              |
| `Actor`     | Persona + permission code + **scope** (`self` / `team` / `any` / `system`)         |
| `Guards`    | Guard keys from `DATA-MODEL.md §19.3` (extensions defined in §0.6)                 |
| `Effects`   | Every other row written in the same transaction                                    |
| `Audit`     | `audit_event.event_code` (a column, FK to the seeded `audit_event_code` catalogue) |
| `Notify`    | `ess_notification_kind` → recipient set / `ess_email_kind` → address set           |

### 0.2 The universal transition procedure

No status column in this system is ever assigned directly. Every transition runs
through one service helper:

```
performTransition(machine, entity, toState, ctx, { reason?, idempotencyKey?, payload? })
```

in this exact order, inside **one** database transaction:

1. **Resolve actor context.** `ctx` carries `app_user_id`, `employee_id`, the union
   permission set from the access token (`scopes`), `request_id`, `session_family_id`,
   `ip_address`, `user_agent`.
2. **Lock the row.** `SELECT … FOR UPDATE` on the entity (see §11.2 for which entities
   additionally take an advisory lock).
3. **Re-read `from_state`** from the locked row. For every entity listed in §11.2 as
   carrying `row_version`, the client **must** supply it (as the `If-Match` header, value
   `W/"<row_version>"`); a request without it is `428 PRECONDITION_REQUIRED`, and a
   mismatch is `409 CONFLICT` with code `STALE_ROW_VERSION` carrying the current value.
   `row_version` is incremented by the transition in the same statement that writes the
   status, so a concurrent reader can never observe a status change without a version
   change. Entities not in that list take no `If-Match`.
4. **`assertTransition(machine, from, to)`** — a row must exist in `state_transition`
   for `(machine, from_state, to_state)`, else `409 INVALID_TRANSITION`.
5. **Permission check** — the actor's scopes must contain
   `state_transition.required_permission_code`, else `403 FORBIDDEN` plus an
   `AUTHZ.DENIED` audit row on the error path (§SECURITY 8.5).
6. **Scope check** — the ABAC predicate for the permission's scope suffix
   (`self` ⇒ subject is the actor; `team` ⇒ subject ∈ `employee_reporting_closure` of
   the actor; `any` ⇒ organisation). Failure is `403`, never `404`-leak on an entity the
   actor may legitimately know exists; `404` is returned when the actor may not know the
   entity exists at all (see `SECURITY.md §4.6`).
   6a. **Step-up authentication** — when the transition is listed in §0.9 as step-up
   protected, `session.step_up_at` must be within `org_setting.step_up_max_age_minutes`
   (seeded `15`) and the session's MFA method must be confirmed, else
   `401 STEP_UP_REQUIRED` plus an `AUTH.STEP_UP_REQUIRED` audit row. The check is
   server-side and reads the `session` row (`DATA-MODEL.md §6.0`), never a client claim.
7. **Guards** — every `guard_key` on the transition row is evaluated against **persisted
   state inside the transaction**, after the locks of step 2 are held. First failure
   returns `422 GUARD_FAILED` with the guard key and a UI-renderable message drawn from
   `ui_copy` (§0.10). Guards never consult anything but the database and `now()`, and
   every guard is **fail-closed**: a missing row, a NULL comparand or an absent setting
   evaluates to `false` (`DATA-MODEL.md §19.3`, binding property 2). A guard is evaluated
   exactly once per transition, inside the transaction — an admission-time pre-check is
   permitted only as a UX affordance and never substitutes for it (TOCTOU).
8. **Write the state change** and every effect listed in the `Effects` column.
9. **Write the `audit_event`** via `withAudit(tx, …)` — same transaction, no exceptions
   (§11.1).
10. **Write `notification` rows and `email_outbox` rows** declared by
    `state_transition.emits_notification_kind` / `emits_email_kind` — same transaction.
11. **Commit.** Only then may a response be returned. Nothing is delivered to an external
    system inside the transaction; delivery is always the outbox worker's job.

A database trigger (`trg_guard_state_transition`) re-checks step 4 on `UPDATE` of every
table carrying a `status` column, so a transition is impossible even by direct SQL.

### 0.3 Audit convention

Every transition writes exactly one `audit_event` with:

```
action          = 'STATE_TRANSITION'
state_machine   = <machine>
from_state      = <from>         -- NULL on creation
to_state        = <to>
entity_type     = <table name>
entity_id       = <row id>
entity_label    = the human reference (WDT-PS-2608-1847, HD-4821, WDT-LV-2026-000481)
actor_role_persona   = the persona whose permission authorised it
actor_permission_code= state_transition.required_permission_code
reason          = the mandatory note, when the transition required one
event_code      = the stable dotted code in the Audit column
```

`event_code` is a **first-class column** on `audit_event` (`DATA-MODEL.md §17.1`) with an
FK to the seeded `audit_event_code` catalogue — not a key inside `metadata`. An event code
that is not in the catalogue fails the insert, so the dotted codes in this document's
`Audit` columns are a closed set that `db:verify-schema` reconciles against the catalogue
(rule: every code named in `WORKFLOWS.md` exists, and every catalogue row is named by at
least one transition or job). `action`/`state_machine`/`from_state`/`to_state` are the
`DATA-MODEL.md` columns.

Every `audit_event` is written through `withAudit(tx, …)`, which computes the row's place
in the per-organisation hash chain (`prev_hash`/`row_hash`, `DATA-MODEL.md §17.1`) under
`pg_advisory_xact_lock(hashtext('audit:' || organization_id))`. The table is append-only
(`trg_append_only_audit`, no `UPDATE`, no `DELETE`, `TRUNCATE` guarded) and verified by the
`audit-chain-verify` job (§10.2). A transition whose audit insert fails **fails the whole
transition** — there is no path that writes state without writing its audit row. `before_data`/`after_data` follow the redaction rules of
`SECURITY.md §8.5` — encrypted columns appear as `"<redacted:aes>"`, money as
minor-unit strings, free text (leave reasons, ticket bodies, rejection notes) is never
copied.

Non-transition writes that must also be audited (`READ_SENSITIVE`, `DOWNLOAD`,
`EXPORT`, `PERMISSION_GRANT`, `CONFIG_CHANGE`) are listed per workflow.

### 0.4 Money and determinism

- All money is **integer paise** (`money_minor`, `bigint`) end to end. No float, no
  decimal string arithmetic in the engine. Intermediate arithmetic uses exact integer
  rationals (`BigInt` numerator/denominator), never IEEE-754.
- All **days** are `numeric(5,2)` in halves only (`CHECK (x*2 = trunc(x*2))`).
- Rounding is always **half-up away from zero**, and only at the points named in §1.9.7.
- The `en-IN` `₹`-formatting in `DESIGN-SYSTEM.md §10` is display-only; it never feeds
  back into a stored value.

### 0.5 Empty-state contract for workflows

A workflow state is a **fact**, and the absence of a row is also a fact. No screen may
infer a value from the absence of data:

- No `payroll_cycle` for a month ⇒ "Payroll for September 2026 has not been opened yet",
  not `₹0`.
- No `leave_balance` row ⇒ `—` with the reason, not `0 / 0`.
- No `payslip_publication` ⇒ the designed Payslips empty state, driven by the employee's
  earliest in-scope `payroll_cycle.status` — never a provisional or draft figure.
- `tds_quarter.status = 'UPCOMING'` with `tds_deducted_minor IS NULL` ⇒ `—` (this is the
  prototype's Q3/Q4 behaviour, and it is persisted, not fabricated).
- An empty `approval_task` queue ⇒ the designed "Nothing waiting on you" state and a
  **suppressed** sidebar badge (no `0` chip).
- No `attendance_record` for the employee in a period ⇒ "Attendance for August 2026 has
  not been prepared yet", not `0 / 31`.
- No `tds_quarter` row **and** an `UPCOMING` row are the same rendering (`—` + gray
  `Upcoming` chip) — the Tax screen left-joins `fiscal_quarter`, so the four quarters
  always render and three of them may legitimately have no row (`DATA-MODEL.md §12.5`).
- No `benefit_enrolment` ⇒ the Benefits empty state naming the next enrolment window from
  `benefit_plan_year.enrolment_window_opens_on`; a NULL window renders "Enrolment dates
  have not been published yet", never an invented date.
- No `expense_fy_rollup` row ⇒ the three Expenses tiles render `—` with their sub-labels,
  not `₹0`. `₹0` is only ever rendered when a rollup row exists **and** its value is zero.

The single authority for which key each surface renders is the empty-state catalogue in
`DATA-MODEL.md §20.16`; **§18** of this document maps each **workflow state** to the key
that catalogue expects, so the two cannot drift. A screen with no matching catalogue key is a
specification bug, not an implementer's choice.

### 0.6 Schema addenda — reconciliation record

**Status: absorbed.** `A-1`…`A-6` and `R-1`…`R-4` below were additions this document
demanded of `DATA-MODEL.md`. They now exist there, at the sections named in the table, and
`DATA-MODEL.md §22` records the same reconciliation from the other side. They are retained
here in full because the _behaviour_ sections below reference their columns, and because a
reader must be able to see why each column exists without leaving this file. **Where the
text below and `DATA-MODEL.md` differ in a name, `DATA-MODEL.md` wins.**

| Addendum                                                                            | Landed in `DATA-MODEL.md`                                                                                  |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| A-1 `payroll_cycle_employee`                                                        | §10.10                                                                                                     |
| A-2 `payroll_cycle.cycle_kind`, `parent_payroll_cycle_id`; R-1 partial unique index | §10.1                                                                                                      |
| A-3 `payroll_correction`, `payroll_run.run_kind`                                    | §10.11, §10.6                                                                                              |
| A-4 `statutory_rate_set`, `statutory_pt_slab`, `employee_statutory_election`        | §10.12                                                                                                     |
| A-5 `profile_change_request` (+ `_field`)                                           | §5.11 — **with a different state set and permission set; §8 of this document has been corrected to match** |
| A-6 `user_invitation`                                                               | §6.5.1                                                                                                     |
| R-2 `attendance.every_slice_approved`                                               | §9.5                                                                                                       |
| R-3 help-desk SLA pause fields                                                      | §16.4                                                                                                      |
| R-4 `trg_payslip_requires_calculating`                                              | §10.7                                                                                                      |

Each is marked `A-n` (addition) or `R-n` (refinement).

**A-1 `payroll_cycle_employee`** — the in-scope employee set, snapshotted at
`VALIDATING`, with a per-employee disposition. Without it, "who was in this run and why"
is not answerable after the fact.

| Column                  | Type                            | Null | Notes                                                                           |
| ----------------------- | ------------------------------- | ---- | ------------------------------------------------------------------------------- |
| `id`                    | `uuid`                          | no   | PK                                                                              |
| `organization_id`       | `uuid`                          | no   | FK → `organization(id)` RESTRICT                                                |
| `payroll_cycle_id`      | `uuid`                          | no   | FK → `payroll_cycle(id)` CASCADE                                                |
| `employee_id`           | `uuid`                          | no   | FK → `employee(id)` RESTRICT                                                    |
| `validation_pass_no`    | `integer`                       | no   | The pass that produced this snapshot                                            |
| `disposition`           | `ess_payroll_scope_disposition` | no   | `INCLUDED` \| `EXCLUDED` \| `DEFERRED`                                          |
| `exclusion_reason_code` | `text`                          | yes  | Mandatory when not `INCLUDED`; one of the rule codes in §1.5 or `MANUAL`        |
| `exclusion_note`        | `text`                          | yes  | Mandatory when `disposition <> 'INCLUDED'`, ≥ 10 chars                          |
| `excluded_by_user_id`   | `uuid`                          | yes  | FK → `app_user(id)` RESTRICT                                                    |
| `excluded_at`           | `timestamptz`                   | yes  |                                                                                 |
| `carry_to_cycle_id`     | `uuid`                          | yes  | FK → `payroll_cycle(id)` SET NULL — where a `DEFERRED` employee is paid instead |
| `attendance_record_id`  | `uuid`                          | yes  | FK → `attendance_record(id)` RESTRICT                                           |
| `salary_structure_id`   | `uuid`                          | yes  | FK → `salary_structure(id)` RESTRICT                                            |
| `payslip_id`            | `uuid`                          | yes  | FK → `payslip(id)` SET NULL — set at `CALCULATED`                               |

```sql
CONSTRAINT ux_pce__cycle_employee UNIQUE (payroll_cycle_id, employee_id),
CONSTRAINT ck_pce__exclusion CHECK (
  (disposition = 'INCLUDED') = (num_nulls(exclusion_reason_code, exclusion_note, excluded_by_user_id, excluded_at) = 4)),
CONSTRAINT ck_pce__included_sources CHECK (
  disposition <> 'INCLUDED' OR (attendance_record_id IS NOT NULL AND salary_structure_id IS NOT NULL))
```

Indexes: `ix_pce__cycle_disposition (payroll_cycle_id, disposition)`,
`ix_pce__employee (employee_id, payroll_cycle_id)`.
New enum `ess_payroll_scope_disposition` = `INCLUDED`, `EXCLUDED`, `DEFERRED`.

**A-2 `payroll_cycle.cycle_kind`** — `ess_payroll_cycle_kind` = `REGULAR`,
`SUPPLEMENTARY`, `OFF_CYCLE`, `CORRECTION`. Default `REGULAR`. Plus
`parent_payroll_cycle_id uuid NULL` FK → `payroll_cycle(id)` RESTRICT (required for every
kind except `REGULAR`).
**R-1** The 1:1 uniqueness on `payroll_cycle.attendance_period_id` becomes
`CREATE UNIQUE INDEX ux_payroll_cycle__attendance_period ON payroll_cycle (attendance_period_id) WHERE cycle_kind = 'REGULAR'`
so a supplementary run can reuse the month's approved attendance without re-approving it.

**A-3 `payroll_correction`** — the post-publication correction machine (§1.10.3). A
published cycle is never rolled back; a correction is its own tracked object.

| Column                                | Type                            | Null | Notes                                                                              |
| ------------------------------------- | ------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| `id`                                  | `uuid`                          | no   | PK                                                                                 |
| `organization_id`                     | `uuid`                          | no   | FK → `organization(id)` RESTRICT                                                   |
| `payroll_cycle_id`                    | `uuid`                          | no   | FK → `payroll_cycle(id)` RESTRICT — the **published** cycle being corrected        |
| `correction_no`                       | `citext`                        | no   | `WDT-PC-2026-0007`, unique per org                                                 |
| `status`                              | `ess_payroll_correction_status` | no   | `RAISED`,`APPROVED`,`CALCULATING`,`CALCULATED`,`PUBLISHED`,`REJECTED`,`FAILED`     |
| `reason_code`                         | `text`                          | no   | `INPUT_ERROR`,`ATTENDANCE_ERROR`,`STRUCTURE_ERROR`,`STATUTORY_ERROR`,`COURT_ORDER` |
| `reason_note`                         | `text`                          | no   | ≥ 20 chars                                                                         |
| `raised_by_user_id` / `raised_at`     | `uuid` / `timestamptz`          | no   |                                                                                    |
| `approved_by_user_id` / `approved_at` | `uuid` / `timestamptz`          | yes  | Must differ from `raised_by_user_id`                                               |
| `payroll_run_id`                      | `uuid`                          | yes  | FK → `payroll_run(id)` RESTRICT — the correction run                               |
| `settlement_cycle_id`                 | `uuid`                          | yes  | FK → `payroll_cycle(id)` RESTRICT — where the net delta is paid/recovered          |
| `affected_employee_count`             | `integer`                       | no   | default `0`                                                                        |
| `row_version`                         | `integer`                       | no   | default `1`                                                                        |

```sql
CONSTRAINT ux_pc_corr__org_no UNIQUE (organization_id, correction_no),
CONSTRAINT ck_pc_corr__dual_control CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> raised_by_user_id)
```

Plus `payroll_run.run_kind ess_payroll_run_kind NOT NULL DEFAULT 'REGULAR'`
(`REGULAR` | `CORRECTION`) and `payroll_run.payroll_correction_id uuid NULL`.

**A-4 Statutory reference tables** — so PF/ESI/PT values are seeded, effective-dated
reference data and never literals in code.

`statutory_rate_set` — one row per (jurisdiction, effective range):
`id`, `organization_id`, `country_code char(2) NOT NULL DEFAULT 'IN'`,
`effective_from date NOT NULL`, `effective_to date NULL`,
`pf_employee_rate numeric(12,6) NOT NULL`, `pf_employer_rate numeric(12,6) NOT NULL`,
`pf_eps_rate numeric(12,6) NOT NULL`, `pf_wage_ceiling_minor money_minor NOT NULL`,
`pf_admin_charge_rate numeric(12,6) NOT NULL`,
`esi_employee_rate numeric(12,6) NOT NULL`, `esi_employer_rate numeric(12,6) NOT NULL`,
`esi_wage_threshold_minor money_minor NOT NULL`,
`esi_contribution_period_start_months smallint[] NOT NULL DEFAULT '{4,10}'`,
`gratuity_rate numeric(12,6) NOT NULL`, `ruleset_sha256 bytea NOT NULL`.
`EXCLUDE USING gist (organization_id WITH =, country_code WITH =, daterange(effective_from, coalesce(effective_to,'infinity'), '[]') WITH &&)`.

`statutory_pt_slab` — professional tax by state:
`id`, `organization_id`, `state_code text NOT NULL`, `effective_from date NOT NULL`,
`effective_to date NULL`, `slab_no smallint NOT NULL`,
`from_monthly_wage_minor money_minor NOT NULL`,
`to_monthly_wage_minor money_minor NULL` (NULL = open top),
`monthly_amount_minor money_minor NOT NULL`,
`applies_in_months smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7,8,9,10,11,12}'`,
`annual_cap_minor money_minor NULL`.
`UNIQUE (organization_id, state_code, effective_from, slab_no)`;
`CHECK (to_monthly_wage_minor IS NULL OR to_monthly_wage_minor > from_monthly_wage_minor)`.

`employee_statutory_election` — per employee, effective-dated:
`id`, `organization_id`, `employee_id`, `effective_from date`, `effective_to date NULL`,
`pf_wage_basis text NOT NULL CHECK (pf_wage_basis IN ('CEILING','ACTUAL'))`,
`pf_applicable boolean NOT NULL DEFAULT true`,
`esi_applicable_override boolean NULL` (NULL ⇒ derive from the threshold),
`pt_state_code text NULL` (NULL ⇒ derive from the work location's state),
`vpf_rate numeric(12,6) NOT NULL DEFAULT 0`.

**A-5 `profile_change_request` + `profile_change_request_field`** — §8.

**A-6 `user_invitation`** — §9. `id`, `organization_id`, `app_user_id`,
`employee_id`, `token_hash bytea NOT NULL` (SHA-256 of a 32-byte random token),
`token_fpr bytea NOT NULL` (blind index for lookup), `expires_at timestamptz NOT NULL`,
`sent_email_outbox_id uuid NULL`, `accepted_at timestamptz NULL`,
`revoked_at timestamptz NULL`, `revoked_by_user_id uuid NULL`, `attempt_count smallint NOT NULL DEFAULT 0`.
`UNIQUE (app_user_id) WHERE accepted_at IS NULL AND revoked_at IS NULL`.

**R-2 `attendance.every_slice_approved` guard refinement.** The predicate becomes:

```sql
NOT EXISTS (
  SELECT 1 FROM attendance_approval aa
  WHERE aa.attendance_period_id = :period
    AND (aa.status NOT IN ('APPROVED','AUTO_ESCALATED') OR aa.decided_at IS NULL))
```

`AUTO_ESCALATED` is a **decided, approving** outcome recorded by HR under
`attendance:approve:any` after `due_at` has passed, carrying a mandatory
`escalation_reason`; it is distinguished from `APPROVED` only so that escalations are
trivially reportable. A slice that HR escalates and then wants to _reject_ is recorded as
`REJECTED` with `escalated_to_user_id` set and `escalated_at` left NULL.

**R-3 Help-desk SLA pause fields.** `helpdesk_ticket.sla_paused_at timestamptz NULL`,
`helpdesk_ticket.sla_paused_seconds integer NOT NULL DEFAULT 0`,
`helpdesk_ticket.email_delivery_status ess_email_status NULL` (denormalised mirror of
`email_outbox.status`, maintained by the dispatcher in the same transaction as the outbox
update, so the ticket screen can render the real delivery state in one read).
`resolution_due_at` becomes mutable only by the SLA recompute routine (§6.4).

**R-4 `payslip` insertion trigger.** `trg_payslip_requires_calculating`
(`BEFORE INSERT ON payslip`) raises unless
`(SELECT status FROM payroll_cycle WHERE id = NEW.payroll_cycle_id FOR SHARE) = 'CALCULATING'`
**or** the insert belongs to a `payroll_run` whose `run_kind = 'CORRECTION'` and whose
`payroll_correction.status = 'CALCULATING'`. This is the database half of §1.8.

### 0.6.2 Further refinements this revision requires of `DATA-MODEL.md`

These are **new** and not yet absorbed. Each closes a defect found in this document or a
divergence between the two; none is optional.

**R-5 `VALIDATED → VALIDATING` (re-validation of a stale but successful validation).**
`payroll.validated_recently` expires a successful validation after
`org_setting.payroll_validation_max_age_hours`. With no transition out of `VALIDATED`
except `CALCULATING`, an expired cycle was a **dead end**: it could neither calculate nor
re-validate. Seed
`('payroll_cycle','VALIDATED','VALIDATING','payroll:validate', NULL)`. Effects and audit
are PAY-11's. This is PAY-21 below.

**R-6 `VALIDATED → INPUTS_LOCKED` and `VALIDATED → CANCELLED`.** A cycle that validated
cleanly and then needs attendance reopened (ATT-8) or abandoning had no path. Seed
`('payroll_cycle','VALIDATED','INPUTS_LOCKED','attendance:reopen','attendance.cycle_not_calculated')`
and `('payroll_cycle','VALIDATED','CANCELLED','payroll:cycle:transition','payroll.no_payslips_exist')`.
These are PAY-22 and the extended PAY-19.

**R-7 `INPUTS_LOCKED → VALIDATING` for non-`REGULAR` cycles.** §1.10.4 describes
supplementary and off-cycle runs skipping attendance, but no such row existed, so the path
was unreachable. Seed
`('payroll_cycle','INPUTS_LOCKED','VALIDATING','payroll:validate','payroll.parent_cycle_published')`
and add a `CHECK`-equivalent guard `payroll.cycle_kind_not_regular` so a `REGULAR` cycle
can never take it. This is PAY-23.

**R-8 `payroll.distinct_publisher` guard.** `ck_payroll_cycle__distinct_publisher` exists
in `DATA-MODEL.md §10.1` but no guard key exposes it, so transition 17 used
`payroll.distinct_approver` and a `422` was raised by a `CHECK` violation instead of a
clean guard failure. Register
`payroll.distinct_publisher` = `published_by_user_id <> calculated_by_user_id AND published_by_user_id <> approved_by_user_id`
and put it on PAY-17. The second conjunct is **stricter than the DB `CHECK`** and is
deliberate: three distinct Accounts users are required to move money to employees, which
is why `payroll.dual_control_available` is raised to require three (R-9).

**R-9 `payroll.dual_control_available` raised to three.** Predicate becomes: ≥ 3 distinct
`ACTIVE`, MFA-enrolled `app_user` rows hold the ACCOUNTS persona. With only two, PAY-17
is unsatisfiable and the cycle would strand at `APPROVED`; the guard must fail at
`INPUTS_LOCKED` (PAY-3), before any work is done, with a message naming the shortfall.
An organisation with fewer than three Accounts users sets
`org_setting.payroll_publisher_may_equal_approver = true` — an audited `CONFIG_CHANGE`
that relaxes only the second conjunct of R-8, never the first.

**R-10 `payroll_cycle_employee.disposition` survives re-validation.** PAY-11 as written
replaced the whole scope snapshot on each pass, which silently discarded every audited
`DEFERRED` decision. The snapshot write becomes an **upsert on
`(payroll_cycle_id, employee_id)`** that carries `disposition`, `exclusion_reason_code`,
`exclusion_note`, `excluded_by_user_id`, `excluded_at` and `carry_to_cycle_id` forward
unchanged, updating only `validation_pass_no` and the resolved source ids. A deferral is
cleared only by `POST /cycles/:id/scope/:employeeId/undefer` (`payroll:cycle:transition`,
note required, audit `PAYROLL.EMPLOYEE_UNDEFERRED`). Add
`CONSTRAINT ck_pce__pass_monotonic CHECK (validation_pass_no >= 1)` and drop the
"replaces the previous pass's rows" language.

**R-11 `statutory_pt_slab.pt_basis`.** §1.9.5 reads `pt_basis` from the slab set; A-4 never
defined it. Add `pt_basis text NOT NULL DEFAULT 'GROSS_EXCL_NON_TAXABLE' CHECK (pt_basis IN ('GROSS_EXCL_NON_TAXABLE','BASIC_PLUS_DA','GROSS'))`
to `statutory_pt_slab`. The default is the corrected basis of §1.9.5 — professional tax is
never levied on a reimbursement of the employee's own expenditure.

**R-12 `statutory_rate_set` surcharge and slab structure.** §1.9.6 reads
`REG.slabs`, `REG.standard_deduction_minor`, `REG.rebate_87a_limit_minor`,
`REG.rebate_87a_amount_minor`, `REG.cess_rate`, `REG.surcharge_rules` and
`REG.allows_chapter_via_deductions` from `tax_regime`; only some exist. Add to
`DATA-MODEL.md §12.1`: child table `tax_regime_slab`
(`tax_regime_id`, `fiscal_year_id`, `slab_no smallint`, `from_income_minor money_minor`,
`to_income_minor money_minor NULL`, `rate numeric(12,6)`,
`UNIQUE (tax_regime_id, fiscal_year_id, slab_no)`) and child table `tax_regime_surcharge`
(`tax_regime_id`, `fiscal_year_id`, `threshold_income_minor money_minor`,
`rate numeric(12,6)`, `marginal_relief_applies boolean NOT NULL DEFAULT true`,
`UNIQUE (tax_regime_id, fiscal_year_id, threshold_income_minor)`), plus columns
`standard_deduction_minor`, `rebate_87a_limit_minor`, `rebate_87a_amount_minor`,
`cess_rate numeric(12,6)`, `allows_chapter_via_deductions boolean`,
`allows_professional_tax_deduction boolean` on `tax_regime`, all **effective-dated by
fiscal year**. Statutory numbers are seeded reference data per FY; none is a literal in
code, and `ruleset_sha256` (§1.7) covers these rows.

**R-13 `statutory_rate_set.pf_admin_charge_rate` is used or removed.** It is defined and
never read. §1.9.3 now produces an `EMPLOYER_CONTRIBUTION` line `PF_ADMIN` from it, so the
employer cost shown on the payslip is complete.

**R-14 `email_outbox` token-bearing payloads are encrypted at rest.** `USER_INVITE` and
`PASSWORD_RESET` rows must carry the one-time secret in an envelope-encrypted
`template_data_ct/_iv/_tag/_dek_id` (class M1, `DATA-MODEL.md §1.6`) rather than in the
plaintext `template_data` jsonb, and the dispatcher nulls the ciphertext on `SENT`. Add
`CHECK (kind NOT IN ('USER_INVITE','PASSWORD_RESET') OR template_data IS NULL)`. Without
this, `ONB-INV-2` ("an invitation token is never stored in plaintext") is false the moment
the row is written.

**R-15 `ess_attendance_lop_source` is written, not implied.** `attendance_record.lop_source`
(`DERIVED` | `HR_OVERRIDE` | `PAYROLL_INPUT_OVERRIDE`) and
`attendance_record.lop_days_derived numeric(5,2)` must both be persisted, so the payslip's
LOP figure and the record's own figure are reconcilable. §1.9.1's "for the calculation
only" override is corrected accordingly (§1.9.1).

**R-16 `helpdesk_ticket` overdue is a query expression, not a stored flag.**
`sla_first_response_breached` / `sla_resolution_breached` are `STORED` generated columns
over `first_responded_at` / `resolved_at`, so they are **false for a ticket that is
overdue and still open** — by construction, since a stored generated column cannot
reference `now()`. Add the view `v_helpdesk_ticket_sla` exposing
`is_first_response_overdue = (first_responded_at IS NULL AND first_response_due_at < now())`
and `is_resolution_overdue = (resolved_at IS NULL AND resolution_due_at < now())`, and
index `ix_ht__fr_due (organization_id, first_response_due_at) WHERE first_responded_at IS NULL`.
The HR queue banner and the escalation job read the view; nothing reads the stored flags
for a live ticket.

### 0.7 Role vocabulary used below

`EMPLOYEE`, `MANAGER`, `HR`, `ACCOUNTS` are the four personas of
`DATA-MODEL.md §3.2`. _System_ means a transition performed by the API's own service
layer or a named `ess_ops.background_job`, recorded with
`audit_event.actor_kind = 'SYSTEM'` or `'SCHEDULER'` and `actor_user_id = NULL`. A system
transition has `state_transition.required_permission_code IS NULL` and is unreachable
from any HTTP route.

### 0.8 RBAC: which persona may trigger what

`DATA-MODEL.md §3` is canonical for the permission catalogue and the four seeded
`role_permission` sets; `SECURITY.md §4` is canonical for how a request's scope set is
derived and for `has_scope()`. This document adds only the binding rules that a workflow
implementer needs:

1. **Every transition names a permission code, and only that code authorises it.** The
   `Actor` column is `persona + permission-code + scope`. The persona is informative (it
   says who normally holds the code); the **code** is what step 5 of §0.2 checks. A user
   who holds `payroll:publish` through some other role publishes payroll; a user who holds
   the ACCOUNTS persona but not the code does not.
2. **Scope suffixes are distinct permissions, never a hierarchy evaluated at runtime.**
   `leave:request:approve:team` and `leave:request:approve:any` are two rows in
   `permission`. Holding `:any` does not imply `:team`; both are granted explicitly where
   both are needed. `has_scope()` compares whole codes, so no prefix match can widen a
   scope.
3. **Scope predicates, exactly:** `self` ⇒ the subject is the actor's own
   `employee_id`; `team` ⇒ the subject is in `employee_reporting_closure` beneath the
   actor (the closure table, not a recursive query at request time); `any` ⇒ the subject
   is in the actor's organisation; `finance` ⇒ organisation-wide but limited to the
   expense-settlement routes. `system` transitions have
   `required_permission_code IS NULL` and are unreachable from any HTTP route.
4. **A user holding two personas holds the union of the two permission sets**, and every
   scope predicate is still evaluated per request against the specific code that
   authorised it. An HR business partner who also manages a team acts under `:team` for
   their own reports and `:any` for HR work, and the audit row records which code was used.
5. **Denials are audited and shaped to avoid leaking existence.** A `403` says the actor
   may not act on an entity they may legitimately know exists; a `404` is returned where
   knowing the entity exists is itself disclosure (`SECURITY.md §4.6`). Both write an
   `AUTHZ.DENIED` audit row on the error path (§11.1).
6. **RLS is the backstop, not the gate.** The API sets `ess.actor_employee_id`,
   `ess.actor_scopes` and `ess.organization_id` with `SET LOCAL` inside the transaction
   (`DATA-MODEL.md §1.8.2`); a bug that forgets a `WHERE` clause yields zero rows rather
   than another employee's payslip. Because the context is transaction-local, it is
   compatible with the transaction-pooled connection the deployment uses, and a request
   that somehow ran outside a transaction would have **no** scopes and see nothing.

The per-transition negative tests this implies are listed in §11.5.

### 0.9 Step-up authentication and rate limits on workflow routes

`SECURITY.md` is canonical for session handling, MFA and the limiter's implementation.
This document names the **workflow-specific** policy, because "apply rate limiting"
without a table is not something an implementer can build.

**Step-up re-authentication** (§0.2 step 6a) is required for these transitions and for no
others. Each moves money, changes where money goes, or changes who can do either:

| Transition                                                         | Why                                 |
| ------------------------------------------------------------------ | ----------------------------------- |
| PAY-15 `CALCULATED → APPROVED`                                     | Approves a whole organisation's pay |
| PAY-17 `APPROVED → PUBLISHED`                                      | Releases it                         |
| PC-2, PC-5 (correction approve, publish)                           | Same, against an already-paid month |
| PCR-5 (`IN_REVIEW → APPROVED`) for `BANK_ACCOUNT` / `STATUTORY_ID` | Redirects an employee's salary      |
| USR-7, USR-9, USR-11 (suspend, disable, offboard)                  | Removes access                      |
| `role:assign` grants of MANAGER/HR/ACCOUNTS                        | Grants access                       |
| Any `EXPORT` of payroll, tax or audit data                         | Bulk sensitive read                 |

A step-up is a fresh MFA assertion against the **current** session, recorded as
`session.step_up_at`; it is valid for `org_setting.step_up_max_age_minutes` (seeded `15`)
and is consumed per session, not per request, so a publish run of 200 payslips prompts
once.

**Rate limits.** Buckets are token-bucket, keyed as shown, enforced server-side at the
edge **and** in the API (the edge limit alone is bypassable by anything that reaches the
origin directly). Seeded defaults, all in `org_setting`:

| Bucket key           | Routes                                             | Limit                                                                        |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| `auth:ip`            | `/auth/*`                                          | 20 / 5 min                                                                   |
| `auth:user`          | login, by resolved user                            | 5 / 15 min, then progressive lockout (USR-5)                                 |
| `invite:<token_fpr>` | `/auth/accept-invitation`                          | 5 total, then the invitation is revoked                                      |
| `write:user`         | every unsafe workflow route                        | 120 / min                                                                    |
| `ticket:create:user` | `POST /tickets`                                    | 10 / hour — a ticket storm also mails an external address                    |
| `policy:ack:user`    | `POST /policy-versions/:id/acknowledge`            | 30 / hour                                                                    |
| `upload:user`        | every multipart route                              | 20 / hour, `org_setting.max_upload_bytes` per file                           |
| `payroll:heavy:org`  | validate, calculate, publish, correction-calculate | 4 / hour per organisation — these are expensive and never legitimately rapid |
| `export:user`        | every `EXPORT` route                               | 5 / hour, each one audited                                                   |
| `search:user`        | global search                                      | 60 / min                                                                     |

A limiter rejection is `429` with `Retry-After`, writes a `RATE_LIMITED` audit row
(§11.1), and **never** consumes the request's `Idempotency-Key` — a retried request after
a `429` must still be able to replay.

### 0.10 Every user-facing string is persisted

`DATA-MODEL.md §4.7` defines `ui_copy` (keyed, versioned, seeded interface copy). Every
quoted string in this document's `Notify`, toast, empty-state, guard-message and email
columns is a `ui_copy` **template** rendered with values from the row that caused it — not
a literal in the frontend or in a service. This is the same rule as directive 2 applied to
words rather than numbers: "first response within 1 working day", "Bank and statutory
changes need a cancelled cheque", "Attendance capture for August 2026 is open" and the
acknowledgement consent sentence are all persisted, versioned and auditable.

Three consequences:

- A template's placeholders are resolved **server-side** from the entity, so a message can
  never contain a value the recipient is not entitled to see (§10.3 rule 4).
- `policy_acknowledgement.acknowledgement_text` stores the **rendered** sentence plus the
  `ui_copy` key and version, so the exact consent wording shown is reconstructible years
  later.
- A missing `ui_copy` key fails `db:verify-schema`, not silently at render time. The CI
  check reconciles every key referenced in the web bundle against the seeded set.

### 0.11 Where the scheduled work runs (and why it cannot be the static host)

This document declares fifteen named background jobs and one long-running payroll worker.
They constrain the deployment, so the constraint is stated here rather than discovered
later:

- The SPA is static and is served by the Netlify site that coexists with `widedrop.com`
  (a separate site or subdomain). **Nothing in this document runs there.** The static host
  has no database credentials, no secrets and no scheduler.
- Every job in §10.2 and the payroll run of §1.7 execute in a **persistent worker process**
  alongside the API, against the same database, with a single-leader lease
  (`ess_ops.background_job.lease_owner` + `lease_expires_at`). A job that dies leaves its
  lease to expire and is re-claimed; §11.3 is what makes the re-run safe.
- The payroll run in particular holds one transaction across the whole organisation and
  must be byte-reproducible (§11.5), which rules out a request-scoped serverless function
  with a wall-clock limit.
- Scheduling is driven from the database (`scheduled_for` + lease), not from a platform
  cron, so a missed window is caught up on the next tick rather than skipped — this is the
  same property §5.5's `<=` thresholds rely on.

`DEPLOYMENT.md` is canonical for topology, secrets and the Netlify/API split; this section
only fixes what the **workflows** require of it.

### 0.12 Module coverage map

Every module the prototype defines has a workflow section. This map exists so a reader can
confirm nothing was left out, and so the Appendix A machine index and the prototype's
navigation can be reconciled mechanically.

| Prototype module (`NAV`)   | Workflow section                                | Primary machine(s)                                               |
| -------------------------- | ----------------------------------------------- | ---------------------------------------------------------------- |
| Home                       | §18 (empty states), §16 (todo list), §10 (bell) | — (all reads)                                                    |
| Payslips                   | §1                                              | `payroll_cycle`, `payroll_run`, `payslip`, `payslip_publication` |
| Tax slips                  | §12                                             | `employee_tax_declaration`, `tds_quarter`, `form16_document`     |
| My profile                 | §8                                              | `profile_change_request`                                         |
| Leave                      | §3                                              | `leave_request`                                                  |
| Benefits                   | §13                                             | `benefit_enrolment`                                              |
| Expenses                   | §4                                              | `expense_claim`, `reimbursement_batch`                           |
| Documents                  | §7                                              | `document_request`                                               |
| Policies                   | §5                                              | `policy_version`, `policy_acknowledgement`                       |
| Directory                  | §15                                             | — (read model)                                                   |
| Announcements              | §14                                             | `announcement`                                                   |
| Help desk                  | §6                                              | `helpdesk_ticket`                                                |
| Approvals (Manager)        | §16                                             | `approval_task`                                                  |
| _(shell)_ global search    | §15.3                                           | — (read model)                                                   |
| _(shell)_ notifications    | §10                                             | —                                                                |
| _(back office)_ Attendance | §2                                              | `attendance_period`, `attendance_record`, `attendance_approval`  |
| _(back office)_ Onboarding | §9                                              | `employee`, `app_user`                                           |

---

## 1. PAYROLL — the mandated workflow

> **Accounts uploads payroll data → HR submits employee attendance → the respective
> Manager reviews/approves attendance → the system validates required payroll inputs →
> automatic payroll/payslip generation → the payslip becomes visible to the employee.**

The order is enforced by `payroll_cycle.status` and by nothing else. Every step is a
transition in the table of §1.3; there is no route, no job and no SQL path that reaches a
later step without passing through the earlier ones.

### 1.1 Actors and separation of duties

| Step                      | Persona                       | Permission                | Why not someone else                                                                                                                                                       |
| ------------------------- | ----------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open the cycle            | ACCOUNTS                      | `payroll:cycle:create`    | HR holds no `payroll:*` write permission                                                                                                                                   |
| Upload payroll data       | ACCOUNTS                      | `payroll:input:upload`    | —                                                                                                                                                                          |
| Commit inputs / lock      | ACCOUNTS                      | `payroll:input:commit`    | —                                                                                                                                                                          |
| Capture attendance        | HR                            | `attendance:capture`      | ACCOUNTS holds **no** `attendance:submit`/`approve` — the payroll operator cannot manufacture their own attendance inputs                                                  |
| Submit attendance         | HR                            | `attendance:submit`       | —                                                                                                                                                                          |
| Approve a team slice      | MANAGER                       | `attendance:approve:team` | Scope-bounded by `employee_reporting_closure`                                                                                                                              |
| Escalate an overdue slice | HR                            | `attendance:approve:any`  | Only after `due_at`, with a mandatory reason, never by the user who submitted the period (`attendance.escalation_actor_not_submitter`); the transition is **AAP-4** (§2.4) |
| Validate                  | ACCOUNTS                      | `payroll:validate`        | —                                                                                                                                                                          |
| Calculate                 | ACCOUNTS                      | `payroll:calculate`       | —                                                                                                                                                                          |
| Approve the run           | ACCOUNTS (**different user**) | `payroll:approve`         | `payroll.distinct_approver`                                                                                                                                                |
| Publish                   | ACCOUNTS (**different user**) | `payroll:publish`         | `payroll.distinct_approver`                                                                                                                                                |
| Close                     | ACCOUNTS                      | `payroll:close`           | —                                                                                                                                                                          |

**Dual and triple control.** `ck_payroll_cycle__distinct_approver`
(`approved_by_user_id <> calculated_by_user_id`) and
`ck_payroll_cycle__distinct_publisher` (`published_by_user_id <> calculated_by_user_id`)
are database `CHECK`s; the guards `payroll.distinct_approver` and
`payroll.distinct_publisher` (R-8) surface the same rule as a clean `422` before the
constraint fires. `payroll.distinct_publisher` additionally requires
`published_by_user_id <> approved_by_user_id`, so **three** distinct Accounts users touch
a run that pays people. An organisation too small for three sets
`org_setting.payroll_publisher_may_equal_approver = true` — an audited `CONFIG_CHANGE`
that relaxes only that second conjunct. `payroll.dual_control_available` (R-9) fails at
PAY-3, before any work is done, when the organisation cannot satisfy the rule.

**The separation is a permission fact, not a convention, and CI proves it.**
`db:verify-schema` asserts over the seeded `role_permission` rows:

| Assertion                                                                                          | Why                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The ACCOUNTS role holds no permission matching `attendance:(capture\|submit\|approve)%`            | The payroll operator cannot manufacture the attendance that feeds their own run                                                                                                                                                                                     |
| The HR role holds no permission matching `payroll:(input\|validate\|calculate\|approve\|publish)%` | The party that states the hours cannot also compute and release the money                                                                                                                                                                                           |
| The MANAGER role holds no `:any`-scoped permission at all                                          | A manager acts only inside `employee_reporting_closure`                                                                                                                                                                                                             |
| The EMPLOYEE role holds only `:self`-scoped permissions plus read-only company data                | Least privilege, by construction                                                                                                                                                                                                                                    |
| No role holds both `payroll:calculate` and `payroll:publish`…                                      | …**is deliberately NOT asserted.** Both are ACCOUNTS permissions; the separation is enforced per-**user** per-**cycle** by the two `CHECK`s above, not by splitting the role, because a two-person Accounts team must still be able to run payroll in either order. |

A human holding two personas (an HR business partner who also manages a team) holds the
union of both permission sets; every scope predicate is still evaluated per request, so
the union never widens `:team` into `:any`. `SECURITY.md §4` is authoritative for the
union rule and for `has_scope()`.

### 1.2 States

`ess_payroll_cycle_status`:

```
DRAFT · INPUTS_OPEN · INPUTS_LOCKED · ATTENDANCE_SUBMITTED · ATTENDANCE_APPROVED ·
VALIDATING · VALIDATION_FAILED · VALIDATED · CALCULATING · CALCULATED · APPROVED ·
PUBLISHED · CLOSED · CANCELLED
```

Mapping to the user's six mandated steps:

| Mandated step                            | Cycle state reached                                 |
| ---------------------------------------- | --------------------------------------------------- |
| Accounts uploads payroll data            | `INPUTS_OPEN` → `INPUTS_LOCKED`                     |
| HR submits employee attendance           | `ATTENDANCE_SUBMITTED`                              |
| Manager reviews/approves attendance      | `ATTENDANCE_APPROVED`                               |
| System validates required payroll inputs | `VALIDATING` → `VALIDATED` (or `VALIDATION_FAILED`) |
| Automatic payroll/payslip generation     | `CALCULATING` → `CALCULATED` → `APPROVED`           |
| Payslip becomes visible to the employee  | `PUBLISHED`                                         |

Failure states: `VALIDATION_FAILED` (validation found unresolved ERRORs, **or** the
calculation run failed). Abandon path: `CANCELLED`, reachable only before any payslip
exists. Terminal: `CLOSED`, `CANCELLED`.

### 1.3 Transition table (`machine = 'payroll_cycle'`)

| #      | from → to                                                                                                                                    | Trigger                                                             | Actor                                                   | Guards                                                                                                                                                                                              | Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Audit                                                       | Notify                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAY-1  | `NULL` → `DRAFT`                                                                                                                             | `POST /api/v1/payroll/cycles` or job `payroll-cycle-open`           | ACCOUNTS `payroll:cycle:create`                         | `payroll.no_open_cycle_for_period`, `payroll.prior_cycle_closed`                                                                                                                                    | Creates the paired `attendance_period` (`OPEN`) 1:1; resolves `scheduled_pay_date` from `organization.payroll_pay_day_rule` against the holiday calendar and persists it; `cycle_kind='REGULAR'`                                                                                                                                                                                                                                                             | `PAYROLL.CYCLE_CREATED`                                     | —                                                                                                                                                          |
| PAY-2  | `DRAFT` → `INPUTS_OPEN`                                                                                                                      | `POST /cycles/:id/open-inputs`                                      | ACCOUNTS `payroll:cycle:transition`                     | `payroll.attendance_period_open`                                                                                                                                                                    | `attendance_period.capture_opened_at = now()`                                                                                                                                                                                                                                                                                                                                                                                                                | `PAYROLL.INPUTS_OPENED`                                     | `PAYROLL_CYCLE_STATE` → all HR users ("Attendance capture for August 2026 is open")                                                                        |
| PAY-3  | `INPUTS_OPEN` → `INPUTS_LOCKED`                                                                                                              | `POST /cycles/:id/lock-inputs`                                      | ACCOUNTS `payroll:input:commit`                         | `payroll.inputs_settled`, `payroll.no_uncommitted_batches`, `payroll.all_batches_validated`, `payroll.committer_not_uploader`, `payroll.dual_control_available` (R-9)                               | `inputs_locked_at`, `inputs_locked_by_user_id`; every `DRAFT` reimbursement batch targeting this cycle is force-closed or rolled forward (§4.5)                                                                                                                                                                                                                                                                                                              | `PAYROLL.INPUTS_LOCKED`                                     | `PAYROLL_CYCLE_STATE` → all HR users ("Payroll inputs are locked — attendance can now be submitted")                                                       |
| PAY-4  | `INPUTS_LOCKED` → `ATTENDANCE_SUBMITTED`                                                                                                     | `POST /attendance/periods/:id/submit` (same transaction as `ATT-2`) | HR `attendance:submit`                                  | `attendance.period_is_hr_submitted`                                                                                                                                                                 | — (all attendance effects are in `ATT-2`/`ATT-3`)                                                                                                                                                                                                                                                                                                                                                                                                            | `PAYROLL.ATTENDANCE_SUBMITTED`                              | `ATTENDANCE_APPROVAL_PENDING` → every manager with a slice                                                                                                 |
| PAY-5  | `ATTENDANCE_SUBMITTED` → `ATTENDANCE_APPROVED`                                                                                               | System, evaluated after every `attendance_approval` decision        | _system_                                                | `attendance.every_slice_approved` (R-2)                                                                                                                                                             | `attendance_period.status = 'APPROVED'`, `approvals_completed_at = now()`                                                                                                                                                                                                                                                                                                                                                                                    | `PAYROLL.ATTENDANCE_APPROVED`                               | `PAYROLL_CYCLE_STATE` → all ACCOUNTS users ("Attendance for August 2026 is fully approved — payroll can be validated")                                     |
| PAY-6  | `ATTENDANCE_SUBMITTED` → `INPUTS_LOCKED`                                                                                                     | `POST /attendance/periods/:id/reopen`                               | HR `attendance:reopen`                                  | `attendance.any_slice_rejected`, `approval.note_required`                                                                                                                                           | `attendance_period` → `OPEN`; rejected records → `DRAFT`; the live `attendance_submission` keeps its row and is superseded on resubmit                                                                                                                                                                                                                                                                                                                       | `PAYROLL.ATTENDANCE_RETURNED`                               | `PAYROLL_CYCLE_STATE` → HR + the rejecting manager                                                                                                         |
| PAY-7  | `ATTENDANCE_APPROVED` → `VALIDATING`                                                                                                         | `POST /cycles/:id/validate`                                         | ACCOUNTS `payroll:validate`                             | `payroll.attendance_locked`                                                                                                                                                                         | `attendance_period` → `LOCKED`; every `attendance_record` → `LOCKED`; every approved `leave_request` overlapping the period gets `attendance_record_id` set (freezes it against withdrawal); `validation_pass_no += 1`; the scope snapshot (A-1) is written                                                                                                                                                                                                  | `PAYROLL.VALIDATION_STARTED`                                | —                                                                                                                                                          |
| PAY-8  | `VALIDATING` → `VALIDATED`                                                                                                                   | System, at the end of the validation pass                           | _system_                                                | `payroll.no_error_validations`                                                                                                                                                                      | `validated_at = now()`; `employee_count = count(payroll_cycle_employee WHERE disposition='INCLUDED')`                                                                                                                                                                                                                                                                                                                                                        | `PAYROLL.VALIDATED`                                         | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                                                           |
| PAY-9  | `VALIDATING` → `VALIDATION_FAILED`                                                                                                           | System                                                              | _system_                                                | `payroll.has_error_validations`                                                                                                                                                                     | Findings persist in `payroll_validation_result` for this `validation_pass_no`                                                                                                                                                                                                                                                                                                                                                                                | `PAYROLL.VALIDATION_FAILED`                                 | `PAYROLL_CYCLE_STATE` → ACCOUNTS **and** HR for each finding whose remedy is an HR action (see §1.5 "Owner" column)                                        |
| PAY-10 | `VALIDATION_FAILED` → `INPUTS_OPEN`                                                                                                          | `POST /cycles/:id/reopen-inputs`                                    | ACCOUNTS `payroll:cycle:transition`                     | `approval.note_required`                                                                                                                                                                            | Unlocks input batches for supersession; `inputs_locked_at = NULL`; attendance stays `LOCKED` unless separately reopened (`ATT-8`)                                                                                                                                                                                                                                                                                                                            | `PAYROLL.INPUTS_REOPENED`                                   | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR                                                                                                                      |
| PAY-11 | `VALIDATION_FAILED` → `VALIDATING`                                                                                                           | `POST /cycles/:id/validate`                                         | ACCOUNTS `payroll:validate`                             | —                                                                                                                                                                                                   | `validation_pass_no += 1`; a new scope snapshot replaces the previous pass's rows                                                                                                                                                                                                                                                                                                                                                                            | `PAYROLL.REVALIDATION_STARTED`                              | —                                                                                                                                                          |
| PAY-12 | `VALIDATED` → `CALCULATING`                                                                                                                  | `POST /cycles/:id/calculate`                                        | ACCOUNTS `payroll:calculate`                            | `payroll.validated_recently`, `payroll.employee_set_unchanged`, `payroll.no_lop_override_after_lock`                                                                                                | Creates `payroll_run` (`run_no = max+1`, `status='QUEUED'`, `engine_version`, `ruleset_sha256`, `input_manifest_sha256`); `calculated_by_user_id` recorded                                                                                                                                                                                                                                                                                                   | `PAYROLL.CALCULATION_STARTED`                               | —                                                                                                                                                          |
| PAY-13 | `CALCULATING` → `CALCULATED`                                                                                                                 | System, on run completion                                           | _system_                                                | `payroll.run_succeeded`, `payroll.payslip_count_matches_employee_count`, `payroll.controls_balance`                                                                                                 | `payslip_count`, `control_gross_minor`, `control_net_minor` write-once; `calculated_at`; `payroll_cycle_employee.payslip_id` backfilled; `employee_tax_projection` rows written with `is_current` flipped                                                                                                                                                                                                                                                    | `PAYROLL.CALCULATED`                                        | `PAYROLL_CYCLE_STATE` → ACCOUNTS ("August 2026 payroll calculated — 214 payslips awaiting approval")                                                       |
| PAY-14 | `CALCULATING` → `VALIDATION_FAILED`                                                                                                          | System, on run failure                                              | _system_                                                | `payroll.run_failed`                                                                                                                                                                                | `payroll_run.status='FAILED'` + `error_message`; **every payslip produced by that run is deleted inside the same transaction that failed** (the run is atomic — see §1.10.1)                                                                                                                                                                                                                                                                                 | `PAYROLL.CALCULATION_FAILED`                                | `PAYROLL_CYCLE_STATE` → ACCOUNTS, tone RED                                                                                                                 |
| PAY-15 | `CALCULATED` → `APPROVED`                                                                                                                    | `POST /cycles/:id/approve`                                          | ACCOUNTS `payroll:approve` (**a second Accounts user**) | `payroll.distinct_approver`, `payroll.controls_balance`                                                                                                                                             | `approved_at`, `approved_by_user_id`                                                                                                                                                                                                                                                                                                                                                                                                                         | `PAYROLL.RUN_APPROVED`                                      | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                                                           |
| PAY-16 | `CALCULATED` → `VALIDATED`                                                                                                                   | `POST /cycles/:id/discard-run`                                      | ACCOUNTS `payroll:cycle:transition`                     | `approval.note_required`, `payroll.no_published_payslips`                                                                                                                                           | Live `payroll_run` → `SUPERSEDED`; every payslip of that run → `SUPERSEDED`; `payslip_count`/controls reset to `NULL`; `payroll_cycle_employee.payslip_id = NULL`                                                                                                                                                                                                                                                                                            | `PAYROLL.RUN_DISCARDED`                                     | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                                                           |
| PAY-17 | `APPROVED` → `PUBLISHED`                                                                                                                     | `POST /cycles/:id/publish`                                          | ACCOUNTS `payroll:publish` (**a third Accounts user**)  | `payroll.distinct_publisher` (R-8), `payroll.every_payslip_generated`, `payroll.pay_date_set`, `payroll.no_published_payslips`, `payslip.publication_row_created` — **step-up MFA required** (§0.9) | For each payslip: `status='PUBLISHED'`, one `payslip_publication` row, PDF render job enqueued, `payslip_fy_rollup` folded, `tds_quarter` recomputed, `employee_tax_regime_election.is_locked=true` **for each employee in this run** whose FY election is not yet locked (per employee, not per organisation — a January joiner must still be able to elect); linked `reimbursement_batch` → `PAID` and its claims → `REIMBURSED`; `actual_pay_date` frozen | `PAYROLL.PUBLISHED` (+ one `PAYSLIP.PUBLISHED` per payslip) | `PAYSLIP_PUBLISHED` → every employee in the run; `PAYSLIP_PUBLISHED` email → each employee's work email (notification only, **never** an attached payslip) |
| PAY-18 | `PUBLISHED` → `CLOSED`                                                                                                                       | `POST /cycles/:id/close`                                            | ACCOUNTS `payroll:close`                                | `payroll.pay_date_passed`, `payroll.reimbursements_settled`                                                                                                                                         | `closed_at`; the period is now immutable; the next period's cycle may be created                                                                                                                                                                                                                                                                                                                                                                             | `PAYROLL.CLOSED`                                            | —                                                                                                                                                          |
| PAY-19 | `DRAFT`\|`INPUTS_OPEN`\|`INPUTS_LOCKED`\|`ATTENDANCE_SUBMITTED`\|`ATTENDANCE_APPROVED`\|`VALIDATED`\|`VALIDATION_FAILED` → `CANCELLED` (R-6) | `POST /cycles/:id/cancel`                                           | ACCOUNTS `payroll:cycle:transition`                     | `payroll.no_payslips_exist`, `approval.note_required`                                                                                                                                               | `cancelled_at`, `cancel_reason`; paired `attendance_period` → `REOPENED` then `OPEN` (it is reusable by a replacement cycle); every input batch → `DISCARDED`; every linked reimbursement batch → back to `LOCKED` and re-targeted                                                                                                                                                                                                                           | `PAYROLL.CANCELLED`                                         | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR, tone RED                                                                                                            |

| PAY-20 | `ATTENDANCE_APPROVED` → `INPUTS_LOCKED` | `POST /attendance/periods/:id/reopen` (ATT-7) | HR `attendance:reopen` | `attendance.cycle_not_calculated`, `approval.note_required` | `attendance_period` → `REOPENED` → `OPEN` (ATT-7/ATT-9); every affected `attendance_record` → `DRAFT`; the live `attendance_submission` is superseded at the next ATT-2 | `PAYROLL.ATTENDANCE_REOPENED` | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR, tone AMBER |
| PAY-21 | `VALIDATED` → `VALIDATING` (R-5) | `POST /cycles/:id/validate` | ACCOUNTS `payroll:validate` | — | `validation_pass_no += 1`; the scope snapshot is **upserted**, preserving dispositions (R-10) | `PAYROLL.REVALIDATION_STARTED` | — |
| PAY-22 | `VALIDATED` → `INPUTS_LOCKED` (R-6) | `POST /attendance/periods/:id/reopen` (ATT-8) | HR `attendance:reopen` | `attendance.cycle_not_calculated`, `approval.note_required` | As PAY-20; `validated_at = NULL` so a stale validation cannot be reused | `PAYROLL.ATTENDANCE_REOPENED` | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR, tone AMBER |
| PAY-23 | `INPUTS_LOCKED` → `VALIDATING` (R-7) | `POST /cycles/:id/validate` | ACCOUNTS `payroll:validate` | `payroll.cycle_kind_not_regular`, `payroll.parent_cycle_published` | The supplementary/off-cycle path of §1.10.4; the parent's `LOCKED` attendance records are read, never re-approved | `PAYROLL.VALIDATION_STARTED` | — |
| PAY-24 | `CALCULATED` → `CANCELLED` | — | — | **Not a transition.** Listed to be explicit: a calculated cycle is discarded with PAY-16 first, then cancelled with PAY-19 from `VALIDATED`. Cancelling while payslips exist is refused by `payroll.no_payslips_exist`. | — | — |

There is **no** transition out of `PUBLISHED` other than `CLOSED`. Corrections are §1.10.3.

**Reachability, asserted.** `db:verify-schema` proves two properties over the seeded
`state_transition` rows for `machine='payroll_cycle'`: (a) every non-terminal state has at
least one outgoing row, so no state is a dead end — this is what PAY-21 and PAY-22 exist
to restore; and (b) every state is reachable from `DRAFT`. A cycle that can enter a state
it cannot leave is a production incident with no recovery route, which is exactly what
`VALIDATED` was before R-5.

### 1.4 Sub-machines

#### 1.4.1 `payroll_input_batch` — the Accounts upload

| #     | from → to                           | Actor                             | Guards                                                                                                                                 | Effects                                                                                                                                                                          |
| ----- | ----------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PIB-1 | `NULL` → `UPLOADING`                | ACCOUNTS `payroll:input:upload`   | cycle is `INPUTS_OPEN`; `file_sha256` not already present on this cycle (`ux_pib__cycle_file_sha`)                                     | `file_object` row (`purpose='PAYROLL_INPUT_UPLOAD'`, `scan_status='PENDING'`)                                                                                                    |
| PIB-2 | `UPLOADING` → `PARSED`              | _system_ (parser job)             | file `scan_status='CLEAN'`; MIME and extension both in `{text/csv, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet}` | `payroll_input_item` per row; `row_count_*`; `parsed_total_minor`; per-row `is_rejected` + `rejection_reason` for unresolvable employee numbers, bad amounts, unknown components |
| PIB-3 | `UPLOADING` → `PARSE_FAILED`        | _system_                          | parse threw, or the file was `INFECTED`/`SCAN_FAILED`                                                                                  | `parse_error` jsonb (line/column/message); no items                                                                                                                              |
| PIB-4 | `PARSED` → `VALIDATED`              | _system_, immediately after PIB-2 | `declared_total_minor IS NULL OR declared_total_minor = parsed_total_minor`; `row_count_rejected = 0`                                  | —                                                                                                                                                                                |
| PIB-5 | `PARSED`\|`VALIDATED` → `DISCARDED` | ACCOUNTS `payroll:input:upload`   | cycle still `INPUTS_OPEN`; note required                                                                                               | items cascade-deleted; the `file_object` is retained as evidence                                                                                                                 |
| PIB-6 | `VALIDATED` → `COMMITTED`           | ACCOUNTS `payroll:input:commit`   | cycle `INPUTS_OPEN`; no duplicate `(employee, kind, pay_component)` against another committed batch unless the component is additive   | `committed_at`, `committed_by_user_id`                                                                                                                                           |
| PIB-7 | `COMMITTED` → `SUPERSEDED`          | ACCOUNTS `payroll:input:commit`   | a replacement batch reached `COMMITTED`; cycle in `INPUTS_OPEN` (reached via PAY-10 if it had been locked)                             | `superseded_by_batch_id`; superseded items are excluded from the generator by the `WHERE NOT is_rejected AND batch.status='COMMITTED'` predicate                                 |

Audit: `PAYROLL.INPUT_UPLOADED`, `…PARSED`, `…PARSE_FAILED`, `…COMMITTED`,
`…SUPERSEDED`, `…DISCARDED`. A parse failure never notifies anyone outside ACCOUNTS and
never surfaces a filename or row content to an employee surface.

**A batch cannot be uploaded outside `INPUTS_OPEN`.** This is the enforcement of "Accounts
uploads _first_": once the cycle is `INPUTS_LOCKED` no further payroll data enters it, and
attendance cannot be submitted until it is (`attendance.payroll_inputs_locked`).

#### 1.4.2 `payroll_run`

`NULL → QUEUED` (PAY-12) · `QUEUED → RUNNING` (_system_, worker lease) ·
`RUNNING → SUCCEEDED` (_system_, all payslips written, controls balanced) ·
`RUNNING → FAILED` (_system_, any error) · `SUCCEEDED → SUPERSEDED` (PAY-16, or a
correction run replacing it). `ux_payroll_run__one_live` guarantees at most one
`SUCCEEDED` non-superseded run per cycle.

### 1.5 The validation checklist (the exact gate before generation)

Run in `VALIDATING` under `validation_pass_no = n`. The pass first resolves **scope**,
then evaluates every rule for every in-scope employee, writing one
`payroll_validation_result` per finding.

**Scope resolution (deterministic).** In-scope employees are those with
`employee.employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD')` on
`payroll_cycle.period_end`, **plus** employees with `employment_status = 'EXITED'` whose
`date_of_exit` falls inside `[period_start, period_end]` (final settlement), **plus**
employees with `date_of_joining <= period_end` who joined mid-period. Excluded outright:
`PRE_JOINING` with `date_of_joining > period_end`, `SUSPENDED` where
`employee_employment.pay_suspended = true`, and `is_service_account` users. The resolved
set is written to `payroll_cycle_employee` (A-1) with `disposition = 'INCLUDED'`.

#### Rule table

| Rule code                     | Severity | Owner    | Predicate (fails when…)                                                                                                                                                                                                                                                                                                                                    | Disposition on failure                                                                                                                                            |
| ----------------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAY_NO_SALARY_STRUCTURE`     | ERROR    | ACCOUNTS | No `salary_structure` row whose `[effective_from, effective_to]` covers `period_end`                                                                                                                                                                                                                                                                       | **Blocking** until resolved or the employee is explicitly `DEFERRED`                                                                                              |
| `PAY_STRUCTURE_ZERO_BASIC`    | ERROR    | ACCOUNTS | The resolved structure has no `BASIC` component, or its amount is ≤ 0                                                                                                                                                                                                                                                                                      | Blocking / deferrable                                                                                                                                             |
| `PAY_CTC_MISSING`             | WARNING  | ACCOUNTS | `annual_ctc_minor` absent — only benefits of kind `MULTIPLE_OF_CTC` are affected                                                                                                                                                                                                                                                                           | Informational; the benefit line is omitted, never guessed                                                                                                         |
| `PAY_ATTENDANCE_MISSING`      | ERROR    | HR       | No `attendance_record` for `(period, employee)`                                                                                                                                                                                                                                                                                                            | **Blocking** — never deferrable: a missing record means the mandated HR/Manager steps did not happen for this person                                              |
| `PAY_ATTENDANCE_NOT_APPROVED` | ERROR    | MANAGER  | The employee's `attendance_record.status <> 'LOCKED'`, or its slice is not `APPROVED`/`AUTO_ESCALATED`                                                                                                                                                                                                                                                     | **Blocking**, not deferrable — same reason                                                                                                                        |
| `PAY_LOP_EXCEEDS_ELIGIBLE`    | ERROR    | HR       | `lop_days > eligible_days` (also a DB `CHECK`; a finding here means data drift)                                                                                                                                                                                                                                                                            | Blocking                                                                                                                                                          |
| `ATT_TOTALS_DRIFT`            | ERROR    | HR       | Σ `payable_days`/`lop_days` over locked records ≠ the control totals on the live `attendance_submission`                                                                                                                                                                                                                                                   | Blocking, cycle-level                                                                                                                                             |
| `PAY_BANK_UNVERIFIED`         | ERROR    | HR       | No current `employee_bank_account` with `is_primary AND is_verified AND effective_to IS NULL`                                                                                                                                                                                                                                                              | **Deferrable** (see disposition rule below)                                                                                                                       |
| `PAY_TDS_MISSING_PAN`         | ERROR    | HR       | No `employee_statutory_id` of kind `PAN` (required to deduct TDS at the normal rate rather than 20 % u/s 206AA)                                                                                                                                                                                                                                            | **Deferrable**; if the employee is retained, TDS is computed at the higher-rate fallback and the finding is recorded as _accepted_, never silently ignored        |
| `PAY_UAN_MISSING`             | WARNING  | HR       | `pf_applicable` and no `UAN`/`PF_ACCOUNT` statutory id                                                                                                                                                                                                                                                                                                     | Informational; PF is still computed and remitted against the employee number                                                                                      |
| `PAY_ESI_ID_MISSING`          | WARNING  | HR       | ESI applies this contribution period and no `ESI` statutory id exists                                                                                                                                                                                                                                                                                      | Informational                                                                                                                                                     |
| `PAY_NO_TAX_REGIME_ELECTION`  | WARNING  | ACCOUNTS | No `employee_tax_regime_election` for the FY                                                                                                                                                                                                                                                                                                               | Resolved deterministically by falling back to `tax_regime.is_default`; the fallback is **recorded on the payslip's `input_snapshot`** as `regimeSource:"DEFAULT"` |
| `PAY_PT_STATE_UNMAPPED`       | ERROR    | ACCOUNTS | The employee's work-location state has no `statutory_pt_slab` effective for the period                                                                                                                                                                                                                                                                     | **Blocking** (cycle-level if it affects a whole location) — deducting the wrong professional tax is a statutory breach                                            |
| `PAY_INPUT_ORPHAN_EMPLOYEE`   | ERROR    | ACCOUNTS | A committed `payroll_input_item` names an employee not in scope                                                                                                                                                                                                                                                                                            | Blocking — the upload is wrong, not the employee                                                                                                                  |
| `PAY_DUPLICATE_INPUT`         | ERROR    | ACCOUNTS | Two committed, non-rejected items for the same `(employee, pay_component, kind)` where the component is not additive                                                                                                                                                                                                                                       | Blocking                                                                                                                                                          |
| `PAY_ARREAR_PERIOD_UNKNOWN`   | ERROR    | ACCOUNTS | `kind='ARREAR'` with `effective_period_code` absent or naming a cycle that never published                                                                                                                                                                                                                                                                 | Blocking                                                                                                                                                          |
| `PAY_REIMBURSEMENT_ORPHAN`    | ERROR    | ACCOUNTS | A `REIMBURSEMENT_PAYOUT` item whose `expense_claim` is not `QUEUED_FOR_PAYMENT`                                                                                                                                                                                                                                                                            | Blocking                                                                                                                                                          |
| `PAY_INPUT_UNRESOLVED_ERROR`  | ERROR    | ACCOUNTS | Any `payroll_input_item.is_rejected` in a **committed** batch                                                                                                                                                                                                                                                                                              | Blocking                                                                                                                                                          |
| `PAY_NEGATIVE_NET`            | ERROR    | ACCOUNTS | Dry-run net pay < 0 (recoveries exceed earnings)                                                                                                                                                                                                                                                                                                           | **Deferrable**; the usual remedy is to move the recovery to a later cycle                                                                                         |
| `PAY_GROSS_DEVIATION`         | WARNING  | ACCOUNTS | Dry-run gross deviates from the employee's **last published** gross by more than `org_setting.payroll_gross_deviation_pct` (seeded `25`). **Not raised when the employee has no published payslip in this organisation** — a first payslip has nothing to deviate from, and comparing against zero would manufacture a 100 % deviation on every new joiner | Informational — a reviewer's prompt, never a block                                                                                                                |
| `PAY_CONTROL_TOTAL_MISMATCH`  | ERROR    | ACCOUNTS | Σ committed input amounts ≠ Σ `payroll_input_batch.parsed_total_minor`                                                                                                                                                                                                                                                                                     | Blocking, cycle-level                                                                                                                                             |
| `PAY_EXITED_EMPLOYEE_NO_FNF`  | WARNING  | HR       | An in-scope employee exited in-period with no final-settlement input items                                                                                                                                                                                                                                                                                 | Informational                                                                                                                                                     |

`payroll.no_error_validations` (the PAY-8 guard) is exactly:

```sql
NOT EXISTS (
  SELECT 1 FROM payroll_validation_result v
  WHERE v.payroll_cycle_id = :cycle
    AND v.validation_pass_no = :pass
    AND v.severity = 'ERROR'
    AND v.resolved_at IS NULL)
```

#### Per-employee failure: block the cycle, or exclude the employee?

**Decision: neither silently. A cycle-level ERROR blocks; a per-employee ERROR blocks
until a human resolves it, and the only two resolutions are (a) fix the data and
re-validate, or (b) record an explicit, audited, reasoned exclusion.** There is no
automatic exclusion anywhere in the system.

The mechanics:

- Every ERROR finding must reach `resolved_at IS NOT NULL` before PAY-8 can fire.
- `POST /cycles/:id/validations/:vid/resolve` (`payroll:validate`) marks a finding
  resolved **only after re-evaluating its predicate** — an unfixed finding cannot be
  waved through. Audit `PAYROLL.VALIDATION_RESOLVED`.
- `POST /cycles/:id/scope/:employeeId/defer` (`payroll:cycle:transition`, note ≥ 10
  chars) sets `payroll_cycle_employee.disposition = 'DEFERRED'`, records
  `exclusion_reason_code` = the blocking rule code, `excluded_by_user_id`, `excluded_at`,
  and marks that employee's findings resolved with
  `resolution_note = 'DEFERRED: <note>'`. Audit `PAYROLL.EMPLOYEE_DEFERRED`.
  Notifications: `PAYROLL_CYCLE_STATE` to HR (so the underlying data gets fixed) — **not**
  to the employee, because at this point they have nothing actionable and no payslip
  exists to explain; the employee is notified when the carry-forward cycle publishes.
- Deferral is **forbidden** for `PAY_ATTENDANCE_MISSING` and
  `PAY_ATTENDANCE_NOT_APPROVED`. Those two mean the mandated workflow did not run for
  that person; excluding them would let payroll proceed while silently skipping the
  control the user mandated. They must be fixed (ATT-7/ATT-8 reopen → capture → submit →
  approve).

* A deferral **survives re-validation**. PAY-11/PAY-21 upsert the scope snapshot on
  `(payroll_cycle_id, employee_id)` and carry `disposition`, `exclusion_reason_code`,
  `exclusion_note`, `excluded_by_user_id`, `excluded_at` and `carry_to_cycle_id` forward
  untouched (R-10). The earlier "a new scope snapshot replaces the previous pass's rows"
  rule silently destroyed audited human decisions on every re-validation and is withdrawn.
  A deferral is reversed only by `POST /cycles/:id/scope/:employeeId/undefer`
  (`payroll:cycle:transition`, note ≥ 10 chars, audit `PAYROLL.EMPLOYEE_UNDEFERRED`),
  which also re-opens the findings that the deferral had marked resolved.

- An employee who leaves scope between passes (exited before `period_end`, or the
  employment record changed) has their row set to `disposition='EXCLUDED'` with
  `exclusion_reason_code='SCOPE_CHANGED'` and a system note; the row is never deleted, so
  "who was considered and why they are not here" is answerable for every pass.
- A `DEFERRED` employee is carried automatically: at PAY-1 of the next cycle, every
  `payroll_cycle_employee` row with `disposition='DEFERRED'` and
  `carry_to_cycle_id IS NULL` on a `CLOSED`/`PUBLISHED` cycle has `carry_to_cycle_id` set
  to the new cycle, and the new cycle's scope resolution force-includes them with an
  `ARREAR` expectation. The HR "Payroll exceptions" screen lists them until settled, so a
  deferral can never be forgotten.

**Justification.** Blocking the whole cycle for one unverified bank account would delay
every employee's salary — a disproportionate, and in India a statutorily risky, outcome.
Silently excluding an employee would be worse: an employee would simply not be paid, with
no record of why and no notification path. The middle position — _stop, name the person,
name the rule, require a human with `payroll:cycle:transition` to write a reason, carry
them forward, keep them on an exceptions list_ — satisfies "no invented data", keeps the
run deterministic and reproducible, and leaves a complete audit trail. The two attendance
rules are excepted from deferral precisely because they are the user's mandated control
points.

### 1.6 Partial manager approval — tracking who still owes

Slices are created at `ATT-3` (§2.3): one `attendance_approval` per distinct
`attendance_record.manager_employee_id` in the period, each with `record_count`,
`total_payable_days`, `total_lop_days` and `due_at = assigned_at + org SLA`. The union of
slices covers every record exactly once (`ATT-INV-3`).

**Who still owes** is one indexed read:

```sql
SELECT aa.manager_employee_id, e.full_name, aa.record_count, aa.due_at,
       (aa.due_at < now()) AS is_overdue
FROM attendance_approval aa
JOIN employee e ON e.id = aa.manager_employee_id
WHERE aa.attendance_period_id = :period
  AND (aa.status NOT IN ('APPROVED','AUTO_ESCALATED') OR aa.decided_at IS NULL)
ORDER BY aa.due_at;
```

This drives the HR "Attendance approvals" progress card: `approved / total` slices,
`records covered / records total`, and the named list of outstanding managers. With zero
outstanding slices the card renders the completed state; it never renders a percentage
derived from anything but these counts.

**Completion.** After **every** `attendance_approval` decision, in the same transaction,
the service re-evaluates R-2's predicate. When it holds it performs `ATT-6`
(`MANAGER_APPROVAL_PENDING → APPROVED`) and `PAY-5`
(`ATTENDANCE_SUBMITTED → ATTENDANCE_APPROVED`) as system transitions. The cycle therefore
learns of completion synchronously with the last manager's click; no polling job is
involved, and no partial state can be mistaken for completion.

**Reminders and escalation.** Job `attendance-approval-reminder` runs hourly:

| Condition                                      | Action                                                                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `due_at - now() <= 24h` and `status='PENDING'` | `ATTENDANCE_APPROVAL_PENDING` notification, `source_rule_code='ATT_APPROVAL_DUE_24H'`                                                                                                       |
| `now() > due_at` and `status='PENDING'`        | `ATTENDANCE_APPROVAL_PENDING` notification to the manager (`ATT_APPROVAL_OVERDUE`) **and** to their manager's manager from `employee_reporting_closure` (`ATT_APPROVAL_OVERDUE_ESCALATION`) |
| `now() > due_at + org escalation window`       | The slice appears in HR's escalation queue; HR may act under `attendance:approve:any` (**AAP-4**, §2.4)                                                                                     |

The dedupe constraint `ux_notification__dedupe` makes each of these fire exactly once per
manager per period per rule code, so the bell count is exact.

### 1.7 Generation (`CALCULATING`)

The run is a single worker task holding a **transaction-scoped** advisory lock on the
cycle (`pg_advisory_xact_lock(hashtext('payroll:' || payroll_cycle_id))`) and executing in
**one database transaction**. The lock must be transaction-scoped: a session-scoped
`pg_advisory_lock` is **not** released when the transaction rolls back, so a crashed run
would hold the cycle hostage until the connection died — and with a transaction pooler in
front of Postgres it could be inherited by an unrelated request. Steps:

1. `SELECT … FROM payroll_cycle WHERE id = :cycle FOR UPDATE` — re-assert `CALCULATING`.
2. Re-assert `payroll.validated_recently`
   (`validated_at > now() - make_interval(hours => org_setting.payroll_validation_max_age_hours)`,
   seeded `24`) **and** `payroll.employee_set_unchanged` (the scope predicate re-derived
   now hashes to `payroll_cycle.employee_set_sha256`, frozen at `VALIDATED`) **and** that
   no `payroll_input_item`, `attendance_record` or `salary_structure` in the manifest has
   `updated_at > validated_at`. A failure aborts the run as `FAILED` with
   `PAY_INPUTS_CHANGED_SINCE_VALIDATION` or `PAY_SCOPE_CHANGED_SINCE_VALIDATION` — it
   never proceeds on a stale validation, and it never silently re-resolves scope inside
   the run, because scope is a reviewed decision (§1.5), not a side effect of timing.
3. Compute `input_manifest_sha256` over the **ordered** (by id) list of every
   `payroll_input_item.id`, `attendance_record.id` and `salary_structure.id` the run will
   read, and `ruleset_sha256` over the active `pay_component` set plus the resolved
   `statutory_rate_set` and `statutory_pt_slab` rows. Both are stored on `payroll_run`
   before any payslip is written.
4. For each `payroll_cycle_employee` with `disposition = 'INCLUDED'`, ordered by
   `employee.employee_number` (a stable order makes the run byte-reproducible), execute
   the calculation of §1.9 and insert one `payslip` (`status='GENERATED'`, `revision=1`)
   plus its `payslip_line` rows plus one `employee_tax_projection` row.
5. Accumulate `Σ gross`, `Σ net`, `Σ deductions` and assert
   `gross - deductions = net` for every payslip and in aggregate
   (`payroll.controls_balance`). The sums are computed in the API over decrypted values
   inside the transaction — `payslip.gross_minor` and friends are encrypted at rest, so no
   SQL `SUM()` over them is possible, and any design that reads a plaintext aggregate
   column instead would be reading a number nothing re-derives.
6. Write `payroll_run.status='SUCCEEDED'`, `payslip_count`, `employee_count`.
7. Perform PAY-13 inside the same transaction.

**Runtime requirement.** The run is a long-lived, single-leader background task. It cannot
execute on a request-scoped serverless function: it holds one transaction across every
employee in the organisation, and §11.5's determinism test requires the same process to
produce byte-identical output twice. §0.11 states where such work runs.

Any error at any step rolls the whole transaction back: `payroll_run` is re-inserted in a
fresh short transaction with `status='FAILED'` and `error_message`, and PAY-14 fires. **A
partially generated run cannot exist** — this is what makes `PAY-14`'s "payslips deleted"
effect trivially true.

### 1.8 The hard visibility rule, and where it is enforced

> A `payslip` row must not exist before the run reaches generation, and must not be
> readable by the employee before publication.

Four independent layers, each sufficient on its own:

| Layer                      | Control                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Database — existence**   | `trg_payslip_requires_calculating` (R-4) rejects any `INSERT` into `payslip` unless the owning cycle is `CALCULATING` (or a `CORRECTION` run is `CALCULATING`). `DELETE` is rejected outright; `UPDATE` is restricted by `trg_payslip_immutable` to `status`, `pdf_file_object_id`, `supersedes_payslip_id`, `revoked_at/reason` and the audit columns.                                                                                                            |
| **Database — readability** | RLS policy `rls_payslip_self` on `payslip`: an actor whose effective permission is `payslip:read:self` may see a row only when `employee_id = current_setting('ess.actor_employee_id')::uuid` **and** `EXISTS (SELECT 1 FROM payslip_publication pub WHERE pub.payslip_id = payslip.id AND pub.published_at <= now() AND pub.revoked_at IS NULL)`. `payslip:read:any` (ACCOUNTS) is a separate policy and every read under it writes a `READ_SENSITIVE` audit row. |
| **Query layer**            | The only function in the employee code path is `payslipRepo.findPublishedForEmployee()`, which emits exactly the query of `DATA-MODEL.md §10.7`. An ESLint rule (`no-restricted-syntax` on `tx.payslip` / `prisma.payslip` outside `apps/api/src/payroll/payslip.repository.ts`) plus a CI grep make any other access path a build failure.                                                                                                                        |
| **Authorization**          | The route `GET /api/v1/me/payslips` requires `payslip:read:self`; the scope predicate forces `employee_id = ctx.employee_id`. There is no employee-facing route that accepts a `payrollCycleId` or a `payslipId` belonging to another employee — IDs are resolved against the actor's own set first (`SECURITY.md §4.6`, no-IDOR pattern).                                                                                                                         |

Before publication the Payslips screen renders its designed empty state, with copy driven
by the employee's earliest in-scope `payroll_cycle.status` (`INPUTS_OPEN` → "August 2026
payroll is being prepared"; `ATTENDANCE_SUBMITTED`/`ATTENDANCE_APPROVED` → "August 2026
payroll is in review"; no cycle at all → "Your first payslip will appear here after your
first payroll run"). It never renders a draft, a provisional total or a synthetic figure.

A **published** payslip may be revoked (`payslip_publication.revoked_at` +
`payslip.status='REVOKED'`) only as part of a correction (§1.10.3), by ACCOUNTS under
`payroll:publish` with a mandatory reason, and the revocation is itself notified to the
employee — a payslip never silently disappears.

### 1.9 The deterministic payslip calculation spec

**Contract:** for a fixed `(engine_version, ruleset_sha256, input_manifest_sha256)` the
engine is a pure function. Re-running it must produce byte-identical
`payslip_line.amount_minor` values and an identical `input_sha256`. This is asserted by a
CI golden-file test and by the `audit-chain-verify` job's payroll spot-check.

All arithmetic below is on integer **paise** with exact rational intermediates.

#### 1.9.0 Inputs resolved (in this order, all from persisted state)

```
AP  = attendance_period            (label, start, end, total_calendar_days)
AR  = attendance_record            (eligible_days, lop_days, payable_days, overtime_hours)
SS  = salary_structure effective on AP.end_date  (+ its salary_structure_component rows)
EMP = employment_as_of(employee, AP.end_date)    (location → state, cost centre, type)
SE  = employee_statutory_election effective on AP.end_date
SR  = statutory_rate_set effective on AP.end_date
PT  = statutory_pt_slab for (SE.pt_state_code ?? EMP.location.state_code) on AP.end_date
REG = employee_tax_regime_election for the FY, else tax_regime.is_default
DEC = employee_tax_declaration (VERIFIED items only once the proof window closed;
                                SUBMITTED items accepted before it)
IN  = payroll_input_item WHERE payroll_cycle_id = cycle AND employee_id = emp
                           AND NOT is_rejected AND batch.status = 'COMMITTED'
YTD = Σ over published payslips of this employee in this fiscal_year
```

#### 1.9.1 Proration factor (LOP)

```
total_days    = AP.total_calendar_days                   -- 31
payable_days  = AR.payable_days = AR.eligible_days - AR.lop_days
factor        = payable_days / total_days                -- exact rational, never rounded
```

`payable_days` and `total_days` are exactly the two numbers the payslip renders as
`31 / 31`.

**The `LOP_OVERRIDE` input is persisted on the record, not applied invisibly.** The
earlier "replaces `AR.lop_days` for the calculation only" rule produced a payslip whose
LOP figure could not be reconciled with the attendance record the employee had been shown
and their manager had approved — two different numbers, one of them existing nowhere. The
corrected rule (R-15): `attendance_record` carries `lop_days_derived` (the fold of §3.7)
and `lop_source` (`DERIVED` | `HR_OVERRIDE` | `PAYROLL_INPUT_OVERRIDE`). A committed
`LOP_OVERRIDE` item writes `lop_days` and sets `lop_source='PAYROLL_INPUT_OVERRIDE'` on
the record **inside the PAY-7 transaction**, before the records are locked, so:

- the override is visible on the attendance screen before it reaches a payslip;
- `ATT_TOTALS_DRIFT` recomputes against the overridden totals, not the approved ones,
  and therefore **fires** — which is correct: changing approved attendance after the
  manager approved it must send the period back through ATT-8, not slip past it;
- `payroll.no_lop_override_after_lock` (a PAY-12 guard) refuses a run whose override was
  committed after `inputs_locked_at`, closing the window in which Accounts could alter
  attendance the manager had already signed off.

The original derived value, the override, the difference and the authorising
`payroll_input_item.id` are all recorded in `input_snapshot.attendance`.

Calendar-day basis (31/31, 30/30, 28/28) is used, not working-day basis: it is the
convention the prototype renders and it makes the monthly full-pay case exact
(`factor = 1`).

#### 1.9.2 Ordered earning components

Order is `pay_component.display_group = 'EARNINGS'` then `display_order` ascending, then
`code` as the tiebreaker. Seeded canonical order:

| Order | Code            | Name                   | Calculation                                                                     | Prorated |
| ----- | --------------- | ---------------------- | ------------------------------------------------------------------------------- | -------- |
| 10    | `BASIC`         | Basic salary           | `PRORATED_FIXED`                                                                | yes      |
| 20    | `HRA`           | House rent allowance   | `PRORATED_FIXED` (or `PERCENT_OF_BASIC` on the **prorated** basic)              | yes      |
| 30    | `CONVEYANCE`    | Conveyance allowance   | `PRORATED_FIXED`                                                                | yes      |
| 40    | `LTA`           | Leave travel allowance | `PRORATED_FIXED`                                                                | yes      |
| 50    | `SPECIAL`       | Special allowance      | `PRORATED_FIXED`                                                                | yes      |
| 60    | `OVERTIME`      | Overtime               | `INPUT_DRIVEN` (`quantity = AR.overtime_hours × rate`)                          | no       |
| 70    | `INCENTIVE`     | Performance incentive  | `INPUT_DRIVEN` (`VARIABLE_PAY`/`INCENTIVE`/`BONUS`)                             | no       |
| 80    | `ARREAR`        | Arrears                | `INPUT_DRIVEN` (`ARREAR`)                                                       | no       |
| 90    | `REIMBURSEMENT` | Expense reimbursement  | `INPUT_DRIVEN` (`REIMBURSEMENT_PAYOUT`) — **non-taxable**, `is_taxable = false` | no       |

Per component:

```
if calculation = PRORATED_FIXED:
    exact   = ssc.amount_minor × payable_days_hundredths
              ─────────────────────────────────────────    (payable_days_hundredths = payable_days × 100)
              total_days × 100
    amount  = roundHalfUp(exact)                       -- to the paisa
elif calculation = PERCENT_OF_BASIC:
    amount  = roundHalfUp(basic_prorated × (ssc.rate_override ?? pc.rate))
elif calculation = FIXED:
    amount  = ssc.amount_minor                         -- not prorated
elif calculation = INPUT_DRIVEN:
    amount  = Σ of the matching payroll_input_item amounts (each already integer paise)
```

```
GROSS            = Σ amount over all EARNING lines with amount ≠ 0
TAXABLE_GROSS    = Σ amount over EARNING lines where pay_component.is_taxable
ESI_GROSS        = Σ amount over EARNING lines where pay_component.is_esi_wage
PT_GROSS         = Σ amount over EARNING lines where pay_component.is_taxable   -- see below
NON_MONETARY     = Σ amount over EARNING lines where NOT pay_component.is_taxable
```

**Four bases, not one.** `GROSS` is what the payslip's earnings column totals and what
`NET = GROSS - TOTAL_DEDUCTIONS` uses. It is **not** the base for professional tax, ESI or
TDS, because it includes the `REIMBURSEMENT` line — money the employee already spent and
is being given back. Levying PT or TDS on a reimbursement over-deducts from the employee;
levying ESI on it over-charges both parties and misstates a statutory return. Each
statutory calculation below therefore names its own base explicitly, and
`db:verify-schema` asserts that every seeded `pay_component` has `is_taxable`,
`is_esi_wage` and a `statutory_key` set — a component with an unset flag is a component
whose statutory treatment nobody decided, and it fails the boot rather than defaulting.

A component resolving to `0` produces **no** `payslip_line` — an absent line is the
correct rendering of "you were not paid this", and the UI's earnings column simply has
fewer rows. Nothing is padded to make the column look full.

`LOP_DEDUCTION` is an **INFORMATIONAL** line (`display_group='INFO'`), present only when
`AR.lop_days > 0`, carrying
`amount = Σ(full monthly amount of each prorated component) - Σ(its prorated amount)`.
It is transparency, not a deduction, and it is excluded from `GROSS` and from
`TOTAL_DEDUCTIONS`.

#### 1.9.3 Provident fund (statutory)

```
pf_wage_full   = Σ amounts of components flagged statutory_key = 'EPF'   -- BASIC (+ DA if configured)
                 (already prorated in §1.9.2)
ceiling_pr      = roundHalfUp(SR.pf_wage_ceiling_minor × factor)          -- ceiling prorates with LOP
pf_wage        = SE.pf_wage_basis = 'CEILING' ? min(pf_wage_full, ceiling_pr) : pf_wage_full

PF_EE  = roundHalfUpToRupee(pf_wage × SR.pf_employee_rate)               -- 0.120000
VPF    = roundHalfUpToRupee(pf_wage × SE.vpf_rate)                       -- 0 unless elected
PF_ER_total = roundHalfUpToRupee(pf_wage × SR.pf_employer_rate)          -- 0.120000
PF_EPS = roundHalfUpToRupee(min(pf_wage, ceiling_pr) × SR.pf_eps_rate)   -- 0.083300
PF_ER  = PF_ER_total - PF_EPS                                            -- the EPF half
PF_ADMIN = roundHalfUpToRupee(pf_wage × SR.pf_admin_charge_rate)         -- R-13, employer cost
```

`PF_ER` is a **derived difference, not an independently rounded figure**: rounding
`PF_ER_total` and `PF_EPS` each to the rupee and subtracting keeps
`PF_ER + PF_EPS = PF_ER_total` exactly, which is the identity EPFO's ECR file requires. It
must not be recomputed as `pf_wage × (pf_employer_rate - pf_eps_rate)`, which can differ
by a rupee.

- `SE.pf_applicable = false` ⇒ no PF lines at all.
- The ceiling rule is a **per-employee election** (`CEILING` vs `ACTUAL`), never a global
  assumption, because both are lawful and the choice materially changes net pay.
- `PF_EE` and `VPF` are `DEDUCTION` lines; `PF_ER` and `PF_EPS` are
  `EMPLOYER_CONTRIBUTION` lines (they render in the payslip's employer column and feed
  the "PF contributed · employee + employer" YTD tile, which is
  `payslip_fy_rollup.employee_pf_minor + employer_pf_minor` — **not** `PF_EE × 2`).
- `PF_ADMIN` is an `EMPLOYER_CONTRIBUTION` line (R-13). It never affects `NET`; it exists
  so the employer-cost column on the payslip and in the payroll register is complete
  rather than silently short by the admin charge.
- `rate_applied` and `basis_amount_minor` are stored on each line, so the line is
  independently reproducible.
- **Every rate is read from `statutory_rate_set`, never from a literal.** The values in
  the comments above (`0.120000`, `0.083300`) are the seeded FY 2026–27 values shown for
  orientation; the engine reads the row effective on `AP.end_date` and hashes it into
  `ruleset_sha256`.

#### 1.9.4 Employees' State Insurance

```
esi_gross = ESI_GROSS  (§1.9.2 — excludes reimbursements and annual LTA by is_esi_wage)

applicable_this_period =
    SE.esi_applicable_override            -- an explicit, audited per-employee decision
      ?? ( decision_wage <= SR.esi_wage_threshold_minor )

decision_wage =
    -- the wage the applicability decision was taken on, resolved deterministically:
    (a) the ESI_GROSS of this employee's payslip for the FIRST month of the current
        contribution period, when one exists (read from payslip_line, not recomputed); else
    (b) the ESI_GROSS this engine is computing right now, when this is the employee's
        first month in the contribution period (a new joiner, or an employee whose first
        payslip falls in this period)
    -- there is no branch (c): the decision is never taken on a projected or annualised
    -- figure, and never on a figure that is not on a payslip or being written to one.

ESI_EE = roundUpToRupee(esi_gross × SR.esi_employee_rate)           -- statutory round-UP
ESI_ER = roundUpToRupee(esi_gross × SR.esi_employer_rate)
```

**Contribution-period freeze.** ESI applicability is decided once per contribution period
(`SR.esi_contribution_period_start_months`, default April and October) and held for the
whole period, even if wages cross the threshold mid-period. The decision, `decision_wage`,
which branch produced it, the source payslip id when branch (a) applied, and the period
boundaries are all stored in `input_snapshot.esi` and re-read (never re-derived) by every
later month of the same contribution period. A new joiner whose first month falls
mid-period is decided on branch (b) in that month and frozen from then on. Employees above the
threshold at the period start produce **no** ESI lines and the profile screen shows
`ESI — Not applicable`, which is a persisted derivation, not a placeholder.

#### 1.9.5 Professional tax

```
pt_wage  = CASE slab_set.pt_basis                       -- R-11, a persisted column
             WHEN 'GROSS_EXCL_NON_TAXABLE' THEN PT_GROSS      -- the seeded default
             WHEN 'BASIC_PLUS_DA'          THEN Σ EARNING lines whose statutory_key = 'EPF'
             WHEN 'GROSS'                  THEN GROSS
           END
slab     = the statutory_pt_slab row for (pt_state_code, AP.end_date) where
           pt_wage >= from_monthly_wage_minor
           AND (to_monthly_wage_minor IS NULL OR pt_wage <= to_monthly_wage_minor)
PT_raw   = (extract(month from AP.end_date) = ANY slab.applies_in_months)
             ? slab.monthly_amount_minor : 0
PT       = slab.annual_cap_minor IS NULL
             ? PT_raw
             : min(PT_raw, max(0, slab.annual_cap_minor - YTD.pt))   -- cap applied here, once
```

`pt_basis` defaults to `GROSS_EXCL_NON_TAXABLE`: professional tax is a tax on employment
income, and a reimbursement of the employee's own outlay is not income. Using the raw
`GROSS` (which includes `REIMBURSEMENT`) would push an employee into a higher slab in any
month they claimed an expense — a deduction that changes because someone bought a train
ticket. The basis is a per-state persisted decision precisely because states differ.

PT is a flat slab amount in whole rupees; it is never prorated by LOP (no state prorates
it) and never interpolated. The annual cap is applied in the formula above, once, against
the FY's PT already deducted (`YTD.pt` = Σ `PT` lines on this employee's published
payslips in this FY) — so the cap can never be exceeded and can never be double-applied by
a second code path. A `pt_wage` below the bottom slab's `from_monthly_wage_minor` yields
**no slab and `PT = 0`**, which is correct (states exempt low wages) and is recorded as
`pt: { slabId: null, reason: 'BELOW_LOWEST_SLAB' }` in `input_snapshot` — an absence with
a reason, not a silent zero. A `pt_wage` above every slab always matches, because the top
slab is open-ended (`to_monthly_wage_minor IS NULL`), which `db:verify-schema` asserts per
(state, effective range). An unmapped state is the blocking validation
`PAY_PT_STATE_UNMAPPED`; `pt_state_code` itself is
`SE.pt_state_code ?? EMP.location.state_code`, and a NULL on both sides is the same
blocking finding, never a guess.

#### 1.9.6 TDS — projected annual income under the elected regime

Every symbol below resolves to a persisted row. `REG` is the elected `tax_regime` **for
this fiscal year**, with its `tax_regime_slab` and `tax_regime_surcharge` children (R-12);
nothing in S1–S12 is a literal in code.

```
-- Cycle counting, defined once and used everywhere below.
-- fn_remaining_regular_cycles(employee, fiscal_year, this_cycle) counts REGULAR
-- payroll_cycle rows of this organisation for this fiscal_year whose period_start is
-- after this cycle's period_start, intersected with the employee's own expected service:
--   * an employee with date_of_exit set is counted only up to the cycle containing it;
--   * an employee with no date_of_exit is counted to the end of the FY.
-- Cycles that do not exist yet are counted from fiscal_year's twelve calendar months,
-- because a payroll cycle is opened one month at a time and the projection must not wait
-- for rows that will not exist until later. The count, the method and the employee's
-- assumed last month are recorded in employee_tax_projection.
remaining_cycles_after_this = fn_remaining_regular_cycles(EMP, FY, cycle)
remaining_cycles_incl_this  = remaining_cycles_after_this + 1

S1  annual_taxable_projection =
      YTD.taxable_gross                                         -- published payslips, this FY
    + current_period_taxable_gross                              -- TAXABLE_GROSS, §1.9.2
    + remaining_cycles_after_this × recurring_monthly_taxable   -- recurring = the PRORATED_FIXED/FIXED
                                                                --   components of the CURRENT salary
                                                                --   structure at FULL value (no LOP is
                                                                --   assumed for a future month — assuming
                                                                --   future absence would fabricate it)
    + Σ known future one-off taxable inputs already committed for later cycles
      (kind IN ('BONUS','INCENTIVE','VARIABLE_PAY') with effective_period_code > current)

S2  - standard_deduction  = REG.standard_deduction_minor        -- 0 when the regime has none
S3  - professional_tax_for_fy                                   -- only when REG.allows_professional_tax_deduction
      = YTD.pt + PT + (remaining_cycles_after_this × PT)
        -- PT_expected is exactly PT, this month's computed slab amount: the slab is a
        -- persisted constant for the wage band, so repeating it is a deterministic
        -- projection, not an estimate. When slab.annual_cap_minor is set, the sum is
        -- capped at it. When PT = 0 because no slab matched, the projection is 0.
S4  - chapter_via_deductions = Σ DEC allowed items, capped per section from the seeded
                               section-limit reference data, 0 when
                               REG.allows_chapter_via_deductions = false
S5  taxable_income = max(0, S1 - S2 - S3 - S4)
S6  taxable_income_rounded = floorToNearest(taxable_income, 1000)
      -- s.288A rounds total income DOWN to the nearest ₹10. Money is paise, so ₹10 =
      -- 1000 paise and the modulus is 1000. The previous text wrote `1000_00` (₹1,000)
      -- in the formula and "₹10 → 10_00 paise" (₹10 = 1000 paise, written wrong) in the
      -- comment: three different numbers for one rule. One number, stated once: 1000.
S7  tax = Σ over REG's tax_regime_slab rows, ascending slab_no, of
          (overlap of [0, taxable_income_rounded] with [from_income_minor, to_income_minor]) × rate
          -- to_income_minor IS NULL on the top slab (open-ended); db:verify-schema asserts
          -- the slabs of a (regime, FY) are contiguous from 0 and end open.
S8  if taxable_income_rounded <= REG.rebate_87a_limit_minor:
          tax = max(0, tax - min(tax, REG.rebate_87a_amount_minor))
S9  surcharge = 0
    for each tax_regime_surcharge row, descending threshold_income_minor:
      if taxable_income_rounded > threshold_income_minor:
          surcharge = roundHalfUpToRupee(tax × rate)
          if marginal_relief_applies:
             excess  = taxable_income_rounded - threshold_income_minor
             tax_at_threshold = the S7/S8 tax on exactly threshold_income_minor
             surcharge = max(0, min(surcharge, excess - (tax - tax_at_threshold)))
          break                                   -- highest matching band only
S10 cess = roundHalfUpToRupee((tax + surcharge) × REG.cess_rate)
S11 projected_annual_tax = tax + surcharge + cess
S12 TDS_this_month =
      remaining_cycles_after_this = 0
        ? max(0, projected_annual_tax - YTD.tds)                         -- true-up in the last cycle
        : max(0, roundHalfUpToRupee( (projected_annual_tax - YTD.tds)
                                     / remaining_cycles_incl_this ))
    then clamped to <= (GROSS - Σ other DEDUCTION lines)
    -- The clamp keeps NET >= 0. When it bites, the unclamped value, the clamped value and
    -- the shortfall are written to employee_tax_projection.tds_clamped_minor and surfaced
    -- to Accounts as the WARNING finding PAY_TDS_CLAMPED on the next cycle, because an
    -- under-deduction that nobody is told about becomes the employee's problem in March.
```

- No PAN (`PAY_TDS_MISSING_PAN` accepted) ⇒ the higher-of rule of s.206AA applies:
  `TDS_this_month = max(computed, roundHalfUpToRupee(current_period_taxable_gross × SR.s206aa_rate))`,
  where `s206aa_rate` is a seeded column on `statutory_rate_set` (R-12 extends the same
  reference row), not the literal `0.20` the earlier draft used. The fact, the rate, the
  computed value and the applied value are recorded in `input_snapshot.tds.s206aaApplied`
  and shown on the payslip as a footnote, so the employee can see **why** their deduction
  is higher and what to do about it.
- A committed `TDS_OVERRIDE` input item replaces S12 entirely; the computed value, the
  override and the authorising `payroll_input_item.id` are all recorded in
  `input_snapshot`.
- The regime is the employee's **election**; where none exists the default regime is used
  and `regimeSource:'DEFAULT'` is recorded. The election locks
  (`employee_tax_regime_election.is_locked`) at the FY's first publication, so mid-year
  switching cannot retroactively change published payslips.
- The election locks **per employee** at that employee's first published payslip of the
  FY — not at the organisation's first publication. A January joiner has no published
  payslip in the FY until January and must be able to elect until then; locking the whole
  organisation in April would deny every later joiner a choice the law gives them.
- Everything S1–S12 is persisted to `employee_tax_projection` (one row per employee per
  run, `is_current` flipped at PAY-13) — the Tax screen reads that row and computes
  nothing. The row carries every intermediate (`S1`…`S11`), `remaining_cycles_incl_this`,
  the assumed last month, `tds_clamped_minor`, `regime_source` and the ids of the
  `tax_regime`, `tax_regime_slab` set and `employee_tax_declaration` it used, so the
  screen can explain any figure it renders without re-running the engine.
- **The Tax screen's regime comparison is a second persisted projection, not a guess.**
  The prototype's "Old regime would cost ₹18,240 more this year" is
  `other_regime_projection.projected_annual_tax - this_projection.projected_annual_tax`,
  where the engine writes **one `employee_tax_projection` row per available regime** on
  every run (`is_current = true` for the elected one, `false` for the counterfactual, with
  `regime_source='COMPARISON'`). Both rows are produced by the same pure function over the
  same inputs. Where the counterfactual row is absent — because the employee's declaration
  has not been captured, or a regime has no seeded slabs for the FY — the comparison
  **renders its empty state** ("We can compare regimes once your declaration is in"), and
  no number is shown. Nothing on this screen is computed in the browser.

#### 1.9.7 Deductions, net, and the rounding rules

Deduction order (`display_group='DEDUCTIONS'`, `display_order`):

| Order | Code                | Source                                                |
| ----- | ------------------- | ----------------------------------------------------- |
| 10    | `PF_EE`             | §1.9.3                                                |
| 15    | `VPF`               | §1.9.3                                                |
| 20    | `ESI_EE`            | §1.9.4                                                |
| 30    | `PT`                | §1.9.5                                                |
| 40    | `TDS`               | §1.9.6                                                |
| 50    | `GROUP_INS`         | `FIXED` from the salary structure / benefit enrolment |
| 60    | `ADVANCE_RECOVERY`  | `INPUT_DRIVEN`                                        |
| 70    | `ONE_OFF_DEDUCTION` | `INPUT_DRIVEN`                                        |

```
TOTAL_DEDUCTIONS = Σ DEDUCTION lines
NET              = GROSS - TOTAL_DEDUCTIONS          -- integer subtraction, never re-rounded
```

**Rounding rules, exhaustively:**

| Where                                     | Rule                                                                                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every intermediate                        | Exact integer rational; no rounding                                                                                                                                 |
| A prorated or percentage **earning** line | `roundHalfUp` to the **paisa**                                                                                                                                      |
| `PF_EE`, `VPF`, `PF_ER`, `PF_EPS`         | `roundHalfUp` to the **rupee** (EPFO convention)                                                                                                                    |
| `ESI_EE`, `ESI_ER`                        | `roundUp` to the **rupee** (ESIC convention)                                                                                                                        |
| `PT`                                      | No rounding — a whole-rupee slab constant                                                                                                                           |
| `TDS`, surcharge, cess                    | `roundHalfUp` to the **rupee**                                                                                                                                      |
| `GROSS`, `TOTAL_DEDUCTIONS`, `NET`        | Never rounded — integer sums of already-rounded lines                                                                                                               |
| Display                                   | `'₹' + Math.round(paise/100).toLocaleString('en-IN')` in list/summary contexts; the payslip detail renders exact rupees-and-paise. The database always keeps paise. |

`roundHalfUp(n/d)` on integers is `(2n + d) div (2d)` for `n,d > 0`, and is applied to
`|n|` with the sign restored — so `-0.5` rounds to `-1`, away from zero, symmetrically.
"Half-up away from zero" and "half-up" name the same function here; §0.4's phrasing is the
binding one. `roundUpToRupee(x)` is `ceil` toward `+∞` on a non-negative amount, which is
the only sign ESIC contributions take; it is never applied to a negative value, and the
engine raises rather than guessing if one is produced.

**The deduction floor.** No `DEDUCTION` line may be negative, and `TOTAL_DEDUCTIONS` may
not exceed `GROSS`. A recovery large enough to breach the floor is not silently truncated:
the dry-run raises `PAY_NEGATIVE_NET` (§1.5, deferrable), and the documented remedy is to
move the recovery to a later cycle. The engine has no clamp here — a clamp would produce a
payslip whose recovery line does not match the recovery that was authorised.

Because `NET` is an integer subtraction of integer sums, `GROSS - TOTAL_DEDUCTIONS = NET`
holds exactly for every payslip and therefore in aggregate — which is what
`payroll.controls_balance` asserts at PAY-13 and re-asserts at PAY-15.

#### 1.9.8 Traceability: the input hash

```
input_snapshot = {
  engineVersion, rulesetSha256, payrollRunId, periodCode,
  attendance: { recordId, calendarDays, eligibleDays, presentDays, paidLeaveDays,
                holidayDays, weekOffDays, absentDays,
                lopDaysDerived, lopDays, lopSource, lopOverrideItemId?, payableDays,
                submissionId, approvalId, approvedByEmployeeId, approvedAt,
                escalated: false | { byUserId, at, reason } },
  structure:  { salaryStructureId, structureSha256,
                components: [{ code, calculation, amountMinor: "8600000", rate }] },
  inputs:     [{ itemId, batchId, sourceRowNo, kind, componentCode, amountMinor: "642000" }],
  statutory:  { rateSetId, pfWageBasis, pfWageMinor, ceilingMinor,
                esi: { applicable, decisionWageMinor, decisionBranch, sourcePayslipId?,
                       periodStart, periodEnd },
                pt: { slabId, slabSetId, stateCode, ptBasis, ptWageMinor, reason? } },
  tax:        { regimeId, regimeSource, projectionId, remainingCyclesInclThis,
                s206aaApplied, tdsClampedMinor, overrideItemId? },
  computed:   { grossMinor, totalDeductionsMinor, netMinor, lines: [{ code, kind, amountMinor }] }
}
input_sha256 = SHA-256( jsonCanonical(input_snapshot) )    -- sorted keys, no whitespace,
                                                            -- money as minor-unit STRINGS
```

`input_sha256` is stored on the payslip. `jsonCanonical` is **RFC 8785 (JCS)**: UTF-8, no
insignificant whitespace, object keys sorted by UTF-16 code unit, no floating-point
anywhere (every money value is a minor-unit decimal **string**, every rate the exact
decimal string as stored). Two implementations that disagree about canonicalisation
produce two different hashes for the same payslip, which would make PAY-INV-9 unverifiable
— so the rule is named, not left to a library default.

The audit test "this payslip still matches its inputs" is: re-read the referenced rows,
rebuild `input_snapshot`, recompute the hash, compare. Because every referenced row is
either immutable (`attendance_record` once `LOCKED`, `payroll_input_item` in a `COMMITTED`
batch, a closed `salary_structure` version) or effective-dated, a legitimate later change
cannot break a past payslip's hash; a mismatch therefore always means either tampering or
a schema/engine defect, and is treated as such. The `payroll-integrity-verify` job runs this over a sample nightly and over the
whole FY before Form 16 issuance; a mismatch raises a P1 and writes an `audit_event`.

### 1.10 Re-runs, corrections and off-cycle runs

#### 1.10.1 A failed run (before `CALCULATED`)

The run transaction is atomic, so a failure leaves **no** payslips. PAY-14 moves the cycle
to `VALIDATION_FAILED`, the failed `payroll_run` row survives with `error_message` and
`error_detail` for forensics, and the operator re-validates (PAY-11) and re-calculates
(PAY-12) producing `run_no + 1`. Nothing is mutated; nothing is deleted.

#### 1.10.2 A wrong run (calculated, not yet published)

PAY-16 (`CALCULATED → VALIDATED`, note required): the live run → `SUPERSEDED`, its
payslips → `SUPERSEDED` (never deleted — they are evidence of what the engine produced),
controls cleared. Re-calculate to produce `run_no + 1` with `revision` still `1`
(`ux_payslip__one_live_per_cycle_employee` only counts `GENERATED`/`PUBLISHED`, so a
superseded revision-1 does not collide). The employee never saw any of it.

#### 1.10.3 A wrong payslip (already published) — `payroll_correction`

The cycle is **not** rolled back. `machine = 'payroll_correction'` (A-3):

| #    | from → to                         | Actor                                                                | Guards                                                                                                                                                                                                                                                                                                    | Effects                                                                                                                                                                                                                                                                                                                                     | Audit                                                          |
| ---- | --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| PC-1 | `NULL` → `RAISED`                 | ACCOUNTS `payroll:calculate`                                         | cycle is `PUBLISHED` or `CLOSED`; `reason_note` ≥ 20 chars; the corrective inputs exist as a committed `payroll_input_batch` on the correction                                                                                                                                                            | `correction_no` from a sequence                                                                                                                                                                                                                                                                                                             | `PAYROLL.CORRECTION_RAISED`                                    |
| PC-2 | `RAISED` → `APPROVED`             | ACCOUNTS `payroll:approve` (**different user**)                      | `payroll.correction_distinct_approver` (the guard; `ck_pc_corr__dual_control` is its database backstop)                                                                                                                                                                                                   | `approved_by_user_id`, `approved_at`                                                                                                                                                                                                                                                                                                        | `PAYROLL.CORRECTION_APPROVED`                                  |
| PC-3 | `APPROVED` → `CALCULATING`        | ACCOUNTS `payroll:calculate`                                         | —                                                                                                                                                                                                                                                                                                         | `payroll_run` with `run_kind='CORRECTION'`, `run_no = max+1`                                                                                                                                                                                                                                                                                | `PAYROLL.CORRECTION_STARTED`                                   |
| PC-4 | `CALCULATING` → `CALCULATED`      | _system_                                                             | run succeeded; every affected employee has exactly one new `payslip` with `revision = prior.revision + 1` and `supersedes_payslip_id = prior.id`                                                                                                                                                          | Prior payslip → `SUPERSEDED`; prior `payslip_publication.revoked_at` set with reason                                                                                                                                                                                                                                                        | `PAYROLL.CORRECTION_CALCULATED`                                |
| PC-5 | `CALCULATED` → `PUBLISHED`        | ACCOUNTS `payroll:publish` (**different user from PC-3's operator**) | `payroll.every_payslip_generated`, `payroll.correction_settlement_cycle_open`, `payroll.correction_distinct_publisher` (R-8's sibling: `published_by_user_id` differs from both the correction's calculator and its approver), `payslip.superseding_revision_published` — **step-up MFA required** (§0.9) | New `payslip_publication` per revised payslip; `payslip_fy_rollup` refolded (old ids removed, new added); `tds_quarter` recomputed; the **net delta** posted into `settlement_cycle_id` as a `payroll_input_item` — `ARREAR` when positive, `ADVANCE_RECOVERY` when negative, `narration = 'Correction <correction_no> for <period_label>'` | `PAYROLL.CORRECTION_PUBLISHED` + `PAYSLIP.REVISED` per payslip |
| PC-6 | `RAISED`\|`APPROVED` → `REJECTED` | ACCOUNTS `payroll:approve`                                           | note required                                                                                                                                                                                                                                                                                             | —                                                                                                                                                                                                                                                                                                                                           | `PAYROLL.CORRECTION_REJECTED`                                  |
| PC-7 | `CALCULATING` → `FAILED`          | _system_                                                             | —                                                                                                                                                                                                                                                                                                         | atomic rollback; no payslips                                                                                                                                                                                                                                                                                                                | `PAYROLL.CORRECTION_FAILED`                                    |

Notifications at PC-5: `PAYSLIP_PUBLISHED` (tone AMBER, title "Your payslip for August
2026 has been revised — revision 2") to each affected employee, plus a
`PAYSLIP_PUBLISHED` email. The employee's Payslips list shows only the live revision; the
superseded revision remains readable to `payslip:read:any` and to the audit trail.

The settlement cycle is `fn_next_open_payroll_cycle(now())` — the earliest `REGULAR`
cycle in `INPUTS_OPEN`.

**The settlement cycle, precisely.** `payroll.correction_settlement_cycle_open` requires
`settlement_cycle_id` to name a `REGULAR` cycle whose status is **`INPUTS_OPEN`** —
not `DRAFT`. A `DRAFT` cycle cannot accept a `payroll_input_item` (PIB-1 requires
`INPUTS_OPEN`), so resolving to one would produce a correction that could never post its
delta. `fn_next_open_payroll_cycle()` is therefore defined as:

```sql
SELECT id FROM payroll_cycle
 WHERE organization_id = :org AND cycle_kind = 'REGULAR' AND status = 'INPUTS_OPEN'
 ORDER BY period_start
 LIMIT 1;
```

Returning no row is not an error state to work around: PC-5 is refused with
`422 GUARD_FAILED`, and the message tells the operator to open and open-inputs the next
cycle first. The delta is never paid outside a payroll cycle, never by a manual bank
transfer recorded in the portal, and never netted against an unrelated claim.

**The correction's own inputs.** PC-1 requires the corrective figures to exist as a
`COMMITTED` `payroll_input_batch` **on the correction's own cycle** (a `CORRECTION`-kind
cycle created with the correction and carrying `parent_payroll_cycle_id` = the published
cycle). The published cycle is never reopened for input, so `PAY-INV-11` and `PAY-INV-15`
both continue to hold while a correction is in flight.

#### 1.10.4 Supplementary / off-cycle runs

`cycle_kind = 'SUPPLEMENTARY'` (extra payment for the same month: a delayed incentive, a
retention bonus) or `'OFF_CYCLE'` (a mid-month payment: final settlement, a joining
bonus). Both carry `parent_payroll_cycle_id` and reuse the parent's **already approved**
`attendance_period` (R-1). Their transition path skips the attendance steps:

```
DRAFT → INPUTS_OPEN → INPUTS_LOCKED → VALIDATING → VALIDATED → CALCULATING
      → CALCULATED → APPROVED → PUBLISHED → CLOSED
```

with `INPUTS_LOCKED → VALIDATING` guarded by a new guard
`payroll.parent_cycle_published` (`parent.status IN ('PUBLISHED','CLOSED')`) in place of
`payroll.attendance_locked`. The validation checklist runs unchanged except that
`PAY_ATTENDANCE_MISSING`/`PAY_ATTENDANCE_NOT_APPROVED` read the parent's locked records.
Payslips from these cycles are normal payslips (`revision = 1` in their own cycle) and
fold into `payslip_fy_rollup` and `tds_quarter` like any other.

### 1.11 Payroll invariants

| #          | Invariant                                                                                                                                      | Enforced by                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| PAY-INV-1  | A `payslip` row exists only for a cycle that has been in `CALCULATING`                                                                         | `trg_payslip_requires_calculating` (R-4)                                                    |
| PAY-INV-2  | An employee can read a payslip only through a live `payslip_publication`                                                                       | RLS `rls_payslip_self` + the single repository function + route scope                       |
| PAY-INV-3  | `gross - total_deductions = net` on every payslip                                                                                              | Integer arithmetic (§1.9.7) + `payroll.controls_balance` at PAY-13 and PAY-15               |
| PAY-INV-4  | `Σ payslip.gross = control_gross_minor` and `Σ net = control_net_minor` for the live run                                                       | `payroll.controls_balance`; controls are write-once at `CALCULATED`                         |
| PAY-INV-5  | `payslip_count = employee_count = count(payroll_cycle_employee WHERE disposition='INCLUDED')`                                                  | `payroll.payslip_count_matches_employee_count`                                              |
| PAY-INV-6  | At most one live (`GENERATED`/`PUBLISHED`) payslip per `(cycle, employee)`                                                                     | `ux_payslip__one_live_per_cycle_employee`                                                   |
| PAY-INV-7  | At most one `SUCCEEDED`, non-superseded `payroll_run` per cycle                                                                                | `ux_payroll_run__one_live`                                                                  |
| PAY-INV-8  | A published payslip is immutable except `status`, `pdf_file_object_id`, `revoked_*`                                                            | `trg_payslip_immutable`; `DELETE` rejected                                                  |
| PAY-INV-9  | Every payslip references the exact `attendance_record`, `salary_structure` and input items that produced it, and `input_sha256` still verifies | FKs + `payroll-integrity-verify`                                                            |
| PAY-INV-10 | The person who calculated a run never approves or publishes it                                                                                 | `payroll.distinct_approver` + DB `CHECK`                                                    |
| PAY-INV-11 | No payroll input enters a cycle after `INPUTS_LOCKED`                                                                                          | PIB transitions require `INPUTS_OPEN`; PAY-10 is the only way back and it is audited        |
| PAY-INV-12 | Attendance is submitted only after inputs are locked                                                                                           | `attendance.payroll_inputs_locked`                                                          |
| PAY-INV-13 | Payroll is validated only after every slice is approved                                                                                        | `attendance.every_slice_approved` (R-2) via PAY-5, and `payroll.attendance_locked` at PAY-7 |
| PAY-INV-14 | No employee is dropped from a run without a persisted reason and an owner                                                                      | `ck_pce__exclusion` (A-1)                                                                   |
| PAY-INV-15 | A `PUBLISHED` cycle never returns to an earlier state                                                                                          | No such row in `state_transition`; corrections use `payroll_correction`                     |
| PAY-INV-16 | Every FY rollup figure is reconstructible from its `source_payslip_ids`                                                                        | `payslip_fy_rollup` + nightly verify                                                        |

### 1.12 Payroll failure and compensation paths

| Failure                                                | Detection                                                   | Compensation                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upload is malformed                                    | PIB-3 `PARSE_FAILED`                                        | `parse_error` is rendered to ACCOUNTS with line/column; the batch is discarded and re-uploaded. The cycle never left `INPUTS_OPEN`.                                                                                                                                                                                    |
| Upload is a duplicate                                  | `ux_pib__cycle_file_sha` violation → `409 DUPLICATE_UPLOAD` | Operator is shown the existing batch                                                                                                                                                                                                                                                                                   |
| A committed batch is wrong                             | `PAY_INPUT_*` validation ERROR                              | PAY-10 reopens inputs; a replacement batch is committed and the old one → `SUPERSEDED` (PIB-7). No item is ever edited in place.                                                                                                                                                                                       |
| A manager rejects a slice                              | `ATT-10`                                                    | PAY-6 returns the cycle to `INPUTS_LOCKED` and the period to `OPEN`; HR corrects only the rejected records; resubmission creates a new `attendance_submission` and supersedes the old one                                                                                                                              |
| A manager never acts                                   | `attendance-approval-reminder`                              | Escalation chain, then HR acts under `attendance:approve:any` (**AAP-4**, §2.4) with a mandatory reason after `due_at`                                                                                                                                                                                                 |
| Validation finds a blocking error                      | PAY-9                                                       | Fix + PAY-11, or an audited per-employee `DEFERRED` (§1.5)                                                                                                                                                                                                                                                             |
| The run crashes                                        | PAY-14                                                      | Atomic rollback; re-validate and re-run; `run_no` increments                                                                                                                                                                                                                                                           |
| Controls do not balance                                | `payroll.controls_balance` fails at PAY-13                  | The run transaction aborts → `FAILED`; a control mismatch can never be published                                                                                                                                                                                                                                       |
| The wrong figures were calculated                      | Caught at review                                            | PAY-16 discard + recalculate                                                                                                                                                                                                                                                                                           |
| The wrong figures were published                       | Caught after PAY-17                                         | `payroll_correction` (§1.10.3): revision n+1, prior publication revoked, employee notified, net delta settled in the next open cycle                                                                                                                                                                                   |
| The cycle must be abandoned                            | Operator decision                                           | PAY-19 `CANCELLED` (only while no payslip exists); the attendance period is released for a replacement cycle                                                                                                                                                                                                           |
| PDF rendering fails after publication                  | The render job                                              | The payslip **is** published and readable on screen (the on-screen payslip is rendered from `payslip_line`, not the PDF); `pdf_file_object_id` stays NULL and the Download button is not rendered until it succeeds. Publication is never blocked on a PDF, and a missing PDF is never presented as a missing payslip. |
| An employee was deferred and the next cycle also fails | HR exceptions screen                                        | The `payroll_cycle_employee` row stays open with `carry_to_cycle_id` re-pointed each cycle; it is a standing exception until an actual payslip exists                                                                                                                                                                  |

---

## 2. ATTENDANCE

Attendance is steps 2 and 3 of the mandated payroll workflow. **Nothing in §2 may be
written by ACCOUNTS** — the payroll operator cannot manufacture their own inputs.

### 2.1 States

- `attendance_period` (`ess_attendance_period_status`): `OPEN`, `HR_SUBMITTED`,
  `MANAGER_APPROVAL_PENDING`, `APPROVED`, `LOCKED`, `REOPENED`
- `attendance_record` (`ess_attendance_record_status`): `DRAFT`, `SUBMITTED`, `APPROVED`,
  `REJECTED`, `LOCKED`
- `attendance_approval` (`ess_attendance_approval_status`): `PENDING`, `APPROVED`,
  `REJECTED`, `AUTO_ESCALATED`

### 2.2 `attendance_period` transitions (`machine = 'attendance_period'`)

| #     | from → to                                   | Trigger                                 | Actor                           | Guards                                                                                                                                                    | Effects                                                                                                                                                                                                                                                                                                     | Audit                                | Notify                                                                                                                   |
| ----- | ------------------------------------------- | --------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| ATT-1 | `NULL` → `OPEN`                             | Same transaction as PAY-1               | ACCOUNTS `payroll:cycle:create` | `attendance.created_with_cycle` (the predecessor `attendance.cycle_exists` was circular and is withdrawn)                                                 | `total_calendar_days = end_date - start_date + 1`; `label` frozen; `capture_opened_at` set at PAY-2                                                                                                                                                                                                         | `ATTENDANCE.PERIOD_OPENED`           | —                                                                                                                        |
| ATT-2 | `OPEN` → `HR_SUBMITTED`                     | `POST /attendance/periods/:id/submit`   | HR `attendance:submit`          | `attendance.payroll_inputs_locked`, `attendance.all_active_employees_have_records`, `attendance.day_identity_holds`, `attendance.no_open_leave_in_period` | One `attendance_submission` (`record_count`, `employee_count_expected`, control totals, `payload_sha256` over the canonical JSON of every submitted record); every `DRAFT` record → `SUBMITTED`; `hr_submitted_at`, `hr_submitted_by_user_id`; PAY-4 fires in the same transaction                          | `ATTENDANCE.SUBMITTED`               | —                                                                                                                        |
| ATT-3 | `HR_SUBMITTED` → `MANAGER_APPROVAL_PENDING` | _system_, same transaction as ATT-2     | _system_                        | `attendance.slices_created`                                                                                                                               | One `attendance_approval` per distinct `manager_employee_id`, each with `record_count`, control totals, `due_at = now() + org attendance SLA`; one `approval_task` (`kind='ATTENDANCE_PERIOD'`) per slice; `attendance_record.attendance_approval_id` set                                                   | `ATTENDANCE.SLICES_CREATED`          | `ATTENDANCE_APPROVAL_PENDING` → each manager                                                                             |
| ATT-4 | `MANAGER_APPROVAL_PENDING` → `APPROVED`     | _system_, after the last slice decision | _system_                        | `attendance.every_slice_approved` (R-2)                                                                                                                   | `approvals_completed_at`; PAY-5 fires in the same transaction                                                                                                                                                                                                                                               | `ATTENDANCE.APPROVED`                | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                         |
| ATT-5 | `MANAGER_APPROVAL_PENDING` → `OPEN`         | `POST /attendance/periods/:id/reopen`   | HR `attendance:reopen`          | `attendance.any_slice_rejected`, `approval.note_required`                                                                                                 | Rejected records → `DRAFT`; the pending slices' `approval_task` rows → `WITHDRAWN`; the live `attendance_submission` keeps `superseded_by_submission_id` NULL until resubmission; PAY-6 fires                                                                                                               | `ATTENDANCE.RETURNED_FOR_CORRECTION` | `PAYROLL_CYCLE_STATE` → HR; `ATTENDANCE_APPROVAL_PENDING` withdrawn from managers (notifications dismissed, not deleted) |
| ATT-6 | `APPROVED` → `LOCKED`                       | _system_, in PAY-7                      | _system_                        | `attendance.cycle_left_attendance_approved`                                                                                                               | Every record → `LOCKED` + `locked_at`; every approved `leave_request` overlapping the period gets `attendance_record_id` (freezing it)                                                                                                                                                                      | `ATTENDANCE.LOCKED`                  | —                                                                                                                        |
| ATT-7 | `APPROVED` → `REOPENED`                     | `POST /attendance/periods/:id/reopen`   | HR `attendance:reopen`          | `attendance.cycle_not_calculated`, `approval.note_required`                                                                                               | `reopened_at/_by/_reason`; **PAY-20 fires in the same transaction**, driving the cycle `ATTENDANCE_APPROVED → INPUTS_LOCKED` — the two machines are 1:1 and must never be left disagreeing about whether attendance is settled                                                                              | `ATTENDANCE.REOPENED`                | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR                                                                                    |
| ATT-8 | `LOCKED` → `REOPENED`                       | `POST /attendance/periods/:id/reopen`   | HR `attendance:reopen`          | `attendance.cycle_not_published`, `approval.note_required`                                                                                                | As ATT-7; **PAY-22 fires in the same transaction** (`VALIDATED → INPUTS_LOCKED`) and `payroll_cycle.validated_at` is set to `NULL` so a stale validation cannot be reused; any `CALCULATED` run must be discarded first (PAY-16) — `attendance.cycle_not_calculated` refuses the reopen while a run is live | `ATTENDANCE.REOPENED`                | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR, tone AMBER                                                                        |
| ATT-9 | `REOPENED` → `OPEN`                         | _system_, immediately                   | _system_                        | —                                                                                                                                                         | Records affected by the reopen → `DRAFT`; prior `attendance_submission.superseded_by_submission_id` set at the next ATT-2                                                                                                                                                                                   | `ATTENDANCE.CAPTURE_REOPENED`        | —                                                                                                                        |

### 2.3 `attendance_record` transitions (`machine = 'attendance_record'`)

| #     | from → to                | Actor                             | Guards                                                        | Effects                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------ | --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ATR-1 | `NULL` → `DRAFT`         | HR `attendance:capture`           | period is `OPEN`                                              | Created by the period-materialise routine for every in-scope employee: `manager_employee_id` and `department_id` snapshotted from `employment_as_of(employee, period.end_date)`; `calendar_days` copied; `eligible_days` prorated for joiners/leavers; `holiday_days`/`week_off_days` from `working_days()`; `paid_leave_days`/`lop_days` folded from approved leave (§3.7) |
| ATR-2 | `DRAFT` → `DRAFT` (edit) | HR `attendance:capture`           | period `OPEN`; `ck_ar__day_identity` must hold after the edit | Manual edit or bulk upload (`source='HR_BULK_UPLOAD'`, `source_file_object_id` retained). `row_version` increments. Audit `ATTENDANCE.RECORD_UPDATED` with `changed_fields`.                                                                                                                                                                                                |
| ATR-3 | `DRAFT` → `SUBMITTED`    | HR `attendance:submit`            | Part of ATT-2                                                 | —                                                                                                                                                                                                                                                                                                                                                                           |
| ATR-4 | `SUBMITTED` → `APPROVED` | MANAGER `attendance:approve:team` | `approval.actor_is_assigned_approver`                         | Part of the slice decision                                                                                                                                                                                                                                                                                                                                                  |
| ATR-5 | `SUBMITTED` → `REJECTED` | MANAGER `attendance:approve:team` | `approval.note_required`                                      | `manager_note` set; the whole slice is rejected (a manager rejects a slice, and may annotate individual records within it)                                                                                                                                                                                                                                                  |
| ATR-6 | `REJECTED` → `DRAFT`     | HR `attendance:capture`           | period back to `OPEN`                                         | `manager_note` retained for context                                                                                                                                                                                                                                                                                                                                         |
| ATR-7 | `APPROVED` → `LOCKED`    | _system_                          | Part of ATT-6                                                 | `locked_at`                                                                                                                                                                                                                                                                                                                                                                 |
| ATR-8 | `LOCKED` → `DRAFT`       | HR `attendance:reopen`            | `attendance.cycle_not_published`                              | Part of ATT-8                                                                                                                                                                                                                                                                                                                                                               |

**Integrity spine.** `ck_ar__day_identity`
(`present + paid_leave + holiday + week_off + absent = eligible`) is checked per row by
the database and in bulk by `attendance.day_identity_holds` at submission. HR cannot
submit a period where any record fails it, and the UI surfaces the offending rows before
the submit button is enabled.

### 2.4 `attendance_approval` transitions (`machine = 'attendance_approval'`)

| #     | from → to                    | Actor                             | Guards                                                                                                                                                                                                                       | Effects                                                                                                                                                                           | Audit                        | Notify                                                                                       |
| ----- | ---------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| AAP-1 | `NULL` → `PENDING`           | _system_ (ATT-3)                  | —                                                                                                                                                                                                                            | `approval_task` created                                                                                                                                                           | `ATTENDANCE.SLICE_ASSIGNED`  | `ATTENDANCE_APPROVAL_PENDING` → manager                                                      |
| AAP-2 | `PENDING` → `APPROVED`       | MANAGER `attendance:approve:team` | `approval.actor_is_assigned_approver`; the slice's records are still `SUBMITTED`; `attendance.totals_unchanged_since_submission` (the slice control totals still equal the records' sums; failure raises `ATT_TOTALS_DRIFT`) | Every record in the slice → `APPROVED`; `decided_at`, `decided_by_user_id`; `approval_task` → `APPROVED` + one `approval_decision`; then the R-2 completion check (→ ATT-4/PAY-5) | `ATTENDANCE.SLICE_APPROVED`  | —                                                                                            |
| AAP-3 | `PENDING` → `REJECTED`       | MANAGER `attendance:approve:team` | `approval.actor_is_assigned_approver`, `approval.note_required`                                                                                                                                                              | Records → `REJECTED` with `manager_note`; `approval_task` → `REJECTED`; the period is driven to ATT-5                                                                             | `ATTENDANCE.SLICE_REJECTED`  | `PAYROLL_CYCLE_STATE` → HR ("Arjun Malhotra returned 6 attendance records for August 2026")  |
| AAP-4 | `PENDING` → `AUTO_ESCALATED` | HR `attendance:approve:any`       | `attendance.approval_overdue` (`due_at IS NOT NULL AND due_at < now()` — fail-closed on a NULL due date), `attendance.escalation_actor_not_submitter`, `approval.note_required`                                              | Records → `APPROVED`; `escalated_at`, `escalated_to_user_id`, `escalation_reason`, `decided_by_user_id` = the HR user; counts as decided-approving for R-2                        | `ATTENDANCE.SLICE_ESCALATED` | `ATTENDANCE_APPROVAL_PENDING` (tone AMBER) → the manager who was bypassed, and their manager |

A manager may **never** approve a slice containing their own record:
`ck_at__not_self` on `approval_task`, and slice construction routes a manager's own record
to their manager's slice (or, at the top of the chain, to the HR business partner's
slice under `attendance:approve:any`).

### 2.5 What the employee sees, and when

`attendance:read:self`, route `GET /api/v1/me/attendance?period=2026-08`. The employee's
own record is returned only when `attendance_record.status IN ('SUBMITTED','APPROVED','LOCKED')`.

| Record status | Employee sees                                                                                                | Chip                             |
| ------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| no record yet | Empty state: "Attendance for August 2026 has not been prepared yet"                                          | —                                |
| `DRAFT`       | Same empty state — an unsubmitted draft is HR's working copy, not a statement to the employee                | —                                |
| `SUBMITTED`   | Day counts (`present`, `paid leave`, `holiday`, `week off`, `absent`, `LOP`), `payable_days / calendar_days` | `Awaiting manager review`, amber |
| `REJECTED`    | Reverts to the "being prepared" empty state (the figures are being corrected)                                | —                                |
| `APPROVED`    | The same day counts, final                                                                                   | `Approved`, green                |
| `LOCKED`      | The same day counts, with "Used for August 2026 payroll"                                                     | `Final`, green                   |

The employee sees **only their own** record. Managers see their slice
(`attendance:read:team`, bounded by `employee_reporting_closure`); HR sees all
(`attendance:read:any`); ACCOUNTS holds `attendance:read:any` for payroll reconciliation
but no write permission at all.

### 2.6 Attendance invariants

| #          | Invariant                                                                                          | Enforced by                                                                                                                                                                                                                                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ATT-INV-1  | Exactly one `attendance_record` per `(period, employee)`                                           | `ux_attendance_record__period_employee`                                                                                                                                                                                                                                                                 |
| ATT-INV-2  | Day counts partition eligible days on every record                                                 | `ck_ar__day_identity` + `attendance.day_identity_holds`                                                                                                                                                                                                                                                 |
| ATT-INV-3  | Every submitted record belongs to exactly one slice, and the slices partition the period's records | `attendance_record.attendance_approval_id` NOT NULL after ATT-3 + a reconciliation assertion in ATT-3 (`Σ slice.record_count = submission.record_count`)                                                                                                                                                |
| ATT-INV-4  | `payable_days = eligible_days - lop_days`, and `lop_days ≤ eligible_days`                          | Generated column + `ck_ar__lop_bound`                                                                                                                                                                                                                                                                   |
| ATT-INV-5  | HR cannot submit before ACCOUNTS locks inputs                                                      | `attendance.payroll_inputs_locked`                                                                                                                                                                                                                                                                      |
| ATT-INV-6  | A manager approves only their own slice                                                            | `approval.actor_is_assigned_approver` + `employee_reporting_closure` scope                                                                                                                                                                                                                              |
| ATT-INV-7  | An `attendance_submission` is immutable except `superseded_by_submission_id`                       | `trg_immutable_attendance_submission`                                                                                                                                                                                                                                                                   |
| ATT-INV-8  | Control totals at approval equal the records' sums                                                 | Re-verified in AAP-2, else `ATT_TOTALS_DRIFT`                                                                                                                                                                                                                                                           |
| ATT-INV-9  | A locked period cannot be edited while a payroll run is live                                       | `attendance.cycle_not_calculated` + PAY-16 precondition on ATT-8                                                                                                                                                                                                                                        |
| ATT-INV-10 | The period machine and the cycle machine never disagree                                            | Every `attendance_period` transition that changes whether attendance is settled fires its paired `payroll_cycle` transition in the same transaction: ATT-2→PAY-4, ATT-4→PAY-5, ATT-5→PAY-6, ATT-6 inside PAY-7, ATT-7→PAY-20, ATT-8→PAY-22. `reporting-closure-verify` also asserts the pairing nightly |
| ATT-INV-11 | ACCOUNTS can never write attendance                                                                | The CI assertion in §1.1 over `role_permission`, plus RLS: the `attendance_record` write policies require `attendance:capture`, which no ACCOUNTS role grant contains                                                                                                                                   |
| ATT-INV-12 | An escalation is never performed by the person who submitted the period                            | `attendance.escalation_actor_not_submitter`                                                                                                                                                                                                                                                             |

### 2.7 Attendance failure paths

| Failure                                                                        | Compensation                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bulk upload row does not match an employee                                     | The row is rejected with a reason and shown in the HR upload result; no record is created or mutated. The period cannot be submitted until every active employee has a record.                                                                                                                                                                                                                                                        |
| A record fails the day identity after an edit                                  | The `UPDATE` is rejected by the DB `CHECK`; the UI shows which counts do not add up                                                                                                                                                                                                                                                                                                                                                   |
| Manager rejects                                                                | ATT-5 → correct → resubmit (new `attendance_submission`, old superseded)                                                                                                                                                                                                                                                                                                                                                              |
| Manager unavailable past SLA                                                   | AAP-4 escalation by HR, audited with a reason                                                                                                                                                                                                                                                                                                                                                                                         |
| Slice totals drift between submission and approval                             | `ATT_TOTALS_DRIFT` blocks AAP-2; HR must resubmit                                                                                                                                                                                                                                                                                                                                                                                     |
| A re-org changes a manager mid-period                                          | Irrelevant — `manager_employee_id` is snapshotted on the record at `period.end_date`, and `attendance_approval` is keyed to that snapshot                                                                                                                                                                                                                                                                                             |
| A leave request is still `PENDING_APPROVAL` when HR tries to submit the period | `attendance.no_open_leave_in_period` blocks ATT-2 and names the requests. An undecided leave overlapping the period would otherwise be folded as `absent`, paying the employee LOP for a day their manager was about to approve. HR either chases the decision or the manager decides; there is no "assume rejected" path                                                                                                             |
| A leave is approved after the period is `LOCKED`                               | LV-4 is refused by `leave.attendance_period_open` (§3.7). The decision is not lost: the request stays `PENDING_APPROVAL`, the manager is told the period is locked, and the routes are (a) reopen attendance (ATT-8) while the cycle is pre-`CALCULATING`, or (b) approve after publication and settle the difference through a `payroll_correction` (§1.10.3). What never happens is an approved paid leave that no payslip reflects |

---

## 3. LEAVE

### 3.1 States

`ess_leave_request_status`: `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`,
`WITHDRAWN`, `CANCELLED`. Terminal: `REJECTED`, `WITHDRAWN`, `CANCELLED`. `APPROVED` is
effectively terminal once `attendance_record_id` is set.

### 3.2 Transition table (`machine = 'leave_request'`)

| #    | from → to                        | Trigger                                                                 | Actor                                  | Guards                                                                                                                                          | Effects                                                                                                                                                                                               | Audit                            | Notify                                                        |
| ---- | -------------------------------- | ----------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------- |
| LV-1 | `NULL` → `DRAFT`                 | `POST /leave-requests` with `submit=false`                              | EMPLOYEE `leave:request:create:self`   | `leave.self_only`                                                                                                                               | `leave_request_day` rows materialised; `total_days` computed by trigger                                                                                                                               | `LEAVE.DRAFTED`                  | —                                                             |
| LV-2 | `NULL` → `PENDING_APPROVAL`      | `POST /leave-requests` (the prototype's single "Submit request" button) | EMPLOYEE `leave:request:create:self`   | `leave.sufficient_balance`, `leave.no_overlap`, `leave.min_notice`, `leave.attachment_if_required`, `leave.manager_exists`, `leave.period_open` | §3.4 reservation; `approver_employee_id` snapshotted; `balance_after_days` snapshotted; `approval_task` created                                                                                       | `LEAVE.SUBMITTED`                | `LEAVE_SUBMITTED` → manager                                   |
| LV-3 | `DRAFT` → `PENDING_APPROVAL`     | `POST /leave-requests/:id/submit`                                       | EMPLOYEE `leave:request:create:self`   | same as LV-2                                                                                                                                    | same as LV-2                                                                                                                                                                                          | `LEAVE.SUBMITTED`                | `LEAVE_SUBMITTED` → manager                                   |
| LV-4 | `PENDING_APPROVAL` → `APPROVED`  | `POST /leave-requests/:id/approve`                                      | MANAGER `leave:request:approve:team`   | `approval.actor_is_assigned_approver`, `leave.period_open`, `leave.attendance_period_open`                                                      | §3.4 settlement (`CONSUMPTION` ledger row); `decided_at`, `decided_by_employee_id`; `approval_task` → `APPROVED` + `approval_decision`; the attendance fold (§3.7) runs if the period is still `OPEN` | `LEAVE.APPROVED`                 | `LEAVE_DECIDED` → employee; `LEAVE_DECISION` email → employee |
| LV-5 | `PENDING_APPROVAL` → `REJECTED`  | `POST /leave-requests/:id/reject`                                       | MANAGER `leave:request:approve:team`   | `approval.actor_is_assigned_approver`, `approval.note_required`                                                                                 | Reservation released; `decision_note` mandatory                                                                                                                                                       | `LEAVE.REJECTED`                 | `LEAVE_DECIDED` → employee; `LEAVE_DECISION` email            |
| LV-6 | `PENDING_APPROVAL` → `WITHDRAWN` | `POST /leave-requests/:id/withdraw` (the prototype's "Withdraw" link)   | EMPLOYEE `leave:request:withdraw:self` | `leave.self_only`                                                                                                                               | Reservation released; `approval_task` → `WITHDRAWN`; the manager's pending notification is dismissed                                                                                                  | `LEAVE.WITHDRAWN`                | `LEAVE_DECIDED` → manager                                     |
| LV-7 | `APPROVED` → `WITHDRAWN`         | `POST /leave-requests/:id/withdraw`                                     | EMPLOYEE `leave:request:withdraw:self` | `leave.starts_in_future`, `leave.not_yet_locked_by_attendance`                                                                                  | `CONSUMPTION_REVERSAL` ledger row with `source_ledger_id`; attendance record recomputed if the period is `OPEN`/`DRAFT`                                                                               | `LEAVE.WITHDRAWN_AFTER_APPROVAL` | `LEAVE_DECIDED` → manager                                     |
| LV-8 | `APPROVED` → `CANCELLED`         | `POST /leave-requests/:id/cancel`                                       | HR `leave:request:approve:any`         | `leave.not_yet_locked_by_attendance`, `approval.note_required`                                                                                  | As LV-7, plus `decision_note`                                                                                                                                                                         | `LEAVE.CANCELLED`                | `LEAVE_DECIDED` → employee + manager; `LEAVE_DECISION` email  |
| LV-9 | `DRAFT` → `CANCELLED`            | `DELETE /leave-requests/:id`                                            | EMPLOYEE `leave:request:withdraw:self` | `leave.self_only`                                                                                                                               | `leave_request_day` cascade-deleted                                                                                                                                                                   | `LEAVE.DRAFT_DISCARDED`          | —                                                             |

### 3.3 Working-day computation

The **stored** `total_days` is always the server's value. It is never client-supplied:
`leave_request.total_days` is maintained by trigger as
`SUM(leave_request_day.day_fraction) FILTER (WHERE counts_toward_balance)` and the trigger
raises if an application tries to set it.

Materialising `leave_request_day` for `[start_date, end_date]`:

```
for each calendar date d in the span:
  is_working_day  = extract(dow from d) <> ALL (employment_as_of(emp,d).weekly_off_days
                                                 ?? organization.week_off_days)
                    AND NOT EXISTS (holiday h WHERE h.holiday_calendar_id = holiday_calendar_for(emp, d)
                                                AND h.holiday_date = d AND h.kind = 'PUBLIC')
  portion         = (d = start_date ? start_portion : d = end_date ? end_portion : 'FULL')
  day_fraction    = is_working_day ? (portion = 'FULL' ? 1.00 : 0.50) : 0.00
  counts_toward_balance = is_working_day AND leave_type.is_paid
```

`holiday_calendar_for()` resolves employee override → location calendar → organisation
default (`DATA-MODEL.md §7.3`). `RESTRICTED` holidays are **not** excluded — taking one is
itself a leave request of the `RESTRICTED_HOLIDAY` type. Non-working days inside a span
exist as rows with `day_fraction = 0.00` so the UI can render the span faithfully
("20 – 24 Oct 2026 · 5 days" where the span covers a weekend shows the real working-day
count, not the calendar span).

The prototype's client-side `if (w !== 0 && w !== 6) days++` is display-only: the browser
may show a provisional count while the form is open, but the value shown after submission
is always the server's.

### 3.4 Balance reservation and settlement

**One quantity, named once.** A leave request has two day counts and they are not
interchangeable: `total_days` (what the employee is away, `Σ day_fraction` over working
days) and `balance_days` (what the entitlement pays for,
`Σ day_fraction WHERE counts_toward_balance`). An **unpaid** leave type consumes no
entitlement, so `balance_days = 0` while `total_days > 0`. Every reservation, ledger row
and guard below uses **`balance_days`**; the earlier draft's `total_days` would have
deducted earned-leave balance for a day of leave-without-pay, and the canonical guard
`leave.sufficient_balance` (`DATA-MODEL.md §19.3`) already reads `balance_days`.
`total_days` is what the UI renders as "5 days"; `balance_days` is what the balance bar
moves by, and the Leave screen shows both whenever they differ.

`leave_balance.pending_days` is a **soft hold** and deliberately not a ledger entry — a
reservation is not a movement of entitlement.

| Event                                         | `pending_days`    | `leave_balance_ledger`                                                                                   |
| --------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------- |
| LV-2 / LV-3 submit                            | `+= balance_days` | —                                                                                                        |
| LV-4 approve                                  | `-= balance_days` | one `CONSUMPTION` row, `delta_days = -balance_days`, `leave_request_id` set, `effective_on = start_date` |
| LV-5 reject                                   | `-= balance_days` | —                                                                                                        |
| LV-6 withdraw from pending                    | `-= balance_days` | —                                                                                                        |
| LV-7 / LV-8 withdraw or cancel after approval | —                 | one `CONSUMPTION_REVERSAL` row, `delta_days = +balance_days`, `source_ledger_id` = the consumption row   |

A request whose `balance_days = 0` (a fully unpaid leave, or a span falling entirely on
non-working days) moves `pending_days` by zero and writes **no** ledger row —
`ux_llg__one_consumption_per_request` is satisfied vacuously and the balance screen shows
no movement, which is the truth. Such a request still routes for approval and still folds
into attendance as LOP (§3.7).

`leave_balance` is recomputed by `fn_refresh_leave_balance(employee, type, period)` in the
**same transaction** as every ledger insert, and re-verified nightly by
`leave-balance-verify`; a mismatch raises P1 and writes an `audit_event`.

`leave.sufficient_balance` is `available_days - pending_days >= balance_days` unless
`leave_type.allows_negative_balance`. A **missing** `leave_balance` row fails the guard
(fail-closed) rather than being read as zero — an employee with no ledger history has no
entitlement to spend, and reading the absence as `0 >= 0` would let an unaccrued leave
through and render a balance the ledger does not support. Because `pending_days` is included, two concurrent
submissions cannot both pass — combined with the `SELECT … FOR UPDATE` on the
`leave_balance` row (§11.2) this closes the double-spend race.

`ux_llg__one_consumption_per_request UNIQUE (leave_request_id, kind)` makes the
consumption and the reversal each idempotent: a retried approval cannot double-deduct.

### 3.5 Overlap rejection

`ex_leave_request__no_self_overlap` — a GiST exclusion constraint on
`(employee_id, daterange(start_date, end_date, '[]'))` `WHERE status IN ('PENDING_APPROVAL','APPROVED')`
— is the authority. The `leave.no_overlap` guard runs the same predicate first so the user
gets a clean `422 GUARD_FAILED` with the conflicting request's reference number; the
constraint is the backstop that survives concurrency. A constraint violation surfacing at
commit is translated to the same `422`, never a `500`.

Overlap is evaluated on the **calendar span**, not on working days — two requests cannot
share a date even if one of them contributes zero days on it.

### 3.6 Accrual, carry-forward and lapse (scheduled)

| Job                    | Cadence                                                                                   | Writes                                                                                                                        | Audit                                           |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `leave-accrual`        | On `leave_scheme.accrual_on_day_of_month`, per `leave_entitlement_rule.accrual_frequency` | One `ACCRUAL` ledger row per (employee, type, period), `actor_kind='SCHEDULER'`, pro-rated for joiners in the accrual month   | `LEAVE.ACCRUED`                                 |
| `leave-carry-forward`  | On `leave_period` rollover                                                                | `CARRY_FORWARD_OUT` (old period) + `CARRY_FORWARD_IN` (new period), capped at `leave_entitlement_rule.max_carry_forward_days` | `LEAVE.CARRIED_FORWARD`                         |
| `leave-lapse`          | On `leave_period` close, after carry-forward                                              | `LAPSE` rows for the uncarried remainder                                                                                      | `LEAVE.LAPSED`                                  |
| `leave-balance-verify` | Nightly                                                                                   | Re-folds the ledger and compares to `leave_balance`                                                                           | `LEAVE.BALANCE_VERIFIED` / P1 alert on mismatch |

Each job is idempotent through `ux_llg` semantics plus an `ess_ops.background_job` lease;
a re-run in the same period writes nothing new. An employee with no ledger rows yet has
**no** `leave_balance` row, and the Leave screen renders the designed empty state — it
never renders `0 / 0`.

### 3.7 The link into attendance (LOP for unpaid leave)

When `attendance_record` is materialised (ATR-1) or recomputed (ATR-2, and after LV-4 /
LV-7 / LV-8 while the period is `OPEN`):

```
paid_leave_days = Σ lrd.day_fraction
                  WHERE lrd.employee_id = :emp
                    AND lrd.leave_date BETWEEN period.start_date AND period.end_date
                    AND lrd.counts_toward_balance            -- working day AND leave_type.is_paid
                    AND lr.status = 'APPROVED'

unpaid_leave_days = Σ lrd.day_fraction
                  WHERE … AND lrd.is_working_day AND NOT leave_type.is_paid
                    AND lr.status = 'APPROVED'

lop_days = absent_days + unpaid_leave_days          -- unless a committed LOP_OVERRIDE input replaces it
```

**The fold has a window, and the window is a guard.** `leave.attendance_period_open` (new;
register it in `DATA-MODEL.md §19.3`) holds when the `attendance_period` covering the
request's dates either does not exist yet or is in `OPEN`. LV-4 and LV-8 carry it. Without
it, a manager could approve a paid leave after HR had submitted, and after the manager had
approved, the very period that leave belongs to: the ledger would consume the balance, the
attendance record would still say `absent`, and the employee would be docked for a day
they had been granted. The guard's failure message names the period and offers the two
lawful routes — reopen (ATT-7/ATT-8) while the cycle is pre-`CALCULATING`, or approve
after publication and settle through a `payroll_correction` (§1.10.3).

Symmetrically, `attendance.no_open_leave_in_period` (new) blocks ATT-2 while any
`PENDING_APPROVAL` leave overlaps the period. Together the two guards make the fold total:
at the instant HR submits, every leave touching the period has been decided, and after
that instant no decision can change it without a recorded reopen or correction.

`payable_days = eligible_days - lop_days` then flows into §1.9.1 as the proration
numerator. At ATT-6 (period `LOCKED`) every contributing `leave_request` gets
`attendance_record_id` set, after which `leave.not_yet_locked_by_attendance` fails and the
request can no longer be withdrawn or cancelled — a leave that has been paid cannot be
retracted without a payroll correction.

### 3.8 Leave invariants

| #         | Invariant                                                                       | Enforced by                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LV-INV-1  | `total_days` is always server-computed from `leave_request_day`                 | Trigger; direct assignment raises                                                                                                                                                                                                   |
| LV-INV-2  | No employee has two live requests covering the same date                        | `ex_leave_request__no_self_overlap`                                                                                                                                                                                                 |
| LV-INV-3  | `available_days` equals the ledger fold, always                                 | `fn_refresh_leave_balance` in-transaction + nightly verify                                                                                                                                                                          |
| LV-INV-4  | Exactly one `CONSUMPTION` and at most one `CONSUMPTION_REVERSAL` per request    | `ux_llg__one_consumption_per_request`                                                                                                                                                                                               |
| LV-INV-5  | `pending_days >= 0` and never counts a decided request                          | `ck_leave_balance__pending` + settlement in every terminal transition                                                                                                                                                               |
| LV-INV-6  | The approver is the snapshotted `approver_employee_id`, not the current manager | `approver_employee_id` + `approval.actor_is_assigned_approver`                                                                                                                                                                      |
| LV-INV-7  | A manager never approves their own leave                                        | `ck_at__not_self` on `approval_task` + ancestor/HRBP routing                                                                                                                                                                        |
| LV-INV-8  | An approved leave folded into a locked attendance period cannot be withdrawn    | `leave.not_yet_locked_by_attendance`                                                                                                                                                                                                |
| LV-INV-9  | The ledger is append-only                                                       | `trg_append_only_leave_ledger`                                                                                                                                                                                                      |
| LV-INV-10 | Entitlement moves by `balance_days`, never by `total_days`                      | §3.4; a property test asserts that an unpaid-type request of any length leaves every `leave_balance` column unchanged                                                                                                               |
| LV-INV-11 | No approved paid leave exists that its period's attendance does not reflect     | `leave.attendance_period_open` on LV-4/LV-8, `attendance.no_open_leave_in_period` on ATT-2, the recompute on LV-7; `leave-attendance-reconcile` (nightly) re-folds every `OPEN`/`HR_SUBMITTED` period and raises P1 on a difference |

### 3.9 Leave failure paths

| Failure                          | Compensation                                                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insufficient balance             | `422` naming the balance and the shortfall, from `leave_balance` — never a guessed number                                                                                                                                 |
| Overlap                          | `422` naming the conflicting `reference_no`                                                                                                                                                                               |
| Notice period too short          | `422`; HR may submit on the employee's behalf under `leave:request:create:self` + `leave:request:approve:any`, waiving `leave.min_notice`, which is audited with a reason                                                 |
| Missing medical certificate      | `422` from `leave.attachment_if_required`; the request stays `DRAFT` and the file may be attached later                                                                                                                   |
| Manager left the company         | `approver_employee_id` still points at them; `approval.actor_is_assigned_approver` also admits `leave:request:approve:any`, so HR reassigns the `approval_task` (`REASSIGNED` + a replacement task) with a mandatory note |
| Approval raced with a withdrawal | The `FOR UPDATE` lock serialises them; the loser gets `409 INVALID_TRANSITION` because `from_state` no longer matches                                                                                                     |
| Balance drift detected           | Nightly verify raises P1; the ledger is authoritative and `leave_balance` is rebuilt from it — the projection is never trusted over the ledger                                                                            |

---

## 4. EXPENSE

### 4.1 States

`ess_expense_claim_status`: `DRAFT`, `SUBMITTED`, `PENDING_MANAGER`, `MANAGER_APPROVED`,
`MANAGER_REJECTED`, `PENDING_FINANCE`, `FINANCE_APPROVED`, `FINANCE_REJECTED`,
`QUEUED_FOR_PAYMENT`, `REIMBURSED`, `WITHDRAWN`, `CANCELLED`.
Terminal: `REIMBURSED`, `MANAGER_REJECTED`, `FINANCE_REJECTED`, `WITHDRAWN`, `CANCELLED`.

### 4.2 Transition table (`machine = 'expense_claim'`)

| #      | from → to                                    | Trigger                                                            | Actor                                    | Guards                                                                                                                                                                                                                                | Effects                                                                                                                                                       | Audit                       | Notify                                                                               |
| ------ | -------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| EXP-1  | `NULL` → `DRAFT`                             | `POST /expense-claims`                                             | EMPLOYEE `expense:claim:create:self`     | `expense.self_only`                                                                                                                                                                                                                   | Lines created; `reference_no` from the sequence                                                                                                               | `EXPENSE.DRAFTED`           | —                                                                                    |
| EXP-2  | `DRAFT` → `SUBMITTED`                        | `POST /expense-claims/:id/submit` (the prototype's "Submit claim") | EMPLOYEE `expense:claim:create:self`     | `expense.has_lines`, `expense.receipt_if_required`, `expense.within_hard_limits`, `expense.manager_exists`                                                                                                                            | `submitted_at`; `expense_fy_rollup` refreshed                                                                                                                 | `EXPENSE.SUBMITTED`         | —                                                                                    |
| EXP-3  | `SUBMITTED` → `PENDING_MANAGER`              | _system_, same transaction                                         | _system_                                 | `expense.approval_task_created`                                                                                                                                                                                                       | `approval_task` (`kind='EXPENSE_CLAIM'`, `amount_minor`, title/subtitle composed server-side)                                                                 | `EXPENSE.ROUTED_TO_MANAGER` | `EXPENSE_SUBMITTED` → manager                                                        |
| EXP-4  | `PENDING_MANAGER` → `MANAGER_APPROVED`       | `POST /expense-claims/:id/manager-approve`                         | MANAGER `expense:claim:approve:team`     | `approval.actor_is_assigned_approver`                                                                                                                                                                                                 | `manager_decided_at`, `manager_decided_by_employee_id`; optional `approved_amount_minor` (partial approval) recorded on `approval_decision`; rollup refreshed | `EXPENSE.MANAGER_APPROVED`  | `EXPENSE_DECIDED` → employee; `EXPENSE_DECISION` email                               |
| EXP-5  | `PENDING_MANAGER` → `MANAGER_REJECTED`       | `POST /expense-claims/:id/manager-reject`                          | MANAGER `expense:claim:approve:team`     | `approval.actor_is_assigned_approver`, `approval.note_required`                                                                                                                                                                       | `decision_note` (renders as the claim row's "Use the L&D budget flow" style note)                                                                             | `EXPENSE.MANAGER_REJECTED`  | `EXPENSE_DECIDED`; `EXPENSE_DECISION` email                                          |
| EXP-6  | `MANAGER_APPROVED` → `PENDING_FINANCE`       | _system_                                                           | _system_                                 | `expense.category_requires_finance`                                                                                                                                                                                                   | `approval_task` for the ACCOUNTS queue (assignee resolved from `ticket_category`-style routing: the Accounts role's members)                                  | `EXPENSE.ROUTED_TO_FINANCE` | —                                                                                    |
| EXP-7  | `MANAGER_APPROVED` → `QUEUED_FOR_PAYMENT`    | _system_                                                           | _system_                                 | `expense.category_skips_finance`                                                                                                                                                                                                      | §4.5 batch assignment                                                                                                                                         | `EXPENSE.QUEUED`            | —                                                                                    |
| EXP-8  | `PENDING_FINANCE` → `FINANCE_APPROVED`       | `POST /expense-claims/:id/finance-approve`                         | ACCOUNTS `expense:claim:approve:finance` | `approval.actor_is_assigned_approver`, `expense.receipt_if_required`, `expense.within_hard_limits` — both re-evaluated here, because an attachment can be quarantined or a limit changed between the manager's decision and Finance's | `finance_decided_at`, `finance_settled_at = now()`                                                                                                            | `EXPENSE.FINANCE_APPROVED`  | `EXPENSE_DECIDED` → employee                                                         |
| EXP-9  | `PENDING_FINANCE` → `FINANCE_REJECTED`       | `POST /expense-claims/:id/finance-reject`                          | ACCOUNTS `expense:claim:approve:finance` | `approval.note_required`                                                                                                                                                                                                              | `decision_note`                                                                                                                                               | `EXPENSE.FINANCE_REJECTED`  | `EXPENSE_DECIDED`; `EXPENSE_DECISION` email                                          |
| EXP-10 | `FINANCE_APPROVED` → `QUEUED_FOR_PAYMENT`    | `POST /reimbursement-batches/:id/add` or the auto-batcher          | ACCOUNTS `expense:reimburse`             | `reimb.batch_open`, `reimb.cycle_is_regular`                                                                                                                                                                                          | `reimbursement_batch_item` created; §4.5                                                                                                                      | `EXPENSE.QUEUED`            | —                                                                                    |
| EXP-11 | `QUEUED_FOR_PAYMENT` → `REIMBURSED`          | _system_, at PAY-17                                                | _system_                                 | `reimb.cycle_published`                                                                                                                                                                                                               | `reimbursement_batch` → `PAID`, `paid_at`; the claim's `paid_payroll_cycle_id` set; rollup refreshed                                                          | `EXPENSE.REIMBURSED`        | `EXPENSE_REIMBURSED` → employee ("EXP-2210 reimbursed with your August 2026 salary") |
| EXP-12 | `DRAFT` → `CANCELLED`                        | `DELETE /expense-claims/:id`                                       | EMPLOYEE `expense:claim:withdraw:self`   | `expense.self_only`                                                                                                                                                                                                                   | Lines cascade-deleted; attachments retained as orphaned `file_object` rows until the retention purge                                                          | `EXPENSE.DISCARDED`         | —                                                                                    |
| EXP-13 | `SUBMITTED`\|`PENDING_MANAGER` → `WITHDRAWN` | `POST /expense-claims/:id/withdraw`                                | EMPLOYEE `expense:claim:withdraw:self`   | `expense.self_only`, `expense.not_yet_decided`                                                                                                                                                                                        | `approval_task` → `WITHDRAWN`; rollup refreshed                                                                                                               | `EXPENSE.WITHDRAWN`         | —                                                                                    |

### 4.3 Category caps

Caps live in `expense_limit` (`expense_limit_basis` ∈ `PER_CLAIM`, `PER_LINE`, `PER_DAY`,
`PER_MONTH`, `PER_FY`), each with `limit_amount_minor` and `is_hard_limit`.

- **Hard limit** (`is_hard_limit = true`) — `expense.within_hard_limits` fails at EXP-2 with
  a `422` naming the category, the cap and the overage, all read from `expense_limit`.
  The prototype's "Internet bill, August · Within ₹1,500 cap" subtitle is
  `expense_limit.limit_amount_minor` for `REMOTE_WORK` / `PER_MONTH`, never a literal.
- **Soft limit** — the claim submits, and the `approval_task.subtitle` carries the overage
  so the manager decides with the fact in front of them.
- **Escalation threshold** — `expense_limit.escalation_amount_minor`
  (`DATA-MODEL.md §13.1`), which this document previously never used. A claim at or above
  it is routed **skip-level**: the `approval_task` is created with
  `assignment_reason = 'SKIP_LEVEL'` and `assignee_employee_id` = the next ancestor in
  `employee_reporting_closure` above the primary manager, falling back to the HR business
  partner at the top of the chain. The employee's own manager receives an
  `EXPENSE_SUBMITTED` notification marked "escalated above you", so nothing is silent. A
  NULL `escalation_amount_minor` means no skip-level routing for that category — it does
  not mean "escalate everything".
- `PER_DAY` / `PER_MONTH` / `PER_FY` bases aggregate over the employee's non-rejected,
  non-withdrawn claims in the window, including the claim being submitted.
- A per-diem style limit is enforced per line against `expense_claim_line.spend_date`.

### 4.4 Attachment requirement

`expense.receipt_if_required` fails unless, for every line where
`expense_category.requires_receipt AND (receipt_required_above_minor IS NULL OR line.amount_minor > receipt_required_above_minor)`,
there is an `expense_attachment` whose `file_object.scan_status = 'CLEAN'`.

A `PENDING` scan does not pass: submission is blocked with "We are still scanning your
receipt" rather than accepted optimistically. An `INFECTED` file is quarantined, the
attachment row is deleted, the employee is told, and a `SECURITY_ALERT` notification goes
to HR (`SECURITY.md §5.3`).

### 4.5 Which payroll cycle pays a claim — the cut-off rule

Deterministic, evaluated by `fn_target_reimbursement_batch(settled_at)`:

```
cutoff_of(M) = make_date(year(M), month(M), organization.expense_cutoff_day_of_month)
               at 23:59:59.999999 in organization.timezone

settled_at   = the timestamp at which the claim became payable
             = finance_settled_at          when the category requires finance approval
             = manager_decided_at          when it does not

target_month = settled_at <= cutoff_of(month(settled_at))
                 ? month(settled_at)
                 : month(settled_at) + 1

batch        = the reimbursement_batch with cutoff_date = cutoff_of(target_month),
               created on demand in DRAFT
```

The batch is then bound to a cycle: `reimbursement_batch.payroll_cycle_id` is the
`REGULAR` cycle whose `period_code` equals `target_month`. **Second condition:** the batch
can only be sent to payroll while that cycle is `INPUTS_OPEN`
(`reimb.cycle_inputs_open`). If the cycle has already locked its inputs, the batch rolls
to the next month's cycle: `payroll_cycle_id` is re-pointed, every item's
`expense_claim.expected_payment_cycle_id` updated, an `EXPENSE.BATCH_ROLLED_FORWARD` audit
event written, and each affected employee receives an `EXPENSE_DECIDED` notification
("EXP-2274 will now be reimbursed with your October 2026 salary"). **The promised date on
screen is always the persisted `reimbursement_batch.payroll_cycle_id`'s
`scheduled_pay_date`** — the "Approved · paying 30 Sep" tile reads it, and when no batch
is assigned yet the tile shows the amount with the sub-label "Payment cycle not assigned
yet", never an invented date.

`reimbursement_batch` machine: `DRAFT → LOCKED` (`reimb.all_claims_finance_approved`) →
`SENT_TO_PAYROLL` (`reimb.cycle_inputs_open`; creates one `payroll_input_item` of kind
`REIMBURSEMENT_PAYOUT` per item, linked by `reimbursement_batch_item.payroll_input_item_id`
and `ux_pii__one_payout_per_claim`) → `PAID` (_system_, `reimb.cycle_published`, at PAY-17);
`DRAFT|LOCKED → CANCELLED` with a note.

### 4.6 Expense invariants

| #         | Invariant                                                                                 | Enforced by                                                                 |
| --------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| EXP-INV-1 | A claim is paid at most once                                                              | `ux_rbi__claim UNIQUE (expense_claim_id)` + `ux_pii__one_payout_per_claim`  |
| EXP-INV-2 | `REIMBURSED` implies a `PUBLISHED`/`CLOSED` payroll cycle paid it                         | `reimb.cycle_published` + `paid_payroll_cycle_id` NOT NULL                  |
| EXP-INV-3 | A manager never approves their own claim                                                  | `ck_at__not_self`                                                           |
| EXP-INV-4 | Finance approval never precedes manager approval                                          | Only `MANAGER_APPROVED → PENDING_FINANCE` reaches the finance states        |
| EXP-INV-5 | Every reimbursed rupee traces to a `payroll_input_item` and a `payslip_line`              | `payroll_input_item.expense_claim_id` + `payslip_line.source_input_item_id` |
| EXP-INV-6 | The three Expenses tiles equal the persisted rollup, which equals a re-scan of the claims | `expense_fy_rollup` maintained by trigger + nightly verify                  |
| EXP-INV-7 | A claim above a hard cap never reaches `SUBMITTED`                                        | `expense.within_hard_limits`                                                |

### 4.7 Expense failure paths

| Failure                                         | Compensation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt still scanning                          | `422`; the claim stays `DRAFT`, nothing is lost                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Receipt infected                                | Attachment removed, employee notified, `SECURITY_ALERT` to HR, claim stays `DRAFT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Claim outside the claim window                  | **Not a block.** `expense.spend_within_claim_window` (`CURRENT_DATE - spend_date <= org_setting.expense_claim_window_days`, seeded `30`) is a **soft flag**, per the canonical catalogue: the claim submits, `policy_flag_codes` gains `LATE_SUBMISSION`, and the flag renders on the approver's card and in the Finance queue. A late bill is still a real expense; refusing it pushes a real cost off the books and into a help-desk ticket. The window is one value in one row read by one guard — the earlier draft both hard-coded `30` and described it as a hard `422` |
| Manager rejects                                 | Terminal `MANAGER_REJECTED`; the employee raises a **new** claim — a rejected claim is never re-opened, so the audit trail stays honest                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Finance rejects after manager approval          | Terminal `FINANCE_REJECTED`; employee and manager both notified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Batch missed the cycle                          | §4.5 roll-forward, audited and notified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Payroll cycle cancelled after `SENT_TO_PAYROLL` | PAY-19 returns the batch to `LOCKED`, deletes its `REIMBURSEMENT_PAYOUT` input items, and re-targets; claims stay `QUEUED_FOR_PAYMENT` and are never silently marked paid                                                                                                                                                                                                                                                                                                                                                                                                     |
| Partial approval                                | `approval_decision.approved_amount_minor` is recorded and becomes the payable amount; the difference is visible to the employee with the manager's note                                                                                                                                                                                                                                                                                                                                                                                                                       |

---

## 5. POLICY

Two machines: `policy_version` (the document's lifecycle) and `policy_acknowledgement`
(the employee's act). Plus the derived per-employee status that the UI renders.

### 5.1 `policy_version` transitions (`machine = 'policy_version'`)

`ess_policy_version_status`: `DRAFT`, `IN_REVIEW`, `PUBLISHED`, `SUPERSEDED`, `WITHDRAWN`.
Terminal: `SUPERSEDED`, `WITHDRAWN`.

| #     | from → to                                       | Trigger                                    | Actor               | Guards                                                                         | Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Audit                      | Notify                                                                                                                                 |
| ----- | ----------------------------------------------- | ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POL-1 | `NULL` → `DRAFT`                                | `POST /policies/:id/versions`              | HR `policy:author`  | `version_major.version_minor` > the latest published version of the policy     | `body_sha256` computed from `body_markdown`; `policy_version_point` rows; `policy_applicability_rule` rows                                                                                                                                                                                                                                                                                                                                                                       | `POLICY.VERSION_DRAFTED`   | —                                                                                                                                      |
| POL-2 | `DRAFT` → `IN_REVIEW`                           | `POST /policy-versions/:id/submit-review`  | HR `policy:author`  | `policy.has_body`                                                              | The version becomes immutable for body/version/effective fields (`trg_policy_version_immutable`)                                                                                                                                                                                                                                                                                                                                                                                 | `POLICY.VERSION_IN_REVIEW` | —                                                                                                                                      |
| POL-3 | `IN_REVIEW` → `DRAFT`                           | `POST /policy-versions/:id/return`         | HR `policy:author`  | `approval.note_required`                                                       | Body becomes editable again **only** because the version never left `DRAFT`/`IN_REVIEW`; once published it can never return                                                                                                                                                                                                                                                                                                                                                      | `POLICY.VERSION_RETURNED`  | —                                                                                                                                      |
| POL-4 | `IN_REVIEW` → `PUBLISHED`                       | `POST /policy-versions/:id/publish`        | HR `policy:publish` | `policy.has_body`, `policy.effective_date_set`, `policy.applicability_defined` | §5.2 in full                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `POLICY.PUBLISHED`         | `POLICY_ASSIGNED` → every newly assigned employee                                                                                      |
| POL-5 | `PUBLISHED` → `SUPERSEDED`                      | _system_, inside POL-4 of the next version | _system_            | the superseding version is `PUBLISHED` and `effective_from` > this version's   | `effective_to = next.effective_from - 1 day`; `next.supersedes_version_id = this.id`; §5.3                                                                                                                                                                                                                                                                                                                                                                                       | `POLICY.SUPERSEDED`        | —                                                                                                                                      |
| POL-6 | `DRAFT`\|`IN_REVIEW`\|`PUBLISHED` → `WITHDRAWN` | `POST /policy-versions/:id/withdraw`       | HR `policy:publish` | `approval.note_required`                                                       | `withdrawn_at/_reason`; open `policy_assignment` rows → `superseded_at = now()`; existing acknowledgements are **kept** (they are historical fact); the prior published version's `effective_to` is re-opened to NULL and its status returned to `PUBLISHED` **only when this version was its direct successor and no third version has since published** — checked against `ux_pv__policy_current` inside the transaction, so withdrawal can never produce two current versions | `POLICY.WITHDRAWN`         | `POLICY_ASSIGNED` (tone GRAY, "…has been withdrawn and no longer needs your acknowledgement") → every employee with an open assignment |

### 5.2 Publication: applicability resolution and assignment

Inside the POL-4 transaction, then continued by job `policy-assignment` for large
populations. **"The transaction records the intent" means one concrete row**, not a
disposition: POL-4 inserts an `ess_ops.background_job` row with
`job_name = 'policy-assignment'`, `scheduled_for = now()` and
`payload = {"policyVersionId": "<id>"}`, in the same transaction as the version's status
change. If the API dies immediately after commit, the job row still exists and the worker
picks it up; if the transaction rolls back, neither the publication nor the job exists.
The threshold at which POL-4 stops assigning inline and leaves it all to the job is
`org_setting.policy_inline_assignment_max` (seeded `500` employees) — a number, not a
judgement call. Below it, POL-4 does the whole assignment inline **and still writes the
job row**, which then finds nothing to do and completes; idempotency
(`ux_pa__version_employee`) makes the overlap harmless and removes the need for the
implementer to choose.

1. **Resolve the audience.** An employee is in scope when at least one
   `policy_applicability_rule` with `is_include = true` matches **and** no rule with
   `is_include = false` matches. Matching evaluates
   `employment_as_of(employee, policy_version.effective_from)` against the rule's
   dimension (`ALL`, `DEPARTMENT` — with `includes_department_descendants` walking the
   department tree, `LOCATION`, `DESIGNATION`, `COST_CENTRE`, `EMPLOYMENT_TYPE`,
   `EMPLOYEE`). Only employees with `employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD')`
   on `effective_from` are assigned.
2. **Create assignments.** One `policy_assignment` per employee
   (`ux_pa__version_employee` makes this idempotent), with
   `due_on = acknowledgement_due_on` when set, else `assigned_at::date + acknowledgement_due_days`,
   else `NULL` (and the UI then renders no "Due …" text).
   `requires_acknowledgement = false` ⇒ **no** assignment rows at all; the policy appears
   in the list as readable with no status chip.
   A `due_on` that has already passed at assignment time is **not** written as overdue on
   day one: `due_on = greatest(acknowledgement_due_on, assigned_at::date + org_setting.policy_min_ack_days)`
   (seeded `7`), and the fact that the absolute date was overridden is recorded in
   `policy_assignment.source_rule_code = 'POLICY_DUE_DATE_FLOORED'`. An employee cannot be
   overdue for a document they were handed this morning.
3. **Supersede the prior version's assignments** (§5.3).
4. **Notify.** One `POLICY_ASSIGNED` notification per newly assigned employee, linked from
   `policy_assignment.notification_id`, tone AMBER, `deep_link_screen = 'policies'`,
   `deep_link_params = {"policyVersionId": …}`.
5. **Announce (optional).** If HR also published an `announcement` referencing the policy,
   that is a separate object with its own audience (§10) — the two are never conflated.

**New joiners after publication.** Job `policy-assignment` also runs on employee
activation (§9): every `PUBLISHED`, non-superseded `policy_version` whose applicability
matches the new employee gets an assignment with
`due_on = activation_date + acknowledgement_due_days` (or the absolute org date when it is
still in the future; when the absolute date has passed, `due_on = activation_date + 7`,
and this rule is recorded as `source_rule_code='POLICY_NEW_JOINER'`). This is why the
Home "Needs your attention" list is a query, never an inference.

### 5.3 What happens to acknowledgements when a new version publishes

| Object                                                  | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy_acknowledgement` rows for the **prior** version | **Untouched.** They remain valid for the version they were made against, carry `acknowledged_body_sha256` proving exactly which text was acknowledged, and are append-only. They are never re-pointed at the new version.                                                                                                                                                                                                                                                                                                                                                                                        |
| `policy_assignment` rows for the prior version          | `superseded_at = now()`. A superseded assignment never appears in the pending count and never goes overdue.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `policy_version` (prior)                                | → `SUPERSEDED`, `effective_to` closed. Still readable, still downloadable by anyone who acknowledged it; the Policies list shows the **current** version by default with a "Version history" affordance.                                                                                                                                                                                                                                                                                                                                                                                                         |
| New version                                             | Fresh `policy_assignment` rows for the resolved audience ⇒ every in-scope employee's derived status becomes `PENDING` again, including those who acknowledged the prior version.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Employees no longer in scope                            | No assignment is created and their prior acknowledgement stands. The policy row is **shown, not hidden**, with the gray `NOT_APPLICABLE` chip and the sub-label "No longer applies to your role — you acknowledged v3.1 on 12 Jan 2026", whenever the employee has a prior acknowledgement of any version of that policy; it is **omitted from the list entirely** when they have none, because a policy that never applied to them and that they never acknowledged is not their record. The earlier "gray or hidden" left the implementer to choose, and the two choices produce different compliance reports. |

The derived per-employee status the list chip and the badge render:

```sql
CASE
  WHEN ack.id IS NOT NULL                                   THEN 'ACKNOWLEDGED'   -- green
  WHEN pa.due_on IS NOT NULL AND pa.due_on < CURRENT_DATE   THEN 'OVERDUE'        -- red
  WHEN pa.id IS NOT NULL                                    THEN 'PENDING'        -- amber
  ELSE 'NOT_APPLICABLE'                                                            -- gray
END
```

joined over `policy_assignment pa … WHERE pa.superseded_at IS NULL` and
`policy_acknowledgement ack ON ack.policy_assignment_id = pa.id`. The sidebar/Home
"N awaiting acknowledgement" chip is `count(*)` of the `PENDING` + `OVERDUE` rows; with
zero it is not rendered at all.

### 5.4 `policy_acknowledgement` (`machine = 'policy_acknowledgement'`)

| #      | from → to               | Trigger                                                                                 | Actor                              | Guards                                                                                                                          | Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Audit                 | Notify                                                                          |
| ------ | ----------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| PACK-1 | `NULL` → `ACKNOWLEDGED` | `POST /policy-versions/:id/acknowledge` (the prototype's "I have read and acknowledge") | EMPLOYEE `policy:acknowledge:self` | `policy.assignment_open` (an assignment exists for (employee, version) with `superseded_at IS NULL` and no acknowledgement yet) | Appends one row with `employee_id`, `policy_version_id`, `policy_assignment_id`, `status='ACKNOWLEDGED'`, `acknowledged_at = now()`, `acknowledged_body_sha256` = the version's `body_sha256` **re-read inside the transaction**, `acknowledgement_text` = the exact consent sentence rendered (read from `ui_copy` by key and version, so the sentence itself is persisted and versioned — §0.10), `ip_address`, `user_agent`, `app_user_id`, and `session_id` | `POLICY.ACKNOWLEDGED` | — (the act needs no notification; it removes one from the employee's Home list) |
| PACK-2 | `NULL` → `WAIVED`       | `POST /policy-assignments/:id/waive`                                                    | HR `policy:publish`                | `approval.note_required`                                                                                                        | Same row shape with `status='WAIVED'`, `waived_by_user_id`, `waiver_reason`                                                                                                                                                                                                                                                                                                                                                                                     | `POLICY.WAIVED`       | `POLICY_ASSIGNED` (tone GRAY) → employee                                        |

**The four mandated facts** — employee, policy version, acknowledgement status,
acknowledgement timestamp — are `employee_id`, `policy_version_id`, `status`,
`acknowledged_at` on this append-only row. `acknowledged_body_sha256` makes the record
evidential: it proves _which text_ was acknowledged even if the PDF is later
re-rendered. `ux_pack__employee_version` makes a double-click idempotent (the second
insert is a no-op returning `200` with the existing row, not a `409`).

An acknowledgement is **never** edited or deleted. Re-acknowledging a new version is a new
row against that version.

**The employee must have been able to read what they acknowledged.** PACK-1 additionally
requires that a `POLICY.READ` audit row exists for this `(employee, policy_version)` —
written when the version's body is served to them — and that the `body_sha256` on that
read event equals the one being acknowledged. A POST to the acknowledge route from a
client that never fetched the policy is refused `422 GUARD_FAILED`
(`policy.version_was_read`). This is what makes "employees must be able to read each
applicable policy and explicitly acknowledge it" an enforced sequence rather than a hope,
and it is why `acknowledged_body_sha256` is re-read inside the transaction: the text
served, the text acknowledged and the text stored are provably one text.

### 5.5 Due dates and overdue escalation

The ladder is expressed as **thresholds crossed, not exact-day equalities**. Each rung
fires when its threshold has been reached **and** the rung has not already fired
(`ux_notification__dedupe` on `(recipient, kind, entity_type, entity_id, source_rule_code)`
is what makes "already fired" a fact rather than a memory). The earlier `= 7` / `= 3` /
`= 1` equalities meant that a single missed job run — a deploy, a database failover, a
worker restart at 08:00 — silently skipped that rung **forever**, because the day never
comes back. A missed run must catch up on the next run, and it does.

Job `policy-due-reminder`, daily at 08:00 org time, over
`policy_assignment WHERE superseded_at IS NULL AND due_on IS NOT NULL` with no
acknowledgement:

| Condition                     | Notification             | `source_rule_code`          | Recipient                                                                                      |
| ----------------------------- | ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `due_on - CURRENT_DATE <= 7`  | `POLICY_ASSIGNED`, amber | `POLICY_DUE_IN_7_DAYS`      | employee                                                                                       |
| `due_on - CURRENT_DATE <= 3`  | `POLICY_ASSIGNED`, amber | `POLICY_DUE_IN_3_DAYS`      | employee                                                                                       |
| `due_on - CURRENT_DATE <= 1`  | `POLICY_ASSIGNED`, amber | `POLICY_DUE_TOMORROW`       | employee                                                                                       |
| `CURRENT_DATE >= due_on + 1`  | `POLICY_OVERDUE`, red    | `POLICY_OVERDUE`            | employee                                                                                       |
| `CURRENT_DATE >= due_on + 7`  | `POLICY_OVERDUE`, red    | `POLICY_OVERDUE_ESCALATION` | the employee's primary manager **and** their HR business partner                               |
| `CURRENT_DATE >= due_on + 21` | `POLICY_OVERDUE`, red    | `POLICY_OVERDUE_COMPLIANCE` | HR compliance queue (a role-targeted notification to every user holding `policy:ack:read:any`) |

The dedupe constraint guarantees each rung fires exactly once even if the job runs twice,
and the `<=` form guarantees it fires **at least** once even if the job misses a day —
together, exactly once — the reminders are
deliberately a fixed ladder rather than a recurring nag, so the bell count stays
meaningful. Also `POLICY_REMINDER` email at `POLICY_OVERDUE_ESCALATION` only (one email,
not five).

There is no auto-acknowledgement, no auto-waiver and no implied consent. An overdue
assignment stays open until the employee acts, HR waives it, or the version is superseded
or withdrawn.

### 5.6 Policy invariants

| #          | Invariant                                                            | Enforced by                                                                      |
| ---------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| POL-INV-1  | A published version's body and version number never change           | `trg_policy_version_immutable`                                                   |
| POL-INV-2  | At most one `PUBLISHED` non-superseded version per policy            | `ux_pv__policy_current`                                                          |
| POL-INV-3  | Published versions of a policy have non-overlapping effective ranges | `ex_policy_version__one_effective`                                               |
| POL-INV-4  | An acknowledgement always names a version, never a policy            | `policy_version_id` NOT NULL + `ux_pack__employee_version`                       |
| POL-INV-5  | Acknowledgements are append-only                                     | `trg_append_only_policy_ack`                                                     |
| POL-INV-6  | The acknowledged text is provable                                    | `acknowledged_body_sha256 = policy_version.body_sha256` at the moment of the act |
| POL-INV-7  | Pending/overdue counts derive only from live assignments             | `WHERE superseded_at IS NULL` in every count query                               |
| POL-INV-8  | An employee can only acknowledge a policy assigned to them           | `policy.assignment_open` + `policy:acknowledge:self` scope                       |
| POL-INV-9  | An employee cannot acknowledge a text they were never served         | `policy.version_was_read` + the `POLICY.READ` audit row's `body_sha256`          |
| POL-INV-10 | No assignment is overdue on the day it is created                    | The `due_on` floor of §5.2 step 2                                                |
| POL-INV-11 | Every reminder rung fires exactly once per assignment                | `<=` thresholds + `ux_notification__dedupe`                                      |

### 5.7 Policy failure paths

| Failure                                    | Compensation                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A published version is wrong               | Publish a corrected version (`v3.2`); the wrong one becomes `SUPERSEDED` with its acknowledgements intact. If it must be repudiated, `WITHDRAWN` with a reason — acknowledgements are still kept as history but the assignments close.                                                 |
| Applicability was wrong (too wide)         | `POST /policy-versions/:id/reassign` (HR `policy:publish`, note required) re-resolves the audience: new matches get assignments; employees no longer matching get `superseded_at` set. Their acknowledgements are kept. Audit `POLICY.AUDIENCE_RECALCULATED` with before/after counts. |
| Applicability was wrong (too narrow)       | Same route; the newly matched employees get assignments with `due_on` recomputed from `now()`                                                                                                                                                                                          |
| The assignment job fails midway            | `ux_pa__version_employee` makes it resumable; `ess_ops.background_job` retries with a lease; the version stays `PUBLISHED` and the notification ladder simply starts later for the stragglers                                                                                          |
| An employee leaves with an open assignment | Offboarding (§9) closes open assignments with `superseded_at` and records `OFFBOARDED` as the reason; the compliance report shows it as closed-unacknowledged, never as acknowledged                                                                                                   |

---

## 6. HELP DESK

### 6.1 States

`ess_ticket_status`: `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `WAITING_ON_EMPLOYEE`,
`RESOLVED`, `CLOSED`, `REOPENED`, `CANCELLED`. Terminal: `CLOSED`, `CANCELLED`.

### 6.2 Transition table (`machine = 'helpdesk_ticket'`)

| #     | from → to                                                                         | Trigger                                                                               | Actor                          | Guards                                                                  | Effects                                                                                                                                                                                                                                                                                                                                                           | Audit                                    | Notify                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HD-1  | `NULL` → `OPEN`                                                                   | `POST /tickets` (the prototype's "Raise ticket")                                      | EMPLOYEE `ticket:create:self`  | category active; `ticket.category_allows_anonymous`, `ticket.self_only` | `ticket_no` from `helpdesk_ticket_seq`; SLA clocks (§6.4); the first `ticket_comment` from `description`; **one `email_outbox` row (§6.3) in the same transaction**; `email_outbox_id` set; default assignee from `ticket_category.default_assignee_user_id/_role_id` (if a single user, the ticket goes straight to `ASSIGNED` via HD-2 in the same transaction) | `TICKET.CREATED` + `TICKET.EMAIL_QUEUED` | `TICKET_UPDATED` → raiser ("HD-4831 raised · first response within 1 working day", the SLA text read from `ticket_category.first_response_sla_hours`); `HELPDESK_TICKET_CREATED` email → `ticket_category.routing_email` |
| HD-2  | `OPEN` → `ASSIGNED`                                                               | `POST /tickets/:id/assign`                                                            | HR `ticket:assign`             | assignee holds `ticket:read:any`                                        | `assigned_to_user_id`, `assigned_at`                                                                                                                                                                                                                                                                                                                              | `TICKET.ASSIGNED`                        | `TICKET_UPDATED` → assignee and raiser                                                                                                                                                                                   |
| HD-3  | `ASSIGNED` → `IN_PROGRESS`                                                        | First `PUBLIC` agent comment, or `POST /tickets/:id/start`                            | HR `ticket:comment:any`        | —                                                                       | `first_responded_at` set by the first `PUBLIC` agent comment (drives `sla_first_response_breached`)                                                                                                                                                                                                                                                               | `TICKET.IN_PROGRESS`                     | `TICKET_UPDATED` → raiser                                                                                                                                                                                                |
| HD-4  | `IN_PROGRESS` → `WAITING_ON_EMPLOYEE`                                             | `POST /tickets/:id/request-info`                                                      | HR `ticket:comment:any`        | a `PUBLIC` comment accompanies it                                       | `sla_paused_at = now()` (R-3)                                                                                                                                                                                                                                                                                                                                     | `TICKET.WAITING_ON_EMPLOYEE`             | `TICKET_UPDATED` → raiser                                                                                                                                                                                                |
| HD-5  | `WAITING_ON_EMPLOYEE` → `IN_PROGRESS`                                             | Raiser posts a `PUBLIC` comment                                                       | EMPLOYEE `ticket:comment:self` | `ticket.self_only`                                                      | `sla_paused_seconds += now() - sla_paused_at`; `sla_paused_at = NULL`; `resolution_due_at` extended by the pause (§6.4)                                                                                                                                                                                                                                           | `TICKET.RESUMED`                         | `TICKET_UPDATED` → assignee                                                                                                                                                                                              |
| HD-6  | `OPEN`\|`ASSIGNED`\|`IN_PROGRESS`\|`WAITING_ON_EMPLOYEE`\|`REOPENED` → `RESOLVED` | `POST /tickets/:id/resolve`                                                           | HR `ticket:resolve`            | `ticket.resolution_summary_present`                                     | `resolved_at`, `resolved_by_user_id`, `resolution_summary`; `sla_resolution_breached` computed                                                                                                                                                                                                                                                                    | `TICKET.RESOLVED`                        | `TICKET_RESOLVED` → raiser; `HELPDESK_TICKET_UPDATED` email → routing address                                                                                                                                            |
| HD-7  | `RESOLVED` → `CLOSED`                                                             | Job `ticket-auto-close` after `org auto_close_days` (7), or `POST /tickets/:id/close` | _system_ / HR `ticket:resolve` | `resolved_at < now() - 7 days` for the job                              | `closed_at`; a satisfaction prompt is offered once                                                                                                                                                                                                                                                                                                                | `TICKET.CLOSED`                          | —                                                                                                                                                                                                                        |
| HD-8  | `RESOLVED` → `REOPENED`                                                           | `POST /tickets/:id/reopen`                                                            | EMPLOYEE `ticket:create:self`  | `ticket.self_only`, `ticket.within_reopen_window` (14 days)             | `reopened_count += 1`; `resolved_at`/`resolved_by_user_id`/`resolution_summary` cleared; SLA clocks restarted from `now()`; the prior resolution is preserved as a `SYSTEM` `ticket_comment`                                                                                                                                                                      | `TICKET.REOPENED`                        | `TICKET_UPDATED` → assignee; `HELPDESK_TICKET_UPDATED` email → routing address                                                                                                                                           |
| HD-9  | `REOPENED` → `ASSIGNED`                                                           | `POST /tickets/:id/assign`                                                            | HR `ticket:assign`             | —                                                                       | As HD-2                                                                                                                                                                                                                                                                                                                                                           | `TICKET.ASSIGNED`                        | `TICKET_UPDATED`                                                                                                                                                                                                         |
| HD-10 | `OPEN` → `CANCELLED`                                                              | `DELETE /tickets/:id`                                                                 | EMPLOYEE `ticket:create:self`  | `ticket.self_only`; not yet assigned                                    | —                                                                                                                                                                                                                                                                                                                                                                 | `TICKET.CANCELLED`                       | —                                                                                                                                                                                                                        |

Chip tones (Design System §1): `OPEN`/`ASSIGNED`/`IN_PROGRESS`/`REOPENED` → amber;
`WAITING_ON_EMPLOYEE` → blue; `RESOLVED`/`CLOSED` → green; `CANCELLED` → gray.
`INTERNAL` comments are never returned to the raiser — enforced in the query
(`WHERE visibility = 'PUBLIC'` for `ticket:read:self`) **and** by RLS.

### 6.3 The email dispatch to `helpdesk@widedroptech.com` — transactional outbox

**The mandated address is guaranteed, not merely defaulted.** Directive 8 requires every
ticket raised in the portal to reach `helpdesk@widedroptech.com`. The routing address is
configuration (`ticket_category.routing_email`, defaulting to
`organization.helpdesk_email`), which is right — it must be changeable without a redeploy
— but configuration that can be changed to _anything_ can be changed to something that
drops the mandate. Three rules close that:

1. `organization.helpdesk_email` is **seeded** to `helpdesk@widedroptech.com` and is
   `NOT NULL`. It is changed only through `PATCH /admin/organization` under
   `org:settings:write`, which writes a `CONFIG_CHANGE` audit row with before/after and
   raises a `SECURITY_ALERT` to every `audit:read` holder.
2. `to_addresses` is built as
   `array_distinct(ARRAY[category.routing_email] || ARRAY[organization.helpdesk_email])`.
   A category may route **in addition to** the organisation help desk; it can never route
   **instead of** it. `ck_email_outbox__helpdesk_recipient CHECK (kind <> 'HELPDESK_TICKET_CREATED' OR cardinality(to_addresses) >= 1)`
   plus a service-layer assertion that `organization.helpdesk_email = ANY(to_addresses)`
   makes the omission unrepresentable.
3. `db:verify-schema` asserts the seeded value, and an integration test raises a ticket in
   every seeded category and asserts the mandated address is in `to_addresses` each time.

**Enqueue (inside the HD-1 transaction, never outside it):**

```
INSERT INTO email_outbox (
  organization_id, kind, status, to_addresses, reply_to_address, from_address,
  subject, template_code, template_data, entity_type, entity_id, idempotency_key)
VALUES (
  :org, 'HELPDESK_TICKET_CREATED', 'QUEUED',
  ARRAY[ticket_category.routing_email],          -- defaults to organization.helpdesk_email
                                                  -- = helpdesk@widedroptech.com
  CASE WHEN t.is_anonymous THEN NULL ELSE employee.work_email END,
  'no-reply@widedroptech.com',
  format('[%s] %s — %s', t.ticket_no, category.name, t.subject),
  'helpdesk_ticket_created',
  jsonb_build_object('ticketNo', t.ticket_no, 'categoryName', category.name,
                     'subject', t.subject, 'raisedByName', <omitted when anonymous>,
                     'raisedAt', t.created_at, 'priority', t.priority,
                     'portalUrl', <deep link>),
  'helpdesk_ticket', t.id,
  'HELPDESK_TICKET_CREATED:helpdesk_ticket:' || t.id || ':v1');
```

- `template_data` carries **identifiers and labels only** — no ticket body, no salary,
  no bank detail, no token. The full body is read in the portal under
  `ticket:read:any`. The two kinds that genuinely must carry a secret (`USER_INVITE`,
  `PASSWORD_RESET`) use the envelope-encrypted `template_data_ct` instead and are barred
  from the plaintext column by a `CHECK` (R-14); the renderer decrypts at send time and
  the dispatcher destroys the ciphertext on `SENT`.
- Every header-bound value (`subject`, `reply_to_address`) has CR/LF stripped
  (`SECURITY.md §B5`) so a subject line cannot inject headers.
- `ux_email_outbox__org_idempotency` makes the enqueue idempotent under request retry.
- If the ticket insert rolls back, **no email row exists**. If it commits, the email is
  durably queued. Delivery is never a precondition for the ticket existing.

**Deliver (job `email-dispatch`, every 30 s):**

```
claim:   UPDATE email_outbox SET status='SENDING'
         WHERE id IN (SELECT id FROM email_outbox
                      WHERE status='QUEUED' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      FOR UPDATE SKIP LOCKED LIMIT 50)
         RETURNING *;
send:    provider HTTPS API (not raw SMTP string concatenation),
         provider idempotency key = email_outbox.id
success: status='SENT', sent_at=now(), provider_message_id=…,
         body_text/body_html=NULL, and for token-bearing kinds
         template_data_ct/_iv/_tag=NULL (R-14) -- the one-time secret is destroyed
         the moment it has been handed to the provider
failure: retry_count += 1
         retry_count <= max_retries (5) → status='QUEUED',
                                          next_attempt_at = now() + least(2^retry_count, 60) minutes
         retry_count  > max_retries    → status='FAILED', failed_at=now(), last_error=…
```

`SENDING` rows older than 10 minutes are swept back to `QUEUED` by the same job (a worker
that died mid-send must not strand a message). Every status change also writes
`helpdesk_ticket.email_delivery_status` (R-3) **in the same transaction**, and an
`audit_event`: `TICKET.EMAIL_SENT` or `TICKET.EMAIL_FAILED`.

**Dead-letter.** `status = 'FAILED'` is the dead-letter state. Effects:

- a `SECURITY_ALERT`-class notification (tone RED, `context_label = 'Help desk'`) to every
  user holding `ticket:read:any`, `source_rule_code = 'HELPDESK_EMAIL_FAILED'`;
- the ticket is flagged in the HR queue (`ix_email_outbox__failed` drives the banner);
- `POST /tickets/:id/retry-notification` (HR `ticket:assign`) resets the row to `QUEUED`
  with `retry_count = 0` and a fresh `idempotency_key` discriminator (`:v2`, `:v3`…),
  audited as `TICKET.EMAIL_RETRIED`.

**What the UI shows — the real delivery state, never an assumption:**

| `email_outbox.status`      | Ticket screen                                                                                                                                                        |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QUEUED` / `SENDING`       | "Notifying the help desk…" (amber dot)                                                                                                                               |
| `SENT`                     | "Help desk notified · 29 Sep 2026, 14:12" (green dot), from `sent_at`                                                                                                |
| `FAILED`                   | Red banner: "We could not email the help desk. **Your ticket HD-4831 is recorded** and is in the People Ops queue." Plus a Retry action for `ticket:assign` holders. |
| `SUPPRESSED` / `CANCELLED` | "Email notification disabled for this category" (gray)                                                                                                               |

The success toast at submission says only what is true at commit time — the persisted
`helpdesk_ticket.ticket_no`, read back from the committed row — and never claims delivery.
The prototype's client-side `'HD-'+(4830+tickets.length)` is display scaffolding only: a
ticket number is allocated by `helpdesk_ticket_seq` on the server, is never derived from a
list length, and never appears in the UI before the row exists.

**The toast's SLA sentence is persisted too.** "first response within 1 working day" is
rendered from `ticket_category.first_response_sla_hours` divided by the org's business
hours per day (both persisted), through the `ui_copy` key `helpdesk.toast.raised`. A
category with a NULL SLA renders the toast without the clause rather than inventing one.

### 6.4 SLA clocks

```
working_hours = org_setting.business_hours_start .. business_hours_end
                (seeded 09:00–18:00) on org_setting.business_days (seeded Mon–Fri),
                in organization.timezone, excluding PUBLIC holidays on the org
                default holiday_calendar. All three are persisted configuration.

addWorkingHours(t, h)  -- advances t by h hours of business time, skipping non-business
                       -- hours, non-business days and PUBLIC holidays. Deterministic and
                       -- total: a ticket raised at 17:30 on a Friday before a public
                       -- Monday with a 1-working-hour SLA is due 09:30 Tuesday.

first_response_due_at = addWorkingHours(created_at, category.first_response_sla_hours)

-- Resolution due date, recomputed by fn_recompute_ticket_sla(ticket) at HD-5 and at
-- HD-8 only (R-3: no other writer may touch resolution_due_at):
resolution_due_at = addWorkingHours(
                      addWorkingHours(created_at, category.resolution_sla_hours),
                      sla_paused_seconds / 3600.0)
```

The pause is re-applied **as working hours, not as wall-clock seconds**. The earlier
`addWorkingHours(...) + sla_paused_seconds` added raw seconds to a business-time deadline:
a ticket paused over a weekend gained 48 hours of deadline for 0 hours of business time
lost, and an SLA stated in working hours was silently settled in calendar hours. One unit,
one clock.

`sla_paused_seconds` accumulates only the **business-time** portion of each pause, so the
division above is exact and the accumulator is monotonic. `ck_ht__due` continues to hold
because both terms are computed from `created_at` forward.

- `sla_first_response_breached` and `sla_resolution_breached` are **`STORED` generated
  columns** over `first_responded_at`/`resolved_at` — facts about persisted timestamps,
  not a job's opinion. Because a stored generated column may not reference `now()`, they
  are necessarily **false for a ticket that is overdue and still open**: they answer "was
  this breached when it finished?", not "is this late right now?".
- "Is this late right now?" is the **view** `v_helpdesk_ticket_sla` (R-16), exposing
  `is_first_response_overdue` and `is_resolution_overdue` as query-time expressions
  against `now()`. The HR queue's overdue banner, the queue ordering and the escalation
  job all read the view. Nothing renders a live "overdue" chip from the stored flags —
  doing so would show every open, late ticket as on-time, which is worse than showing
  nothing.
- The clock pauses only in `WAITING_ON_EMPLOYEE` (HD-4 → HD-5). It does **not** pause in
  `OPEN` — an unassigned ticket is the organisation's problem, not the employee's.
- Job `ticket-sla-escalation`, every 15 minutes:
  - `first_response_due_at < now()` and `first_responded_at IS NULL` ⇒ `TICKET_UPDATED`
    (red) to the assignee and, if unassigned, to every `ticket:assign` holder
    (`source_rule_code = 'TICKET_FIRST_RESPONSE_BREACH'`), and `priority` is raised one
    step (audited `TICKET.PRIORITY_ESCALATED`).
  - `resolution_due_at < now()` and not resolved ⇒ `TICKET_UPDATED` (red) to the assignee
    and the category owner (`TICKET_RESOLUTION_BREACH`).
- The prototype's "first response within 1 working day" copy is
  `ticket_category.first_response_sla_hours` rendered as working days — persisted
  configuration, never a literal.

### 6.5 Help-desk invariants

| #        | Invariant                                                                    | Enforced by                                                                                                                    |
| -------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| HD-INV-1 | A ticket exists regardless of email outcome                                  | The outbox pattern: the ticket insert and the enqueue share a transaction; delivery is asynchronous and never gates the insert |
| HD-INV-2 | Exactly one creation email per ticket                                        | `ux_email_outbox__org_idempotency` on `HELPDESK_TICKET_CREATED:helpdesk_ticket:<id>:v1`                                        |
| HD-INV-3 | The UI never claims delivery that did not happen                             | The screen renders `email_outbox.status` (mirrored to `helpdesk_ticket.email_delivery_status`), never an optimistic constant   |
| HD-INV-4 | A failed email is visible and retriable, never lost                          | `FAILED` dead-letter + notification + HR banner + retry route                                                                  |
| HD-INV-5 | `INTERNAL` comments never reach the raiser                                   | Query predicate + RLS                                                                                                          |
| HD-INV-6 | An anonymous ticket carries no raiser identity anywhere, including the email | `ck_ht__anonymity`, `ck_ht__anon_user`, `reply_to_address` omitted, `raisedByName` omitted from `template_data`                |
| HD-INV-7 | `RESOLVED`/`CLOSED` always carries a resolution summary                      | `ck_ht__resolution_summary`                                                                                                    |
| HD-INV-8 | SLA breach flags are derived, not asserted                                   | Generated columns                                                                                                              |

### 6.6 Help-desk failure paths

| Failure                                 | Compensation                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail provider down                      | Retries with exponential backoff `least(2^retry_count, 60)` minutes — 2, 4, 8, 16, 32 minutes for attempts 1–5, capped at 60 — then `FAILED` dead-letter, notification, HR banner, manual retry. (The earlier "1, 2, 4, 8, 16" did not match the formula beside it; the formula is binding.) |
| Worker dies mid-send                    | `SENDING` rows older than 10 minutes are reclaimed; the provider idempotency key (`email_outbox.id`) prevents a duplicate send                                                                                                                                                               |
| Duplicate submit (double click / retry) | `Idempotency-Key` header → `ess_ops.idempotency_key` returns the original `201` body; no second ticket, no second email                                                                                                                                                                      |
| Routing address changed                 | It is `organization.helpdesk_email` / `ticket_category.routing_email`, changed through an audited `CONFIG_CHANGE`, not a redeploy. In-flight queued rows keep the address captured at enqueue.                                                                                               |
| Attachment infected                     | Attachment rejected before the ticket transaction commits; the ticket may still be raised without it                                                                                                                                                                                         |
| Employee reopens after 14 days          | `ticket.within_reopen_window` fails; they raise a new ticket, which is linked via `related_entity_type='helpdesk_ticket'`                                                                                                                                                                    |

---

## 7. DOCUMENT / LETTER REQUEST

### 7.1 States

`ess_document_request_status`: `SUBMITTED`, `IN_REVIEW`, `PROCESSING`, `ISSUED`,
`REJECTED`, `CANCELLED`. Terminal: `ISSUED`, `REJECTED`, `CANCELLED`.

### 7.2 Transition table (`machine = 'document_request'`)

| #     | from → to                                           | Trigger                                                      | Actor                                   | Guards                                                                                               | Effects                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Audit                 | Notify                                                                                                                         |
| ----- | --------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| DOC-1 | `NULL` → `SUBMITTED`                                | `POST /document-requests` (the prototype's "Request letter") | EMPLOYEE `document:request:create:self` | `letter_template.is_active`; `addressee` present when `requires_addressee`                           | `request_no`; `due_at = addWorkingDays(requested_at, letter_template.sla_working_days)` against the employee's holiday calendar; an `approval_task` (`kind='DOCUMENT_REQUEST'`) assigned to the HR queue when `requires_hr_approval`                                                                                                                                                                                                                                                              | `DOCUMENT.REQUESTED`  | `TICKET_UPDATED`-class `DOCUMENT_ISSUED` kind is **not** used here; the raiser sees the row. HR queue gets `APPROVAL_PENDING`. |
| DOC-2 | `SUBMITTED` → `IN_REVIEW`                           | `POST /document-requests/:id/claim`                          | HR `document:request:fulfil`            | —                                                                                                    | `assigned_to_user_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `DOCUMENT.IN_REVIEW`  | —                                                                                                                              |
| DOC-3 | `IN_REVIEW` → `PROCESSING`                          | `POST /document-requests/:id/start`                          | HR `document:request:fulfil`            | —                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `DOCUMENT.PROCESSING` | —                                                                                                                              |
| DOC-4 | `PROCESSING` → `ISSUED`                             | `POST /document-requests/:id/issue`                          | HR `document:request:fulfil`            | `docreq.document_attached` (an `employee_document` exists and its `file_object.scan_status='CLEAN'`) | The PDF is rendered server-side from `letter_template.body_template` with **only** persisted placeholder values (name, employee number, designation, DOJ, and — when `includes_salary_details` — the current `salary_structure` amounts); stored as a `file_object` (`purpose='LETTER_PDF'`) and an `employee_document` (`visibility='EMPLOYEE_AND_HR'`); `employee_document_id`, `issued_at`, `issued_by_user_id`. When `includes_salary_details`, a `READ_SENSITIVE` audit row is also written. | `DOCUMENT.ISSUED`     | `DOCUMENT_ISSUED` → employee; `DOCUMENT_ISSUED` email → employee work email (notification only, **no attachment**)             |
| DOC-5 | `SUBMITTED`\|`IN_REVIEW`\|`PROCESSING` → `REJECTED` | `POST /document-requests/:id/reject`                         | HR `document:request:fulfil`            | `approval.note_required`                                                                             | `rejection_reason`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `DOCUMENT.REJECTED`   | `DOCUMENT_ISSUED` (tone RED, "…could not be issued: <reason>") → employee                                                      |
| DOC-6 | `SUBMITTED` → `CANCELLED`                           | `DELETE /document-requests/:id`                              | EMPLOYEE `document:request:create:self` | `docreq.self_only`; not yet claimed                                                                  | `cancelled_at`; `approval_task` → `WITHDRAWN`                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `DOCUMENT.CANCELLED`  | —                                                                                                                              |

Chip tones: `SUBMITTED`/`IN_REVIEW`/`PROCESSING` → `Processing`, amber; `ISSUED` →
`Issued`, green; `REJECTED` → red; `CANCELLED` → gray. The download button on a row is
rendered **iff** `employee_document_id IS NOT NULL` and the file is `CLEAN` — the
prototype's `l.issued` flag is exactly this, persisted.

Every download writes an `audit_event` with `action='DOWNLOAD'` and increments no counter
the employee can see; salary-certificate downloads additionally write `READ_SENSITIVE`.

### 7.3 Invariants and failure paths

| #         | Invariant                                                       | Enforced by                                                                                                                                |
| --------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| DOC-INV-1 | `ISSUED` implies a stored, scanned document                     | `ck_dr__issued` + `docreq.document_attached`                                                                                               |
| DOC-INV-2 | A letter's content contains only persisted values               | The renderer resolves placeholders from the database; it has no free-text injection point and template authoring is `document:type:manage` |
| DOC-INV-3 | `REJECTED` always carries a reason                              | `ck_dr__rejected`                                                                                                                          |
| DOC-INV-4 | `due_at >= requested_at` and reflects the real working calendar | `ck_dr__due` + `addWorkingDays()`                                                                                                          |

| Failure                                                              | Compensation                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PDF render fails                                                     | The request stays `PROCESSING`; the HR screen shows the render error; nothing is marked issued                                                                                                         |
| Template placeholder unresolvable (e.g. no current salary structure) | DOC-4 fails with `422` naming the missing datum; HR fixes the underlying record — the letter never prints a blank or a guess                                                                           |
| Wrong letter issued                                                  | HR issues a corrected `employee_document` and rejects/reissues via a **new** request; the original `employee_document` is marked superseded (`employee_document.superseded_by_id`) rather than deleted |
| Employee cancels after HR started                                    | DOC-6's guard fails; HR rejects with a note instead                                                                                                                                                    |

---

## 8. PROFILE CHANGE REQUEST

The prototype's "Request a change" on My profile. Nothing on the employee record is ever
edited straight from the employee-facing screen except the fields the organisation has
marked self-service.

### 8.1 Schema — **canonical is `DATA-MODEL.md §5.11`**

**Corrected.** This section previously specified a `profile_change_request` with states
`SUBMITTED`/`IN_VERIFICATION`/`PROOF_REQUIRED`/`APPROVED_APPLIED`, permissions
`profile:update:self`/`profile:update:any`, and a `(target_table, target_column)` field
model. `DATA-MODEL.md §5.11` — written later, and canonical for schema per the precedence
rule in the header — landed a different and better design. Two specifications of one table
is the worst outcome available, so this section now **restates the canonical design** and
adds only the behaviour that the schema document does not carry.

| Aspect              | Canonical (`DATA-MODEL.md §5.11`)                                                                               | What this section used to say (**withdrawn**)           |
| ------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Status enum         | `ess_profile_change_status` = `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `CANCELLED`, `APPLIED` | `IN_VERIFICATION`, `PROOF_REQUIRED`, `APPROVED_APPLIED` |
| Employee permission | `profile:change_request:create:self`                                                                            | `profile:update:self`                                   |
| Verifier permission | `profile:change_request:decide`                                                                                 | `profile:update:any` / `payroll:salary_structure:write` |
| Field identity      | `profile_change_request_field.field ess_profile_change_field` + `target_row_id`                                 | free-text `target_table`/`target_column`                |
| Concurrency         | `profile.target_row_unchanged_since_submit` against the target row's `row_version`                              | an HMAC `current_value_hash`                            |
| Apply step          | a distinct `APPROVED → APPLIED` system transition                                                               | fused into one `APPROVED_APPLIED` state                 |

Two consequences of the canonical design are load-bearing and were lost in the old text:

- **Approval and application are separate states.** `APPROVED` records the human decision;
  `APPLIED` records that the write succeeded against an unchanged target row. Fusing them
  meant a decision whose write failed had nowhere to sit, and made
  `profile.target_row_unchanged_since_submit` unenforceable — the guard has to run
  _between_ the two.
- **`field` is an enum, not a pair of free-text identifiers.** A `target_table`/
  `target_column` pair supplied by a client is a mass-assignment vector: the allowlist
  becomes a runtime string comparison instead of a type. `ess_profile_change_field`
  (`PERSONAL_EMAIL`, `PERSONAL_MOBILE`, `CURRENT_ADDRESS`, `PERMANENT_ADDRESS`,
  `MARITAL_STATUS`, `EMERGENCY_CONTACT`, `BANK_ACCOUNT`, `STATUTORY_ID`, `NAME`,
  `DATE_OF_BIRTH`) closes the set at the database, and the mapping from enum value to the
  table and column it writes lives in server code, never in the request.

`profile_field_policy` (reference data, seeded) remains as specified here and supplies
`self_service`, `requires_proof`, `sla_working_days` and `help_text` per
`ess_profile_change_field` value. `help_text` is the source of the prototype's per-tab
notes ("Bank and statutory changes need a cancelled cheque or ID proof and are verified by
Payroll within 2 working days") — persisted copy, not a literal, and the "2 working days"
in it is rendered from `sla_working_days`, not typed into the string.

### 8.2 Transition table (`machine = 'profile_change_request'`)

Canonical states and permissions. `PROOF_REQUIRED` is **not** a state: asking for a better
proof is a comment on an `IN_REVIEW` request, not a different lifecycle stage, and the
canonical enum has no value for it.

| #     | from → to                             | Trigger                                                                 | Actor                                         | Guards                                                                                                                                                                                                    | Effects                                                                                                                                                                                                                                                                                                                                                                                                      | Audit                                                                                                          | Notify                                                                                                                                                                                                  |
| ----- | ------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCR-1 | `NULL` → `DRAFT`                      | `POST /me/profile-change-requests` with `submit=false`                  | EMPLOYEE `profile:change_request:create:self` | `profile.self_only`                                                                                                                                                                                       | `request_no`; `profile_change_request_field` rows                                                                                                                                                                                                                                                                                                                                                            | `PROFILE.CHANGE_DRAFTED`                                                                                       | —                                                                                                                                                                                                       |
| PCR-2 | `NULL`\|`DRAFT` → `SUBMITTED`         | `POST /me/profile-change-requests` (the prototype's "Request a change") | EMPLOYEE `profile:change_request:create:self` | `profile.self_only`, `profile.has_fields`, `profile.proof_if_required`, `profile.no_open_request_for_field`                                                                                               | Target rows' `row_version` captured per field; `approval_task` (`kind='PROFILE_CHANGE'`, `profile_change_request_id` set) assigned to the employee's HR business partner, falling back to any holder of `profile:change_request:decide`; `due_at = addWorkingDays(now(), profile_field_policy.sla_working_days)` for the highest-sensitivity field                                                           | `PROFILE.CHANGE_REQUESTED` — metadata carries **the `field` enum values only**, never the proposed values      | `APPROVAL_PENDING` → the verifier queue                                                                                                                                                                 |
| PCR-3 | `SUBMITTED` → `IN_REVIEW`             | `POST /profile-change-requests/:id/claim`                               | HR `profile:change_request:decide`            | —                                                                                                                                                                                                         | `assigned_to_user_id`                                                                                                                                                                                                                                                                                                                                                                                        | `PROFILE.CHANGE_IN_REVIEW`                                                                                     | —                                                                                                                                                                                                       |
| PCR-4 | `IN_REVIEW` → `SUBMITTED`             | `POST /…/request-better-proof`                                          | HR `profile:change_request:decide`            | `approval.note_required`                                                                                                                                                                                  | A `PUBLIC` note is recorded on the request; `proof_file_object_id` cleared; `assigned_to_user_id` cleared. **The request returns to the queue rather than entering a state of its own**                                                                                                                                                                                                                      | `PROFILE.CHANGE_PROOF_REQUESTED`                                                                               | `TICKET_UPDATED` (tone AMBER, context `People Ops`) → employee, with the note                                                                                                                           |
| PCR-5 | `IN_REVIEW` → `APPROVED`              | `POST /…/approve`                                                       | HR `profile:change_request:decide`            | `profile.proof_if_required`, `profile.verifier_not_requester` (`ck_at__not_self` on the task is the backstop) — **step-up MFA required for `BANK_ACCOUNT` and `STATUTORY_ID`** (§0.9, `SECURITY.md §2.7`) | `verified_at`, `verified_by_user_id`; `approval_task` → `APPROVED` + one `approval_decision`. **No target row is written yet**                                                                                                                                                                                                                                                                               | `PROFILE.CHANGE_APPROVED`                                                                                      | —                                                                                                                                                                                                       |
| PCR-6 | `APPROVED` → `APPLIED`                | _system_, same transaction as PCR-5                                     | _system_                                      | `profile.target_row_unchanged_since_submit`                                                                                                                                                               | The write is applied: in-place for mutable columns; a **new effective-dated row** for `employee_bank_account`, `employee_statutory_id`, `employee_statutory_election` and `employee_employment`, with the prior row's `effective_to = new.effective_from - 1`. `applied = true` per field; `applied_at`. For `BANK_ACCOUNT`/`STATUTORY_ID` the new row is written with **`is_verified = false`** (see below) | `PROFILE.CHANGE_APPLIED` with `before_data`/`after_data` per §8.3; `profile_change_request.audit_event_id` set | `TICKET_UPDATED` (context `People Ops`, "Your bank details were updated on 29 Sep 2026") → employee; plus a `SECURITY_ALERT` **email** to the employee's work address for `BANK_ACCOUNT`/`STATUTORY_ID` |
| PCR-7 | `APPROVED` → `IN_REVIEW`              | _system_, on guard failure at PCR-6                                     | _system_                                      | `profile.target_row_unchanged_since_submit` failed                                                                                                                                                        | Nothing is written to any target table; the request returns to the verifier with `409 STALE` recorded as a note naming the field whose row moved                                                                                                                                                                                                                                                             | `PROFILE.CHANGE_APPLY_REFUSED`                                                                                 | `APPROVAL_PENDING` → verifier                                                                                                                                                                           |
| PCR-8 | `SUBMITTED`\|`IN_REVIEW` → `REJECTED` | `POST /…/reject`                                                        | HR `profile:change_request:decide`            | `approval.note_required`                                                                                                                                                                                  | `rejection_reason`; `approval_task` → `REJECTED` + `approval_decision`                                                                                                                                                                                                                                                                                                                                       | `PROFILE.CHANGE_REJECTED`                                                                                      | `TICKET_UPDATED` (tone RED) → employee, with the reason                                                                                                                                                 |
| PCR-9 | `DRAFT`\|`SUBMITTED` → `CANCELLED`    | `DELETE /me/profile-change-requests/:id`                                | EMPLOYEE `profile:change_request:create:self` | `profile.self_only`; `decided_at IS NULL`                                                                                                                                                                 | `approval_task` → `WITHDRAWN`                                                                                                                                                                                                                                                                                                                                                                                | `PROFILE.CHANGE_CANCELLED`                                                                                     | —                                                                                                                                                                                                       |

Terminal: `APPLIED`, `REJECTED`, `CANCELLED`.

**A new bank account is unverified for payroll until Payroll verifies it.** PCR-6 writes
`employee_bank_account.is_verified = false` (and the same for a new `employee_statutory_id`),
which makes that employee fail `PAY_BANK_UNVERIFIED` on the next cycle until someone
holding `payroll:salary_structure:write` verifies the account against the proof. This is
the prototype's caption "verified by Payroll within 2 working days" expressed as a state
the system enforces. It is also why the verifier permission for the **change request** and
the verifier permission for the **bank account** are deliberately different codes: People
Ops approves the employee's request to change their account; Payroll independently
confirms the account is real before money goes to it.

**Self-service fields bypass this machine, and the set is closed.**
`PATCH /me/profile` accepts only fields whose `profile_field_policy.self_service = true`,
through an explicit allowlist keyed by `ess_profile_change_field` (`SECURITY.md §5.10`).
Every other field is a `422` naming the change-request route. There is no request body
shape, and no `?force=`, that reaches a non-self-service column through this route.

### 8.3 The before/after audit event

At PCR-5 exactly one `audit_event` is written with `action = 'UPDATE'`,
`entity_type = 'employee'`, `entity_id = employee.id`,
`changed_fields = ARRAY['employee_bank_account.account_number', …]`, and:

| Field class                                                 | `before_data` / `after_data`                                                                                                                                                                                                           |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-sensitive (marital status, blood group, preferred name) | The literal old and new values                                                                                                                                                                                                         |
| Sensitive but maskable (bank account, PAN, Aadhaar, phone)  | `{"beforeHash": "<HMAC-SHA256(LOG_HASH_KEY, old)>", "afterHash": "<…new>", "beforeMask": "•••• 4412", "afterMask": "•••• 9087"}` — answers "was it changed?" and "was it changed back?" without storing the value (`SECURITY.md §8.5`) |
| Encrypted columns                                           | `"<redacted:aes>"`                                                                                                                                                                                                                     |

The `profile_change_request.audit_event_id` points at this row, so the request and the
evidence are mutually reachable. The employee's Profile screen renders the change history
from `audit_event` filtered to their own `entity_id` — not from a separate, forgeable log.

### 8.4 Invariants and failure paths

| #         | Invariant                                                                        | Enforced by                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCR-INV-1 | No sensitive profile field changes without a verified request                    | `profile_field_policy.self_service = false` + the enum-keyed mass-assignment allowlist (`SECURITY.md §5.10`) — `PATCH /me/profile` accepts only self-service fields |
| PCR-INV-2 | The requester never verifies their own request                                   | `profile.verifier_not_requester` + `ck_at__not_self` on the `approval_task`; `profile:change_request:decide` has no `:self`-scoped variant                          |
| PCR-INV-3 | A stale request cannot overwrite a newer value                                   | `profile.target_row_unchanged_since_submit` at PCR-6, evaluated **after** the approval and **before** any write; failure routes to PCR-7 and writes nothing         |
| PCR-INV-4 | Bank/statutory changes are effective-dated, never in-place                       | New row + `effective_to` closure; `ux_employee_bank_account__one_primary`                                                                                           |
| PCR-INV-5 | A newly applied bank account is unverified for payroll until Payroll verifies it | PCR-6 writes `is_verified = false`; `PAY_BANK_UNVERIFIED` then raises against that employee until a `payroll:salary_structure:write` holder verifies it             |
| PCR-INV-6 | An approval never half-applies                                                   | PCR-5 and PCR-6 are one transaction; every field's target write and every `applied` flag commit together or not at all                                              |

| Failure                       | Compensation                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proof missing or unreadable   | PCR-4 returns the request to `SUBMITTED` with a note; the request stays open and the employee attaches a new proof through PCR-2's route against the same `request_no`                                                |
| Value changed underneath      | PCR-7: nothing is written, the request returns to `IN_REVIEW`, and the verifier sees which field's row moved and the current value                                                                                    |
| Wrong value applied           | A **new** change request restores it; the audit chain shows both events. Nothing is edited out.                                                                                                                       |
| Bank change lands mid-payroll | Effective dating: a change effective after `period_end` does not affect the running cycle, because the payslip resolves the account effective on `period_end` and snapshots `bank_account_last4`/`bank_name_snapshot` |

---

## 9. ONBOARDING / OFFBOARDING

Two coupled machines: `employee.employment_status` (the HR fact) and `app_user.status`
(the access fact). They are deliberately separate — an employee may exist before access,
and access must die before the employee record does.

### 9.1 States

- `ess_employment_status`: `PRE_JOINING`, `ACTIVE`, `ON_LEAVE`, `NOTICE_PERIOD`,
  `SUSPENDED`, `EXITED`
- `ess_user_status`: `INVITED`, `PENDING_MFA`, `ACTIVE`, `LOCKED`, `SUSPENDED`,
  `DISABLED`, `OFFBOARDED` (the four-value list this document previously printed is
  **withdrawn**; `DATA-MODEL.md §2` is canonical and the three extra values are load-bearing
  — `PENDING_MFA` parks a user granted a privileged role before they enrol,
  and `SUSPENDED`/`OFFBOARDED` carry different session-revocation and retention
  consequences from an administrative `DISABLED`)

### 9.2 `employee` lifecycle (`machine = 'employee'`)

| #     | from → to                                           | Trigger                                                                             | Actor                               | Guards                                                                                                                                                         | Effects                                                                                                                                                                                                                                                                                                  | Audit                     | Notify                                                                                                                                              |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| EMP-1 | `NULL` → `PRE_JOINING`                              | `POST /employees`                                                                   | HR `employee:create`                | `work_email` unique in org; `date_of_joining` present                                                                                                          | `employee_number` from the sequence (never reused); first `employee_employment` row effective from `date_of_joining`; `employee_personal_detail`; `app_user` created with `status='INVITED'` and `password_hash = NULL`; `user_role` grant of `EMPLOYEE` **valid from `date_of_joining`**                | `EMPLOYEE.CREATED`        | —                                                                                                                                                   |
| EMP-2 | `PRE_JOINING` → `ACTIVE`                            | Job `employee-activation` on `date_of_joining`, or `POST /employees/:id/activate`   | _system_ / HR `employee:update:any` | `CURRENT_DATE >= date_of_joining`; a salary structure exists (WARNING if not — it blocks payroll, not activation)                                              | `policy-assignment` for every applicable published policy (§5.2); `leave_balance` seeded via `OPENING`/`ACCRUAL` ledger rows per `leave_entitlement_rule` (pro-rated for the joining month); `benefit_enrolment` rows in `ELIGIBLE`; `tds_quarter` rows for the FY; `employee_reporting_closure` rebuilt | `EMPLOYEE.ACTIVATED`      | `POLICY_ASSIGNED` per assignment; `ANNOUNCEMENT_PUBLISHED` for pinned announcements is **not** backfilled (an announcement is an event, not a task) |
| EMP-3 | `ACTIVE` ↔ `ON_LEAVE`                               | Job `employee-leave-status`, driven by approved long leave                          | _system_                            | An `APPROVED` leave spanning `CURRENT_DATE` of a type flagged `sets_on_leave_status`                                                                           | Directory "Team today" chip becomes `On leave`, amber — derived from `leave_request_day`, never typed                                                                                                                                                                                                    | `EMPLOYEE.STATUS_CHANGED` | —                                                                                                                                                   |
| EMP-4 | `ACTIVE` → `NOTICE_PERIOD`                          | `POST /employees/:id/resign`                                                        | HR `employee:update:any`            | `date_of_exit` present and ≥ `CURRENT_DATE`                                                                                                                    | `employee.date_of_exit`; the exit checklist opens; payroll inclusion continues                                                                                                                                                                                                                           | `EMPLOYEE.NOTICE_STARTED` | `TICKET_UPDATED`-class notice to the manager and the HRBP                                                                                           |
| EMP-5 | `ACTIVE`\|`ON_LEAVE`\|`NOTICE_PERIOD` → `SUSPENDED` | `POST /employees/:id/suspend`                                                       | HR `employee:update:any`            | `approval.note_required`                                                                                                                                       | `app_user` → `SUSPENDED` (USR-7) in the same transaction; all sessions and refresh families revoked; `employee_employment.pay_suspended` set per the suspension decision (a suspension may be with or without pay, and which it is must be a recorded decision, never a default)                         | `EMPLOYEE.SUSPENDED`      | `SECURITY_ALERT` → HR + the manager                                                                                                                 |
| EMP-6 | `SUSPENDED` → `ACTIVE`                              | `POST /employees/:id/reinstate`                                                     | HR `employee:update:any`            | `approval.note_required`                                                                                                                                       | `app_user` → `ACTIVE` (USR-8); a fresh invitation is **not** sent (the password survives); `token_version` bumped; `pay_suspended` cleared                                                                                                                                                               | `EMPLOYEE.REINSTATED`     | —                                                                                                                                                   |
| EMP-7 | `NOTICE_PERIOD`\|`ACTIVE`\|`SUSPENDED` → `EXITED`   | Job `employee-offboarding` on `date_of_exit + 1`, or `POST /employees/:id/offboard` | _system_ / HR `employee:deactivate` | `date_of_exit IS NOT NULL` and `<= CURRENT_DATE`; no `PENDING_APPROVAL` leave and no live `approval_task` **assigned to** them (they must be reassigned first) | §9.4 in full                                                                                                                                                                                                                                                                                             | `EMPLOYEE.OFFBOARDED`     | `TICKET_UPDATED` → manager, HRBP, ACCOUNTS                                                                                                          |

### 9.3 `app_user` lifecycle (`machine = 'app_user'`)

**Canonical: `DATA-MODEL.md §5.1.1`.** The table below is that machine with this
document's effects and audit codes attached. Two corrections from the earlier draft are
material: the column is `app_user.token_version` (claim `ver`), **not** `token_epoch` —
`DATA-MODEL.md §22` renamed it and this document had not followed — and an offboarded
user reaches `OFFBOARDED`, not `DISABLED`, because the two differ in what happens to the
password hash and to retention.

| #      | from → to                                       | Trigger                                                      | Actor                                   | Guards                                                                                                                                              | Effects                                                                                                                                                                                                                                                                                                                            | Audit                                                                                                                  |
| ------ | ----------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| USR-1  | `NULL` → `INVITED`                              | EMP-1                                                        | HR `employee:create`                    | `user.email_unique_in_org`                                                                                                                          | `user_invitation` (A-6) with a 32-byte CSPRNG token; only `token_hash` and `token_fpr` persist; `expires_at = now() + org_setting.invitation_ttl_days` (seeded `7`); one `email_outbox` row of kind `USER_INVITE` with the token in `template_data_ct` (R-14), same transaction                                                    | `USER.INVITED`                                                                                                         |
| USR-2  | `INVITED` → `PENDING_MFA`                       | `POST /auth/accept-invitation`                               | anonymous, holding the token            | `user.invitation_live` (matches by `token_fpr`, hash verifies in constant time, not expired, not revoked, `attempt_count < 5`), `user.password_set` | `password_hash` (Argon2id + pepper), `password_updated_at`, `email_verified_at`, `terms_accepted_at`; `user_invitation.accepted_at`; the invitation is consumed and cannot be replayed                                                                                                                                             | `USER.ACTIVATED`                                                                                                       |
| USR-3  | `PENDING_MFA` → `ACTIVE`                        | MFA enrolment confirmed                                      | _system_                                | `user.mfa_confirmed_or_within_grace`                                                                                                                | Grants the `EMPLOYEE` persona when an `employee` row exists and `CURRENT_DATE >= date_of_joining`; recovery codes issued once                                                                                                                                                                                                      | `USER.MFA_ENROLLED`                                                                                                    |
| USR-4  | `ACTIVE` → `PENDING_MFA`                        | A privileged role is granted to a user with no confirmed MFA | HR/admin `role:assign`                  | `user.privileged_role_granted_without_mfa`                                                                                                          | `token_version += 1`; every session and refresh-token family revoked. The user cannot use the new privilege until they enrol — a MANAGER/HR/ACCOUNTS grant never lands on a single-factor account                                                                                                                                  | `PERMISSION_GRANT` + `SECURITY.SESSIONS_REVOKED`                                                                       |
| USR-5  | `ACTIVE` → `LOCKED`                             | Progressive lockout (`SECURITY.md §2.6`)                     | _system_                                | `user.lockout_threshold_reached`                                                                                                                    | `locked_until`                                                                                                                                                                                                                                                                                                                     | `AUTH.ACCOUNT_LOCKED`                                                                                                  |
| USR-6  | `LOCKED` → `ACTIVE`                             | Expiry of `locked_until`, or an admin clear                  | _system_ / HR `security:session:revoke` | `user.lockout_expired_or_admin_cleared`                                                                                                             | `failed_login_count = 0`                                                                                                                                                                                                                                                                                                           | `AUTH.ACCOUNT_UNLOCKED`                                                                                                |
| USR-7  | `ACTIVE`\|`LOCKED`\|`PENDING_MFA` → `SUSPENDED` | EMP-5, or `POST /users/:id/suspend`                          | HR `employee:deactivate`                | `approval.note_required`                                                                                                                            | `token_version += 1`; every session and every `refresh_token` family revoked; every live `user_invitation` revoked; `user_role` grants left **intact but inert** (the user cannot authenticate, so no permission can be exercised) — a suspension is reversible and re-granting roles by hand on every reinstatement invites error | `USER.SUSPENDED` + `SECURITY.SESSIONS_REVOKED`; `SECURITY_ALERT` email                                                 |
| USR-8  | `SUSPENDED` → `ACTIVE`                          | EMP-6                                                        | HR `employee:deactivate`                | `approval.note_required`                                                                                                                            | `token_version += 1`; the password survives and **no** new invitation is sent; MFA must be re-satisfied at the next login                                                                                                                                                                                                          | `USER.REINSTATED`                                                                                                      |
| USR-9  | any non-terminal → `DISABLED`                   | `POST /users/:id/disable`                                    | HR `employee:deactivate`                | `approval.note_required`                                                                                                                            | Administrative disable, employment unchanged (a contractor between engagements, an account under investigation): sessions revoked, `token_version += 1`, `disabled_at`/`disabled_reason` set. The password hash is **retained**                                                                                                    | `USER.DISABLED` + `SECURITY.SESSIONS_REVOKED`; `SECURITY_ALERT` email                                                  |
| USR-10 | `DISABLED` → `ACTIVE`                           | `POST /users/:id/enable`                                     | HR `employee:deactivate`                | `approval.note_required`                                                                                                                            | `disabled_at = NULL`; `token_version += 1`; roles re-granted **explicitly**, never silently restored                                                                                                                                                                                                                               | `USER.REENABLED`                                                                                                       |
| USR-11 | any → `OFFBOARDED`                              | EMP-7                                                        | HR `employee:deactivate`                | `user.employee_exited`                                                                                                                              | **Terminal.** `password_hash = NULL`, every `mfa_credential` disabled, every session and refresh family revoked, `token_version += 1`, every `user_role` grant closed with `valid_to = employee.date_of_exit`, every live `user_invitation` revoked. The row is retained for audit and is never deleted                            | `USER.OFFBOARDED` + `SECURITY.SESSIONS_REVOKED`; `SECURITY_ALERT` email to the work address before it is deprovisioned |

Terminal: `OFFBOARDED`. Every transition writes an `audit_event`
(`action='STATE_TRANSITION'`, `entity_type='app_user'`).

**`token_version`, not `token_epoch`.** Access tokens carry the `ver` claim; the API
compares it to `app_user.token_version` on every request and rejects a mismatch with
`401 TOKEN_REVOKED`. Bumping the column is therefore an **immediate**, global revocation
that does not wait for token expiry, which is what makes USR-4, USR-7, USR-9 and USR-11
security controls rather than bookkeeping.

**Invitation resend** (`POST /employees/:id/resend-invitation`, HR `employee:create`)
revokes the outstanding `user_invitation` and issues a new one in the same transaction —
an old link is dead the moment a new one is issued. Audit `USER.INVITATION_RESENT`.
The route is rate-limited per target user (§0.9) so it cannot be used to flood an inbox.

**The password policy check does not run inside the transaction.** USR-2 validates the
password against `SECURITY.md §2.2` and the HIBP k-anonymity range API **before** opening
the transaction, because it is a network call and must never hold a row lock. If HIBP is
unreachable, the check **fails closed for privileged accounts** (any user with a
MANAGER/HR/ACCOUNTS grant pending) and **fails open with an audit row**
(`AUTH.BREACH_CHECK_UNAVAILABLE`) for an ordinary employee, because blocking every new
joiner's first login on a third party's availability is its own outage. The choice is
recorded in `org_setting.breach_check_failure_mode` (`FAIL_CLOSED` | `FAIL_OPEN_AUDITED`,
seeded to the split above) so it is a decision on the record, not an implementer's guess.

### 9.4 Offboarding effects, in one transaction

| Domain                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**                                 | `app_user` → `OFFBOARDED` (USR-11): `token_version` bumped, every session and refresh-token family revoked, every live `user_role` grant closed with `valid_to = employee.date_of_exit`, `password_hash` nulled, MFA credentials disabled. The employee cannot sign in from the moment the transition commits. `valid_to = date_of_exit` (not `CURRENT_DATE`) so the grant history says truthfully when the person stopped holding the role, even if offboarding runs late.                                                                                                       |
| **Approvals held**                         | Every `approval_task` with `assignee_employee_id = them` and `status='PENDING'` is `REASSIGNED` to the next ancestor in `employee_reporting_closure` (or the HRBP), each with an `approval_decision` of outcome `REASSIGNED` and a system note. **This runs before** the `EXITED` guard passes — offboarding cannot strand a queue.                                                                                                                                                                                                                                               |
| **Approvals owed to them**                 | Their own `PENDING_APPROVAL` leave and `PENDING_MANAGER` expenses must be decided or withdrawn first (the EMP-7 guard); HR is shown the list.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Reporting**                              | `employee_manager` rows closed at `date_of_exit`; every direct report is re-pointed to the exiting employee's manager, and `employee_reporting_closure` is rebuilt.                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Payroll inclusion**                      | They remain in scope for the cycle whose `[period_start, period_end]` contains `date_of_exit` (final settlement), with `eligible_days` pro-rated to `date_of_exit`. From the next cycle onward, scope resolution excludes them. A `PAY_EXITED_EMPLOYEE_NO_FNF` WARNING appears if no settlement inputs were uploaded.                                                                                                                                                                                                                                                             |
| **Leave**                                  | The leave period is closed for them: `ENCASHMENT` ledger rows for encashable balance (posted as a payroll input of kind `VARIABLE_PAY` into the settlement cycle), `LAPSE` rows for the rest. Nothing is silently dropped.                                                                                                                                                                                                                                                                                                                                                        |
| **Policies**                               | Open `policy_assignment` rows get `superseded_at = now()` with `source_rule_code='OFFBOARDED'`. Existing acknowledgements are kept forever (they are compliance evidence).                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Expenses / tickets / document requests** | Open items are reassigned to the HRBP for closure; nothing is auto-rejected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Directory**                              | `is_directory_listed = false`; the person disappears from Directory and from "Team today" but remains resolvable by `employee:read:any` for payroll and audit.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Payslips and tax**                       | Remain readable **only** to `payslip:read:any` / `tax:*:any`. The exited employee has no portal access; Form 16 is delivered out of band by HR.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Data retention**                         | Nothing is deleted at offboarding. `file_retention-purge` applies the schedule of `DATA-MODEL.md §18.4` / `SECURITY.md §8.7`: payroll, tax, payslip, bank, statutory and policy-acknowledgement records are retained 8 years from the end of the financial year; leave/expense/ticket lifecycle 5 years; `login_attempt` 90 days. Encrypted personal details are re-wrapped, not dropped, until their retention expires, at which point `crypto-shredding` destroys the row's DEK and the ciphertext becomes unrecoverable — a deletion that is itself audited (`CRYPTO_REWRAP`). |

### 9.5 Invariants and failure paths

| #         | Invariant                                                                             | Enforced by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ONB-INV-1 | An `INVITED` user has no password and cannot authenticate                             | `ck_app_user__password_present`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ONB-INV-2 | An invitation token is never stored in plaintext, logged, or readable at rest         | `user_invitation` stores only `token_hash` (SHA-256 of the 32-byte token) and `token_fpr` (HMAC-SHA-256 under the blind-index key, truncated to 16 bytes — a **keyed** value, so a stolen database cannot be scanned for a guessed token). The token reaches the recipient through `email_outbox.template_data_ct`, envelope-encrypted (R-14) and destroyed on `SENT`. The earlier claim was false as written: it asserted plaintext was never stored while describing a plaintext email body that was stored until dispatch |
| ONB-INV-3 | One live invitation per user                                                          | `UNIQUE (app_user_id) WHERE accepted_at IS NULL AND revoked_at IS NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ONB-INV-4 | An exited employee holds no live role grant, no live session and no usable credential | USR-11 effects, asserted nightly by `session-sweep` and by an `EXITED`-employee spot check in `audit-chain-verify`                                                                                                                                                                                                                                                                                                                                                                                                           |
| ONB-INV-5 | Offboarding never strands a pending approval                                          | The reassignment step + the EMP-7 guard                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ONB-INV-6 | `EXITED` requires `date_of_exit`                                                      | `ck_employee__exited_has_date`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ONB-INV-7 | An employee number is never reused                                                    | Sequence-backed, `ux_employee__org_number`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

| Failure                        | Compensation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation expires unaccepted  | HR resends; the old token is revoked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Invitation link brute-forced   | The token is 32 CSPRNG bytes (256 bits), so guessing is infeasible; `attempt_count` and the `invite:<fpr>` rate-limit bucket bound the attempt rate regardless, and after 5 failed attempts the invitation is revoked and a `SECURITY_ALERT` goes to every `security:session:revoke` holder. A lookup miss and a hash mismatch return the same response in the same time, so the endpoint is not a token oracle                                                                                                                                                                                                                                                                                                                                                                           |
| Employee offboarded by mistake | `EXITED → ACTIVE` is **not** a legal transition, and `OFFBOARDED` is terminal for `app_user`. HR creates the correction as an explicit re-hire: a new `employee_employment` row, `employment_status` restored through an `employee:update:any` route that requires a note and writes `EMPLOYEE.REHIRED`, and a **new** `app_user`-level activation — since the offboarded account's `password_hash` is gone, the person receives a fresh `user_invitation` (USR-1 → USR-2 → USR-3) against their existing `app_user` row, which is moved from `OFFBOARDED` to `INVITED` by the same `employee:deactivate`-holding route, audited as `USER.REHIRE_REACTIVATED`. Roles are re-granted individually. Nothing is restored implicitly, and the audit trail shows both the exit and the return. |
| Exit date moves                | `date_of_exit` updated while still `NOTICE_PERIOD`; once `EXITED`, a change requires the re-hire path                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Reports orphaned               | `employee_reporting_closure` rebuild is part of the transaction; `reporting-closure-verify` re-checks nightly and alerts on any employee with no resolvable approver                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

---

## 10. NOTIFICATION GENERATION RULES

Every `notification` row is traceable to a persisted cause:
`ck_notification__source CHECK (num_nonnulls(source_audit_event_id, source_rule_code) >= 1)`.
There is **no** API endpoint that creates an arbitrary notification. A notification is
created only by (a) a `state_transition` row whose `emits_notification_kind` is set, or
(b) a named scheduled job, whose rule is recorded in `source_rule_code`.

`ux_notification__dedupe (recipient_app_user_id, kind, entity_type, entity_id, coalesce(source_rule_code,''))`
means a retried transition or a re-run job produces **one** row — so the bell's unread
count is exact, not approximate.

### 10.1 Transition-driven notifications (exhaustive)

| Kind                          | Tone                                                            | Emitted by                                                                                                                                                                                                             | Recipients (resolved from persisted relationships)                                                           | `context_label`                               | `deep_link_screen`                 |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------- |
| `PAYSLIP_PUBLISHED`           | GREEN                                                           | PAY-17; PC-5 (AMBER, revision)                                                                                                                                                                                         | Each employee with a payslip in the run — from `payslip_publication.employee_id`                             | `Payroll`                                     | `payslips`                         |
| `PAYROLL_CYCLE_STATE`         | BLUE / AMBER / RED                                              | PAY-2, PAY-3, PAY-5, PAY-6, PAY-8, PAY-9, PAY-10, PAY-13, PAY-14, PAY-15, PAY-16, PAY-19, ATT-5, ATT-7, ATT-8                                                                                                          | Users holding `payroll:cycle:read` (ACCOUNTS) and/or `attendance:submit` (HR), per the row's `Notify` column | `Payroll`                                     | _(HR/Accounts back-office screen)_ |
| `ATTENDANCE_APPROVAL_PENDING` | AMBER                                                           | ATT-3, AAP-4                                                                                                                                                                                                           | The manager of each `attendance_approval` slice; on escalation also their manager                            | `Attendance`                                  | `approvals`                        |
| `LEAVE_SUBMITTED`             | BLUE                                                            | LV-2, LV-3                                                                                                                                                                                                             | `leave_request.approver_employee_id` → their `app_user`                                                      | `Approvals`                                   | `approvals`                        |
| `LEAVE_DECIDED`               | GREEN (approved) / RED (rejected) / GRAY (withdrawn, cancelled) | LV-4, LV-5, LV-6, LV-7, LV-8                                                                                                                                                                                           | The employee; for withdrawals, the manager                                                                   | `Leave`                                       | `leave`                            |
| `EXPENSE_SUBMITTED`           | AMBER                                                           | EXP-3                                                                                                                                                                                                                  | The assigned manager                                                                                         | `Approvals`                                   | `approvals`                        |
| `EXPENSE_DECIDED`             | GREEN / RED                                                     | EXP-4, EXP-5, EXP-8, EXP-9, and the §4.5 batch roll-forward                                                                                                                                                            | The claiming employee                                                                                        | `Expenses`                                    | `expenses`                         |
| `EXPENSE_REIMBURSED`          | BLUE                                                            | EXP-11                                                                                                                                                                                                                 | The claiming employee                                                                                        | `Expenses`                                    | `expenses`                         |
| `POLICY_ASSIGNED`             | AMBER (assigned) / GRAY (waived, withdrawn)                     | POL-4, POL-6, PACK-2, EMP-2, audience recalculation                                                                                                                                                                    | Each newly assigned employee                                                                                 | `<policy.owner_label>` (e.g. `IT & Security`) | `policies`                         |
| `POLICY_OVERDUE`              | RED                                                             | Job `policy-due-reminder`                                                                                                                                                                                              | Employee; at +7 the manager and HRBP; at +21 the compliance queue                                            | `<policy.owner_label>`                        | `policies`                         |
| `ANNOUNCEMENT_PUBLISHED`      | BLUE                                                            | `announcement` `SCHEDULED`\|`DRAFT` → `PUBLISHED`                                                                                                                                                                      | Every employee matched by `announcement_audience`                                                            | `<announcement.department_label>`             | `announcements`                    |
| `TICKET_UPDATED`              | AMBER / BLUE                                                    | HD-1 (to raiser), HD-2, HD-3, HD-4, HD-5, HD-8, HD-9; PCR-4, PCR-6, PCR-8; EMP-4, EMP-7                                                                                                                                | Raiser and/or assignee as listed per transition                                                              | `Help desk` / `People Ops`                    | `help`                             |
| `TICKET_RESOLVED`             | GREEN                                                           | HD-6                                                                                                                                                                                                                   | The raiser (never for an anonymous ticket — there is no recipient)                                           | `Help desk`                                   | `help`                             |
| `DOCUMENT_ISSUED`             | GREEN (issued) / RED (rejected)                                 | DOC-4, DOC-5                                                                                                                                                                                                           | The requesting employee                                                                                      | `Documents`                                   | `documents`                        |
| `APPROVAL_PENDING`            | BLUE                                                            | `approval_task` `NULL → PENDING` for kinds `DOCUMENT_REQUEST` and `PROFILE_CHANGE`, and `approval_task` `PENDING → REASSIGNED`/`EXPIRED` (to the new assignee)                                                         | `approval_task.assignee_app_user_id`                                                                         | `Approvals`                                   | `approvals`                        |
| `FORM16_ISSUED`               | GREEN                                                           | `form16_document` `PENDING → ISSUED`                                                                                                                                                                                   | The employee                                                                                                 | `Tax`                                         | `tax`                              |
| `SECURITY_ALERT`              | RED                                                             | New-device login, password change, MFA change, session revocation, `INFECTED` upload, EMP-5/USR-7, USR-9, USR-11, PCR-6 on `BANK_ACCOUNT`/`STATUTORY_ID`, a failed step-up, a `role:assign` grant of a privileged role | The affected user; security-relevant org events additionally to `security:session:revoke` holders            | `Security`                                    | _(profile / security screen)_      |

### 10.2 Job-driven notifications (exhaustive)

| Job                            | `source_rule_code`                                                                | Kind                                    | Recipient                                   | Condition                                             |
| ------------------------------ | --------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------- | ----------------------------------------------------- |
| `policy-due-reminder`          | `POLICY_DUE_IN_7_DAYS`, `POLICY_DUE_IN_3_DAYS`, `POLICY_DUE_TOMORROW`             | `POLICY_ASSIGNED`                       | employee                                    | §5.5                                                  |
| `policy-due-reminder`          | `POLICY_OVERDUE`, `POLICY_OVERDUE_ESCALATION`, `POLICY_OVERDUE_COMPLIANCE`        | `POLICY_OVERDUE`                        | employee / manager+HRBP / compliance        | §5.5                                                  |
| `policy-assignment`            | `POLICY_NEW_JOINER`                                                               | `POLICY_ASSIGNED`                       | new joiner                                  | §5.2                                                  |
| `attendance-approval-reminder` | `ATT_APPROVAL_DUE_24H`, `ATT_APPROVAL_OVERDUE`, `ATT_APPROVAL_OVERDUE_ESCALATION` | `ATTENDANCE_APPROVAL_PENDING`           | manager / their manager                     | §1.6                                                  |
| `ticket-sla-escalation`        | `TICKET_FIRST_RESPONSE_BREACH`, `TICKET_RESOLUTION_BREACH`                        | `TICKET_UPDATED`                        | assignee / `ticket:assign` holders          | §6.4                                                  |
| `email-dispatch`               | `HELPDESK_EMAIL_FAILED`                                                           | `SECURITY_ALERT`                        | `ticket:read:any` holders                   | Outbox row reached `FAILED`                           |
| `announcement-publish`         | `ANNOUNCEMENT_SCHEDULED_RELEASE`                                                  | `ANNOUNCEMENT_PUBLISHED`                | matched audience                            | `publish_at <= now()`                                 |
| `tds-quarter-refresh`          | `TDS_QUARTER_FILED`                                                               | `TICKET_UPDATED`(BLUE, context `Tax`)   | employee                                    | `tds_quarter` moved to `FILED`                        |
| `leave-lapse`                  | `LEAVE_LAPSE_WARNING_30D`                                                         | `LEAVE_DECIDED`(AMBER, context `Leave`) | employee                                    | Lapsing balance > 0, 30 days before the period closes |
| `session-sweep`                | `SESSION_REVOKED_INACTIVITY`                                                      | `SECURITY_ALERT`                        | the user                                    | Session family revoked for inactivity                 |
| `audit-chain-verify`           | `AUDIT_CHAIN_BROKEN`                                                              | `SECURITY_ALERT`                        | `audit:read` holders                        | Verification failed (also a P1 page)                  |
| `payroll-integrity-verify`     | `PAYSLIP_HASH_MISMATCH`                                                           | `SECURITY_ALERT`                        | `payroll:cycle:read` + `audit:read` holders | `input_sha256` no longer verifies                     |

### 10.3 Rules that hold for every notification

1. **No notification without a cause row.** `source_audit_event_id` or
   `source_rule_code` — the `CHECK` makes it structural.
2. **Recipients are resolved from persisted relationships** at emission time
   (`approver_employee_id`, `assignee_app_user_id`, `employee_reporting_closure`,
   `announcement_audience`, `role` membership) — never from a hardcoded list and never
   from a client-supplied id.
3. **Emission shares the transaction** with the change it announces. A rolled-back
   approval produces no notification; a committed approval always produces one.
4. **The title is composed server-side** from persisted fields, so it can never contain a
   value the reader is not entitled to see. Amounts appear only in notifications to the
   person entitled to that amount (the claimant, or their approving manager).
5. **Anonymous tickets produce no raiser-directed notification** — there is no recipient
   to resolve, and inventing one would deanonymise.
6. **Withdrawal dismisses, never deletes.** When an underlying request is withdrawn, the
   approver's notification gets `dismissed_at = now()`; the row survives for audit.
7. **The bell count** is `count(*) WHERE read_at IS NULL AND dismissed_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
   for the current user. With zero, the dot is not rendered — never a `0` badge.
8. **The popover renders `occurred_at` + `context_label`** (`31 Aug · Payroll`) from the
   row; the tone dot is `ess_notification_tone` mapped to Design System §1. Nothing in the
   popover is client-derived.

---

## 11. CROSS-CUTTING

### 11.1 Transactional boundaries

**The rule:** a state change, its audit event, its notifications and its outbox rows are
one atomic unit. `apps/api/src/audit/audit.ts` exposes only `withAudit(tx, ctx, fn)`; a
lint rule forbids importing `prisma.$transaction` directly from `routes/` or `services/`,
so it is not possible to mutate state without an audit row in the same transaction.

| Unit of work                                        | Must share one transaction                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Any** transition                                  | the status write · the `audit_event` · every `notification` declared by `emits_notification_kind` · every `email_outbox` row declared by `emits_email_kind`                                                                                                                                                                                                                                                             |
| Help-desk ticket creation (HD-1)                    | `helpdesk_ticket` · first `ticket_comment` · `email_outbox` (`HELPDESK_TICKET_CREATED`) · `helpdesk_ticket.email_outbox_id` · `notification` to the raiser · 2 audit rows (`TICKET.CREATED`, `TICKET.EMAIL_QUEUED`)                                                                                                                                                                                                     |
| Leave submit (LV-2/3)                               | `leave_request` · `leave_request_day` rows · `leave_balance.pending_days` · `approval_task` · `notification` · audit                                                                                                                                                                                                                                                                                                    |
| Leave approve (LV-4)                                | `leave_request` · `leave_balance_ledger` (`CONSUMPTION`) · `fn_refresh_leave_balance` · `approval_task` · `approval_decision` · `notification` · `email_outbox` · audit                                                                                                                                                                                                                                                 |
| Attendance submit (ATT-2 + ATT-3 + PAY-4)           | `attendance_period` · every `attendance_record` · `attendance_submission` · every `attendance_approval` · every `approval_task` · `payroll_cycle` · notifications · audit                                                                                                                                                                                                                                               |
| Slice decision (AAP-2) + completion (ATT-4 + PAY-5) | `attendance_approval` · its `attendance_record` rows · `approval_task` · `approval_decision` · the completion check and, if it holds, both period and cycle transitions · notifications · audit                                                                                                                                                                                                                         |
| Payroll run (§1.7)                                  | `payroll_run` · every `payslip` · every `payslip_line` · every `employee_tax_projection` · `payroll_cycle_employee.payslip_id` · `payroll_cycle` (PAY-13) · audit. **All or nothing.**                                                                                                                                                                                                                                  |
| Payroll publish (PAY-17)                            | every `payslip.status` · every `payslip_publication` · every `payslip_fy_rollup` fold · `tds_quarter` recompute · `reimbursement_batch` → `PAID` · every linked `expense_claim` → `REIMBURSED` · `employee_tax_regime_election.is_locked` · one `notification` + one `email_outbox` per employee · `payroll_cycle` · audit                                                                                              |
| Policy publish (POL-4 + POL-5)                      | `policy_version` · prior version's `SUPERSEDED` + `effective_to` · `policy_assignment` inserts (or the job intent row) · prior assignments' `superseded_at` · notifications · audit                                                                                                                                                                                                                                     |
| Policy acknowledge (PACK-1)                         | `policy_acknowledgement` · `audit_event` (referenced back by `audit_event_id`)                                                                                                                                                                                                                                                                                                                                          |
| Profile change approve + apply (PCR-5 + PCR-6)      | `profile_change_request` (both status writes) · every `profile_change_request_field.applied` · the target-table writes (in-place or new effective-dated rows) · `approval_task` + `approval_decision` · `audit_event` with before/after · notification · `email_outbox` for `BANK_ACCOUNT`/`STATUTORY_ID`. A `profile.target_row_unchanged_since_submit` failure aborts the whole unit (PCR-7) and writes no target row |
| Offboarding (EMP-7 + USR-11)                        | `employee` · `app_user` · every `user_role` closure · every `refresh_token` revocation · every `approval_task` reassignment + `approval_decision` · `employee_manager` closures · closure-table rebuild · `policy_assignment` supersessions · leave encashment/lapse ledger rows · audit                                                                                                                                |

**Deliberately outside the transaction** (and therefore retryable and idempotent):
SMTP/API mail delivery (`email-dispatch`), PDF rendering, virus scanning, search index
updates, metrics. Each has its own durable state (`email_outbox.status`,
`file_object.scan_status`, `payslip.pdf_file_object_id`) so the UI renders the real state
rather than assuming success.

**Failure-path audits** (`AUTHZ.DENIED`, `AUTH.LOGIN_FAILED`, `RATE_LIMITED`) have no
business transaction to join and are written in their own short transaction on the
`onResponse`/error path, with a bounded in-memory retry — an audit outage must not turn a
failed login into an availability incident.

### 11.2 Concurrency control

| Mechanism                             | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Optimistic `row_version`**          | `leave_request`, `expense_claim`, `attendance_period`, `attendance_record`, `attendance_approval`, `payroll_cycle`, `payroll_input_batch`, `document_request`, `helpdesk_ticket`, `profile_change_request`, `approval_task`, `reimbursement_batch`, `payroll_correction`. The client sends the version it read; a mismatch is `409 STALE_ROW_VERSION` carrying the current value, and the UI re-reads rather than overwriting.                                                                                                                                                                                                                                                                                                                 |
| **Pessimistic `SELECT … FOR UPDATE`** | Every transition, on the entity row (step 2 of §0.2). Additionally: `leave_balance` (before the `leave.sufficient_balance` guard, closing the double-spend race), `payroll_cycle` (before **every** payroll and attendance transition, which is what serialises the whole mandated sequence), `reimbursement_batch` (before item add/lock), `attendance_period` (before slice creation and before the completion check).                                                                                                                                                                                                                                                                                                                       |
| **Advisory transaction lock**         | `pg_advisory_xact_lock(hashtext('audit:' \|\| organization_id))` in the audit hash-chain trigger, so the chain cannot fork. `pg_advisory_xact_lock(hashtext('payroll:' \|\| cycle_id))` held by the calculation worker for the whole run, so two workers cannot generate the same cycle. It is **transaction-scoped**: a session-scoped `pg_advisory_lock` survives a rollback and, behind a transaction pooler, can be inherited by an unrelated request — a crashed run would hold the cycle until its connection died. `pg_advisory_xact_lock(hashtext('attcomplete:' \|\| period_id))` around the R-2 completion check, so two managers clicking Approve simultaneously cannot both fire ATT-4/PAY-5.                                      |
| **Constraint-level serialisation**    | `ex_leave_request__no_self_overlap` (GiST), `ux_payslip__one_live_per_cycle_employee`, `ux_payroll_run__one_live`, `ux_pa__version_employee`, `ux_pack__employee_version`, `ux_llg__one_consumption_per_request`, `ux_rbi__claim`, `ux_email_outbox__org_idempotency`, `ux_notification__dedupe`, `ux_attsub__period_live`, `ux_pib__cycle_file_sha`. Every one of these turns a lost race into a clean, translatable error instead of duplicate data.                                                                                                                                                                                                                                                                                         |
| **Queue claiming**                    | `FOR UPDATE SKIP LOCKED` on `email_outbox` (dispatcher) and `ess_ops.background_job` (lease with `lease_owner` + `lease_expires_at`, reclaimed after expiry).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Isolation level**                   | `READ COMMITTED` for every request-path transaction, which is sufficient because every cross-row decision is protected by an explicit lock or a constraint. **Two exceptions, both in the worker:** the payroll run (§1.7) and the correction run (PC-3) open at `REPEATABLE READ`, so the manifest they hashed is the manifest they read; because they hold `pg_advisory_xact_lock` on the cycle first, they cannot contend with each other and a serialisation failure is therefore not an expected outcome — if one occurs the run fails cleanly (PAY-14) and is re-run, never partially applied. No transition ever runs at `SERIALIZABLE`; the guarantees here come from locks and constraints, which are testable, not from retry loops. |
| **Error translation**                 | Unique-violation → `409` with a domain code; exclusion-violation → `422 GUARD_FAILED` with the conflicting reference; check-violation → `422 INVARIANT_VIOLATED` with the constraint name mapped to a message. A constraint never surfaces as a `500`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### 11.3 Idempotency of retried transitions

Three layers, in order of preference:

**1. Natural idempotency (preferred).** A transition whose `from_state` no longer matches
returns `409 INVALID_TRANSITION` with the current state — a retry of an already-applied
transition is therefore safe and self-describing, not a duplicate write. The unique
constraints in §11.2 make the _effects_ idempotent too: a retried leave approval cannot
insert a second `CONSUMPTION` row, a retried publish cannot insert a second
`payslip_publication`, a retried ticket creation cannot enqueue a second email.

**2. `Idempotency-Key` header** on every unsafe route (`POST`, `PATCH`, `DELETE`), backed
by `ess_ops.idempotency_key`:

```
key      = client-supplied UUIDv4 (the SPA generates one per user action, kept across retries)
scope    = (organization_id, app_user_id, key, route)          -- UNIQUE
flow     = INSERT … ON CONFLICT DO NOTHING
           conflict + completed_at IS NOT NULL
             → same request_hash  ⇒ replay the stored (response_status, response_body)
             → different hash     ⇒ 422 IDEMPOTENCY_KEY_REUSED
           conflict + completed_at IS NULL (locked_at recent)
             → 409 REQUEST_IN_FLIGHT, Retry-After: 1
expiry   = 24 hours
```

`request_hash` is SHA-256 over the canonical body plus the route, so the same key with a
different payload is refused rather than silently replaying.

**3. Deterministic derived keys** for machine-to-machine effects, so a retry converges on
the same row:

| Effect                    | Key                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------- |
| Help-desk email           | `HELPDESK_TICKET_CREATED:helpdesk_ticket:<ticketId>:v1`                               |
| Payslip publication email | `PAYSLIP_PUBLISHED:payslip:<payslipId>:v1`                                            |
| Notification              | `ux_notification__dedupe (recipient, kind, entity_type, entity_id, source_rule_code)` |
| Leave consumption         | `ux_llg__one_consumption_per_request (leave_request_id, kind)`                        |
| Reimbursement payout item | `ux_pii__one_payout_per_claim (expense_claim_id) WHERE kind='REIMBURSEMENT_PAYOUT'`   |
| Policy assignment         | `ux_pa__version_employee (policy_version_id, employee_id)`                            |
| Payroll input batch       | `ux_pib__cycle_file_sha (payroll_cycle_id, file_sha256)`                              |
| Scheduled job run         | `ess_ops.background_job (job_name, scheduled_for)` + lease                            |

**Job idempotency.** Every named job in `DATA-MODEL.md §17.5` is written to be
re-runnable: it claims a lease, does its work under the natural keys above, and records
`finished_at`. A job that dies mid-run leaves its lease to expire and is re-claimed; the
constraints make the partially-applied work converge rather than duplicate. Accrual,
carry-forward and lapse jobs additionally key their ledger rows by
`(employee, type, period, kind, effective_on)` so a second run in the same window writes
nothing.

**What is never idempotent, by design:** a second, genuinely distinct user action. Two
leave requests for different dates are two requests. The system distinguishes "retry" from
"do it again" purely by the `Idempotency-Key`, which the SPA scopes to a single user
gesture.

### 11.4 Guard-key extensions introduced by this document

Added to the catalogue of `DATA-MODEL.md §19.3`:

| Guard key                                                                                                                                                                                                                                                    | Predicate                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payroll.no_published_payslips`                                                                                                                                                                                                                              | No `payslip` for the cycle has `status = 'PUBLISHED'`                                                                                                                                                                                                                                                                                                                      |
| `payroll.parent_cycle_published`                                                                                                                                                                                                                             | `parent_payroll_cycle_id`'s cycle is `PUBLISHED` or `CLOSED` (supplementary/off-cycle runs, §1.10.4)                                                                                                                                                                                                                                                                       |
| `payroll.scope_resolved`                                                                                                                                                                                                                                     | Every in-scope employee has a `payroll_cycle_employee` row for the current `validation_pass_no`                                                                                                                                                                                                                                                                            |
| `expense.approval_task_created`                                                                                                                                                                                                                              | An `approval_task` of kind `EXPENSE_CLAIM` exists and is `PENDING` for the claim                                                                                                                                                                                                                                                                                           |
| `docreq.self_only`                                                                                                                                                                                                                                           | `document_request.employee_id = actor_employee_id` _(already listed; restated for completeness)_                                                                                                                                                                                                                                                                           |
| `profile.verifier_not_requester`                                                                                                                                                                                                                             | `verified_by_user_id <> submitted_by_user_id`. (`profile.fields_in_policy` and `profile.values_unchanged`, proposed by an earlier draft, are **withdrawn**: the canonical catalogue already has `profile.has_fields` and `profile.target_row_unchanged_since_submit`, and the enum-keyed `ess_profile_change_field` makes a free-text field allowlist unnecessary — §8.1.) |
| `profile.no_open_request_for_field`                                                                                                                                                                                                                          | No other `SUBMITTED`/`IN_REVIEW`/`APPROVED` request of the same employee names the same `(field, target_row_id)` — two concurrent requests to change one bank account are a race, not a queue                                                                                                                                                                              |
| `payroll.distinct_publisher`                                                                                                                                                                                                                                 | R-8 — `published_by_user_id` differs from both `calculated_by_user_id` and `approved_by_user_id`, unless `org_setting.payroll_publisher_may_equal_approver` relaxes the second conjunct                                                                                                                                                                                    |
| `payroll.correction_distinct_publisher`                                                                                                                                                                                                                      | The same rule for a `payroll_correction`                                                                                                                                                                                                                                                                                                                                   |
| `payroll.cycle_kind_not_regular`                                                                                                                                                                                                                             | `payroll_cycle.cycle_kind <> 'REGULAR'` — gates PAY-23 so a regular cycle can never skip attendance                                                                                                                                                                                                                                                                        |
| `payroll.no_lop_override_after_lock`                                                                                                                                                                                                                         | No committed `LOP_OVERRIDE` item has `created_at > payroll_cycle.inputs_locked_at` (canonical; now referenced, by PAY-12)                                                                                                                                                                                                                                                  |
| `payroll.employee_set_unchanged`                                                                                                                                                                                                                             | The §1.5 scope predicate re-derived now hashes to `payroll_cycle.employee_set_sha256` (canonical; now referenced, by PAY-12)                                                                                                                                                                                                                                               |
| `payroll.inputs_settled`                                                                                                                                                                                                                                     | ≥ 1 `COMMITTED` batch **or** the three `no_inputs_attested_*` columns are set (canonical; now referenced, by PAY-3 — `payroll.at_least_one_committed_batch` alone made a month with no variable pay unpayable)                                                                                                                                                             |
| `payroll.committer_not_uploader`                                                                                                                                                                                                                             | `committed_by_user_id <> uploaded_by_user_id` (canonical; now referenced, by PAY-3)                                                                                                                                                                                                                                                                                        |
| `payroll.dual_control_available`                                                                                                                                                                                                                             | R-9 — ≥ 3 distinct `ACTIVE`, MFA-enrolled ACCOUNTS users, unless relaxed by `org_setting`                                                                                                                                                                                                                                                                                  |
| `attendance.created_with_cycle`                                                                                                                                                                                                                              | The enclosing command is cycle creation (canonical; replaces the circular `attendance.cycle_exists` on ATT-1)                                                                                                                                                                                                                                                              |
| `attendance.escalation_actor_not_submitter`                                                                                                                                                                                                                  | The escalating user is not `attendance_submission.submitted_by_user_id` (canonical; now referenced, by AAP-4)                                                                                                                                                                                                                                                              |
| `attendance.totals_unchanged_since_submission`                                                                                                                                                                                                               | The slice's control totals still equal its records' sums (canonical; now referenced, by AAP-2)                                                                                                                                                                                                                                                                             |
| `attendance.no_open_leave_in_period`                                                                                                                                                                                                                         | **New.** No `PENDING_APPROVAL` `leave_request` overlaps `[period_start, period_end]` for any employee in the period. Gates ATT-2                                                                                                                                                                                                                                           |
| `leave.attendance_period_open`                                                                                                                                                                                                                               | **New.** The `attendance_period` covering the request's dates does not exist, or is `OPEN`. Gates LV-4 and LV-8 (§3.7)                                                                                                                                                                                                                                                     |
| `policy.version_was_read`                                                                                                                                                                                                                                    | **New.** A `POLICY.READ` audit row exists for `(actor, policy_version)` whose `body_sha256` equals the version's current `body_sha256`. Gates PACK-1 (§5.4)                                                                                                                                                                                                                |
| `payslip.publication_row_created`                                                                                                                                                                                                                            | A `payslip_publication` row exists before `payslip.status` flips (canonical; now referenced, by PAY-17)                                                                                                                                                                                                                                                                    |
| `payslip.superseding_revision_published`                                                                                                                                                                                                                     | The superseding revision is published before the prior one is marked `SUPERSEDED` (canonical; now referenced, by PC-5)                                                                                                                                                                                                                                                     |
| `reimb.cycle_is_regular`                                                                                                                                                                                                                                     | The target cycle's `cycle_kind = 'REGULAR'` (canonical; now referenced, by EXP-10)                                                                                                                                                                                                                                                                                         |
| `user.email_unique_in_org`, `user.invitation_live`, `user.password_set`, `user.mfa_confirmed_or_within_grace`, `user.privileged_role_granted_without_mfa`, `user.lockout_threshold_reached`, `user.lockout_expired_or_admin_cleared`, `user.employee_exited` | Canonical (`DATA-MODEL.md §5.1.1`, §19.3); now referenced, by §9.3                                                                                                                                                                                                                                                                                                         |
| `benefit.enrolment_window_open`, `benefit.waiver_reason_present`, `benefit.documents_clean`                                                                                                                                                                  | Canonical; now referenced, by §13.1                                                                                                                                                                                                                                                                                                                                        |
| `announcement.has_audience`, `announcement.publish_at_future`                                                                                                                                                                                                | Canonical; now referenced, by §14                                                                                                                                                                                                                                                                                                                                          |
| `tax.declaration_window_open`, `tax.proof_window_open`, `tax.all_items_have_proof`                                                                                                                                                                           | Canonical; now referenced, by §12.1                                                                                                                                                                                                                                                                                                                                        |
| `employee.no_pending_obligations`                                                                                                                                                                                                                            | The exiting employee has no `PENDING_APPROVAL` leave, no `PENDING_MANAGER` expense and no `PENDING` `approval_task` assigned to them                                                                                                                                                                                                                                       |
| `ticket.category_allows_anonymous`                                                                                                                                                                                                                           | `is_anonymous ⇒ ticket_category.is_anonymous_allowed`                                                                                                                                                                                                                                                                                                                      |

**Guard-registry closure.** `DATA-MODEL.md §19.3` binds two properties: every seeded
`guard_key` resolves to a registered implementation, **and every registered guard is
referenced by at least one `state_transition` row**. The second half is why the long list
above matters: before this revision, eighteen canonical guards — the `user.*`,
`benefit.*`, `announcement.*` and `tax.*` families, plus `payroll.inputs_settled`,
`payroll.employee_set_unchanged`, `payroll.committer_not_uploader`,
`attendance.created_with_cycle`, `attendance.escalation_actor_not_submitter`,
`attendance.totals_unchanged_since_submission`, `payslip.publication_row_created`,
`payslip.superseding_revision_published` and `reimb.cycle_is_regular` — were registered
and referenced by nothing in this document, which would have failed the boot. Each is now
attached to the transition it was written for.

### 11.5 Testing obligations these workflows impose

| Area                      | Required test                                                                                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering                  | An integration test that attempts each mandated payroll step out of order and asserts `409`/`422` with the guard key — one test per skipped step                                                                                |
| Visibility                | A test that a payslip row does not exist before `CALCULATING`, is unreadable by its owner between `GENERATED` and `PUBLISHED`, and becomes readable at `PUBLISHED`; plus a direct-SQL test that the RLS policy refuses the read |
| Determinism               | A golden-file test: fixed inputs → fixed `payslip_line` amounts and a fixed `input_sha256`, across two runs and across a process restart                                                                                        |
| Rounding                  | Property tests asserting `gross - deductions = net` and the half-up/round-up rules of §1.9.7 over generated inputs                                                                                                              |
| Concurrency               | Two concurrent leave submissions against one balance; two concurrent slice approvals racing the completion check; two concurrent publishes                                                                                      |
| Idempotency               | Every unsafe route replayed with the same `Idempotency-Key`; every job run twice                                                                                                                                                |
| Outbox                    | Ticket creation with the mail provider failing, asserting the ticket persists, the outbox reaches `FAILED`, the HR notification fires and the UI renders the failure state                                                      |
| Empty states              | Every screen rendered against an empty database, asserting no `0`, no `₹0` and no fabricated date appears where the underlying row is absent                                                                                    |
| Authorization             | For every transition in this document, a negative test per persona that does not hold the permission, and a scope test (a Manager acting on an employee outside their closure)                                                  |
| Separation of duties      | A test that the seeded `role_permission` set satisfies every assertion in §1.1; a test that one Accounts user cannot calculate **and** approve, and cannot approve **and** publish, the same cycle                              |
| Step-up                   | For every transition in §0.9's table, a test that it is refused `401 STEP_UP_REQUIRED` on a session whose `step_up_at` is stale, and accepted after a fresh assertion                                                           |
| Rate limits               | For every bucket in §0.9, a test that the limit is enforced **at the API**, not only at the edge, and that a `429` does not consume the `Idempotency-Key`                                                                       |
| Reachability              | A graph test over the seeded `state_transition` rows: every non-terminal state of every machine has an outgoing transition, and every state is reachable from the machine's initial state                                       |
| Guard closure             | A test that every registered guard is referenced by ≥ 1 seeded transition and every referenced guard is registered — both directions                                                                                            |
| Fail-closed guards        | For each guard, a test with its comparand NULL or its row missing, asserting `false` rather than an exception or `true`                                                                                                         |
| No fabricated decisions   | A test that no seeded transition can produce `ess_approval_decision_outcome.AUTO_APPROVED`, and that an `EXPIRED` task leaves the underlying request undecided                                                                  |
| Mandated email recipient  | A test that raises a ticket in **every** seeded `ticket_category` and asserts `organization.helpdesk_email` appears in `to_addresses` each time, including when the category's `routing_email` differs                          |
| Tax determinism           | A golden-file test over S1–S12 for a fixture set spanning both regimes, a surcharge band with marginal relief, the s.206AA path and the last cycle of the FY                                                                    |
| Policy evidence           | A test that `POST /policy-versions/:id/acknowledge` is refused when no `POLICY.READ` event exists for that body hash                                                                                                            |
| Leave/attendance coupling | A test that a leave cannot be approved into a submitted or locked period, and that a period cannot be submitted with an undecided overlapping leave                                                                             |

---

## 12. TAX — declaration, projection, quarters and Form 16

The prototype's **Tax slips** screen renders four things: the four FY quarters with a TDS
amount and a chip, a Form 16 list with download links, an "Update declaration" action and
a regime comparison. Every one of them is a persisted row or a deterministic fold over
persisted rows; none is computed in the browser.

### 12.1 `employee_tax_declaration` (`machine = 'employee_tax_declaration'`)

Canonical states and permissions: `DATA-MODEL.md §12.3`.

| #     | from → to                           | Trigger                                         | Actor                                 | Guards                        | Effects                                                                                                                                                                                                                         | Audit                       | Notify                                                                          |
| ----- | ----------------------------------- | ----------------------------------------------- | ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------- |
| TXD-1 | `NULL` → `DRAFT`                    | `POST /me/tax-declarations`                     | EMPLOYEE `tax:declaration:write:self` | `tax.declaration_window_open` | One row per `(employee, fiscal_year)` (`ux_etd__employee_fy`); items appended                                                                                                                                                   | `TAX.DECLARATION_DRAFTED`   | —                                                                               |
| TXD-2 | `DRAFT` → `SUBMITTED`               | `POST /me/tax-declarations/:id/submit`          | EMPLOYEE `tax:declaration:write:self` | `tax.declaration_window_open` | `submitted_at`; `declared_total_minor` recomputed **server-side** as Σ items and re-encrypted; the next payroll run's S4 reads it                                                                                               | `TAX.DECLARATION_SUBMITTED` | `TICKET_UPDATED` (BLUE, context `Tax`) → employee, confirming what was recorded |
| TXD-3 | `SUBMITTED` → `PROOF_PENDING`       | _system_, job `tax-proof-window`                | _system_                              | `tax.proof_window_open`       | —                                                                                                                                                                                                                               | `TAX.PROOF_WINDOW_OPENED`   | `TICKET_UPDATED` (AMBER) → employee                                             |
| TXD-4 | `PROOF_PENDING` → `PROOF_SUBMITTED` | `POST /me/tax-declarations/:id/submit-proofs`   | EMPLOYEE `tax:declaration:write:self` | `tax.all_items_have_proof`    | `proof_submitted_at`                                                                                                                                                                                                            | `TAX.PROOFS_SUBMITTED`      | `APPROVAL_PENDING` → `tax:declaration:verify` holders                           |
| TXD-5 | `PROOF_SUBMITTED` → `VERIFIED`      | `POST /tax-declarations/:id/verify`             | ACCOUNTS `tax:declaration:verify`     | —                             | Per item: `verified_amount_minor` (≤ declared, ≥ 0) and `proof_status`; `verified_total_minor` = Σ verified; `verified_at`, `verified_by_user_id`. **From this point S4 reads `verified_total_minor`, not the declared figure** | `TAX.DECLARATION_VERIFIED`  | `TICKET_UPDATED` (GREEN) → employee, naming any item reduced                    |
| TXD-6 | `PROOF_SUBMITTED` → `REJECTED`      | `POST /tax-declarations/:id/reject`             | ACCOUNTS `tax:declaration:verify`     | `approval.note_required`      | `rejection_reason`; S4 falls back to `0` for the rejected items                                                                                                                                                                 | `TAX.DECLARATION_REJECTED`  | `TICKET_UPDATED` (RED) → employee with the reason                               |
| TXD-7 | `REJECTED` → `PROOF_PENDING`        | `POST /me/tax-declarations/:id/resubmit-proofs` | EMPLOYEE `tax:declaration:write:self` | `tax.proof_window_open`       | —                                                                                                                                                                                                                               | `TAX.PROOFS_RESUBMITTED`    | `APPROVAL_PENDING` → verifiers                                                  |

Terminal: `VERIFIED`.

**Which figure S4 uses, and when — stated once so the engine has no choice.**

| Declaration state at the moment of the run                                                 | S4 uses                                                                                                        |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| No declaration row for the FY                                                              | `0`. The Tax screen shows the empty state, not `₹0 declared`                                                   |
| `DRAFT`                                                                                    | `0` — an unsubmitted draft is the employee's working copy, exactly as an unsubmitted attendance record is HR's |
| `SUBMITTED` / `PROOF_PENDING` / `PROOF_SUBMITTED`, and the proof window has **not** closed | `declared_total_minor`, capped per section                                                                     |
| `SUBMITTED` / `PROOF_PENDING` / `PROOF_SUBMITTED`, and the proof window **has** closed     | `0` for every item whose `proof_status <> 'ACCEPTED'` — the statutory position when proof was not produced     |
| `VERIFIED`                                                                                 | `verified_total_minor`, capped per section                                                                     |
| `REJECTED`                                                                                 | `0` for the rejected items, declared/verified for the rest                                                     |

The per-section caps (80C, 80D, 80CCD(1B), 24B…) are seeded reference data per fiscal
year, not literals; `PAY_DECLARATION_CAPPED` is an INFO validation finding naming the item
and the cap whenever one bites, so a reduced deduction is always explainable.

**The declaration window is persisted.** The prototype's toast "Declaration window opens
1 Dec 2026" renders `fiscal_year.declaration_window_opens_on`. Outside the window the
button is disabled with that date as its reason; a NULL window renders "Declaration dates
have not been published yet" and the button stays disabled. No date is ever invented, and
no client-side check substitutes for `tax.declaration_window_open`.

### 12.2 `tds_quarter` (`machine = 'tds_quarter'`)

Rows are created by job `tds-quarter-refresh` when an employee first becomes in scope for
a cycle in that FY, and refreshed by the same job after every publication
(`DATA-MODEL.md §12.5`). The Tax screen **left-joins `fiscal_quarter`**, so all four
quarters always render and a missing row is legitimate.

| #     | from → to                  | Actor                            | Guards                                                                     | Effects                                                                                                                                                                                                                                                  | Audit                    |
| ----- | -------------------------- | -------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| TDQ-1 | `NULL` → `UPCOMING`        | _system_ (`tds-quarter-refresh`) | The quarter has not started                                                | `tds_deducted_minor` stays `NULL` (`ck_tdsq__upcoming_null`)                                                                                                                                                                                             | `TAX.QUARTER_OPENED`     |
| TDQ-2 | `UPCOMING` → `IN_PROGRESS` | _system_                         | `fiscal_quarter.start_date <= CURRENT_DATE`                                | `tds_deducted_minor` = Σ `payslip.tds_minor` over **published** payslips whose `period_end` falls in the quarter, folded in the API over decrypted values; `source_payslip_ids` records exactly which; `payslip_count = cardinality(source_payslip_ids)` | `TAX.QUARTER_RECOMPUTED` |
| TDQ-3 | `IN_PROGRESS` → `FILED`    | ACCOUNTS `tax:quarter:manage`    | `form_24q_ack_no` present (`ck_tdsq__filed_ack`), `approval.note_required` | `filed_at`, `filed_by_user_id`                                                                                                                                                                                                                           | `TAX.QUARTER_FILED`      |
| TDQ-4 | `FILED` → `REVISED`        | ACCOUNTS `tax:quarter:manage`    | `approval.note_required`                                                   | `revised_at`; the fold re-runs                                                                                                                                                                                                                           | `TAX.QUARTER_REVISED`    |

Statuses 3 and 4 in `DATA-MODEL.md §12.5`'s derivation table are the system's; 1 and 2 are
Accounts'. The derivation is evaluated top-down and is **total**, so a past quarter with no
payslips is `IN_PROGRESS` with `tds_deducted_minor = 0` — a real zero, backed by a real
(empty) `source_payslip_ids` — while a future quarter is `UPCOMING` with `NULL`, rendered
as `—`. These are different facts and the UI renders them differently.

A quarter that is `FILED` and then receives a correction (§1.10.3) does **not** silently
change: the refresh job detects that the fold no longer equals `tds_deducted_minor` on a
`FILED` row, leaves the stored value alone, and raises `TAX.QUARTER_DRIFT` to every
`tax:quarter:manage` holder. Accounts then files a revision (TDQ-4). Overwriting a filed
return without a revision record would misstate what was filed with the tax authority.

### 12.3 `form16_document` (`machine = 'form16_document'`)

| #     | from → to                         | Actor                       | Guards                                                                                                                                        | Effects                                                                                                                        | Audit                  | Notify                                                                                           |
| ----- | --------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------ |
| F16-1 | `NULL` → `PENDING`                | ACCOUNTS `tax:form16:issue` | Every quarter of the FY is `FILED` or `REVISED`; the FY's last `REGULAR` cycle is `CLOSED`; `payroll-integrity-verify` has passed over the FY | One row per `(employee, fiscal_year, revision)`                                                                                | `TAX.FORM16_PREPARED`  | —                                                                                                |
| F16-2 | `PENDING` → `ISSUED`              | ACCOUNTS `tax:form16:issue` | `file_object_id` set and `scan_status='CLEAN'`; `is_digitally_signed` true when the org requires it                                           | `issued_at`, `issued_by_user_id`, `file_name`, `traces_ack_no`                                                                 | `TAX.FORM16_ISSUED`    | `FORM16_ISSUED` → employee; `DOCUMENT_ISSUED`-class email (notification only, **no attachment**) |
| F16-3 | `ISSUED` → `REVISED`              | ACCOUNTS `tax:form16:issue` | `approval.note_required`                                                                                                                      | A **new row** with `revision + 1`; the prior row is retained and remains downloadable to `tax:read:any`                        | `TAX.FORM16_REVISED`   | `FORM16_ISSUED` (AMBER, "revised") → employee                                                    |
| F16-4 | `ISSUED`\|`PENDING` → `WITHDRAWN` | ACCOUNTS `tax:form16:issue` | `approval.note_required`                                                                                                                      | `withdrawn_at`, `withdrawn_reason`; the download link disappears from the employee's list and the reason is shown in its place | `TAX.FORM16_WITHDRAWN` | `FORM16_ISSUED` (RED) → employee                                                                 |

The employee's Form 16 list is exactly
`WHERE employee_id = :me AND status IN ('ISSUED','REVISED') AND withdrawn_at IS NULL`,
newest first, rendering `file_name` and `issued_at` from the row. With no rows it renders
the designed empty state ("Your Form 16 for FY 2026–27 will appear here after the year
closes"), never a placeholder filename. Every download writes a `DOWNLOAD` audit row on
the sensitive path, and the file is served through a short-lived, single-use signed URL
scoped to the requesting session — never a public object URL.

### 12.4 Tax invariants

| #         | Invariant                                                                 | Enforced by                                                                                    |
| --------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| TAX-INV-1 | Every figure on the Tax screen is a stored column                         | `employee_tax_projection`, `tds_quarter`, `form16_document`; the screen performs no arithmetic |
| TAX-INV-2 | A quarter's TDS equals the payslips it names                              | `source_payslip_ids` + nightly re-fold; drift raises `TAX.QUARTER_DRIFT`                       |
| TAX-INV-3 | A filed return is never silently changed                                  | TDQ-4 revision path; the refresh job will not overwrite a `FILED` row                          |
| TAX-INV-4 | A regime election cannot retroactively alter a published payslip          | `employee_tax_regime_election.is_locked` per employee at their first FY publication (§1.9.6)   |
| TAX-INV-5 | An unverified declaration never reduces tax after the proof window closes | The S4 table in §12.1                                                                          |
| TAX-INV-6 | Form 16 is issued only from filed quarters over a closed year             | F16-1 guards                                                                                   |

---

## 13. BENEFITS

The prototype's Benefits screen shows benefit cards with a value and a primary action, and
a dependents list. `DATA-MODEL.md §12.7–§12.9` is canonical.

### 13.1 `benefit_enrolment` (`machine = 'benefit_enrolment'`)

| #     | from → to                                  | Actor                                                                         | Guards                                                                                | Effects                                                                                                            | Audit                         | Notify                                                  |
| ----- | ------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------- |
| BEN-1 | `NULL` → `ELIGIBLE`                        | _system_, at EMP-2 and at each `benefit_plan_year` rollover                   | The plan's eligibility rule matches `employment_as_of(employee, plan_year.starts_on)` | One row per `(employee, benefit_plan_year)`                                                                        | `BENEFIT.ELIGIBLE`            | —                                                       |
| BEN-2 | `ELIGIBLE` → `ENROLLED`                    | EMPLOYEE `benefit:enrol:self`, or HR `benefit:manage` for auto-enrolled plans | `benefit.enrolment_window_open`                                                       | `enrolled_at`; `employee_contribution_minor` from the plan's default or the employee's election; dependents linked | `BENEFIT.ENROLLED`            | `TICKET_UPDATED` (GREEN, context `Benefits`) → employee |
| BEN-3 | `ELIGIBLE` → `WAIVED`                      | EMPLOYEE `benefit:enrol:self`                                                 | `benefit.enrolment_window_open`, `benefit.waiver_reason_present`                      | `waiver_reason`                                                                                                    | `BENEFIT.WAIVED`              | —                                                       |
| BEN-4 | `ENROLLED` → `PENDING_DOCUMENTS`           | HR `benefit:manage`                                                           | `approval.note_required`                                                              | The missing document is named                                                                                      | `BENEFIT.DOCUMENTS_REQUESTED` | `TICKET_UPDATED` (AMBER) → employee                     |
| BEN-5 | `PENDING_DOCUMENTS` → `ENROLLED`           | HR `benefit:manage`                                                           | `benefit.documents_clean`                                                             | —                                                                                                                  | `BENEFIT.DOCUMENTS_ACCEPTED`  | `TICKET_UPDATED` (GREEN) → employee                     |
| BEN-6 | `ENROLLED` → `TERMINATED`                  | HR `benefit:manage`                                                           | `approval.note_required`                                                              | `effective_to`                                                                                                     | `BENEFIT.TERMINATED`          | `TICKET_UPDATED` → employee                             |
| BEN-7 | `ENROLLED`\|`PENDING_DOCUMENTS` → `LAPSED` | _system_, at `effective_to`                                                   | —                                                                                     | —                                                                                                                  | `BENEFIT.LAPSED`              | —                                                       |

Terminal: `TERMINATED`, `LAPSED`.

### 13.2 The two buttons that are requests, not writes

`benefit_plan.primary_action = 'CHANGE_CONTRIBUTION'` and `'ADD_DEPENDENT'` **create a
`helpdesk_ticket`** in the `BENEFITS` category with
`related_entity_type = 'benefit_enrolment'` and `related_entity_id` set — they do not
write `employee_contribution_minor` and they do not insert a `dependent`. The reason is
not ceremony: a contribution change alters a payroll input (and therefore a future
payslip), and a dependent addition alters an insurer's covered-lives list. Both need a
human and a record.

Consequences the UI must honour:

- The toast shows the **persisted** `ticket_no` read back from the committed row, exactly
  as §6 requires, not a client-side counter. The prototype's "Contribution changes apply
  from the next payroll" is the `ui_copy` template for this ticket category.
- Outside `benefit_plan_year.enrolment_window_opens_on … closes_on` the button renders
  **disabled** with the persisted window dates as its reason. A NULL window renders
  "Enrolment dates have not been published yet" — never a guessed window.
- There is **no** code path that changes `employee_contribution_minor` without a ticket
  and a subsequent `benefit:manage` action against it, and the change reaches payroll only
  as a `payroll_input_item` or a salary-structure revision, both of which are already
  audited and validated.

### 13.3 What the cards render, and the zero-data case

| Card element                                        | Source                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Value (`₹5,00,000`, `3× annual CTC`, `₹8,600 / mo`) | `benefit_plan.coverage_kind` + the enrolment's resolved amount. `MULTIPLE_OF_CTC` renders the multiple **and** the resolved rupee amount only when `employee_employment.annual_ctc_minor` exists; with no CTC it renders the multiple alone (this is the `PAY_CTC_MISSING` WARNING of §1.5 surfacing honestly, not a guessed figure) |
| Meta line (insurer, policy number, covered lives)   | `benefit_plan`, `benefit_plan_year`, `benefit_enrolment_dependent`                                                                                                                                                                                                                                                                   |
| Nominee (`Karthik Raghavan (100%)`)                 | `nominee` rows; percentages must sum to 100 or the card shows "Nomination incomplete" with a link to fix it — it never normalises the numbers itself                                                                                                                                                                                 |
| Dependents list                                     | `dependent` joined through `benefit_enrolment_dependent`; the avatar uses the plaintext `initials` column, and the full name is decrypted only for the owning employee and `employee:read:any` holders                                                                                                                               |

With no `benefit_enrolment` rows the screen renders one empty state naming the next
enrolment window; with enrolments but no dependents, the dependents card renders its own
empty state. Neither fabricates a covered life.

---

## 14. ANNOUNCEMENTS

`machine = 'announcement'`; canonical states and guards in `DATA-MODEL.md §16.1`.

| #     | from → to                 | Actor                                | Guards                                                        | Effects                                                                       | Audit                      | Notify                                                                        |
| ----- | ------------------------- | ------------------------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| ANN-1 | `NULL` → `DRAFT`          | HR `announcement:author`             | —                                                             | Body stored; `announcement_audience` rows                                     | `ANNOUNCEMENT.DRAFTED`     | —                                                                             |
| ANN-2 | `DRAFT` → `SCHEDULED`     | HR `announcement:publish`            | `announcement.has_audience`, `announcement.publish_at_future` | `publish_at`; an `ess_ops.background_job` row for `announcement-publish`      | `ANNOUNCEMENT.SCHEDULED`   | —                                                                             |
| ANN-3 | `DRAFT` → `PUBLISHED`     | HR `announcement:publish`            | `announcement.has_audience`                                   | `published_at`, `published_by_user_id`; audience resolved (§14.1)             | `ANNOUNCEMENT.PUBLISHED`   | `ANNOUNCEMENT_PUBLISHED` → every matched employee                             |
| ANN-4 | `SCHEDULED` → `PUBLISHED` | _system_, job `announcement-publish` | `publish_at <= now()`                                         | As ANN-3                                                                      | `ANNOUNCEMENT.PUBLISHED`   | `ANNOUNCEMENT_PUBLISHED`, `source_rule_code='ANNOUNCEMENT_SCHEDULED_RELEASE'` |
| ANN-5 | `SCHEDULED` → `DRAFT`     | HR `announcement:author`             | —                                                             | `publish_at` cleared; the pending job row cancelled                           | `ANNOUNCEMENT.UNSCHEDULED` | —                                                                             |
| ANN-6 | `PUBLISHED` → `ARCHIVED`  | HR `announcement:publish`            | —                                                             | `archived_at`; it leaves the feed. Existing `announcement_read` rows are kept | `ANNOUNCEMENT.ARCHIVED`    | —                                                                             |

Terminal: `ARCHIVED`. `is_pinned` is settable only on a `PUBLISHED` row
(`ck_ann__pin`) and is what puts an item first in `ix_ann__feed`.

### 14.1 Audience resolution — fail-closed

An employee sees an announcement when at least one `announcement_audience` row matches
`employment_as_of(employee, published_at)` on its dimension (`ALL`, `DEPARTMENT`,
`LOCATION`, `EMPLOYMENT_TYPE`, `EMPLOYEE`). `announcement.has_audience` makes an
audience-less announcement unpublishable, so the read path never has to decide what "no
audience" means — the alternative (treating it as "everyone") is how an internal note
reaches the whole company.

An announcement is **an event, not a task**: it is not backfilled to employees who join
after publication (§9.2 EMP-2 says so explicitly), it produces no due date, and it never
appears in "Needs your attention". A policy that needs acknowledging is a
`policy_version`, and the two are never conflated even when HR publishes both for the same
change.

### 14.2 Read state

`announcement_read (announcement_id, employee_id, read_at)` is written once, by the
employee's own read, and is the source of the unread dot in the feed. It is **not** a
notification: the `ANNOUNCEMENT_PUBLISHED` notification is dismissed independently. The
feed's unread count is `count(*)` over published, non-archived, in-audience announcements
with no `announcement_read` row — with zero, no badge is rendered.

---

## 15. DIRECTORY, TEAM AND SEARCH

No state machine — these are read models. They are specified because "who may see whose
phone number" is an authorization decision, and because the prototype's search returns
payslips.

### 15.1 Who appears in the Directory

```sql
WHERE employee.organization_id = current_setting('ess.organization_id')::uuid
  AND employee.is_directory_listed
  AND employee.employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD')
```

`PRE_JOINING` employees are absent until EMP-2; `EXITED` employees leave the Directory at
EMP-7 (`is_directory_listed = false`) while remaining resolvable to `employee:read:any`
for payroll and audit. Service accounts are never listed.

### 15.2 Which fields, to whom

| Field                                                                        | Everyone                         | The person's manager chain                                                   | `employee:read:any` (HR)                                           |
| ---------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Name, initials, designation, department, work location, work email           | yes                              | yes                                                                          | yes                                                                |
| Work phone                                                                   | yes (it is the company's number) | yes                                                                          | yes                                                                |
| Reporting manager, reporting line                                            | yes                              | yes                                                                          | yes                                                                |
| Personal mobile, personal email, addresses, DOB, marital status, blood group | **no**                           | **no**                                                                       | yes, decrypted, and every read writes a `READ_SENSITIVE` audit row |
| Emergency contacts                                                           | **no**                           | manager: yes (the prototype's "visible only to People Ops and your manager") | yes                                                                |
| Bank, statutory ids, salary, payslips                                        | **no**                           | **no**                                                                       | only `payroll:*`/`tax:*` holders, audited                          |

The Directory API returns only the first block by default; the sensitive block is a
separate, separately-authorized endpoint, so a scope bug cannot leak it through the list
view. The prototype's `PEOPLE` array — which carries mobile numbers for everyone — is
layout scaffolding and is explicitly not the production field set (`DESIGN-SYSTEM.md §11`).

### 15.3 "Team today"

The chip on each direct report is derived, never typed:

```sql
CASE WHEN EXISTS (
       SELECT 1 FROM leave_request lr
       JOIN leave_request_day lrd ON lrd.leave_request_id = lr.id
       WHERE lr.employee_id = e.id AND lr.status = 'APPROVED'
         AND lrd.leave_date = CURRENT_DATE AND lrd.day_fraction > 0)
     THEN 'On leave'                      -- amber
     WHEN EXISTS (SELECT 1 FROM holiday h
                  WHERE h.holiday_calendar_id = holiday_calendar_for(e.id, CURRENT_DATE)
                    AND h.holiday_date = CURRENT_DATE AND h.kind = 'PUBLIC')
     THEN 'Holiday'                       -- gray
     WHEN NOT is_working_day(e.id, CURRENT_DATE) THEN 'Week off'   -- gray
     ELSE 'Available'                     -- green
END
```

The order matters and is fixed: an approved leave on a day that is also a holiday shows
`On leave` only if the leave actually consumed that day (`day_fraction > 0`), which by
§3.3 it does not on a public holiday — so the holiday branch is what renders. A manager
with no direct reports sees the "Team today" card's empty state, not an empty table.

### 15.4 Global search

The prototype's search returns four typed result kinds. Each is **re-authorized
server-side**, and the client sends only the query string:

| Kind    | Source                                                                                                            | Scope rule                                                                                                                              |
| ------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Module  | The actor's own resolved navigation                                                                               | Only modules the actor's scopes admit — a non-manager never sees "Approvals" as a result, because the nav itself is derived from scopes |
| Person  | The Directory read model of §15.1/§15.2                                                                           | Name, designation and department only; never a phone or an email the actor may not see                                                  |
| Policy  | `policy_version` joined to the actor's `policy_assignment`, plus policies published as organisation-wide readable | Never a policy the actor is not entitled to read                                                                                        |
| Payslip | `payslipRepo.findPublishedForEmployee()` — **the same single function as §1.8**                                   | Own, published payslips only. Search does not get its own query path                                                                    |

Search is rate-limited (`search:user`, §0.9), the query string is never logged with the
actor's identity in the same record, and an empty result set renders the prototype's "No
matches for …" state. Search never reveals existence: a query that matches a person the
actor may not see returns nothing rather than a redacted row.

---

## 16. APPROVALS — the unified manager queue (`machine = 'approval_task'`)

The prototype's **Approvals** screen and the sidebar badge are one table:
`approval_task` (`DATA-MODEL.md §19.1`). Every pending decision in the system — leave,
expense, attendance slice, document request, profile change — has exactly one row, which
is why the badge is one indexed read and why a re-org cannot lose a decision.

### 16.1 Transitions

Canonical machine: `DATA-MODEL.md §19.2.1`.

| #     | from → to                | Actor                                                                          | Guards                                                          | Effects                                                                                                                                                                       | Audit                   | Notify                                                                                                 |
| ----- | ------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| APT-1 | `NULL` → `PENDING`       | _system_, inside the originating transition (LV-2, EXP-3, ATT-3, DOC-1, PCR-2) | —                                                               | `assignee_employee_id` + `assignment_reason` resolved (§16.2); `title`/`subtitle`/`amount_minor` composed **server-side** from persisted fields; `due_at` from the kind's SLA | per originating section | per originating section                                                                                |
| APT-2 | `PENDING` → `APPROVED`   | `approval:task:act` + the kind's own code                                      | `approval.actor_is_assigned_approver`                           | The underlying entity's transition, one `approval_decision`, the ledger/rollup effects, notification, email, audit — **all one transaction**                                  | per originating section | per originating section                                                                                |
| APT-3 | `PENDING` → `REJECTED`   | as APT-2                                                                       | `approval.actor_is_assigned_approver`, `approval.note_required` | As APT-2 with the note                                                                                                                                                        | per originating section | per originating section                                                                                |
| APT-4 | `PENDING` → `WITHDRAWN`  | _system_, when the request is withdrawn or cancelled                           | —                                                               | The assignee's notification is **dismissed, not deleted** (§10.3 rule 6)                                                                                                      | `APPROVAL.WITHDRAWN`    | —                                                                                                      |
| APT-5 | `PENDING` → `REASSIGNED` | `approval:task:act` or HR `role:assign`                                        | `approval.note_required`                                        | A **replacement** task with `assignment_reason='REASSIGNED'` and `reassigned_from_task_id`; one `approval_decision` of outcome `REASSIGNED`                                   | `APPROVAL.REASSIGNED`   | `APPROVAL_PENDING` → the new assignee; `TICKET_UPDATED` → the old one                                  |
| APT-6 | `PENDING` → `EXPIRED`    | _system_, job `approval-sla-escalation`                                        | `due_at < now()`                                                | The task leaves the queue and a **replacement is created one level up** (`SKIP_LEVEL`). **Nothing is decided**                                                                | `APPROVAL.EXPIRED`      | `APPROVAL_PENDING` → the skip-level assignee; `TICKET_UPDATED` → the original assignee and the subject |

**`EXPIRED` never approves anything.** `ess_approval_decision_outcome.AUTO_APPROVED`
exists in the enum and is reachable from **no** transition in this document;
`db:verify-schema` asserts that no seeded `state_transition` row produces it. Silently
approving an employee's leave or expense because a manager was slow would attribute a
decision to a person who never made it — a fabricated fact about a human being, which is
the same defect as a fabricated number and rather worse.

The one apparent exception is attendance, and it is not one: AAP-4 `AUTO_ESCALATED` is a
**human** decision by an HR user holding `attendance:approve:any`, taken after `due_at`,
with a mandatory reason, recorded against that user. It is named `AUTO_ESCALATED` only so
escalations are trivially reportable.

### 16.2 Who the task is assigned to, and why

`assignment_reason` makes every queue entry explainable, resolved in this order:

1. `PRIMARY_MANAGER` — the subject's current `PRIMARY` `employee_manager`.
2. `SKIP_LEVEL` — the next ancestor in `employee_reporting_closure`, used when the primary
   manager is the subject themself (`ck_at__not_self`), when the amount crosses
   `expense_limit.escalation_amount_minor` (§4.3), or on APT-6.
3. `HR_BUSINESS_PARTNER` — the subject's HRBP, used at the top of the reporting chain and
   for `PROFILE_CHANGE`.
4. `HR_FALLBACK` — any holder of the deciding permission, used when none of the above
   resolves. It is the last resort and it is visible as such in the queue.
5. `REASSIGNED` — set by APT-5.

A task is **never** left unassigned: `assignee_employee_id` is `NOT NULL`, and
`reporting-closure-verify` (§10.2) alerts nightly on any employee for whom rule 4 would be
needed, so the fallback is a signal rather than a steady state.

**A manager never decides their own request.** `ck_at__not_self` forbids
`assignee_employee_id = subject_employee_id` at the database, and the resolution order
routes a manager's own leave, expense, attendance record or profile change to their
manager (or the HRBP at the top). This is the same rule as `payroll.distinct_approver`,
applied to people rather than to payroll runs.

### 16.3 What the screen renders

| Element                                        | Source                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Sidebar badge                                  | `count(*) FROM approval_task WHERE assignee_app_user_id = :me AND status='PENDING'`. **Zero renders no badge**, not a `0` chip |
| Card kind chip (`Leave` blue, `Expense` amber) | `approval_task.kind` → Design System §1 tones                                                                                  |
| Card title / subtitle                          | The stored `title`/`subtitle`, composed server-side at APT-1                                                                   |
| Amount                                         | `amount_minor`, present only for expense tasks and visible to this assignee by definition                                      |
| "Requested 27 Sep"                             | `requested_at`                                                                                                                 |
| Ordering                                       | `priority_order`, then `due_at` — overdue first, then oldest                                                                   |
| History tab                                    | `approval_decision` rows for tasks this actor decided, newest first                                                            |
| Empty pending queue                            | The designed "Nothing waiting on you" state                                                                                    |
| Empty history                                  | Its own empty state — a new manager has decided nothing, and that is not an error                                              |

`title` and `subtitle` are composed once, at creation, from persisted fields — including
the prototype's "Balance after: 9.5 days", which is `leave_request.balance_after_days`
snapshotted at LV-2, not a live recomputation. That matters: the manager decides against
the balance as it stood when the request was made, and the card must not silently change
under them while they read it.

### 16.4 Approvals invariants

| #         | Invariant                                          | Enforced by                                                                                                                                   |
| --------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| APT-INV-1 | Exactly one live task per pending decision         | `ux_at__kind_entity (kind, entity_id) WHERE status='PENDING'`                                                                                 |
| APT-INV-2 | No task is ever unassigned                         | `assignee_employee_id NOT NULL` + the resolution order of §16.2                                                                               |
| APT-INV-3 | Nobody decides their own request                   | `ck_at__not_self` + routing                                                                                                                   |
| APT-INV-4 | No decision is ever fabricated by time passing     | APT-6 escalates, never approves; `AUTO_APPROVED` is unreachable and CI proves it                                                              |
| APT-INV-5 | A decision and its consequences are atomic         | §11.1; the task, the `approval_decision`, the entity transition, the ledger effects, the notification and the audit row share one transaction |
| APT-INV-6 | Two managers clicking Approve produce one decision | `FOR UPDATE` on the task + `row_version` / `If-Match` → one `409`                                                                             |
| APT-INV-7 | Offboarding never strands a queue                  | §9.4; reassignment runs **before** the `EXITED` guard passes                                                                                  |

---

## 17. PAYSLIP DELIVERY — download, PDF and the "email me a copy" action

The prototype's payslip detail offers **Download** and **Email payslip**. Both are
authorization decisions and both are audited.

| Action               | Rule                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Render on screen** | From `payslip_line`, never from the PDF. A payslip is readable the moment it is published even if its PDF has not rendered — §1.12 already requires this, and it is why the screen is the authority and the PDF is a convenience                                                                                                                                                                                           |
| **Download**         | The button renders **iff** `pdf_file_object_id IS NOT NULL` and that `file_object.scan_status = 'CLEAN'`. The file is served through a short-lived (5 min), single-use signed URL bound to the requesting session, never a public object URL. Every download writes `action='DOWNLOAD'` **and** `READ_SENSITIVE`                                                                                                           |
| **Email a copy**     | Enqueues an `email_outbox` row of kind `PAYSLIP_COPY_REQUESTED` to **the employee's own work email only** — the address is read from `employee.work_email` server-side and the request body carries no address at all. The mail contains a deep link, **never an attachment**: a payslip mailed as a PDF leaves the system's access controls permanently. Audit `PAYSLIP.COPY_REQUESTED`. Rate-limited under `export:user` |
| **The toast**        | Says what is true at commit: "We'll email a link to priya.raghavan@widedrop.com" — the address rendered from the persisted column, and the future tense because delivery is the outbox worker's job (§6.3). It never claims the mail was sent                                                                                                                                                                              |

`PAYSLIP_PUBLISHED` mails at PAY-17 follow the same rule: notification only, no
attachment, no amount in the body. The amount is behind the login.

**PDF rendering is outside the transaction and has its own state.** The render job writes
`payslip.pdf_file_object_id` when it succeeds. A failure is retried with backoff and, after
exhaustion, raises `PAYSLIP.PDF_RENDER_FAILED` to `payroll:cycle:read` holders. The
employee is never told a payslip is missing when only its PDF is — the screen shows the
payslip and omits the Download button, which is the honest rendering of that state.

---

## 18. EMPTY-STATE DERIVATION — every surface, from its workflow state

Directive 9 requires every screen, card, table, dashboard, group box, chart and widget to
be polished and correct with zero data, and directive 2 forbids inventing a value to fill
one. `DATA-MODEL.md §20.16` is the catalogue of empty-state **keys** and the query that
detects each; `DESIGN-SYSTEM.md §8` is the visual treatment. This section supplies the
missing third piece: **which workflow state produces which key**, so that an empty screen
is a rendering of a known fact rather than a fallback.

### 18.1 The three kinds of absence, which must never be conflated

| Kind        | Meaning                                                    | Rendering                                                                   |
| ----------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Not yet** | The workflow has not reached the step that creates the row | The step's own copy, naming where it is: "August 2026 payroll is in review" |
| **Never**   | The row will not exist for this actor, and that is correct | The reason: "ESI — Not applicable", "No longer applies to your role"        |
| **None**    | The row set is legitimately empty and is expected to fill  | The designed empty state plus, where the user can act, one secondary button |

A real `0` is a **fourth** thing and is rendered as `0` only when a row exists whose value
is zero — `expense_fy_rollup.reimbursed_minor = 0` renders `₹0`; the **absence** of the
rollup row renders `—`. A metric tile whose value is absent shows `—` in `--text-muted`
with the sub-label carrying the reason (`DESIGN-SYSTEM.md §8`), never `₹0`, never `0 / 0`,
never `0 %`.

### 18.2 Workflow state → empty-state key

| Surface                             | Condition                                                                             | Key                         | Copy source                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| Payslips list                       | No `payslip_publication` for the actor, earliest in-scope cycle `DRAFT`/`INPUTS_OPEN` | `payslips.preparing`        | "August 2026 payroll is being prepared"                                                |
| Payslips list                       | …cycle `INPUTS_LOCKED`…`ATTENDANCE_APPROVED`                                          | `payslips.in_review`        | "August 2026 payroll is in review"                                                     |
| Payslips list                       | …cycle `VALIDATING`…`APPROVED`                                                        | `payslips.finalising`       | "August 2026 payroll is being finalised"                                               |
| Payslips list                       | No `payroll_cycle` covering the actor at all                                          | `payslips.none_ever`        | "Your first payslip will appear here after your first payroll run"                     |
| Payslip download button             | `pdf_file_object_id IS NULL` or not `CLEAN`                                           | _(button not rendered)_     | The payslip itself renders; §17                                                        |
| YTD tiles                           | No `payslip_fy_rollup` row for the FY                                                 | `payslips.ytd_none`         | `—` per tile, sub-label "No published payslips this financial year"                    |
| Tax quarters                        | `tds_quarter` row absent, or `UPCOMING`                                               | `tax.quarter_upcoming`      | `—` + gray `Upcoming` chip (both cases render identically — §12.2)                     |
| Tax quarters                        | Row exists, quarter started, no payslips folded                                       | _(not empty)_               | `₹0` — a real zero with an empty `source_payslip_ids`                                  |
| Form 16 list                        | No `ISSUED`/`REVISED` row                                                             | `tax.form16_none`           | "Your Form 16 for FY 2026–27 will appear here after the year closes"                   |
| Regime comparison                   | No counterfactual projection row                                                      | `tax.compare_unavailable`   | "We can compare regimes once your declaration is in"                                   |
| Declaration card                    | No declaration, window closed                                                         | `tax.declaration_closed`    | Window dates from `fiscal_year`; button disabled                                       |
| Leave balances                      | No `leave_balance` row for a type                                                     | `leave.balance_none`        | `—` + "Accrual starts after your first full month", never `0 / 0`                      |
| Leave history                       | No `leave_request` rows                                                               | `leave.history_none`        | "You have not applied for leave yet"                                                   |
| Holidays card                       | No `holiday` rows ahead in the calendar                                               | `leave.holidays_none`       | "No upcoming holidays on your calendar"                                                |
| Attendance card                     | No `attendance_record`, or status `DRAFT`/`REJECTED`                                  | `attendance.not_prepared`   | "Attendance for August 2026 has not been prepared yet" (§2.5)                          |
| Expenses tiles                      | No `expense_fy_rollup` row                                                            | `expenses.tiles_none`       | `—` per tile with its sub-label                                                        |
| Expenses tile "Approved · paying …" | Approved claims exist, no batch assigned                                              | `expenses.cycle_unassigned` | The amount, sub-label "Payment cycle not assigned yet" — never an invented date (§4.5) |
| Expenses list                       | No claims                                                                             | `expenses.none`             | "No claims yet" + "New claim" button                                                   |
| Documents / letters                 | No `document_request` rows                                                            | `documents.letters_none`    | "No letter requests yet" + "Request letter"                                            |
| Documents library                   | No `employee_document` rows                                                           | `documents.library_none`    | "Documents issued to you will appear here"                                             |
| Policies list                       | No `policy_assignment` and no readable policy                                         | `policies.none`             | "No policies are published yet"                                                        |
| Policies chip                       | Assignment superseded / never in scope                                                | `policies.not_applicable`   | Gray `NOT_APPLICABLE` + the reason (§5.3)                                              |
| Policies badge                      | Zero pending + overdue                                                                | _(badge suppressed)_        | No `0` chip                                                                            |
| Benefits                            | No `benefit_enrolment`                                                                | `benefits.none`             | Next window from `benefit_plan_year`, or "Enrolment dates have not been published yet" |
| Dependents                          | No `dependent` rows                                                                   | `benefits.dependents_none`  | "No dependents added"                                                                  |
| Announcements                       | No published, in-audience announcement                                                | `announcements.none`        | "No announcements yet"                                                                 |
| Directory                           | Query matches nothing                                                                 | `directory.no_matches`      | The prototype's "No matches for …"                                                     |
| Directory "Team today"              | Actor has no direct reports                                                           | `directory.team_none`       | "You have no direct reports"                                                           |
| Help desk                           | No tickets                                                                            | `help.tickets_none`         | "You have not raised a ticket yet" + "Raise ticket"                                    |
| Help desk delivery chip             | `email_outbox.status`                                                                 | _(not empty)_               | Renders the real status (§6.3) — never an assumed "sent"                               |
| Approvals pending                   | No `PENDING` task for the actor                                                       | `approvals.pending_none`    | "Nothing waiting on you"; sidebar badge suppressed                                     |
| Approvals history                   | No decided tasks                                                                      | `approvals.history_none`    | "Decisions you make will appear here"                                                  |
| Home "Needs your attention"         | No pending policy, no pending approval                                                | `home.todos_none`           | "You are all caught up"                                                                |
| Home latest payslip                 | As Payslips list                                                                      | _(the same key)_            | The card shows the same state, never a stale figure                                    |
| Notifications popover               | No unread, undismissed, unexpired rows                                                | `notifications.none`        | "No notifications"; the bell dot is not rendered                                       |
| Global search                       | No results                                                                            | `search.no_matches`         | "No matches for …"                                                                     |

### 18.3 What CI checks

- **Catalogue closure.** Every key above exists in `DATA-MODEL.md §20.16` and vice versa;
  every key resolves to a `ui_copy` row (§0.10). A key with no copy fails the build.
- **Zero-data render.** §11.5's "Empty states" obligation is executed against a database
  containing **only** seeded reference data and one activated employee: every screen is
  rendered and asserted to contain no `0`, no `₹0`, no `0 %`, no `0 / 0` and no date
  string, except where §18.1's real-zero rule applies and a row is present to justify it.
- **No client-side fallback.** A lint rule forbids `||`/`??` defaulting of a rendered
  numeric or date value in the web package (`value ?? 0`, `value || '—'` where `value`
  comes from an API response); the API returns `null` and the component renders the keyed
  empty state, so a missing figure can never be silently replaced by a plausible one.

---

## Appendix A — Machine index

Every machine in the system, with the section that specifies its **behaviour** here and the
`DATA-MODEL.md` section that specifies its **states and guards**. `DATA-MODEL.md §2.1`
requires that every table carrying a `status` column has a machine; this index is the
reconciliation of that requirement against this document, and `db:verify-schema` checks
both directions.

| Machine                          | States | Behaviour (this doc) | Schema (`DATA-MODEL.md`) |
| -------------------------------- | ------ | -------------------- | ------------------------ |
| `payroll_cycle`                  | 14     | §1.3 (PAY-1…PAY-23)  | §10.2                    |
| `payroll_input_batch`            | 7      | §1.4.1               | §10.5.1                  |
| `payroll_run`                    | 5      | §1.4.2               | §10.6.1                  |
| `payslip`                        | 4      | §1.8, §17            | §10.7.1                  |
| `payslip_publication`            | —      | §1.8, §17            | §10.8.1                  |
| `payroll_correction`             | 7      | §1.10.3              | §10.11                   |
| `attendance_period`              | 6      | §2.2                 | §9.5                     |
| `attendance_record`              | 5      | §2.3                 | §9.5                     |
| `attendance_approval`            | 4      | §2.4                 | §9.5                     |
| `leave_request`                  | 6      | §3.2                 | §8.6                     |
| `expense_claim`                  | 12     | §4.2                 | §13.3                    |
| `reimbursement_batch`            | 5      | §4.5                 | §11                      |
| `policy_version`                 | 5      | §5.1                 | §15.4                    |
| `policy_acknowledgement`         | 2      | §5.4                 | §15.4                    |
| `helpdesk_ticket`                | 8      | §6.2                 | §16.4                    |
| `document_request`               | 6      | §7.2                 | §14.3                    |
| `profile_change_request`         | 7      | §8.2                 | §5.11                    |
| `employee` (`employment_status`) | 6      | §9.2                 | §5.2                     |
| `app_user`                       | 7      | §9.3                 | §5.1.1                   |
| `session`                        | 3      | `SECURITY.md §2`     | §6.6                     |
| `approval_task`                  | 6      | §16.1                | §19.2.1                  |
| `announcement`                   | 4      | §14                  | §16.1                    |
| `employee_tax_declaration`       | 6      | §12.1                | §12.3                    |
| `tds_quarter`                    | 4      | §12.2                | §12.5.1                  |
| `form16_document`                | 4      | §12.3                | §12.6.1                  |
| `benefit_enrolment`              | 6      | §13.1                | §12.8.1                  |

Every one of these is seeded into `state_transition` and is the **only** legal set of
moves; `trg_guard_state_transition` enforces it at the database level. Two machines that
this document previously named do not exist under those names and are corrected here:
`tax_declaration` is `employee_tax_declaration`, and there is no `employee` machine
separate from `employment_status` — the column is the machine, and its transitions are
EMP-1…EMP-7.

**States with no machine are a schema bug, not a simplification.** `payslip.status` was
unguarded until `DATA-MODEL.md §10.7.1` added its machine, which meant
`UPDATE payslip SET status='PUBLISHED'` was structurally permitted — the single most
consequential write in the system, reachable by a stray query. That is the class of defect
this index exists to prevent.

---

## Appendix B — What this revision changed, and why

A reader who knows the previous draft needs to know which rules moved. Each entry is a
defect that was corrected, not a preference that was expressed.

| #   | Defect                                                                                                                                             | Correction                                                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `VALIDATED` had no outgoing transition but `CALCULATING`, while `payroll.validated_recently` expired it — a cycle could become permanently stuck   | R-5/R-6: PAY-21, PAY-22, and `VALIDATED → CANCELLED`                                                                        |
| 2   | §1.10.4's supplementary path (`INPUTS_LOCKED → VALIDATING`) was described but was not a transition                                                 | R-7: PAY-23, gated by `payroll.cycle_kind_not_regular`                                                                      |
| 3   | ATT-7/ATT-8 reopened attendance with no paired cycle transition, leaving the two machines disagreeing                                              | PAY-20/PAY-22 fire in the same transaction; ATT-INV-10                                                                      |
| 4   | PAY-3 used `payroll.at_least_one_committed_batch`, making a month with no variable pay unpayable                                                   | `payroll.inputs_settled` + the attested no-inputs path                                                                      |
| 5   | Publication used `payroll.distinct_approver`, so the publisher could be the approver                                                               | R-8/R-9: `payroll.distinct_publisher`, three-person control, `dual_control_available` raised to 3 and checked at PAY-3      |
| 6   | PAY-11 replaced the scope snapshot, destroying audited `DEFERRED` decisions on every re-validation                                                 | R-10: upsert, carry dispositions forward, explicit `undefer` route                                                          |
| 7   | `pt_basis` was read but never defined; PT was levied on `GROSS`, including reimbursements                                                          | R-11: `pt_basis` column, default `GROSS_EXCL_NON_TAXABLE`, four bases named in §1.9.2                                       |
| 8   | s.288A rounding was stated three ways (`1000_00`, "nearest ₹10", "10_00 paise")                                                                    | One modulus: `floorToNearest(taxable_income, 1000)`                                                                         |
| 9   | `REG.slabs`, `surcharge_rules`, `rebate_87a` had no schema; `PT_expected` and `remaining_months` were undefined                                    | R-12: `tax_regime_slab`, `tax_regime_surcharge`, FY-effective columns; `fn_remaining_regular_cycles`; `PT_expected = PT`    |
| 10  | ESI's `esi_gross_at_contribution_period_start` was undefined for a mid-period joiner                                                               | Two named branches, a stored decision, no third branch                                                                      |
| 11  | `LOP_OVERRIDE` altered pay "for the calculation only", producing a payslip that contradicted the approved attendance record                        | R-15: the override is persisted on the record with `lop_source`, drifts the totals, and is refused after `inputs_locked_at` |
| 12  | The invitation token was claimed never to be stored in plaintext while being stored in a plaintext email body                                      | R-14: envelope-encrypted `template_data_ct`, destroyed on `SENT`; `token_fpr` is a keyed blind index                        |
| 13  | §8 specified a `profile_change_request` that contradicted the canonical table in states, permissions and field model                               | §8 rewritten to `DATA-MODEL.md §5.11`, with `APPROVED`/`APPLIED` separated so the stale-row guard can run between them      |
| 14  | §9.3 used `token_epoch`, omitted `PENDING_MFA`/`SUSPENDED`/`OFFBOARDED`, and disabled rather than offboarded exiting staff                         | §9.3 rewritten to `DATA-MODEL.md §5.1.1`; `token_version`; USR-11 terminal                                                  |
| 15  | SLA pause added wall-clock seconds to a business-hours deadline                                                                                    | `addWorkingHours` applied to the pause too; `sla_paused_seconds` accumulates business time only                             |
| 16  | `sla_*_breached` generated columns were used to answer "is this late now?", which they cannot                                                      | R-16: `v_helpdesk_ticket_sla` view + a partial index                                                                        |
| 17  | The policy reminder ladder used exact-day equalities, so one missed job run skipped a rung forever                                                 | `<=` thresholds + dedupe                                                                                                    |
| 18  | Directive 8's mandated address was a mutable default with no guarantee                                                                             | Seeded `NOT NULL`, always unioned into `to_addresses`, asserted in CI and in an integration test                            |
| 19  | `leave.sufficient_balance` and the reservation table used `total_days`, deducting entitlement for unpaid leave                                     | `balance_days` throughout; LV-INV-10                                                                                        |
| 20  | A leave could be approved into a submitted or locked period, silently contradicting the payslip                                                    | `leave.attendance_period_open` + `attendance.no_open_leave_in_period`; LV-INV-11                                            |
| 21  | `expense.spend_within_claim_window` was a hard `422` here and a soft flag in the catalogue                                                         | Soft flag, per the canonical entry; `escalation_amount_minor` skip-level routing added                                      |
| 22  | An employee could acknowledge a policy body they were never served                                                                                 | `policy.version_was_read`; POL-INV-9                                                                                        |
| 23  | `ATT-11` was cited three times and never existed                                                                                                   | All three now cite AAP-4                                                                                                    |
| 24  | Eighteen registered guards were referenced by no transition, which fails the guard-registry closure rule                                           | Each attached in §11.4                                                                                                      |
| 25  | Tax, Benefits, Announcements, Directory, Search, Approvals and payslip delivery had no workflow section, though the prototype defines all of them  | §§12–17, plus the coverage map in §0.12                                                                                     |
| 26  | RBAC, step-up authentication, rate limiting and the `ui_copy` rule were asserted as principles with no per-route specification                     | §§0.8–0.10                                                                                                                  |
| 27  | Fifteen jobs and a long-running payroll worker were specified with no statement of where they run                                                  | §0.11                                                                                                                       |
| 28  | `pg_advisory_lock` (session-scoped) was used where a rollback must release the lock                                                                | `pg_advisory_xact_lock` in §1.7 and §11.2                                                                                   |
| 29  | `metadata.event_code` contradicted the canonical `audit_event.event_code` column                                                                   | §0.1/§0.3 corrected; the code set is closed and CI-reconciled                                                               |
| 30  | The regime comparison, the ticket number and the "1 working day" SLA text were rendered client-side in the prototype and had no server-side source | §1.9.6 (counterfactual projection row), §6.3 (`ticket_no` read back), §0.10 (`ui_copy`)                                     |
