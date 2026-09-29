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

| Column      | Meaning                                                                    |
| ----------- | -------------------------------------------------------------------------- |
| `#`         | Stable transition number, referenced elsewhere as e.g. `PAY-13`            |
| `from → to` | `NULL` as `from` means the creation transition                             |
| `Trigger`   | The API route or job that performs it                                      |
| `Actor`     | Persona + permission code + **scope** (`self` / `team` / `any` / `system`) |
| `Guards`    | Guard keys from `DATA-MODEL.md §19.3` (extensions defined in §0.6)         |
| `Effects`   | Every other row written in the same transaction                            |
| `Audit`     | `audit_event.event_code` (a column, FK to the seeded `audit_event_code` catalogue)                         |
| `Notify`    | `ess_notification_kind` → recipient set / `ess_email_kind` → address set   |

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
`DATA-MODEL.md §20.16`; §12.6 of this document maps each **workflow state** to the key that
catalogue expects, so the two cannot drift. A screen with no matching catalogue key is a
specification bug, not an implementer's choice.

### 0.6 Schema addenda — reconciliation record

**Status: absorbed.** `A-1`…`A-6` and `R-1`…`R-4` below were additions this document
demanded of `DATA-MODEL.md`. They now exist there, at the sections named in the table, and
`DATA-MODEL.md §22` records the same reconciliation from the other side. They are retained
here in full because the *behaviour* sections below reference their columns, and because a
reader must be able to see why each column exists without leaving this file. **Where the
text below and `DATA-MODEL.md` differ in a name, `DATA-MODEL.md` wins.**

| Addendum | Landed in `DATA-MODEL.md` |
|---|---|
| A-1 `payroll_cycle_employee` | §10.10 |
| A-2 `payroll_cycle.cycle_kind`, `parent_payroll_cycle_id`; R-1 partial unique index | §10.1 |
| A-3 `payroll_correction`, `payroll_run.run_kind` | §10.11, §10.6 |
| A-4 `statutory_rate_set`, `statutory_pt_slab`, `employee_statutory_election` | §10.12 |
| A-5 `profile_change_request` (+ `_field`) | §5.11 — **with a different state set and permission set; §8 of this document has been corrected to match** |
| A-6 `user_invitation` | §6.5.1 |
| R-2 `attendance.every_slice_approved` | §9.5 |
| R-3 help-desk SLA pause fields | §16.4 |
| R-4 `trg_payslip_requires_calculating` | §10.7 |

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

---

## 1. PAYROLL — the mandated workflow

> **Accounts uploads payroll data → HR submits employee attendance → the respective
> Manager reviews/approves attendance → the system validates required payroll inputs →
> automatic payroll/payslip generation → the payslip becomes visible to the employee.**

The order is enforced by `payroll_cycle.status` and by nothing else. Every step is a
transition in the table of §1.3; there is no route, no job and no SQL path that reaches a
later step without passing through the earlier ones.

### 1.1 Actors and separation of duties

| Step                      | Persona                       | Permission                | Why not someone else                                                                                                      |
| ------------------------- | ----------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Open the cycle            | ACCOUNTS                      | `payroll:cycle:create`    | HR holds no `payroll:*` write permission                                                                                  |
| Upload payroll data       | ACCOUNTS                      | `payroll:input:upload`    | —                                                                                                                         |
| Commit inputs / lock      | ACCOUNTS                      | `payroll:input:commit`    | —                                                                                                                         |
| Capture attendance        | HR                            | `attendance:capture`      | ACCOUNTS holds **no** `attendance:submit`/`approve` — the payroll operator cannot manufacture their own attendance inputs |
| Submit attendance         | HR                            | `attendance:submit`       | —                                                                                                                         |
| Approve a team slice      | MANAGER                       | `attendance:approve:team` | Scope-bounded by `employee_reporting_closure`                                                                             |
| Escalate an overdue slice | HR                            | `attendance:approve:any`  | Only after `due_at`, with a mandatory reason                                                                              |
| Validate                  | ACCOUNTS                      | `payroll:validate`        | —                                                                                                                         |
| Calculate                 | ACCOUNTS                      | `payroll:calculate`       | —                                                                                                                         |
| Approve the run           | ACCOUNTS (**different user**) | `payroll:approve`         | `payroll.distinct_approver`                                                                                               |
| Publish                   | ACCOUNTS (**different user**) | `payroll:publish`         | `payroll.distinct_approver`                                                                                               |
| Close                     | ACCOUNTS                      | `payroll:close`           | —                                                                                                                         |

Dual control: `approved_by_user_id <> calculated_by_user_id` is both a guard and a
database `CHECK`. Two distinct Accounts users are structurally required to publish.

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

| #      | from → to                                                                  | Trigger                                                             | Actor                                        | Guards                                                                                                    | Effects                                                                                                                                                                                                                                                                                                                                             | Audit                                                       | Notify                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PAY-1  | `NULL` → `DRAFT`                                                           | `POST /api/v1/payroll/cycles` or job `payroll-cycle-open`           | ACCOUNTS `payroll:cycle:create`              | `payroll.no_open_cycle_for_period`, `payroll.prior_cycle_closed`                                          | Creates the paired `attendance_period` (`OPEN`) 1:1; resolves `scheduled_pay_date` from `organization.payroll_pay_day_rule` against the holiday calendar and persists it; `cycle_kind='REGULAR'`                                                                                                                                                    | `PAYROLL.CYCLE_CREATED`                                     | —                                                                                                                                                          |
| PAY-2  | `DRAFT` → `INPUTS_OPEN`                                                    | `POST /cycles/:id/open-inputs`                                      | ACCOUNTS `payroll:cycle:transition`          | `payroll.attendance_period_open`                                                                          | `attendance_period.capture_opened_at = now()`                                                                                                                                                                                                                                                                                                       | `PAYROLL.INPUTS_OPENED`                                     | `PAYROLL_CYCLE_STATE` → all HR users ("Attendance capture for August 2026 is open")                                                                        |
| PAY-3  | `INPUTS_OPEN` → `INPUTS_LOCKED`                                            | `POST /cycles/:id/lock-inputs`                                      | ACCOUNTS `payroll:input:commit`              | `payroll.inputs_settled`, `payroll.no_uncommitted_batches`, `payroll.all_batches_validated`, `payroll.committer_not_uploader`, `payroll.dual_control_available` (R-9) | `inputs_locked_at`, `inputs_locked_by_user_id`; every `DRAFT` reimbursement batch targeting this cycle is force-closed or rolled forward (§4.5)                                                                                                                                                                                                     | `PAYROLL.INPUTS_LOCKED`                                     | `PAYROLL_CYCLE_STATE` → all HR users ("Payroll inputs are locked — attendance can now be submitted")                                                       |
| PAY-4  | `INPUTS_LOCKED` → `ATTENDANCE_SUBMITTED`                                   | `POST /attendance/periods/:id/submit` (same transaction as `ATT-2`) | HR `attendance:submit`                       | `attendance.period_is_hr_submitted`                                                                       | — (all attendance effects are in `ATT-2`/`ATT-3`)                                                                                                                                                                                                                                                                                                   | `PAYROLL.ATTENDANCE_SUBMITTED`                              | `ATTENDANCE_APPROVAL_PENDING` → every manager with a slice                                                                                                 |
| PAY-5  | `ATTENDANCE_SUBMITTED` → `ATTENDANCE_APPROVED`                             | System, evaluated after every `attendance_approval` decision        | _system_                                     | `attendance.every_slice_approved` (R-2)                                                                   | `attendance_period.status = 'APPROVED'`, `approvals_completed_at = now()`                                                                                                                                                                                                                                                                           | `PAYROLL.ATTENDANCE_APPROVED`                               | `PAYROLL_CYCLE_STATE` → all ACCOUNTS users ("Attendance for August 2026 is fully approved — payroll can be validated")                                     |
| PAY-6  | `ATTENDANCE_SUBMITTED` → `INPUTS_LOCKED`                                   | `POST /attendance/periods/:id/reopen`                               | HR `attendance:reopen`                       | `attendance.any_slice_rejected`, `approval.note_required`                                                 | `attendance_period` → `OPEN`; rejected records → `DRAFT`; the live `attendance_submission` keeps its row and is superseded on resubmit                                                                                                                                                                                                              | `PAYROLL.ATTENDANCE_RETURNED`                               | `PAYROLL_CYCLE_STATE` → HR + the rejecting manager                                                                                                         |
| PAY-7  | `ATTENDANCE_APPROVED` → `VALIDATING`                                       | `POST /cycles/:id/validate`                                         | ACCOUNTS `payroll:validate`                  | `payroll.attendance_locked`                                                                               | `attendance_period` → `LOCKED`; every `attendance_record` → `LOCKED`; every approved `leave_request` overlapping the period gets `attendance_record_id` set (freezes it against withdrawal); `validation_pass_no += 1`; the scope snapshot (A-1) is written                                                                                         | `PAYROLL.VALIDATION_STARTED`                                | —                                                                                                                                                          |
| PAY-8  | `VALIDATING` → `VALIDATED`                                                 | System, at the end of the validation pass                           | _system_                                     | `payroll.no_error_validations`                                                                            | `validated_at = now()`; `employee_count = count(payroll_cycle_employee WHERE disposition='INCLUDED')`                                                                                                                                                                                                                                               | `PAYROLL.VALIDATED`                                         | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                                                           |
| PAY-9  | `VALIDATING` → `VALIDATION_FAILED`                                         | System                                                              | _system_                                     | `payroll.has_error_validations`                                                                           | Findings persist in `payroll_validation_result` for this `validation_pass_no`                                                                                                                                                                                                                                                                       | `PAYROLL.VALIDATION_FAILED`                                 | `PAYROLL_CYCLE_STATE` → ACCOUNTS **and** HR for each finding whose remedy is an HR action (see §1.5 "Owner" column)                                        |
| PAY-10 | `VALIDATION_FAILED` → `INPUTS_OPEN`                                        | `POST /cycles/:id/reopen-inputs`                                    | ACCOUNTS `payroll:cycle:transition`          | `approval.note_required`                                                                                  | Unlocks input batches for supersession; `inputs_locked_at = NULL`; attendance stays `LOCKED` unless separately reopened (`ATT-8`)                                                                                                                                                                                                                   | `PAYROLL.INPUTS_REOPENED`                                   | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR                                                                                                                      |
| PAY-11 | `VALIDATION_FAILED` → `VALIDATING`                                         | `POST /cycles/:id/validate`                                         | ACCOUNTS `payroll:validate`                  | —                                                                                                         | `validation_pass_no += 1`; a new scope snapshot replaces the previous pass's rows                                                                                                                                                                                                                                                                   | `PAYROLL.REVALIDATION_STARTED`                              | —                                                                                                                                                          |
| PAY-12 | `VALIDATED` → `CALCULATING`                                                | `POST /cycles/:id/calculate`                                        | ACCOUNTS `payroll:calculate` | `payroll.validated_recently`, `payroll.employee_set_unchanged`, `payroll.no_lop_override_after_lock` | Creates `payroll_run` (`run_no = max+1`, `status='QUEUED'`, `engine_version`, `ruleset_sha256`, `input_manifest_sha256`); `calculated_by_user_id` recorded                                                                                                                                                                                          | `PAYROLL.CALCULATION_STARTED`                               | —                                                                                                                                                          |
| PAY-13 | `CALCULATING` → `CALCULATED`                                               | System, on run completion                                           | _system_                                     | `payroll.run_succeeded`, `payroll.payslip_count_matches_employee_count`, `payroll.controls_balance`       | `payslip_count`, `control_gross_minor`, `control_net_minor` write-once; `calculated_at`; `payroll_cycle_employee.payslip_id` backfilled; `employee_tax_projection` rows written with `is_current` flipped                                                                                                                                           | `PAYROLL.CALCULATED`                                        | `PAYROLL_CYCLE_STATE` → ACCOUNTS ("August 2026 payroll calculated — 214 payslips awaiting approval")                                                       |
| PAY-14 | `CALCULATING` → `VALIDATION_FAILED`                                        | System, on run failure                                              | _system_                                     | `payroll.run_failed`                                                                                      | `payroll_run.status='FAILED'` + `error_message`; **every payslip produced by that run is deleted inside the same transaction that failed** (the run is atomic — see §1.10.1)                                                                                                                                                                        | `PAYROLL.CALCULATION_FAILED`                                | `PAYROLL_CYCLE_STATE` → ACCOUNTS, tone RED                                                                                                                 |
| PAY-15 | `CALCULATED` → `APPROVED`                                                  | `POST /cycles/:id/approve`                                          | ACCOUNTS `payroll:approve` (**a second Accounts user**) | `payroll.distinct_approver`, `payroll.controls_balance` | `approved_at`, `approved_by_user_id`                                                                                                                                                                                                                                                                                                                | `PAYROLL.RUN_APPROVED`                                      | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                                                           |
| PAY-16 | `CALCULATED` → `VALIDATED`                                                 | `POST /cycles/:id/discard-run`                                      | ACCOUNTS `payroll:cycle:transition`          | `approval.note_required`, `payroll.no_published_payslips`                                                 | Live `payroll_run` → `SUPERSEDED`; every payslip of that run → `SUPERSEDED`; `payslip_count`/controls reset to `NULL`; `payroll_cycle_employee.payslip_id = NULL`                                                                                                                                                                                   | `PAYROLL.RUN_DISCARDED`                                     | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                                                           |
| PAY-17 | `APPROVED` → `PUBLISHED`                                                   | `POST /cycles/:id/publish`                                          | ACCOUNTS `payroll:publish` (**a third Accounts user**) | `payroll.distinct_publisher` (R-8), `payroll.every_payslip_generated`, `payroll.pay_date_set`, `payroll.no_published_payslips`, `payslip.publication_row_created` — **step-up MFA required** (§0.9) | For each payslip: `status='PUBLISHED'`, one `payslip_publication` row, PDF render job enqueued, `payslip_fy_rollup` folded, `tds_quarter` recomputed, `employee_tax_regime_election.is_locked=true` **for each employee in this run** whose FY election is not yet locked (per employee, not per organisation — a January joiner must still be able to elect); linked `reimbursement_batch` → `PAID` and its claims → `REIMBURSED`; `actual_pay_date` frozen | `PAYROLL.PUBLISHED` (+ one `PAYSLIP.PUBLISHED` per payslip) | `PAYSLIP_PUBLISHED` → every employee in the run; `PAYSLIP_PUBLISHED` email → each employee's work email (notification only, **never** an attached payslip) |
| PAY-18 | `PUBLISHED` → `CLOSED`                                                     | `POST /cycles/:id/close`                                            | ACCOUNTS `payroll:close`                     | `payroll.pay_date_passed`, `payroll.reimbursements_settled`                                               | `closed_at`; the period is now immutable; the next period's cycle may be created                                                                                                                                                                                                                                                                    | `PAYROLL.CLOSED`                                            | —                                                                                                                                                          |
| PAY-19 | `DRAFT`\|`INPUTS_OPEN`\|`INPUTS_LOCKED`\|`ATTENDANCE_SUBMITTED`\|`ATTENDANCE_APPROVED`\|`VALIDATED`\|`VALIDATION_FAILED` → `CANCELLED` (R-6) | `POST /cycles/:id/cancel`                                           | ACCOUNTS `payroll:cycle:transition`          | `payroll.no_payslips_exist`, `approval.note_required`                                                     | `cancelled_at`, `cancel_reason`; paired `attendance_period` → `REOPENED` then `OPEN` (it is reusable by a replacement cycle); every input batch → `DISCARDED`; every linked reimbursement batch → back to `LOCKED` and re-targeted                                                                                                                  | `PAYROLL.CANCELLED`                                         | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR, tone RED                                                                                                            |

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

| Rule code                     | Severity | Owner    | Predicate (fails when…)                                                                                              | Disposition on failure                                                                                                                                            |
| ----------------------------- | -------- | -------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAY_NO_SALARY_STRUCTURE`     | ERROR    | ACCOUNTS | No `salary_structure` row whose `[effective_from, effective_to]` covers `period_end`                                 | **Blocking** until resolved or the employee is explicitly `DEFERRED`                                                                                              |
| `PAY_STRUCTURE_ZERO_BASIC`    | ERROR    | ACCOUNTS | The resolved structure has no `BASIC` component, or its amount is ≤ 0                                                | Blocking / deferrable                                                                                                                                             |
| `PAY_CTC_MISSING`             | WARNING  | ACCOUNTS | `annual_ctc_minor` absent — only benefits of kind `MULTIPLE_OF_CTC` are affected                                     | Informational; the benefit line is omitted, never guessed                                                                                                         |
| `PAY_ATTENDANCE_MISSING`      | ERROR    | HR       | No `attendance_record` for `(period, employee)`                                                                      | **Blocking** — never deferrable: a missing record means the mandated HR/Manager steps did not happen for this person                                              |
| `PAY_ATTENDANCE_NOT_APPROVED` | ERROR    | MANAGER  | The employee's `attendance_record.status <> 'LOCKED'`, or its slice is not `APPROVED`/`AUTO_ESCALATED`               | **Blocking**, not deferrable — same reason                                                                                                                        |
| `PAY_LOP_EXCEEDS_ELIGIBLE`    | ERROR    | HR       | `lop_days > eligible_days` (also a DB `CHECK`; a finding here means data drift)                                      | Blocking                                                                                                                                                          |
| `ATT_TOTALS_DRIFT`            | ERROR    | HR       | Σ `payable_days`/`lop_days` over locked records ≠ the control totals on the live `attendance_submission`             | Blocking, cycle-level                                                                                                                                             |
| `PAY_BANK_UNVERIFIED`         | ERROR    | HR       | No current `employee_bank_account` with `is_primary AND is_verified AND effective_to IS NULL`                        | **Deferrable** (see disposition rule below)                                                                                                                       |
| `PAY_TDS_MISSING_PAN`         | ERROR    | HR       | No `employee_statutory_id` of kind `PAN` (required to deduct TDS at the normal rate rather than 20 % u/s 206AA)      | **Deferrable**; if the employee is retained, TDS is computed at the higher-rate fallback and the finding is recorded as _accepted_, never silently ignored        |
| `PAY_UAN_MISSING`             | WARNING  | HR       | `pf_applicable` and no `UAN`/`PF_ACCOUNT` statutory id                                                               | Informational; PF is still computed and remitted against the employee number                                                                                      |
| `PAY_ESI_ID_MISSING`          | WARNING  | HR       | ESI applies this contribution period and no `ESI` statutory id exists                                                | Informational                                                                                                                                                     |
| `PAY_NO_TAX_REGIME_ELECTION`  | WARNING  | ACCOUNTS | No `employee_tax_regime_election` for the FY                                                                         | Resolved deterministically by falling back to `tax_regime.is_default`; the fallback is **recorded on the payslip's `input_snapshot`** as `regimeSource:"DEFAULT"` |
| `PAY_PT_STATE_UNMAPPED`       | ERROR    | ACCOUNTS | The employee's work-location state has no `statutory_pt_slab` effective for the period                               | **Blocking** (cycle-level if it affects a whole location) — deducting the wrong professional tax is a statutory breach                                            |
| `PAY_INPUT_ORPHAN_EMPLOYEE`   | ERROR    | ACCOUNTS | A committed `payroll_input_item` names an employee not in scope                                                      | Blocking — the upload is wrong, not the employee                                                                                                                  |
| `PAY_DUPLICATE_INPUT`         | ERROR    | ACCOUNTS | Two committed, non-rejected items for the same `(employee, pay_component, kind)` where the component is not additive | Blocking                                                                                                                                                          |
| `PAY_ARREAR_PERIOD_UNKNOWN`   | ERROR    | ACCOUNTS | `kind='ARREAR'` with `effective_period_code` absent or naming a cycle that never published                           | Blocking                                                                                                                                                          |
| `PAY_REIMBURSEMENT_ORPHAN`    | ERROR    | ACCOUNTS | A `REIMBURSEMENT_PAYOUT` item whose `expense_claim` is not `QUEUED_FOR_PAYMENT`                                      | Blocking                                                                                                                                                          |
| `PAY_INPUT_UNRESOLVED_ERROR`  | ERROR    | ACCOUNTS | Any `payroll_input_item.is_rejected` in a **committed** batch                                                        | Blocking                                                                                                                                                          |
| `PAY_NEGATIVE_NET`            | ERROR    | ACCOUNTS | Dry-run net pay < 0 (recoveries exceed earnings)                                                                     | **Deferrable**; the usual remedy is to move the recovery to a later cycle                                                                                         |
| `PAY_GROSS_DEVIATION`         | WARNING  | ACCOUNTS | Dry-run gross deviates > 25 % from the employee's last published gross                                               | Informational — a reviewer's prompt, never a block                                                                                                                |
| `PAY_CONTROL_TOTAL_MISMATCH`  | ERROR    | ACCOUNTS | Σ committed input amounts ≠ Σ `payroll_input_batch.parsed_total_minor`                                               | Blocking, cycle-level                                                                                                                                             |
| `PAY_EXITED_EMPLOYEE_NO_FNF`  | WARNING  | HR       | An in-scope employee exited in-period with no final-settlement input items                                           | Informational                                                                                                                                                     |

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
  control the user mandated. They must be fixed (`ATT-8` reopen → capture → submit →
  approve).
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
| `now() > due_at + org escalation window`       | The slice appears in HR's escalation queue; HR may act under `attendance:approve:any` (`ATT-11`)                                                                                            |

The dedupe constraint `ux_notification__dedupe` makes each of these fire exactly once per
manager per period per rule code, so the bell count is exact.

### 1.7 Generation (`CALCULATING`)

The run is a single worker task holding an advisory lock on the cycle
(`pg_advisory_lock(hashtext('payroll:' || payroll_cycle_id))`) and executing in **one
database transaction**:

1. `SELECT … FROM payroll_cycle WHERE id = :cycle FOR UPDATE` — re-assert `CALCULATING`.
2. Re-assert `payroll.validated_recently`: `validated_at > now() - interval '24 hours'`
   **and** no `payroll_input_item`, `attendance_record` or `salary_structure` in the
   manifest has `updated_at > validated_at`. A failure here aborts the run as `FAILED`
   with `PAY_INPUTS_CHANGED_SINCE_VALIDATION` — never proceeds on stale validation.
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
   `gross - deductions = net` for every payslip and in aggregate.
6. Write `payroll_run.status='SUCCEEDED'`, `payslip_count`, `employee_count`.
7. Perform PAY-13 inside the same transaction.

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
`31 / 31`. A `LOP_OVERRIDE` input item, when committed, replaces `AR.lop_days` **for the
calculation only**; the override, the original and the difference are all recorded in
`input_snapshot`.

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
GROSS = Σ amount over all EARNING lines with amount ≠ 0
```

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
```

- `SE.pf_applicable = false` ⇒ no PF lines at all.
- The ceiling rule is a **per-employee election** (`CEILING` vs `ACTUAL`), never a global
  assumption, because both are lawful and the choice materially changes net pay.
- `PF_EE` and `VPF` are `DEDUCTION` lines; `PF_ER` and `PF_EPS` are
  `EMPLOYER_CONTRIBUTION` lines (they render in the payslip's employer column and feed
  the "PF contributed · employee + employer" YTD tile, which is
  `payslip_fy_rollup.employee_pf_minor + employer_pf_minor` — **not** `PF_EE × 2`).
- `rate_applied` and `basis_amount_minor` are stored on each line, so the line is
  independently reproducible.

#### 1.9.4 Employees' State Insurance

```
esi_gross = Σ EARNING lines where pay_component.is_esi_wage        -- excludes reimbursements & annual LTA
applicable_this_period =
    SE.esi_applicable_override
      ?? ( esi_gross_at_contribution_period_start <= SR.esi_wage_threshold_minor )

ESI_EE = roundUpToRupee(esi_gross × SR.esi_employee_rate)           -- 0.007500, statutory round-UP
ESI_ER = roundUpToRupee(esi_gross × SR.esi_employer_rate)           -- 0.032500
```

**Contribution-period freeze.** ESI applicability is decided once per contribution period
(`SR.esi_contribution_period_start_months`, default April and October) and held for the
whole period, even if wages cross the threshold mid-period. The decision, the wage it was
based on and the period boundaries are stored in `input_snapshot.esi`. Employees above the
threshold at the period start produce **no** ESI lines and the profile screen shows
`ESI — Not applicable`, which is a persisted derivation, not a placeholder.

#### 1.9.5 Professional tax

```
pt_wage  = GROSS (as defined by the state's rule; stored per slab set as pt_basis)
slab     = the statutory_pt_slab row for (state, period) where
           pt_wage >= from_monthly_wage_minor
           AND (to_monthly_wage_minor IS NULL OR pt_wage <= to_monthly_wage_minor)
PT       = (month(AP.end_date) = ANY slab.applies_in_months) ? slab.monthly_amount_minor : 0
```

Capped by `slab.annual_cap_minor` against the FY's PT already deducted (`YTD.pt`). PT is
a flat slab amount in whole rupees; it is never prorated by LOP (no state prorates it) and
never interpolated. No slab match with a mapped state is impossible by construction (the
top slab is open-ended); an unmapped state is the blocking validation
`PAY_PT_STATE_UNMAPPED`.

#### 1.9.6 TDS — projected annual income under the elected regime

```
S1  annual_taxable_projection =
      YTD.taxable_gross                                         -- published payslips, this FY
    + current_period_taxable_gross                              -- Σ EARNING lines where is_taxable
    + remaining_months × recurring_monthly_taxable               -- recurring = PRORATED_FIXED/FIXED at full value
    + Σ known future one-off taxable inputs already committed for later cycles
      (kind IN ('BONUS','INCENTIVE','VARIABLE_PAY') with effective_period_code > current)

    remaining_months = number of REGULAR payroll cycles remaining in the FY after this one,
                       counted from fiscal_year (a persisted count, never "12 - month")

S2  - standard_deduction                = REG.standard_deduction_minor
S3  - professional_tax_for_fy           = YTD.pt + PT + (remaining_months × PT_expected)   [old regime only]
S4  - chapter_via_deductions            = Σ DEC allowed items, capped per section,
                                          0 when REG.allows_chapter_via_deductions = false
S5  taxable_income = max(0, S1 - S2 - S3 - S4)
S6  taxable_income_rounded = floorToNearest(taxable_income, 1000_00)      -- s.288A: nearest ₹10;
                                                                          -- Widedrop rounds down to ₹10 → 10_00 paise
S7  tax = Σ over REG.slabs of  (overlap of taxable_income_rounded with [from,to]) × rate
S8  - rebate_87a  if taxable_income_rounded <= REG.rebate_87a_limit_minor  → tax = max(0, tax - rebate)
S9  + surcharge   per REG.surcharge_rules (with marginal relief), roundHalfUpToRupee
S10 + cess        = roundHalfUpToRupee((tax + surcharge) × REG.cess_rate)     -- 0.040000
S11 projected_annual_tax = tax + surcharge + cess
S12 TDS_this_month =
      is_last_cycle_of_fy
        ? max(0, projected_annual_tax - YTD.tds)
        : roundHalfUpToRupee( (projected_annual_tax - YTD.tds) / remaining_cycles_including_this )
    clamped to >= 0 and to <= (GROSS - other_deductions)  -- TDS never drives net below zero
```

- No PAN (`PAY_TDS_MISSING_PAN` accepted) ⇒ the higher-of rule of s.206AA applies:
  `TDS_this_month = max(computed, roundHalfUpToRupee(current_period_taxable_gross × 0.20))`.
  The fact and the rate are recorded in `input_snapshot.tds.s206aaApplied`.
- A committed `TDS_OVERRIDE` input item replaces S12 entirely; the computed value, the
  override and the authorising `payroll_input_item.id` are all recorded in
  `input_snapshot`.
- The regime is the employee's **election**; where none exists the default regime is used
  and `regimeSource:'DEFAULT'` is recorded. The election locks
  (`employee_tax_regime_election.is_locked`) at the FY's first publication, so mid-year
  switching cannot retroactively change published payslips.
- Everything S1–S12 is persisted to `employee_tax_projection` (one row per employee per
  run) — the Tax screen reads that row and computes nothing.

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

Because `NET` is an integer subtraction of integer sums, `GROSS - TOTAL_DEDUCTIONS = NET`
holds exactly for every payslip and therefore in aggregate — which is what
`payroll.controls_balance` asserts at PAY-13 and re-asserts at PAY-15.

#### 1.9.8 Traceability: the input hash

```
input_snapshot = {
  engineVersion, rulesetSha256, payrollRunId, periodCode,
  attendance: { recordId, calendarDays, eligibleDays, presentDays, paidLeaveDays,
                holidayDays, weekOffDays, absentDays, lopDays, lopOverride?, payableDays,
                approvalId, approvedByEmployeeId, approvedAt },
  structure:  { salaryStructureId, structureSha256,
                components: [{ code, calculation, amountMinor: "8600000", rate }] },
  inputs:     [{ itemId, batchId, sourceRowNo, kind, componentCode, amountMinor: "642000" }],
  statutory:  { rateSetId, pfWageBasis, pfWageMinor, ceilingMinor, esi: {...}, pt: { slabId, stateCode } },
  tax:        { regimeId, regimeSource, projectionId, s206aaApplied, overrideItemId? },
  computed:   { grossMinor, totalDeductionsMinor, netMinor, lines: [{ code, kind, amountMinor }] }
}
input_sha256 = SHA-256( jsonCanonical(input_snapshot) )    -- sorted keys, no whitespace,
                                                            -- money as minor-unit STRINGS
```

`input_sha256` is stored on the payslip. The audit test "this payslip still matches its
inputs" is: re-read the referenced rows, rebuild `input_snapshot`, recompute the hash,
compare. The `payroll-integrity-verify` job runs this over a sample nightly and over the
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

| #    | from → to                         | Actor                                                                | Guards                                                                                                                                           | Effects                                                                                                                                                                                                                                                                                                                                     | Audit                                                          |
| ---- | --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| PC-1 | `NULL` → `RAISED`                 | ACCOUNTS `payroll:calculate`                                         | cycle is `PUBLISHED` or `CLOSED`; `reason_note` ≥ 20 chars; the corrective inputs exist as a committed `payroll_input_batch` on the correction   | `correction_no` from a sequence                                                                                                                                                                                                                                                                                                             | `PAYROLL.CORRECTION_RAISED`                                    |
| PC-2 | `RAISED` → `APPROVED`             | ACCOUNTS `payroll:approve` (**different user**)                      | `ck_pc_corr__dual_control`                                                                                                                       | `approved_by_user_id`, `approved_at`                                                                                                                                                                                                                                                                                                        | `PAYROLL.CORRECTION_APPROVED`                                  |
| PC-3 | `APPROVED` → `CALCULATING`        | ACCOUNTS `payroll:calculate`                                         | —                                                                                                                                                | `payroll_run` with `run_kind='CORRECTION'`, `run_no = max+1`                                                                                                                                                                                                                                                                                | `PAYROLL.CORRECTION_STARTED`                                   |
| PC-4 | `CALCULATING` → `CALCULATED`      | _system_                                                             | run succeeded; every affected employee has exactly one new `payslip` with `revision = prior.revision + 1` and `supersedes_payslip_id = prior.id` | Prior payslip → `SUPERSEDED`; prior `payslip_publication.revoked_at` set with reason                                                                                                                                                                                                                                                        | `PAYROLL.CORRECTION_CALCULATED`                                |
| PC-5 | `CALCULATED` → `PUBLISHED`        | ACCOUNTS `payroll:publish` (**different user from PC-3's operator**) | new payslips all `GENERATED`; a settlement target cycle is resolved                                                                              | New `payslip_publication` per revised payslip; `payslip_fy_rollup` refolded (old ids removed, new added); `tds_quarter` recomputed; the **net delta** posted into `settlement_cycle_id` as a `payroll_input_item` — `ARREAR` when positive, `ADVANCE_RECOVERY` when negative, `narration = 'Correction <correction_no> for <period_label>'` | `PAYROLL.CORRECTION_PUBLISHED` + `PAYSLIP.REVISED` per payslip |
| PC-6 | `RAISED`\|`APPROVED` → `REJECTED` | ACCOUNTS `payroll:approve`                                           | note required                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                           | `PAYROLL.CORRECTION_REJECTED`                                  |
| PC-7 | `CALCULATING` → `FAILED`          | _system_                                                             | —                                                                                                                                                | atomic rollback; no payslips                                                                                                                                                                                                                                                                                                                | `PAYROLL.CORRECTION_FAILED`                                    |

Notifications at PC-5: `PAYSLIP_PUBLISHED` (tone AMBER, title "Your payslip for August
2026 has been revised — revision 2") to each affected employee, plus a
`PAYSLIP_PUBLISHED` email. The employee's Payslips list shows only the live revision; the
superseded revision remains readable to `payslip:read:any` and to the audit trail.

The settlement cycle is `fn_next_open_payroll_cycle(now())` — the earliest `REGULAR`
cycle in `DRAFT`/`INPUTS_OPEN`; if none exists the correction cannot reach PC-5 and the
guard message tells the operator to open the next cycle first. The delta is never paid
outside a payroll cycle.

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
| A manager never acts                                   | `attendance-approval-reminder`                              | Escalation chain, then HR acts under `attendance:approve:any` (`ATT-11`) with a mandatory reason after `due_at`                                                                                                                                                                                                        |
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

| #     | from → to                                   | Trigger                                 | Actor                           | Guards                                                                                                              | Effects                                                                                                                                                                                                                                                                            | Audit                                | Notify                                                                                                                   |
| ----- | ------------------------------------------- | --------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| ATT-1 | `NULL` → `OPEN`                             | Same transaction as PAY-1               | ACCOUNTS `payroll:cycle:create` | `attendance.created_with_cycle` (the predecessor `attendance.cycle_exists` was circular and is withdrawn)                                                                                           | `total_calendar_days = end_date - start_date + 1`; `label` frozen; `capture_opened_at` set at PAY-2                                                                                                                                                                                | `ATTENDANCE.PERIOD_OPENED`           | —                                                                                                                        |
| ATT-2 | `OPEN` → `HR_SUBMITTED`                     | `POST /attendance/periods/:id/submit`   | HR `attendance:submit`          | `attendance.payroll_inputs_locked`, `attendance.all_active_employees_have_records`, `attendance.day_identity_holds` | One `attendance_submission` (`record_count`, `employee_count_expected`, control totals, `payload_sha256` over the canonical JSON of every submitted record); every `DRAFT` record → `SUBMITTED`; `hr_submitted_at`, `hr_submitted_by_user_id`; PAY-4 fires in the same transaction | `ATTENDANCE.SUBMITTED`               | —                                                                                                                        |
| ATT-3 | `HR_SUBMITTED` → `MANAGER_APPROVAL_PENDING` | _system_, same transaction as ATT-2     | _system_                        | `attendance.slices_created`                                                                                         | One `attendance_approval` per distinct `manager_employee_id`, each with `record_count`, control totals, `due_at = now() + org attendance SLA`; one `approval_task` (`kind='ATTENDANCE_PERIOD'`) per slice; `attendance_record.attendance_approval_id` set                          | `ATTENDANCE.SLICES_CREATED`          | `ATTENDANCE_APPROVAL_PENDING` → each manager                                                                             |
| ATT-4 | `MANAGER_APPROVAL_PENDING` → `APPROVED`     | _system_, after the last slice decision | _system_                        | `attendance.every_slice_approved` (R-2)                                                                             | `approvals_completed_at`; PAY-5 fires in the same transaction                                                                                                                                                                                                                      | `ATTENDANCE.APPROVED`                | `PAYROLL_CYCLE_STATE` → ACCOUNTS                                                                                         |
| ATT-5 | `MANAGER_APPROVAL_PENDING` → `OPEN`         | `POST /attendance/periods/:id/reopen`   | HR `attendance:reopen`          | `attendance.any_slice_rejected`, `approval.note_required`                                                           | Rejected records → `DRAFT`; the pending slices' `approval_task` rows → `WITHDRAWN`; the live `attendance_submission` keeps `superseded_by_submission_id` NULL until resubmission; PAY-6 fires                                                                                      | `ATTENDANCE.RETURNED_FOR_CORRECTION` | `PAYROLL_CYCLE_STATE` → HR; `ATTENDANCE_APPROVAL_PENDING` withdrawn from managers (notifications dismissed, not deleted) |
| ATT-6 | `APPROVED` → `LOCKED`                       | _system_, in PAY-7                      | _system_                        | `attendance.cycle_left_attendance_approved`                                                                         | Every record → `LOCKED` + `locked_at`; every approved `leave_request` overlapping the period gets `attendance_record_id` (freezing it)                                                                                                                                             | `ATTENDANCE.LOCKED`                  | —                                                                                                                        |
| ATT-7 | `APPROVED` → `REOPENED`                     | `POST /attendance/periods/:id/reopen`   | HR `attendance:reopen`          | `attendance.cycle_not_calculated`, `approval.note_required`                                                         | `reopened_at/_by/_reason`                                                                                                                                                                                                                                                          | `ATTENDANCE.REOPENED`                | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR                                                                                    |
| ATT-8 | `LOCKED` → `REOPENED`                       | `POST /attendance/periods/:id/reopen`   | HR `attendance:reopen`          | `attendance.cycle_not_published`, `approval.note_required`                                                          | As ATT-7; the cycle is driven back to `INPUTS_LOCKED` and any `CALCULATED` run is discarded first (PAY-16) — a reopen is refused while a run is live                                                                                                                               | `ATTENDANCE.REOPENED`                | `PAYROLL_CYCLE_STATE` → ACCOUNTS + HR, tone AMBER                                                                        |
| ATT-9 | `REOPENED` → `OPEN`                         | _system_, immediately                   | _system_                        | —                                                                                                                   | Records affected by the reopen → `DRAFT`; prior `attendance_submission.superseded_by_submission_id` set at the next ATT-2                                                                                                                                                          | `ATTENDANCE.CAPTURE_REOPENED`        | —                                                                                                                        |

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

| #     | from → to                    | Actor                             | Guards                                                                                                                                                            | Effects                                                                                                                                                                           | Audit                        | Notify                                                                                       |
| ----- | ---------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------- |
| AAP-1 | `NULL` → `PENDING`           | _system_ (ATT-3)                  | —                                                                                                                                                                 | `approval_task` created                                                                                                                                                           | `ATTENDANCE.SLICE_ASSIGNED`  | `ATTENDANCE_APPROVAL_PENDING` → manager                                                      |
| AAP-2 | `PENDING` → `APPROVED`       | MANAGER `attendance:approve:team` | `approval.actor_is_assigned_approver`; the slice's records still `SUBMITTED`; slice control totals still match the records (re-verified, else `ATT_TOTALS_DRIFT`) | Every record in the slice → `APPROVED`; `decided_at`, `decided_by_user_id`; `approval_task` → `APPROVED` + one `approval_decision`; then the R-2 completion check (→ ATT-4/PAY-5) | `ATTENDANCE.SLICE_APPROVED`  | —                                                                                            |
| AAP-3 | `PENDING` → `REJECTED`       | MANAGER `attendance:approve:team` | `approval.actor_is_assigned_approver`, `approval.note_required`                                                                                                   | Records → `REJECTED` with `manager_note`; `approval_task` → `REJECTED`; the period is driven to ATT-5                                                                             | `ATTENDANCE.SLICE_REJECTED`  | `PAYROLL_CYCLE_STATE` → HR ("Arjun Malhotra returned 6 attendance records for August 2026")  |
| AAP-4 | `PENDING` → `AUTO_ESCALATED` | HR `attendance:approve:any`       | `attendance.approval_overdue` (`due_at < now()`), `approval.note_required`                                                                                        | Records → `APPROVED`; `escalated_at`, `escalated_to_user_id`, `escalation_reason`, `decided_by_user_id` = the HR user; counts as decided-approving for R-2                        | `ATTENDANCE.SLICE_ESCALATED` | `ATTENDANCE_APPROVAL_PENDING` (tone AMBER) → the manager who was bypassed, and their manager |

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

| #         | Invariant                                                                                          | Enforced by                                                                                                                                              |
| --------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ATT-INV-1 | Exactly one `attendance_record` per `(period, employee)`                                           | `ux_attendance_record__period_employee`                                                                                                                  |
| ATT-INV-2 | Day counts partition eligible days on every record                                                 | `ck_ar__day_identity` + `attendance.day_identity_holds`                                                                                                  |
| ATT-INV-3 | Every submitted record belongs to exactly one slice, and the slices partition the period's records | `attendance_record.attendance_approval_id` NOT NULL after ATT-3 + a reconciliation assertion in ATT-3 (`Σ slice.record_count = submission.record_count`) |
| ATT-INV-4 | `payable_days = eligible_days - lop_days`, and `lop_days ≤ eligible_days`                          | Generated column + `ck_ar__lop_bound`                                                                                                                    |
| ATT-INV-5 | HR cannot submit before ACCOUNTS locks inputs                                                      | `attendance.payroll_inputs_locked`                                                                                                                       |
| ATT-INV-6 | A manager approves only their own slice                                                            | `approval.actor_is_assigned_approver` + `employee_reporting_closure` scope                                                                               |
| ATT-INV-7 | An `attendance_submission` is immutable except `superseded_by_submission_id`                       | `trg_immutable_attendance_submission`                                                                                                                    |
| ATT-INV-8 | Control totals at approval equal the records' sums                                                 | Re-verified in AAP-2, else `ATT_TOTALS_DRIFT`                                                                                                            |
| ATT-INV-9 | A locked period cannot be edited while a payroll run is live                                       | `attendance.cycle_not_published` + PAY-16 precondition on ATT-8                                                                                          |

### 2.7 Attendance failure paths

| Failure                                            | Compensation                                                                                                                                                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bulk upload row does not match an employee         | The row is rejected with a reason and shown in the HR upload result; no record is created or mutated. The period cannot be submitted until every active employee has a record. |
| A record fails the day identity after an edit      | The `UPDATE` is rejected by the DB `CHECK`; the UI shows which counts do not add up                                                                                            |
| Manager rejects                                    | ATT-5 → correct → resubmit (new `attendance_submission`, old superseded)                                                                                                       |
| Manager unavailable past SLA                       | AAP-4 escalation by HR, audited with a reason                                                                                                                                  |
| Slice totals drift between submission and approval | `ATT_TOTALS_DRIFT` blocks AAP-2; HR must resubmit                                                                                                                              |
| A re-org changes a manager mid-period              | Irrelevant — `manager_employee_id` is snapshotted on the record at `period.end_date`, and `attendance_approval` is keyed to that snapshot                                      |

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
| LV-4 | `PENDING_APPROVAL` → `APPROVED`  | `POST /leave-requests/:id/approve`                                      | MANAGER `leave:request:approve:team`   | `approval.actor_is_assigned_approver`, `leave.period_open`                                                                                      | §3.4 settlement (`CONSUMPTION` ledger row); `decided_at`, `decided_by_employee_id`; `approval_task` → `APPROVED` + `approval_decision`; the attendance fold (§3.7) runs if the period is still `OPEN` | `LEAVE.APPROVED`                 | `LEAVE_DECIDED` → employee; `LEAVE_DECISION` email → employee |
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

`leave_balance.pending_days` is a **soft hold** and deliberately not a ledger entry — a
reservation is not a movement of entitlement.

| Event                                         | `pending_days`  | `leave_balance_ledger`                                                                                 |
| --------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| LV-2 / LV-3 submit                            | `+= total_days` | —                                                                                                      |
| LV-4 approve                                  | `-= total_days` | one `CONSUMPTION` row, `delta_days = -total_days`, `leave_request_id` set, `effective_on = start_date` |
| LV-5 reject                                   | `-= total_days` | —                                                                                                      |
| LV-6 withdraw from pending                    | `-= total_days` | —                                                                                                      |
| LV-7 / LV-8 withdraw or cancel after approval | —               | one `CONSUMPTION_REVERSAL` row, `delta_days = +total_days`, `source_ledger_id` = the consumption row   |

`leave_balance` is recomputed by `fn_refresh_leave_balance(employee, type, period)` in the
**same transaction** as every ledger insert, and re-verified nightly by
`leave-balance-verify`; a mismatch raises P1 and writes an `audit_event`.

`leave.sufficient_balance` is `available_days - pending_days >= total_days` unless
`leave_type.allows_negative_balance`. Because `pending_days` is included, two concurrent
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

`payable_days = eligible_days - lop_days` then flows into §1.9.1 as the proration
numerator. At ATT-6 (period `LOCKED`) every contributing `leave_request` gets
`attendance_record_id` set, after which `leave.not_yet_locked_by_attendance` fails and the
request can no longer be withdrawn or cancelled — a leave that has been paid cannot be
retracted without a payroll correction.

### 3.8 Leave invariants

| #        | Invariant                                                                       | Enforced by                                                           |
| -------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| LV-INV-1 | `total_days` is always server-computed from `leave_request_day`                 | Trigger; direct assignment raises                                     |
| LV-INV-2 | No employee has two live requests covering the same date                        | `ex_leave_request__no_self_overlap`                                   |
| LV-INV-3 | `available_days` equals the ledger fold, always                                 | `fn_refresh_leave_balance` in-transaction + nightly verify            |
| LV-INV-4 | Exactly one `CONSUMPTION` and at most one `CONSUMPTION_REVERSAL` per request    | `ux_llg__one_consumption_per_request`                                 |
| LV-INV-5 | `pending_days >= 0` and never counts a decided request                          | `ck_leave_balance__pending` + settlement in every terminal transition |
| LV-INV-6 | The approver is the snapshotted `approver_employee_id`, not the current manager | `approver_employee_id` + `approval.actor_is_assigned_approver`        |
| LV-INV-7 | A manager never approves their own leave                                        | `ck_at__not_self` on `approval_task` + ancestor/HRBP routing          |
| LV-INV-8 | An approved leave folded into a locked attendance period cannot be withdrawn    | `leave.not_yet_locked_by_attendance`                                  |
| LV-INV-9 | The ledger is append-only                                                       | `trg_append_only_leave_ledger`                                        |

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

| #      | from → to                                    | Trigger                                                            | Actor                                    | Guards                                                                                                                                          | Effects                                                                                                                                                       | Audit                       | Notify                                                                               |
| ------ | -------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ |
| EXP-1  | `NULL` → `DRAFT`                             | `POST /expense-claims`                                             | EMPLOYEE `expense:claim:create:self`     | `expense.self_only`                                                                                                                             | Lines created; `reference_no` from the sequence                                                                                                               | `EXPENSE.DRAFTED`           | —                                                                                    |
| EXP-2  | `DRAFT` → `SUBMITTED`                        | `POST /expense-claims/:id/submit` (the prototype's "Submit claim") | EMPLOYEE `expense:claim:create:self`     | `expense.has_lines`, `expense.receipt_if_required`, `expense.within_hard_limits`, `expense.manager_exists`, `expense.spend_within_claim_window` | `submitted_at`; `expense_fy_rollup` refreshed                                                                                                                 | `EXPENSE.SUBMITTED`         | —                                                                                    |
| EXP-3  | `SUBMITTED` → `PENDING_MANAGER`              | _system_, same transaction                                         | _system_                                 | `expense.approval_task_created`                                                                                                                 | `approval_task` (`kind='EXPENSE_CLAIM'`, `amount_minor`, title/subtitle composed server-side)                                                                 | `EXPENSE.ROUTED_TO_MANAGER` | `EXPENSE_SUBMITTED` → manager                                                        |
| EXP-4  | `PENDING_MANAGER` → `MANAGER_APPROVED`       | `POST /expense-claims/:id/manager-approve`                         | MANAGER `expense:claim:approve:team`     | `approval.actor_is_assigned_approver`                                                                                                           | `manager_decided_at`, `manager_decided_by_employee_id`; optional `approved_amount_minor` (partial approval) recorded on `approval_decision`; rollup refreshed | `EXPENSE.MANAGER_APPROVED`  | `EXPENSE_DECIDED` → employee; `EXPENSE_DECISION` email                               |
| EXP-5  | `PENDING_MANAGER` → `MANAGER_REJECTED`       | `POST /expense-claims/:id/manager-reject`                          | MANAGER `expense:claim:approve:team`     | `approval.actor_is_assigned_approver`, `approval.note_required`                                                                                 | `decision_note` (renders as the claim row's "Use the L&D budget flow" style note)                                                                             | `EXPENSE.MANAGER_REJECTED`  | `EXPENSE_DECIDED`; `EXPENSE_DECISION` email                                          |
| EXP-6  | `MANAGER_APPROVED` → `PENDING_FINANCE`       | _system_                                                           | _system_                                 | `expense.category_requires_finance`                                                                                                             | `approval_task` for the ACCOUNTS queue (assignee resolved from `ticket_category`-style routing: the Accounts role's members)                                  | `EXPENSE.ROUTED_TO_FINANCE` | —                                                                                    |
| EXP-7  | `MANAGER_APPROVED` → `QUEUED_FOR_PAYMENT`    | _system_                                                           | _system_                                 | `expense.category_skips_finance`                                                                                                                | §4.6 batch assignment                                                                                                                                         | `EXPENSE.QUEUED`            | —                                                                                    |
| EXP-8  | `PENDING_FINANCE` → `FINANCE_APPROVED`       | `POST /expense-claims/:id/finance-approve`                         | ACCOUNTS `expense:claim:approve:finance` | receipts `CLEAN`; amount within `expense_limit` for the period                                                                                  | `finance_decided_at`, `finance_settled_at = now()`                                                                                                            | `EXPENSE.FINANCE_APPROVED`  | `EXPENSE_DECIDED` → employee                                                         |
| EXP-9  | `PENDING_FINANCE` → `FINANCE_REJECTED`       | `POST /expense-claims/:id/finance-reject`                          | ACCOUNTS `expense:claim:approve:finance` | `approval.note_required`                                                                                                                        | `decision_note`                                                                                                                                               | `EXPENSE.FINANCE_REJECTED`  | `EXPENSE_DECIDED`; `EXPENSE_DECISION` email                                          |
| EXP-10 | `FINANCE_APPROVED` → `QUEUED_FOR_PAYMENT`    | `POST /reimbursement-batches/:id/add` or the auto-batcher          | ACCOUNTS `expense:reimburse`             | `reimb.batch_open`                                                                                                                              | `reimbursement_batch_item` created; §4.6                                                                                                                      | `EXPENSE.QUEUED`            | —                                                                                    |
| EXP-11 | `QUEUED_FOR_PAYMENT` → `REIMBURSED`          | _system_, at PAY-17                                                | _system_                                 | `reimb.cycle_published`                                                                                                                         | `reimbursement_batch` → `PAID`, `paid_at`; the claim's `paid_payroll_cycle_id` set; rollup refreshed                                                          | `EXPENSE.REIMBURSED`        | `EXPENSE_REIMBURSED` → employee ("EXP-2210 reimbursed with your August 2026 salary") |
| EXP-12 | `DRAFT` → `CANCELLED`                        | `DELETE /expense-claims/:id`                                       | EMPLOYEE `expense:claim:withdraw:self`   | `expense.self_only`                                                                                                                             | Lines cascade-deleted; attachments retained as orphaned `file_object` rows until the retention purge                                                          | `EXPENSE.DISCARDED`         | —                                                                                    |
| EXP-13 | `SUBMITTED`\|`PENDING_MANAGER` → `WITHDRAWN` | `POST /expense-claims/:id/withdraw`                                | EMPLOYEE `expense:claim:withdraw:self`   | `expense.self_only`, `expense.not_yet_decided`                                                                                                  | `approval_task` → `WITHDRAWN`; rollup refreshed                                                                                                               | `EXPENSE.WITHDRAWN`         | —                                                                                    |

### 4.3 Category caps

Caps live in `expense_limit` (`expense_limit_basis` ∈ `PER_CLAIM`, `PER_LINE`, `PER_DAY`,
`PER_MONTH`, `PER_FY`), each with `limit_amount_minor` and `is_hard_limit`.

- **Hard limit** (`is_hard_limit = true`) — `expense.within_hard_limits` fails at EXP-2 with
  a `422` naming the category, the cap and the overage, all read from `expense_limit`.
  The prototype's "Internet bill, August · Within ₹1,500 cap" subtitle is
  `expense_limit.limit_amount_minor` for `REMOTE_WORK` / `PER_MONTH`, never a literal.
- **Soft limit** — the claim submits, and the `approval_task.subtitle` carries the overage
  so the manager decides with the fact in front of them.
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

| Failure                                         | Compensation                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt still scanning                          | `422`; the claim stays `DRAFT`, nothing is lost                                                                                                                           |
| Receipt infected                                | Attachment removed, employee notified, `SECURITY_ALERT` to HR, claim stays `DRAFT`                                                                                        |
| Claim outside the 30-day window                 | `422` from `expense.spend_within_claim_window`; HR/Accounts may raise it on the employee's behalf with an audited note                                                    |
| Manager rejects                                 | Terminal `MANAGER_REJECTED`; the employee raises a **new** claim — a rejected claim is never re-opened, so the audit trail stays honest                                   |
| Finance rejects after manager approval          | Terminal `FINANCE_REJECTED`; employee and manager both notified                                                                                                           |
| Batch missed the cycle                          | §4.5 roll-forward, audited and notified                                                                                                                                   |
| Payroll cycle cancelled after `SENT_TO_PAYROLL` | PAY-19 returns the batch to `LOCKED`, deletes its `REIMBURSEMENT_PAYOUT` input items, and re-targets; claims stay `QUEUED_FOR_PAYMENT` and are never silently marked paid |
| Partial approval                                | `approval_decision.approved_amount_minor` is recorded and becomes the payable amount; the difference is visible to the employee with the manager's note                   |

---

## 5. POLICY

Two machines: `policy_version` (the document's lifecycle) and `policy_acknowledgement`
(the employee's act). Plus the derived per-employee status that the UI renders.

### 5.1 `policy_version` transitions (`machine = 'policy_version'`)

`ess_policy_version_status`: `DRAFT`, `IN_REVIEW`, `PUBLISHED`, `SUPERSEDED`, `WITHDRAWN`.
Terminal: `SUPERSEDED`, `WITHDRAWN`.

| #     | from → to                                       | Trigger                                    | Actor               | Guards                                                                         | Effects                                                                                                                                                                                                                                         | Audit                      | Notify                                                                                                                                 |
| ----- | ----------------------------------------------- | ------------------------------------------ | ------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| POL-1 | `NULL` → `DRAFT`                                | `POST /policies/:id/versions`              | HR `policy:author`  | `version_major.version_minor` > the latest published version of the policy     | `body_sha256` computed from `body_markdown`; `policy_version_point` rows; `policy_applicability_rule` rows                                                                                                                                      | `POLICY.VERSION_DRAFTED`   | —                                                                                                                                      |
| POL-2 | `DRAFT` → `IN_REVIEW`                           | `POST /policy-versions/:id/submit-review`  | HR `policy:author`  | `policy.has_body`                                                              | The version becomes immutable for body/version/effective fields (`trg_policy_version_immutable`)                                                                                                                                                | `POLICY.VERSION_IN_REVIEW` | —                                                                                                                                      |
| POL-3 | `IN_REVIEW` → `DRAFT`                           | `POST /policy-versions/:id/return`         | HR `policy:author`  | `approval.note_required`                                                       | Body becomes editable again **only** because the version never left `DRAFT`/`IN_REVIEW`; once published it can never return                                                                                                                     | `POLICY.VERSION_RETURNED`  | —                                                                                                                                      |
| POL-4 | `IN_REVIEW` → `PUBLISHED`                       | `POST /policy-versions/:id/publish`        | HR `policy:publish` | `policy.has_body`, `policy.effective_date_set`, `policy.applicability_defined` | §5.2 in full                                                                                                                                                                                                                                    | `POLICY.PUBLISHED`         | `POLICY_ASSIGNED` → every newly assigned employee                                                                                      |
| POL-5 | `PUBLISHED` → `SUPERSEDED`                      | _system_, inside POL-4 of the next version | _system_            | the superseding version is `PUBLISHED` and `effective_from` > this version's   | `effective_to = next.effective_from - 1 day`; `next.supersedes_version_id = this.id`; §5.3                                                                                                                                                      | `POLICY.SUPERSEDED`        | —                                                                                                                                      |
| POL-6 | `DRAFT`\|`IN_REVIEW`\|`PUBLISHED` → `WITHDRAWN` | `POST /policy-versions/:id/withdraw`       | HR `policy:publish` | `approval.note_required`                                                       | `withdrawn_at/_reason`; open `policy_assignment` rows → `superseded_at = now()`; existing acknowledgements are **kept** (they are historical fact); the prior published version's `effective_to` is re-opened to NULL if this was its successor | `POLICY.WITHDRAWN`         | `POLICY_ASSIGNED` (tone GRAY, "…has been withdrawn and no longer needs your acknowledgement") → every employee with an open assignment |

### 5.2 Publication: applicability resolution and assignment

Inside the POL-4 transaction, then continued by job `policy-assignment` for large
populations (the job is idempotent and the transaction records the intent):

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

| Object                                                  | Effect                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy_acknowledgement` rows for the **prior** version | **Untouched.** They remain valid for the version they were made against, carry `acknowledged_body_sha256` proving exactly which text was acknowledged, and are append-only. They are never re-pointed at the new version. |
| `policy_assignment` rows for the prior version          | `superseded_at = now()`. A superseded assignment never appears in the pending count and never goes overdue.                                                                                                               |
| `policy_version` (prior)                                | → `SUPERSEDED`, `effective_to` closed. Still readable, still downloadable by anyone who acknowledged it; the Policies list shows the **current** version by default with a "Version history" affordance.                  |
| New version                                             | Fresh `policy_assignment` rows for the resolved audience ⇒ every in-scope employee's derived status becomes `PENDING` again, including those who acknowledged the prior version.                                          |
| Employees no longer in scope                            | No assignment is created; their prior acknowledgement stands; the policy row shows `NOT_APPLICABLE` (gray) or is hidden.                                                                                                  |

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

| #      | from → to               | Trigger                                                                                 | Actor                              | Guards                                                                                                                          | Effects                                                                                                                                                                                                                                                                                                                                   | Audit                 | Notify                                                                          |
| ------ | ----------------------- | --------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------- |
| PACK-1 | `NULL` → `ACKNOWLEDGED` | `POST /policy-versions/:id/acknowledge` (the prototype's "I have read and acknowledge") | EMPLOYEE `policy:acknowledge:self` | `policy.assignment_open` (an assignment exists for (employee, version) with `superseded_at IS NULL` and no acknowledgement yet) | Appends one row with `employee_id`, `policy_version_id`, `policy_assignment_id`, `status='ACKNOWLEDGED'`, `acknowledged_at = now()`, `acknowledged_body_sha256` = the version's `body_sha256` **re-read inside the transaction**, `acknowledgement_text` = the exact consent sentence rendered, `ip_address`, `user_agent`, `app_user_id` | `POLICY.ACKNOWLEDGED` | — (the act needs no notification; it removes one from the employee's Home list) |
| PACK-2 | `NULL` → `WAIVED`       | `POST /policy-assignments/:id/waive`                                                    | HR `policy:publish`                | `approval.note_required`                                                                                                        | Same row shape with `status='WAIVED'`, `waived_by_user_id`, `waiver_reason`                                                                                                                                                                                                                                                               | `POLICY.WAIVED`       | `POLICY_ASSIGNED` (tone GRAY) → employee                                        |

**The four mandated facts** — employee, policy version, acknowledgement status,
acknowledgement timestamp — are `employee_id`, `policy_version_id`, `status`,
`acknowledged_at` on this append-only row. `acknowledged_body_sha256` makes the record
evidential: it proves _which text_ was acknowledged even if the PDF is later
re-rendered. `ux_pack__employee_version` makes a double-click idempotent (the second
insert is a no-op returning `200` with the existing row, not a `409`).

An acknowledgement is **never** edited or deleted. Re-acknowledging a new version is a new
row against that version.

### 5.5 Due dates and overdue escalation

Job `policy-due-reminder`, daily at 08:00 org time, over
`policy_assignment WHERE superseded_at IS NULL AND due_on IS NOT NULL` with no
acknowledgement:

| Condition                    | Notification             | `source_rule_code`          | Recipient                                                                                      |
| ---------------------------- | ------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------- |
| `due_on - CURRENT_DATE = 7`  | `POLICY_ASSIGNED`, amber | `POLICY_DUE_IN_7_DAYS`      | employee                                                                                       |
| `due_on - CURRENT_DATE = 3`  | `POLICY_ASSIGNED`, amber | `POLICY_DUE_IN_3_DAYS`      | employee                                                                                       |
| `due_on - CURRENT_DATE = 1`  | `POLICY_ASSIGNED`, amber | `POLICY_DUE_TOMORROW`       | employee                                                                                       |
| `CURRENT_DATE = due_on + 1`  | `POLICY_OVERDUE`, red    | `POLICY_OVERDUE`            | employee                                                                                       |
| `CURRENT_DATE = due_on + 7`  | `POLICY_OVERDUE`, red    | `POLICY_OVERDUE_ESCALATION` | the employee's primary manager **and** their HR business partner                               |
| `CURRENT_DATE = due_on + 21` | `POLICY_OVERDUE`, red    | `POLICY_OVERDUE_COMPLIANCE` | HR compliance queue (a role-targeted notification to every user holding `policy:ack:read:any`) |

`ux_notification__dedupe (recipient, kind, entity_type, entity_id, source_rule_code)`
guarantees each fires exactly once even if the job runs twice — the reminders are
deliberately a fixed ladder rather than a recurring nag, so the bell count stays
meaningful. Also `POLICY_REMINDER` email at `POLICY_OVERDUE_ESCALATION` only (one email,
not five).

There is no auto-acknowledgement, no auto-waiver and no implied consent. An overdue
assignment stays open until the employee acts, HR waives it, or the version is superseded
or withdrawn.

### 5.6 Policy invariants

| #         | Invariant                                                            | Enforced by                                                                      |
| --------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| POL-INV-1 | A published version's body and version number never change           | `trg_policy_version_immutable`                                                   |
| POL-INV-2 | At most one `PUBLISHED` non-superseded version per policy            | `ux_pv__policy_current`                                                          |
| POL-INV-3 | Published versions of a policy have non-overlapping effective ranges | `ex_policy_version__one_effective`                                               |
| POL-INV-4 | An acknowledgement always names a version, never a policy            | `policy_version_id` NOT NULL + `ux_pack__employee_version`                       |
| POL-INV-5 | Acknowledgements are append-only                                     | `trg_append_only_policy_ack`                                                     |
| POL-INV-6 | The acknowledged text is provable                                    | `acknowledged_body_sha256 = policy_version.body_sha256` at the moment of the act |
| POL-INV-7 | Pending/overdue counts derive only from live assignments             | `WHERE superseded_at IS NULL` in every count query                               |
| POL-INV-8 | An employee can only acknowledge a policy assigned to them           | `policy.assignment_open` + `policy:acknowledge:self` scope                       |

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

| #     | from → to                                                                         | Trigger                                                                               | Actor                          | Guards                                                                            | Effects                                                                                                                                                                                                                                                                                                                                                           | Audit                                    | Notify                                                                                                                                                                                                                   |
| ----- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| HD-1  | `NULL` → `OPEN`                                                                   | `POST /tickets` (the prototype's "Raise ticket")                                      | EMPLOYEE `ticket:create:self`  | category active; `is_anonymous` only where `ticket_category.is_anonymous_allowed` | `ticket_no` from `helpdesk_ticket_seq`; SLA clocks (§6.4); the first `ticket_comment` from `description`; **one `email_outbox` row (§6.3) in the same transaction**; `email_outbox_id` set; default assignee from `ticket_category.default_assignee_user_id/_role_id` (if a single user, the ticket goes straight to `ASSIGNED` via HD-2 in the same transaction) | `TICKET.CREATED` + `TICKET.EMAIL_QUEUED` | `TICKET_UPDATED` → raiser ("HD-4831 raised · first response within 1 working day", the SLA text read from `ticket_category.first_response_sla_hours`); `HELPDESK_TICKET_CREATED` email → `ticket_category.routing_email` |
| HD-2  | `OPEN` → `ASSIGNED`                                                               | `POST /tickets/:id/assign`                                                            | HR `ticket:assign`             | assignee holds `ticket:read:any`                                                  | `assigned_to_user_id`, `assigned_at`                                                                                                                                                                                                                                                                                                                              | `TICKET.ASSIGNED`                        | `TICKET_UPDATED` → assignee and raiser                                                                                                                                                                                   |
| HD-3  | `ASSIGNED` → `IN_PROGRESS`                                                        | First `PUBLIC` agent comment, or `POST /tickets/:id/start`                            | HR `ticket:comment:any`        | —                                                                                 | `first_responded_at` set by the first `PUBLIC` agent comment (drives `sla_first_response_breached`)                                                                                                                                                                                                                                                               | `TICKET.IN_PROGRESS`                     | `TICKET_UPDATED` → raiser                                                                                                                                                                                                |
| HD-4  | `IN_PROGRESS` → `WAITING_ON_EMPLOYEE`                                             | `POST /tickets/:id/request-info`                                                      | HR `ticket:comment:any`        | a `PUBLIC` comment accompanies it                                                 | `sla_paused_at = now()` (R-3)                                                                                                                                                                                                                                                                                                                                     | `TICKET.WAITING_ON_EMPLOYEE`             | `TICKET_UPDATED` → raiser                                                                                                                                                                                                |
| HD-5  | `WAITING_ON_EMPLOYEE` → `IN_PROGRESS`                                             | Raiser posts a `PUBLIC` comment                                                       | EMPLOYEE `ticket:comment:self` | `ticket.self_only`                                                                | `sla_paused_seconds += now() - sla_paused_at`; `sla_paused_at = NULL`; `resolution_due_at` extended by the pause (§6.4)                                                                                                                                                                                                                                           | `TICKET.RESUMED`                         | `TICKET_UPDATED` → assignee                                                                                                                                                                                              |
| HD-6  | `OPEN`\|`ASSIGNED`\|`IN_PROGRESS`\|`WAITING_ON_EMPLOYEE`\|`REOPENED` → `RESOLVED` | `POST /tickets/:id/resolve`                                                           | HR `ticket:resolve`            | `ticket.resolution_summary_present`                                               | `resolved_at`, `resolved_by_user_id`, `resolution_summary`; `sla_resolution_breached` computed                                                                                                                                                                                                                                                                    | `TICKET.RESOLVED`                        | `TICKET_RESOLVED` → raiser; `HELPDESK_TICKET_UPDATED` email → routing address                                                                                                                                            |
| HD-7  | `RESOLVED` → `CLOSED`                                                             | Job `ticket-auto-close` after `org auto_close_days` (7), or `POST /tickets/:id/close` | _system_ / HR `ticket:resolve` | `resolved_at < now() - 7 days` for the job                                        | `closed_at`; a satisfaction prompt is offered once                                                                                                                                                                                                                                                                                                                | `TICKET.CLOSED`                          | —                                                                                                                                                                                                                        |
| HD-8  | `RESOLVED` → `REOPENED`                                                           | `POST /tickets/:id/reopen`                                                            | EMPLOYEE `ticket:create:self`  | `ticket.self_only`, `ticket.within_reopen_window` (14 days)                       | `reopened_count += 1`; `resolved_at`/`resolved_by_user_id`/`resolution_summary` cleared; SLA clocks restarted from `now()`; the prior resolution is preserved as a `SYSTEM` `ticket_comment`                                                                                                                                                                      | `TICKET.REOPENED`                        | `TICKET_UPDATED` → assignee; `HELPDESK_TICKET_UPDATED` email → routing address                                                                                                                                           |
| HD-9  | `REOPENED` → `ASSIGNED`                                                           | `POST /tickets/:id/assign`                                                            | HR `ticket:assign`             | —                                                                                 | As HD-2                                                                                                                                                                                                                                                                                                                                                           | `TICKET.ASSIGNED`                        | `TICKET_UPDATED`                                                                                                                                                                                                         |
| HD-10 | `OPEN` → `CANCELLED`                                                              | `DELETE /tickets/:id`                                                                 | EMPLOYEE `ticket:create:self`  | `ticket.self_only`; not yet assigned                                              | —                                                                                                                                                                                                                                                                                                                                                                 | `TICKET.CANCELLED`                       | —                                                                                                                                                                                                                        |

Chip tones (Design System §1): `OPEN`/`ASSIGNED`/`IN_PROGRESS`/`REOPENED` → amber;
`WAITING_ON_EMPLOYEE` → blue; `RESOLVED`/`CLOSED` → green; `CANCELLED` → gray.
`INTERNAL` comments are never returned to the raiser — enforced in the query
(`WHERE visibility = 'PUBLIC'` for `ticket:read:self`) **and** by RLS.

### 6.3 The email dispatch to `helpdesk@widedroptech.com` — transactional outbox

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
  `ticket:read:any`.
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
success: status='SENT', sent_at=now(), provider_message_id=…, body_text/body_html=NULL
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
ticket number — and never claims delivery.

### 6.4 SLA clocks

```
working_hours = organization business hours (default 09:00–18:00, Mon–Fri)
                excluding PUBLIC holidays on the org default calendar

first_response_due_at = addWorkingHours(created_at, ticket_category.first_response_sla_hours)
resolution_due_at     = addWorkingHours(created_at, ticket_category.resolution_sla_hours)
                        + sla_paused_seconds        -- recomputed on every HD-5
```

- `sla_first_response_breached` and `sla_resolution_breached` are **generated columns** —
  they are facts about persisted timestamps, not a job's opinion.
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

| Failure                                 | Compensation                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mail provider down                      | Retries with exponential backoff (1, 2, 4, 8, 16, capped 60 min), then `FAILED` dead-letter, notification, HR banner, manual retry                                                             |
| Worker dies mid-send                    | `SENDING` rows older than 10 minutes are reclaimed; the provider idempotency key (`email_outbox.id`) prevents a duplicate send                                                                 |
| Duplicate submit (double click / retry) | `Idempotency-Key` header → `ess_ops.idempotency_key` returns the original `201` body; no second ticket, no second email                                                                        |
| Routing address changed                 | It is `organization.helpdesk_email` / `ticket_category.routing_email`, changed through an audited `CONFIG_CHANGE`, not a redeploy. In-flight queued rows keep the address captured at enqueue. |
| Attachment infected                     | Attachment rejected before the ticket transaction commits; the ticket may still be raised without it                                                                                           |
| Employee reopens after 14 days          | `ticket.within_reopen_window` fails; they raise a new ticket, which is linked via `related_entity_type='helpdesk_ticket'`                                                                      |

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

### 8.1 Schema (A-5)

`profile_change_request`

| Column                                  | Type                        | Null | Notes                                                                                                                              |
| --------------------------------------- | --------------------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                    | `uuid`                      | no   | PK                                                                                                                                 |
| `organization_id`                       | `uuid`                      | no   | FK → `organization(id)` RESTRICT                                                                                                   |
| `request_no`                            | `citext`                    | no   | `WDT-PCR-2026-00118`, unique per org                                                                                               |
| `employee_id`                           | `uuid`                      | no   | FK → `employee(id)` RESTRICT                                                                                                       |
| `section`                               | `ess_profile_section`       | no   | `PERSONAL` \| `CONTACT` \| `ADDRESS` \| `BANK` \| `STATUTORY` \| `EMERGENCY` \| `DEPENDENT` — matches the prototype's profile tabs |
| `status`                                | `ess_profile_change_status` | no   | `SUBMITTED`,`IN_VERIFICATION`,`PROOF_REQUIRED`,`APPROVED_APPLIED`,`REJECTED`,`CANCELLED`                                           |
| `requires_proof`                        | `boolean`                   | no   | From `profile_field_policy` for the highest-sensitivity field in the request                                                       |
| `proof_file_object_id`                  | `uuid`                      | yes  | FK → `file_object(id)` RESTRICT, `purpose='PROFILE_PROOF'`                                                                         |
| `submitted_at` / `submitted_by_user_id` |                             | no   |                                                                                                                                    |
| `assigned_to_user_id`                   | `uuid`                      | yes  | FK → `app_user(id)` SET NULL                                                                                                       |
| `verified_at` / `verified_by_user_id`   |                             | yes  |                                                                                                                                    |
| `applied_at`                            | `timestamptz`               | yes  |                                                                                                                                    |
| `rejection_reason`                      | `text`                      | yes  | Mandatory on `REJECTED`                                                                                                            |
| `effective_from`                        | `date`                      | yes  | For effective-dated targets (bank account, statutory election)                                                                     |
| `approval_task_id`                      | `uuid`                      | yes  | FK → `approval_task(id)` SET NULL                                                                                                  |
| `audit_event_id`                        | `uuid`                      | yes  | The before/after event written at application                                                                                      |
| `row_version`                           | `integer`                   | no   | default `1`                                                                                                                        |

`profile_change_request_field` — one row per field changed:
`id`, `organization_id`, `profile_change_request_id` (CASCADE),
`target_table text NOT NULL`, `target_column text NOT NULL`,
`proposed_value_ct/_iv/_tag/_dek_id/_mask` (envelope — a proposed PAN or account number is
as sensitive as the stored one), `proposed_value_plain text NULL` (only for columns the
`profile_field_policy` marks non-sensitive), `current_value_hash bytea NOT NULL`
(HMAC of the value at submission — optimistic concurrency without storing the old value),
`applied boolean NOT NULL DEFAULT false`.
`CHECK (num_nonnulls(proposed_value_ct, proposed_value_plain) = 1)`;
`UNIQUE (profile_change_request_id, target_table, target_column)`.

`profile_field_policy` — reference data, seeded: `section`, `target_table`,
`target_column`, `self_service boolean`, `requires_proof boolean`,
`verifier_permission_code text` (`profile:update:any` for HR fields,
`payroll:salary_structure:write` for bank/statutory fields), `sla_working_days smallint`,
`help_text text` (the source of the prototype's per-tab notes such as "Bank and statutory
changes need a cancelled cheque or ID proof and are verified by Payroll within 2 working
days" — persisted copy, not a literal).

### 8.2 Transition table (`machine = 'profile_change_request'`)

| #     | from → to                                                     | Trigger                                   | Actor                                                               | Guards                                                                                                                                                                                        | Effects                                                                                                                                                                                                                                                                                                                                                                                                  | Audit                                                             | Notify                                                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCR-1 | `NULL` → `SUBMITTED`                                          | `POST /me/profile-change-requests`        | EMPLOYEE `profile:update:self`                                      | Every field is in `profile_field_policy` for the section; no other open request touches the same `(target_table, target_column)`; `requires_proof ⇒ proof_file_object_id` present and `CLEAN` | Fields persisted; `current_value_hash` computed; `approval_task` (`kind='PROFILE_CHANGE'`) assigned to the holders of the section's `verifier_permission_code`; `due_at = addWorkingDays(now(), policy.sla_working_days)`                                                                                                                                                                                | `PROFILE.CHANGE_REQUESTED` (metadata: the **column names only**)  | `APPROVAL_PENDING` → the verifier queue                                                                                                                                                                                                           |
| PCR-2 | `SUBMITTED` → `IN_VERIFICATION`                               | `POST /profile-change-requests/:id/claim` | HR or ACCOUNTS (per `verifier_permission_code`)                     | —                                                                                                                                                                                             | `assigned_to_user_id`                                                                                                                                                                                                                                                                                                                                                                                    | `PROFILE.CHANGE_IN_VERIFICATION`                                  | —                                                                                                                                                                                                                                                 |
| PCR-3 | `IN_VERIFICATION` → `PROOF_REQUIRED`                          | `POST /…/request-proof`                   | verifier                                                            | `approval.note_required`                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                                        | `PROFILE.CHANGE_PROOF_REQUESTED`                                  | `APPROVAL_PENDING` (tone AMBER) → employee                                                                                                                                                                                                        |
| PCR-4 | `PROOF_REQUIRED` → `IN_VERIFICATION`                          | `POST /…/attach-proof`                    | EMPLOYEE `profile:update:self`                                      | file `CLEAN`                                                                                                                                                                                  | `proof_file_object_id`                                                                                                                                                                                                                                                                                                                                                                                   | `PROFILE.CHANGE_PROOF_ATTACHED`                                   | `APPROVAL_PENDING` → verifier                                                                                                                                                                                                                     |
| PCR-5 | `IN_VERIFICATION` → `APPROVED_APPLIED`                        | `POST /…/approve`                         | verifier (`profile:update:any` or `payroll:salary_structure:write`) | For each field: `current_value_hash` still matches the live value (else `409 STALE`); `requires_proof ⇒ CLEAN` proof present; verifier ≠ requester (`ck_at__not_self` on the task)            | **The write is applied in this transaction**: in-place for mutable columns; a **new effective-dated row** for `employee_bank_account` (old row's `effective_to = effective_from - 1`, new row `is_verified = true`, `verified_by_user_id`, `proof_file_object_id` carried over), `employee_statutory_id`, `employee_statutory_election`, `employee_employment`. `applied = true` per field; `applied_at` | `PROFILE.CHANGE_APPLIED` with `before_data`/`after_data` per §8.3 | `APPROVAL_PENDING`-class notification to the employee: kind `TICKET_UPDATED`, context `People Ops`, "Your bank details were updated on 29 Sep 2026"; plus a `SECURITY_ALERT` email to the employee's work address for `BANK`/`STATUTORY` sections |
| PCR-6 | `SUBMITTED`\|`IN_VERIFICATION`\|`PROOF_REQUIRED` → `REJECTED` | `POST /…/reject`                          | verifier                                                            | `approval.note_required`                                                                                                                                                                      | `rejection_reason`                                                                                                                                                                                                                                                                                                                                                                                       | `PROFILE.CHANGE_REJECTED`                                         | employee notified with the reason                                                                                                                                                                                                                 |
| PCR-7 | `SUBMITTED`\|`PROOF_REQUIRED` → `CANCELLED`                   | `DELETE /…`                               | EMPLOYEE `profile:update:self`                                      | self only                                                                                                                                                                                     | `approval_task` → `WITHDRAWN`                                                                                                                                                                                                                                                                                                                                                                            | `PROFILE.CHANGE_CANCELLED`                                        | —                                                                                                                                                                                                                                                 |

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

| #         | Invariant                                                                     | Enforced by                                                                                                                                                               |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PCR-INV-1 | No sensitive profile field changes without a verified request                 | `profile_field_policy.self_service = false` + the API's mass-assignment allowlist (`SECURITY.md §5.10`) — the `PATCH /me/profile` route accepts only self-service columns |
| PCR-INV-2 | The requester never verifies their own request                                | `ck_at__not_self` on the `approval_task` + `verifier_permission_code` is never held with `:self` scope                                                                    |
| PCR-INV-3 | A stale request cannot overwrite a newer value                                | `current_value_hash` comparison at PCR-5                                                                                                                                  |
| PCR-INV-4 | Bank/statutory changes are effective-dated, never in-place                    | New row + `effective_to` closure; `ux_employee_bank_account__one_primary`                                                                                                 |
| PCR-INV-5 | A newly applied bank account is unverified for payroll until proof is on file | `is_verified` set only from a proof-bearing request; otherwise `PAY_BANK_UNVERIFIED` blocks                                                                               |

| Failure                       | Compensation                                                                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Proof missing or unreadable   | PCR-3 `PROOF_REQUIRED` with a note; the request stays open                                                                                                                                                            |
| Value changed underneath      | `409 STALE`; the verifier re-opens the request against current values                                                                                                                                                 |
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
- `ess_user_status`: `INVITED`, `ACTIVE`, `LOCKED`, `DISABLED`

### 9.2 `employee` lifecycle (`machine = 'employee'`)

| #     | from → to                                           | Trigger                                                                             | Actor                               | Guards                                                                                                                                                         | Effects                                                                                                                                                                                                                                                                                                  | Audit                     | Notify                                                                                                                                              |
| ----- | --------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| EMP-1 | `NULL` → `PRE_JOINING`                              | `POST /employees`                                                                   | HR `employee:create`                | `work_email` unique in org; `date_of_joining` present                                                                                                          | `employee_number` from the sequence (never reused); first `employee_employment` row effective from `date_of_joining`; `employee_personal_detail`; `app_user` created with `status='INVITED'` and `password_hash = NULL`; `user_role` grant of `EMPLOYEE` **valid from `date_of_joining`**                | `EMPLOYEE.CREATED`        | —                                                                                                                                                   |
| EMP-2 | `PRE_JOINING` → `ACTIVE`                            | Job `employee-activation` on `date_of_joining`, or `POST /employees/:id/activate`   | _system_ / HR `employee:update:any` | `CURRENT_DATE >= date_of_joining`; a salary structure exists (WARNING if not — it blocks payroll, not activation)                                              | `policy-assignment` for every applicable published policy (§5.2); `leave_balance` seeded via `OPENING`/`ACCRUAL` ledger rows per `leave_entitlement_rule` (pro-rated for the joining month); `benefit_enrolment` rows in `ELIGIBLE`; `tds_quarter` rows for the FY; `employee_reporting_closure` rebuilt | `EMPLOYEE.ACTIVATED`      | `POLICY_ASSIGNED` per assignment; `ANNOUNCEMENT_PUBLISHED` for pinned announcements is **not** backfilled (an announcement is an event, not a task) |
| EMP-3 | `ACTIVE` ↔ `ON_LEAVE`                               | Job `employee-leave-status`, driven by approved long leave                          | _system_                            | An `APPROVED` leave spanning `CURRENT_DATE` of a type flagged `sets_on_leave_status`                                                                           | Directory "Team today" chip becomes `On leave`, amber — derived from `leave_request_day`, never typed                                                                                                                                                                                                    | `EMPLOYEE.STATUS_CHANGED` | —                                                                                                                                                   |
| EMP-4 | `ACTIVE` → `NOTICE_PERIOD`                          | `POST /employees/:id/resign`                                                        | HR `employee:update:any`            | `date_of_exit` present and ≥ `CURRENT_DATE`                                                                                                                    | `employee.date_of_exit`; the exit checklist opens; payroll inclusion continues                                                                                                                                                                                                                           | `EMPLOYEE.NOTICE_STARTED` | `TICKET_UPDATED`-class notice to the manager and the HRBP                                                                                           |
| EMP-5 | `ACTIVE`\|`ON_LEAVE`\|`NOTICE_PERIOD` → `SUSPENDED` | `POST /employees/:id/suspend`                                                       | HR `employee:update:any`            | `approval.note_required`                                                                                                                                       | `app_user` → `DISABLED` (EMP-U4) in the same transaction; all sessions revoked; `employee_employment.pay_suspended` set per the suspension decision                                                                                                                                                      | `EMPLOYEE.SUSPENDED`      | `SECURITY_ALERT` → HR + the manager                                                                                                                 |
| EMP-6 | `SUSPENDED` → `ACTIVE`                              | `POST /employees/:id/reinstate`                                                     | HR `employee:update:any`            | `approval.note_required`                                                                                                                                       | `app_user` → `ACTIVE`; a fresh invitation is **not** sent (the password survives); `token_epoch` bumped                                                                                                                                                                                                  | `EMPLOYEE.REINSTATED`     | —                                                                                                                                                   |
| EMP-7 | `NOTICE_PERIOD`\|`ACTIVE`\|`SUSPENDED` → `EXITED`   | Job `employee-offboarding` on `date_of_exit + 1`, or `POST /employees/:id/offboard` | _system_ / HR `employee:deactivate` | `date_of_exit IS NOT NULL` and `<= CURRENT_DATE`; no `PENDING_APPROVAL` leave and no live `approval_task` **assigned to** them (they must be reassigned first) | §9.4 in full                                                                                                                                                                                                                                                                                             | `EMPLOYEE.OFFBOARDED`     | `TICKET_UPDATED` → manager, HRBP, ACCOUNTS                                                                                                          |

### 9.3 `app_user` lifecycle (`machine = 'app_user'`)

| #     | from → to                                  | Trigger                                                              | Actor                        | Guards                                                                                                                                                               | Effects                                                                                                                                                                                                                                     | Audit                                         |
| ----- | ------------------------------------------ | -------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| USR-1 | `NULL` → `INVITED`                         | EMP-1                                                                | HR `employee:create`         | —                                                                                                                                                                    | `user_invitation` (A-6) with a 32-byte random token, only its SHA-256 stored, `expires_at = now() + 7 days`; one `email_outbox` row of kind `USER_INVITE` in the same transaction                                                           | `USER.INVITED`                                |
| USR-2 | `INVITED` → `ACTIVE`                       | `POST /auth/accept-invitation`                                       | anonymous, holding the token | Token matches by `token_fpr`, hash verifies, not expired, not revoked, `attempt_count < 5`; password passes `SECURITY.md §2.2` policy and the HIBP k-anonymity check | `password_hash` (Argon2id + pepper), `password_updated_at`, `email_verified_at`, `terms_accepted_at`; `user_invitation.accepted_at`; MFA enrolment is forced on first login when `mfa_enforced_at` is set                                   | `USER.ACTIVATED`                              |
| USR-3 | `ACTIVE` → `LOCKED`                        | Progressive lockout (`SECURITY.md §2.6`)                             | _system_                     | `failed_login_count` threshold                                                                                                                                       | `locked_until`                                                                                                                                                                                                                              | `AUTH.ACCOUNT_LOCKED`                         |
| USR-4 | `LOCKED` → `ACTIVE`                        | Expiry of `locked_until`, or HR `security:mfa:reset`-adjacent unlock | _system_ / HR                | —                                                                                                                                                                    | `failed_login_count = 0`                                                                                                                                                                                                                    | `AUTH.ACCOUNT_UNLOCKED`                       |
| USR-5 | `ACTIVE`\|`LOCKED`\|`INVITED` → `DISABLED` | EMP-5, EMP-7, or `POST /users/:id/disable`                           | HR `employee:deactivate`     | `approval.note_required`                                                                                                                                             | `disabled_at`, `disabled_reason`; `token_epoch += 1` (invalidates every access token at the next request); every `refresh_token` family revoked; every `user_invitation` revoked; `user_role` grants revoked with `valid_to = CURRENT_DATE` | `USER.DISABLED` + `SECURITY.SESSIONS_REVOKED` |
| USR-6 | `DISABLED` → `ACTIVE`                      | EMP-6                                                                | HR `employee:update:any`     | `approval.note_required`                                                                                                                                             | `disabled_at = NULL`; `token_epoch += 1`; roles re-granted explicitly (never silently restored)                                                                                                                                             | `USER.REENABLED`                              |

Invitation resend (`POST /employees/:id/resend-invitation`, HR `employee:create`) revokes
the outstanding `user_invitation` and issues a new one — an old link is dead the moment a
new one is issued. Audit `USER.INVITATION_RESENT`.

### 9.4 Offboarding effects, in one transaction

| Domain                                     | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access**                                 | `app_user` → `DISABLED` (USR-5): `token_epoch` bumped, every refresh-token family revoked, every live `user_role` grant closed with `valid_to = date_of_exit`. The employee cannot sign in from the moment the transition commits.                                                                                                                                                                                                                                                                                                                                                |
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

| #         | Invariant                                                       | Enforced by                                                                                                      |
| --------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ONB-INV-1 | An `INVITED` user has no password and cannot authenticate       | `ck_app_user__password_present`                                                                                  |
| ONB-INV-2 | An invitation token is never stored in plaintext or logged      | Only `token_hash` + `token_fpr` persist; the token appears once, in the email body, which is nulled after `SENT` |
| ONB-INV-3 | One live invitation per user                                    | `UNIQUE (app_user_id) WHERE accepted_at IS NULL AND revoked_at IS NULL`                                          |
| ONB-INV-4 | An exited employee holds no live role grant and no live session | USR-5 effects, asserted by the `session-sweep` job                                                               |
| ONB-INV-5 | Offboarding never strands a pending approval                    | The reassignment step + the EMP-7 guard                                                                          |
| ONB-INV-6 | `EXITED` requires `date_of_exit`                                | `ck_employee__exited_has_date`                                                                                   |
| ONB-INV-7 | An employee number is never reused                              | Sequence-backed, `ux_employee__org_number`                                                                       |

| Failure                        | Compensation                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invitation expires unaccepted  | HR resends; the old token is revoked                                                                                                                                                                                                                                                                                                                              |
| Invitation link brute-forced   | `attempt_count` + the `login:<fpr>` rate-limit bucket; after 5 attempts the invitation is revoked and a `SECURITY_ALERT` is raised                                                                                                                                                                                                                                |
| Employee offboarded by mistake | `EXITED → ACTIVE` is **not** a legal transition. HR creates the correction as an explicit re-hire: a new `employee_employment` row, `employment_status` restored through an `employee:update:any` route that requires a note and writes `EMPLOYEE.REHIRED`, and `app_user` re-enabled (USR-6) with roles re-granted individually. Nothing is restored implicitly. |
| Exit date moves                | `date_of_exit` updated while still `NOTICE_PERIOD`; once `EXITED`, a change requires the re-hire path                                                                                                                                                                                                                                                             |
| Reports orphaned               | `employee_reporting_closure` rebuild is part of the transaction; `reporting-closure-verify` re-checks nightly and alerts on any employee with no resolvable approver                                                                                                                                                                                              |

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

| Kind                          | Tone                                                            | Emitted by                                                                                                               | Recipients (resolved from persisted relationships)                                                           | `context_label`                               | `deep_link_screen`                 |
| ----------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------- | ---------------------------------- |
| `PAYSLIP_PUBLISHED`           | GREEN                                                           | PAY-17; PC-5 (AMBER, revision)                                                                                           | Each employee with a payslip in the run — from `payslip_publication.employee_id`                             | `Payroll`                                     | `payslips`                         |
| `PAYROLL_CYCLE_STATE`         | BLUE / AMBER / RED                                              | PAY-2, PAY-3, PAY-5, PAY-6, PAY-8, PAY-9, PAY-10, PAY-13, PAY-14, PAY-15, PAY-16, PAY-19, ATT-5, ATT-7, ATT-8            | Users holding `payroll:cycle:read` (ACCOUNTS) and/or `attendance:submit` (HR), per the row's `Notify` column | `Payroll`                                     | _(HR/Accounts back-office screen)_ |
| `ATTENDANCE_APPROVAL_PENDING` | AMBER                                                           | ATT-3, AAP-4                                                                                                             | The manager of each `attendance_approval` slice; on escalation also their manager                            | `Attendance`                                  | `approvals`                        |
| `LEAVE_SUBMITTED`             | BLUE                                                            | LV-2, LV-3                                                                                                               | `leave_request.approver_employee_id` → their `app_user`                                                      | `Approvals`                                   | `approvals`                        |
| `LEAVE_DECIDED`               | GREEN (approved) / RED (rejected) / GRAY (withdrawn, cancelled) | LV-4, LV-5, LV-6, LV-7, LV-8                                                                                             | The employee; for withdrawals, the manager                                                                   | `Leave`                                       | `leave`                            |
| `EXPENSE_SUBMITTED`           | AMBER                                                           | EXP-3                                                                                                                    | The assigned manager                                                                                         | `Approvals`                                   | `approvals`                        |
| `EXPENSE_DECIDED`             | GREEN / RED                                                     | EXP-4, EXP-5, EXP-8, EXP-9, and the §4.5 batch roll-forward                                                              | The claiming employee                                                                                        | `Expenses`                                    | `expenses`                         |
| `EXPENSE_REIMBURSED`          | BLUE                                                            | EXP-11                                                                                                                   | The claiming employee                                                                                        | `Expenses`                                    | `expenses`                         |
| `POLICY_ASSIGNED`             | AMBER (assigned) / GRAY (waived, withdrawn)                     | POL-4, POL-6, PACK-2, EMP-2, audience recalculation                                                                      | Each newly assigned employee                                                                                 | `<policy.owner_label>` (e.g. `IT & Security`) | `policies`                         |
| `POLICY_OVERDUE`              | RED                                                             | Job `policy-due-reminder`                                                                                                | Employee; at +7 the manager and HRBP; at +21 the compliance queue                                            | `<policy.owner_label>`                        | `policies`                         |
| `ANNOUNCEMENT_PUBLISHED`      | BLUE                                                            | `announcement` `SCHEDULED`\|`DRAFT` → `PUBLISHED`                                                                        | Every employee matched by `announcement_audience`                                                            | `<announcement.department_label>`             | `announcements`                    |
| `TICKET_UPDATED`              | AMBER / BLUE                                                    | HD-1 (to raiser), HD-2, HD-3, HD-4, HD-5, HD-8, HD-9; PCR-5, PCR-6; EMP-4, EMP-7                                         | Raiser and/or assignee as listed per transition                                                              | `Help desk` / `People Ops`                    | `help`                             |
| `TICKET_RESOLVED`             | GREEN                                                           | HD-6                                                                                                                     | The raiser (never for an anonymous ticket — there is no recipient)                                           | `Help desk`                                   | `help`                             |
| `DOCUMENT_ISSUED`             | GREEN (issued) / RED (rejected)                                 | DOC-4, DOC-5                                                                                                             | The requesting employee                                                                                      | `Documents`                                   | `documents`                        |
| `APPROVAL_PENDING`            | BLUE                                                            | `approval_task` `NULL → PENDING` for kinds `DOCUMENT_REQUEST` and `PROFILE_CHANGE`                                       | `approval_task.assignee_app_user_id`                                                                         | `Approvals`                                   | `approvals`                        |
| `FORM16_ISSUED`               | GREEN                                                           | `form16_document` `PENDING → ISSUED`                                                                                     | The employee                                                                                                 | `Tax`                                         | `tax`                              |
| `SECURITY_ALERT`              | RED                                                             | New-device login, password change, MFA change, session revocation, `INFECTED` upload, EMP-5, PCR-5 on `BANK`/`STATUTORY` | The affected user; security-relevant org events additionally to `security:session:revoke` holders            | `Security`                                    | _(profile / security screen)_      |

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

| Unit of work                                        | Must share one transaction                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Any** transition                                  | the status write · the `audit_event` · every `notification` declared by `emits_notification_kind` · every `email_outbox` row declared by `emits_email_kind`                                                                                                                                                                |
| Help-desk ticket creation (HD-1)                    | `helpdesk_ticket` · first `ticket_comment` · `email_outbox` (`HELPDESK_TICKET_CREATED`) · `helpdesk_ticket.email_outbox_id` · `notification` to the raiser · 2 audit rows (`TICKET.CREATED`, `TICKET.EMAIL_QUEUED`)                                                                                                        |
| Leave submit (LV-2/3)                               | `leave_request` · `leave_request_day` rows · `leave_balance.pending_days` · `approval_task` · `notification` · audit                                                                                                                                                                                                       |
| Leave approve (LV-4)                                | `leave_request` · `leave_balance_ledger` (`CONSUMPTION`) · `fn_refresh_leave_balance` · `approval_task` · `approval_decision` · `notification` · `email_outbox` · audit                                                                                                                                                    |
| Attendance submit (ATT-2 + ATT-3 + PAY-4)           | `attendance_period` · every `attendance_record` · `attendance_submission` · every `attendance_approval` · every `approval_task` · `payroll_cycle` · notifications · audit                                                                                                                                                  |
| Slice decision (AAP-2) + completion (ATT-4 + PAY-5) | `attendance_approval` · its `attendance_record` rows · `approval_task` · `approval_decision` · the completion check and, if it holds, both period and cycle transitions · notifications · audit                                                                                                                            |
| Payroll run (§1.7)                                  | `payroll_run` · every `payslip` · every `payslip_line` · every `employee_tax_projection` · `payroll_cycle_employee.payslip_id` · `payroll_cycle` (PAY-13) · audit. **All or nothing.**                                                                                                                                     |
| Payroll publish (PAY-17)                            | every `payslip.status` · every `payslip_publication` · every `payslip_fy_rollup` fold · `tds_quarter` recompute · `reimbursement_batch` → `PAID` · every linked `expense_claim` → `REIMBURSED` · `employee_tax_regime_election.is_locked` · one `notification` + one `email_outbox` per employee · `payroll_cycle` · audit |
| Policy publish (POL-4 + POL-5)                      | `policy_version` · prior version's `SUPERSEDED` + `effective_to` · `policy_assignment` inserts (or the job intent row) · prior assignments' `superseded_at` · notifications · audit                                                                                                                                        |
| Policy acknowledge (PACK-1)                         | `policy_acknowledgement` · `audit_event` (referenced back by `audit_event_id`)                                                                                                                                                                                                                                             |
| Profile change apply (PCR-5)                        | `profile_change_request` · every `profile_change_request_field.applied` · the target-table writes (in-place or new effective-dated rows) · `audit_event` with before/after · notification · `email_outbox` for bank/statutory                                                                                              |
| Offboarding (EMP-7 + USR-5)                         | `employee` · `app_user` · every `user_role` closure · every `refresh_token` revocation · every `approval_task` reassignment + `approval_decision` · `employee_manager` closures · closure-table rebuild · `policy_assignment` supersessions · leave encashment/lapse ledger rows · audit                                   |

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

| Mechanism                             | Where                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Optimistic `row_version`**          | `leave_request`, `expense_claim`, `attendance_period`, `attendance_record`, `attendance_approval`, `payroll_cycle`, `payroll_input_batch`, `document_request`, `helpdesk_ticket`, `profile_change_request`, `approval_task`, `reimbursement_batch`, `payroll_correction`. The client sends the version it read; a mismatch is `409 STALE_ROW_VERSION` carrying the current value, and the UI re-reads rather than overwriting.                                      |
| **Pessimistic `SELECT … FOR UPDATE`** | Every transition, on the entity row (step 2 of §0.2). Additionally: `leave_balance` (before the `leave.sufficient_balance` guard, closing the double-spend race), `payroll_cycle` (before **every** payroll and attendance transition, which is what serialises the whole mandated sequence), `reimbursement_batch` (before item add/lock), `attendance_period` (before slice creation and before the completion check).                                            |
| **Advisory transaction lock**         | `pg_advisory_xact_lock(hashtext('audit:' \|\| organization_id))` in the audit hash-chain trigger, so the chain cannot fork. `pg_advisory_lock(hashtext('payroll:' \|\| cycle_id))` held by the calculation worker for the whole run, so two workers cannot generate the same cycle. `pg_advisory_xact_lock(hashtext('attcomplete:' \|\| period_id))` around the R-2 completion check, so two managers clicking Approve simultaneously cannot both fire ATT-4/PAY-5. |
| **Constraint-level serialisation**    | `ex_leave_request__no_self_overlap` (GiST), `ux_payslip__one_live_per_cycle_employee`, `ux_payroll_run__one_live`, `ux_pa__version_employee`, `ux_pack__employee_version`, `ux_llg__one_consumption_per_request`, `ux_rbi__claim`, `ux_email_outbox__org_idempotency`, `ux_notification__dedupe`, `ux_attsub__period_live`, `ux_pib__cycle_file_sha`. Every one of these turns a lost race into a clean, translatable error instead of duplicate data.              |
| **Queue claiming**                    | `FOR UPDATE SKIP LOCKED` on `email_outbox` (dispatcher) and `ess_ops.background_job` (lease with `lease_owner` + `lease_expires_at`, reclaimed after expiry).                                                                                                                                                                                                                                                                                                       |
| **Isolation level**                   | `READ COMMITTED` throughout, which is sufficient because every cross-row decision is protected by an explicit lock or a constraint. The payroll run additionally runs at `REPEATABLE READ` so the manifest it hashed is the manifest it read.                                                                                                                                                                                                                       |
| **Error translation**                 | Unique-violation → `409` with a domain code; exclusion-violation → `422 GUARD_FAILED` with the conflicting reference; check-violation → `422 INVARIANT_VIOLATED` with the constraint name mapped to a message. A constraint never surfaces as a `500`.                                                                                                                                                                                                              |

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

| Guard key                          | Predicate                                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `payroll.no_published_payslips`    | No `payslip` for the cycle has `status = 'PUBLISHED'`                                                                                |
| `payroll.parent_cycle_published`   | `parent_payroll_cycle_id`'s cycle is `PUBLISHED` or `CLOSED` (supplementary/off-cycle runs, §1.10.4)                                 |
| `payroll.scope_resolved`           | Every in-scope employee has a `payroll_cycle_employee` row for the current `validation_pass_no`                                      |
| `expense.approval_task_created`    | An `approval_task` of kind `EXPENSE_CLAIM` exists and is `PENDING` for the claim                                                     |
| `docreq.self_only`                 | `document_request.employee_id = actor_employee_id` _(already listed; restated for completeness)_                                     |
| `profile.fields_in_policy`         | Every requested `(target_table, target_column)` exists in `profile_field_policy` for the section                                     |
| `profile.values_unchanged`         | Every field's `current_value_hash` still matches the live value                                                                      |
| `profile.verifier_not_requester`   | `verified_by_user_id <> submitted_by_user_id`                                                                                        |
| `employee.no_pending_obligations`  | The exiting employee has no `PENDING_APPROVAL` leave, no `PENDING_MANAGER` expense and no `PENDING` `approval_task` assigned to them |
| `ticket.category_allows_anonymous` | `is_anonymous ⇒ ticket_category.is_anonymous_allowed`                                                                                |

### 11.5 Testing obligations these workflows impose

| Area          | Required test                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordering      | An integration test that attempts each mandated payroll step out of order and asserts `409`/`422` with the guard key — one test per skipped step                                                                                |
| Visibility    | A test that a payslip row does not exist before `CALCULATING`, is unreadable by its owner between `GENERATED` and `PUBLISHED`, and becomes readable at `PUBLISHED`; plus a direct-SQL test that the RLS policy refuses the read |
| Determinism   | A golden-file test: fixed inputs → fixed `payslip_line` amounts and a fixed `input_sha256`, across two runs and across a process restart                                                                                        |
| Rounding      | Property tests asserting `gross - deductions = net` and the half-up/round-up rules of §1.9.7 over generated inputs                                                                                                              |
| Concurrency   | Two concurrent leave submissions against one balance; two concurrent slice approvals racing the completion check; two concurrent publishes                                                                                      |
| Idempotency   | Every unsafe route replayed with the same `Idempotency-Key`; every job run twice                                                                                                                                                |
| Outbox        | Ticket creation with the mail provider failing, asserting the ticket persists, the outbox reaches `FAILED`, the HR notification fires and the UI renders the failure state                                                      |
| Empty states  | Every screen rendered against an empty database, asserting no `0`, no `₹0` and no fabricated date appears where the underlying row is absent                                                                                    |
| Authorization | For every transition in this document, a negative test per persona that does not hold the permission, and a scope test (a Manager acting on an employee outside their closure)                                                  |

---

## Appendix A — Machine index

| Machine                  | States | Section               |
| ------------------------ | ------ | --------------------- |
| `payroll_cycle`          | 14     | §1.3                  |
| `payroll_input_batch`    | 7      | §1.4.1                |
| `payroll_run`            | 5      | §1.4.2                |
| `payroll_correction`     | 7      | §1.10.3               |
| `attendance_period`      | 6      | §2.2                  |
| `attendance_record`      | 5      | §2.3                  |
| `attendance_approval`    | 4      | §2.4                  |
| `leave_request`          | 6      | §3.2                  |
| `expense_claim`          | 12     | §4.2                  |
| `reimbursement_batch`    | 5      | §4.5                  |
| `policy_version`         | 5      | §5.1                  |
| `policy_acknowledgement` | 2      | §5.4                  |
| `helpdesk_ticket`        | 8      | §6.2                  |
| `document_request`       | 6      | §7.2                  |
| `profile_change_request` | 6      | §8.2                  |
| `employee`               | 6      | §9.2                  |
| `app_user`               | 4      | §9.3                  |
| `approval_task`          | 6      | `DATA-MODEL.md §19`   |
| `announcement`           | 4      | `DATA-MODEL.md §16.1` |
| `tax_declaration`        | 6      | `DATA-MODEL.md §12.3` |

Every one of these is seeded into `state_transition` and is the **only** legal set of
moves; `trg_guard_state_transition` enforces it at the database level.
