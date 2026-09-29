# Widedrop ESS — Domain Model & PostgreSQL/Prisma Schema

**Status:** authoritative. Implementers derive migrations and `schema.prisma` from this
document; no further modelling decisions are required.
**Scope:** every module the prototype defines (Home, Payslips, Tax slips, My profile,
Leave, Benefits, Expenses, Documents, Policies, Directory, Announcements, Help desk,
Manager Approvals) plus the HR and Accounts back-office surfaces that the payroll
workflow requires.
**Target:** PostgreSQL 16, accessed through Prisma 5 from Fastify 5 / Node 22.

> **Data-integrity rule (overrides the prototype).** The prototype's `PAYSLIPS`,
> `PROFILE`, `PEOPLE`, `ANN`, `BAL`, `YTD`, `TAXQ`, `EXP0`, `TK0`, `APR0` … literals
> exist only to fix layout and copy tone. Section 20 maps **every** number the
> prototype renders to a persisted column or a deterministic aggregation defined here.
> Nothing in the running system may render a value that Section 20 does not source.

---

## 1. Conventions

### 1.1 Schemas and extensions

```sql
CREATE SCHEMA IF NOT EXISTS ess;      -- all business tables
CREATE SCHEMA IF NOT EXISTS ess_ops;  -- infrastructure: outbox, jobs, rate limits, idempotency
SET search_path = ess, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid(), digest()
CREATE EXTENSION IF NOT EXISTS citext;      -- case-insensitive email / code
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- EXCLUDE constraints on date ranges
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- directory / global search
```

### 1.2 Primary keys and audit columns

| Rule | Definition |
|---|---|
| Primary key | `id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()` on **every** table unless the table is explicitly a link/ledger table with a stated composite PK. |
| Tenancy | Every business table carries `organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT`. Every user-facing index is composite and **leads with `organization_id`**. |
| Creation stamp | `created_at timestamptz NOT NULL DEFAULT now()` |
| Update stamp | `updated_at timestamptz NOT NULL DEFAULT now()`, maintained by trigger `trg_touch_updated_at` (`BEFORE UPDATE … SET NEW.updated_at = now()`). |
| Actor stamps | `created_by_user_id uuid NULL REFERENCES app_user(id) ON DELETE SET NULL`, `updated_by_user_id uuid NULL REFERENCES app_user(id) ON DELETE SET NULL`. NULL only for rows written by the system (migrations, schedulers, seeds). |
| Optimistic lock | `row_version integer NOT NULL DEFAULT 1` on every table that has a state machine; incremented by the same trigger. API sends `If-Match: <row_version>`; mismatch → `409`. |
| Soft delete | **Not used.** Lifecycle is expressed by status enums and `is_active boolean`. Physically deleting operational rows is forbidden (Section 18). |

Columns listed per table below **omit** these standard columns; assume they are present
on every table unless the table description says "no audit columns" (only
`audit_event`, `leave_balance_ledger` and other append-only ledgers say that, and they
carry only `created_at`).

### 1.3 Naming

- Tables: `snake_case`, **singular** (`payslip`, not `payslips`).
- Enums: `ess_<entity>_<field>` (e.g. `ess_leave_request_status`).
- FK columns: `<referenced_table>_id`; when the role matters, `<role>_<table>_id`
  (`manager_employee_id`, `approver_user_id`).
- Booleans: `is_*` / `has_*` / `allows_*`.
- Timestamps: `*_at`. Dates: `*_on` or `*_date`. Money: `*_minor`. Day counts: `*_days`.
- Indexes: `ix_<table>__<col>[_<col>…]`; unique: `ux_…`; check: `ck_<table>__<rule>`;
  exclusion: `ex_<table>__<rule>`; FK: `fk_<table>__<referenced>`.

### 1.4 Money — integer minor units only

```sql
CREATE DOMAIN money_minor AS bigint;       -- Indian paise. 1 INR = 100 paise.
```

- **Never** `float`, `real`, `double precision`, or `money`.
- All amount columns are `money_minor` (i.e. `bigint`, 8 bytes, range ±9.22e18 paise ≈
  ±92 quadrillion INR — far beyond any payroll need).
- Signed amounts are permitted only where a value is genuinely bidirectional
  (`payslip_line.amount_minor` for an adjustment, `leave_balance_ledger.delta_days`).
  Every other amount carries `CHECK (col >= 0)`.
- Prisma maps `money_minor` to `BigInt`. The API layer serialises `BigInt` to a JSON
  **string of minor units** (`"8600000"`), never a JS `number`. The web layer formats
  with `'₹' + Math.round(minor / 100).toLocaleString('en-IN')` (Design System §10) —
  rounding happens **only at render time**; paise are preserved in the database.
- Rates, percentages and multipliers: `numeric(12,6)` (e.g. PF at `0.120000`).
- Day counts (half-days exist): `numeric(5,2)` with `CHECK (col >= 0)` and
  `CHECK ((col * 2) = floor(col * 2))` where only halves are legal.

### 1.5 Time

- All instants: `timestamptz`, stored UTC.
- All calendar facts (leave dates, pay period bounds, holidays, effective dates):
  `date`, interpreted in `organization.timezone` (`Asia/Kolkata`).
- The Financial Year is April–March; quarters Q1 Apr–Jun … Q4 Jan–Mar
  (Design System §10). Represented by `fiscal_year` and `fiscal_quarter` (§4.6), never
  computed ad hoc in application code.

### 1.6 Application-layer encryption (AES-256-GCM envelope)

Sensitive columns are **never** stored as plaintext. They use a fixed five-column
envelope, generated by a shared Prisma/TypeScript helper so the shape is identical
everywhere:

| Suffix | Type | Null | Meaning |
|---|---|---|---|
| `<field>_ct` | `bytea` | see table | AES-256-GCM ciphertext of the UTF-8 plaintext |
| `<field>_iv` | `bytea` | same as `_ct` | 12-byte random nonce, unique per write |
| `<field>_tag` | `bytea` | same as `_ct` | 16-byte GCM authentication tag |
| `<field>_dek_id` | `uuid` | same as `_ct` | FK → `data_encryption_key(id)` — identifies the wrapped DEK and therefore the key version |
| `<field>_mask` | `text` | same as `_ct` | **Deterministic masked projection**, computed at write time, safe to read and render |

Plus, where equality lookup or duplicate detection is required (PAN, Aadhaar, bank
account number):

| Suffix | Type | Meaning |
|---|---|---|
| `<field>_fpr` | `bytea` | `HMAC-SHA256(pepper_v<n>, normalise(plaintext))`, 32 bytes. Blind index for uniqueness and search. Never reversible. The pepper lives in the secret manager, not in the database. |

Constraints applied to every envelope:

```sql
CONSTRAINT ck_<table>__<field>_envelope CHECK (
  num_nulls(<field>_ct, <field>_iv, <field>_tag, <field>_dek_id, <field>_mask) IN (0, 5)
),
CONSTRAINT ck_<table>__<field>_iv_len  CHECK (<field>_iv  IS NULL OR octet_length(<field>_iv)  = 12),
CONSTRAINT ck_<table>__<field>_tag_len CHECK (<field>_tag IS NULL OR octet_length(<field>_tag) = 16)
```

**Additional authenticated data (AAD).** Every encrypt/decrypt passes
`AAD = organization_id || '|' || <table> || '|' || <field> || '|' || <row id>`. A
ciphertext copied into another row or another column fails authentication, so
cut-and-paste tampering is detected by GCM, not by application logic.

**Envelope key hierarchy.** `data_encryption_key` (§17.3) holds DEKs wrapped by a KMS
master key (AWS KMS / GCP KMS / Fly-hosted HashiCorp Vault transit). Rotation creates a
new `data_encryption_key` row with `version = max+1`; existing rows are re-encrypted
lazily by the `crypto-rewrap` background job. Nothing in the database can decrypt
anything without a live KMS grant.

**Masking rules** (`<field>_mask`, matching the prototype's rendering verbatim):

| Field | Mask rule | Example (prototype) |
|---|---|---|
| Bank account number | last 4 digits, grouped: `'•••• •••• ' || right(digits, 4)` | `•••• •••• 4412` |
| Bank account (inline, e.g. payslip header) | `'••' || right(digits, 4)` | `••4412` |
| IFSC | **not encrypted** — IFSC is a public bank-branch code, stored plaintext | `HDFC0000523` |
| PAN | first 5 + 4 bullets + last 1 | `AXYPR••••K` |
| Aadhaar | `'•••• •••• ' || right(digits, 4)` | `•••• •••• 8821` |
| UAN | plaintext, formatted in groups of 4 (not secret under EPFO rules, but read-restricted) | `1012 3456 7890` |
| PRAN (NPS) | `'••••' || right(digits, 4)` | `••••4471` |
| Tax declaration amounts | no mask; whole row is permission-gated, decrypted only for the owning employee and `tax:declaration:read:any` | — |

**Which columns are encrypted.** Exactly these, and nothing else:

| Table | Encrypted fields | Blind index |
|---|---|---|
| `employee_bank_account` | `account_number`, `account_holder_name` | `account_number_fpr` |
| `employee_statutory_id` | `value` (PAN / Aadhaar / UAN / PRAN / ESI / PF account) | `value_fpr` |
| `employee_personal_detail` | `personal_email`, `personal_mobile`, `date_of_birth`, `current_address`, `permanent_address` | `personal_email_fpr` |
| `employee_emergency_contact` | `contact_name`, `phone`, `relationship_note` | — |
| `dependent` | `full_name`, `date_of_birth` | — |
| `nominee` | `full_name`, `relationship`, `share_percent_note` | — |
| `employee_tax_declaration_item` | `declared_amount_minor` (as decimal string) | — |
| `salary_structure_component` | `amount_minor` (as decimal string) | — |
| `payroll_input_item` | `amount_minor` (as decimal string) | — |
| `payslip_line` | `amount_minor` (as decimal string) | — |
| `payslip` | `gross_earnings_minor`, `total_deductions_minor`, `net_pay_minor`, `employer_pf_minor`, `tds_minor` (as decimal strings) | — |
| `mfa_credential` | `totp_secret` | — |
| `mfa_recovery_code` | *(not encrypted — Argon2id hashed, see §6.3)* | — |

> **Why salary amounts are encrypted.** Payroll amounts are the highest-value target in
> an ESS. Encrypting them at the application layer means a stolen database dump, a
> leaked read replica, or a logical-replication tap yields no compensation data without
> a live KMS grant. The cost is that **aggregates over money must be computed in the
> API layer, not in SQL**. Section 20 therefore specifies, for every money aggregate,
> the exact row set the API fetches and folds — never a SQL `SUM()` over an encrypted
> column. Where a money aggregate must be queryable (only two cases: `payslip`
> totals for the Payslips YTD tiles, and `expense_claim` totals for the Expenses stat
> tiles), a **pre-aggregated, non-reversible rollup** is persisted instead:
> `payslip_fy_rollup` (§10.9) and `expense_fy_rollup` (§13.4), both written inside the
> same transaction as the underlying row and both holding only per-employee,
> per-FY totals that the employee is already entitled to see.

### 1.7 Prisma mapping rules

- `@@schema("ess")` with `previewFeatures = ["multiSchema"]`.
- Every table gets `@@map("<table_name>")`; every column `@map("<column_name>")`.
- `uuid` → `String @db.Uuid`; `citext` → `String @db.Citext`; `bytea` → `Bytes`;
  `money_minor`/`bigint` → `BigInt @db.BigInt`; `numeric(p,s)` → `Decimal @db.Decimal(p,s)`;
  `jsonb` → `Json @db.JsonB`; `timestamptz` → `DateTime @db.Timestamptz(6)`;
  `date` → `DateTime @db.Date`; `tstzrange`/`daterange` → `Unsupported("daterange")`.
- Postgres enums → Prisma `enum` with `@@map`.
- **Raw SQL migrations are required** (Prisma cannot express them) for: all triggers,
  all `EXCLUDE` constraints, all partial and expression indexes, `CHECK` constraints
  containing subqueries or `num_nulls`, the `audit_event` hash chain, the
  append-only/immutability rules, `pg_trgm` indexes, and the RLS policies in §1.8.
  Each is delivered as a hand-written file under `apps/api/prisma/migrations/`.
- Prisma relation `onDelete` must be set to exactly the `ON DELETE` behaviour stated in
  each table below, and the generated SQL must be diffed against this document in CI
  (`npm run db:verify-schema`).

### 1.8 Row-level security (defence in depth)

Authorization is enforced **server-side in the API** (that is the primary control).
RLS is a second, independent layer so that a query-construction bug cannot leak another
employee's row.

- The API connects as role `ess_app`, which is **not** the table owner and has no
  `BYPASSRLS`.
- Every request opens its transaction with
  `SET LOCAL ess.actor_user_id = $1; SET LOCAL ess.actor_employee_id = $2; SET LOCAL ess.organization_id = $3; SET LOCAL ess.scopes = $4;`
  (`$4` is a comma-separated permission-code list).
- Every table in `ess` has `ENABLE ROW LEVEL SECURITY` plus, at minimum, a tenancy
  policy:
  `USING (organization_id = current_setting('ess.organization_id')::uuid)`.
- Employee-owned tables (`payslip`, `leave_request`, `expense_claim`, `employee_document`,
  `policy_acknowledgement`, `notification`, `employee_bank_account`, …) add a self/scope
  policy:
  `USING (employee_id = current_setting('ess.actor_employee_id')::uuid OR current_setting('ess.scopes') LIKE '%<code>:read:any%' OR employee_id IN (SELECT descendant_employee_id FROM employee_reporting_closure WHERE ancestor_employee_id = current_setting('ess.actor_employee_id')::uuid AND depth > 0))`.
- `payslip` additionally requires the publication gate in §10.7.
- Migrations and scheduled jobs run as `ess_migrator` / `ess_job`, which carry
  `BYPASSRLS` and are never reachable from an HTTP request path.

### 1.9 Entity-relationship overview

```
organization ─┬─ department ─┬─ employee ──┬─ employee_personal_detail
              ├─ location    │             ├─ employee_employment (effective-dated)
              ├─ cost_centre │             ├─ employee_bank_account
              ├─ designation │             ├─ employee_statutory_id
              │              │             ├─ employee_emergency_contact
              │              │             ├─ dependent ── nominee
              │              │             └─ app_user (1:0..1)
              │              └─ employee_manager (history) ── employee_reporting_closure
              │
              ├─ LEAVE     leave_type → leave_scheme → leave_entitlement_rule
              │            leave_period → leave_balance ← leave_balance_ledger
              │            leave_request → leave_request_day
              │            holiday_calendar → holiday
              │
              ├─ ATTEND.   attendance_period → attendance_record
              │            attendance_submission → attendance_approval
              │
              ├─ PAYROLL   pay_component
              │            salary_structure → salary_structure_component
              │            payroll_cycle ─┬─ payroll_input_batch → payroll_input_item
              │                           ├─ payroll_validation_result
              │                           ├─ payroll_run → payslip → payslip_line
              │                           │                      └─ payslip_publication
              │                           └─ reimbursement_batch → reimbursement_batch_item
              │
              ├─ TAX       tax_regime, employee_tax_regime_election
              │            employee_tax_declaration → …_item
              │            employee_tax_projection, tds_quarter, form16_document
              │
              ├─ BENEFITS  benefit_plan → benefit_plan_year → benefit_enrolment
              │                                            └─ benefit_enrolment_dependent
              │
              ├─ EXPENSES  expense_category → expense_limit
              │            expense_claim → expense_claim_line → expense_attachment
              │
              ├─ DOCS      document_type → employee_document
              │            letter_template → document_request
              │
              ├─ POLICY    policy → policy_version ─┬─ policy_version_point
              │                                     ├─ policy_applicability_rule
              │                                     └─ policy_assignment → policy_acknowledgement
              │
              ├─ COMMS     announcement → announcement_audience / announcement_read
              │            notification
              │
              ├─ HELPDESK  ticket_category → helpdesk_ticket → ticket_comment / ticket_attachment
              │            faq_article
              │
              ├─ APPROVAL  approval_task → approval_decision      (unifies leave / expense / attendance)
              │
              └─ CROSS     file_object, email_outbox, audit_event, state_transition,
                           data_encryption_key, role/permission/user_role
```

---
## 2. Enum catalogue

Every enum below is a native Postgres enum in schema `ess`. Adding a value is a
forward-only migration (`ALTER TYPE … ADD VALUE`); removing a value is forbidden.

| Enum | Values |
|---|---|
| `ess_employment_status` | `PRE_JOINING`, `ACTIVE`, `ON_LEAVE`, `NOTICE_PERIOD`, `SUSPENDED`, `EXITED` |
| `ess_employment_type` | `FULL_TIME_PERMANENT`, `FULL_TIME_PROBATION`, `FIXED_TERM`, `INTERN`, `CONTRACTOR`, `CONSULTANT` |
| `ess_gender` | `FEMALE`, `MALE`, `NON_BINARY`, `UNDISCLOSED` |
| `ess_marital_status` | `SINGLE`, `MARRIED`, `DIVORCED`, `WIDOWED`, `UNDISCLOSED` |
| `ess_blood_group` | `A_POS`, `A_NEG`, `B_POS`, `B_NEG`, `AB_POS`, `AB_NEG`, `O_POS`, `O_NEG`, `UNKNOWN` |
| `ess_user_status` | `INVITED`, `ACTIVE`, `LOCKED`, `DISABLED` |
| `ess_mfa_method` | `TOTP` |
| `ess_login_outcome` | `SUCCESS`, `BAD_CREDENTIALS`, `UNKNOWN_USER`, `MFA_REQUIRED`, `MFA_FAILED`, `LOCKED`, `DISABLED`, `RATE_LIMITED` |
| `ess_statutory_id_kind` | `PAN`, `AADHAAR`, `UAN`, `PF_ACCOUNT`, `ESI`, `PRAN`, `PASSPORT` |
| `ess_leave_unit` | `DAY`, `HALF_DAY` |
| `ess_leave_accrual_frequency` | `MONTHLY`, `QUARTERLY`, `ANNUAL`, `NONE` |
| `ess_leave_request_status` | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `CANCELLED` |
| `ess_leave_day_portion` | `FULL`, `FIRST_HALF`, `SECOND_HALF` |
| `ess_leave_ledger_kind` | `OPENING`, `ACCRUAL`, `CARRY_FORWARD_IN`, `CARRY_FORWARD_OUT`, `CONSUMPTION`, `CONSUMPTION_REVERSAL`, `ENCASHMENT`, `LAPSE`, `ADJUSTMENT` |
| `ess_holiday_kind` | `PUBLIC`, `RESTRICTED`, `WEEKEND_COMPENSATORY` |
| `ess_attendance_period_status` | `OPEN`, `HR_SUBMITTED`, `MANAGER_APPROVAL_PENDING`, `APPROVED`, `LOCKED`, `REOPENED` |
| `ess_attendance_record_status` | `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `LOCKED` |
| `ess_attendance_approval_status` | `PENDING`, `APPROVED`, `REJECTED`, `AUTO_ESCALATED` |
| `ess_attendance_source` | `HR_MANUAL`, `HR_BULK_UPLOAD`, `BIOMETRIC_IMPORT`, `SYSTEM_DERIVED` |
| `ess_pay_component_kind` | `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `INFORMATIONAL` |
| `ess_pay_component_calc` | `FIXED`, `PERCENT_OF_BASIC`, `PERCENT_OF_GROSS`, `SLAB`, `INPUT_DRIVEN`, `STATUTORY_ENGINE`, `PRORATED_FIXED` |
| `ess_payroll_cycle_status` | `DRAFT`, `INPUTS_OPEN`, `INPUTS_LOCKED`, `ATTENDANCE_SUBMITTED`, `ATTENDANCE_APPROVED`, `VALIDATING`, `VALIDATION_FAILED`, `VALIDATED`, `CALCULATING`, `CALCULATED`, `APPROVED`, `PUBLISHED`, `CLOSED`, `CANCELLED` |
| `ess_payroll_input_batch_status` | `UPLOADING`, `PARSED`, `PARSE_FAILED`, `VALIDATED`, `COMMITTED`, `SUPERSEDED`, `DISCARDED` |
| `ess_payroll_input_kind` | `VARIABLE_PAY`, `INCENTIVE`, `BONUS`, `ARREAR`, `ONE_OFF_DEDUCTION`, `LOP_OVERRIDE`, `REIMBURSEMENT_PAYOUT`, `ADVANCE_RECOVERY`, `TDS_OVERRIDE` |
| `ess_payroll_validation_severity` | `INFO`, `WARNING`, `ERROR` |
| `ess_payroll_run_status` | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SUPERSEDED` |
| `ess_payslip_status` | `GENERATED`, `PUBLISHED`, `SUPERSEDED`, `REVOKED` |
| `ess_payslip_line_kind` | `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `INFORMATIONAL` |
| `ess_tax_regime_code` | `OLD`, `NEW` |
| `ess_tax_declaration_status` | `DRAFT`, `SUBMITTED`, `PROOF_PENDING`, `PROOF_SUBMITTED`, `VERIFIED`, `REJECTED` |
| `ess_tds_quarter_status` | `UPCOMING`, `IN_PROGRESS`, `FILED`, `REVISED` |
| `ess_form16_status` | `PENDING`, `ISSUED`, `REVISED`, `WITHDRAWN` |
| `ess_benefit_category` | `HEALTH`, `LIFE`, `ACCIDENT`, `RETIREMENT`, `WELLNESS`, `ALLOWANCE`, `OTHER` |
| `ess_benefit_coverage_kind` | `FIXED_SUM_INSURED`, `MULTIPLE_OF_CTC`, `MONTHLY_AMOUNT`, `PERCENT_OF_BASIC`, `NON_MONETARY` |
| `ess_benefit_enrolment_status` | `ELIGIBLE`, `ENROLLED`, `WAIVED`, `PENDING_DOCUMENTS`, `LAPSED`, `TERMINATED` |
| `ess_benefit_action` | `NONE`, `DOWNLOAD_ECARD`, `VIEW_POLICY_DOCUMENT`, `CHANGE_CONTRIBUTION`, `ADD_DEPENDENT`, `RAISE_TICKET` |
| `ess_dependent_relationship` | `SPOUSE`, `SON`, `DAUGHTER`, `FATHER`, `MOTHER`, `FATHER_IN_LAW`, `MOTHER_IN_LAW`, `SIBLING`, `OTHER` |
| `ess_expense_claim_status` | `DRAFT`, `SUBMITTED`, `PENDING_MANAGER`, `MANAGER_APPROVED`, `MANAGER_REJECTED`, `PENDING_FINANCE`, `FINANCE_APPROVED`, `FINANCE_REJECTED`, `QUEUED_FOR_PAYMENT`, `REIMBURSED`, `WITHDRAWN`, `CANCELLED` |
| `ess_expense_limit_basis` | `PER_CLAIM`, `PER_LINE`, `PER_DAY`, `PER_MONTH`, `PER_FY` |
| `ess_reimbursement_batch_status` | `DRAFT`, `LOCKED`, `SENT_TO_PAYROLL`, `PAID`, `CANCELLED` |
| `ess_document_request_status` | `SUBMITTED`, `IN_REVIEW`, `PROCESSING`, `ISSUED`, `REJECTED`, `CANCELLED` |
| `ess_document_visibility` | `EMPLOYEE_AND_HR`, `HR_ONLY`, `EMPLOYEE_MANAGER_HR` |
| `ess_policy_status` | `DRAFT`, `PUBLISHED`, `ARCHIVED` |
| `ess_policy_version_status` | `DRAFT`, `IN_REVIEW`, `PUBLISHED`, `SUPERSEDED`, `WITHDRAWN` |
| `ess_policy_ack_status` | `PENDING`, `ACKNOWLEDGED`, `WAIVED`, `OVERDUE` |
| `ess_policy_applicability_dimension` | `ALL`, `DEPARTMENT`, `LOCATION`, `EMPLOYMENT_TYPE`, `DESIGNATION`, `COST_CENTRE`, `EMPLOYEE` |
| `ess_announcement_status` | `DRAFT`, `SCHEDULED`, `PUBLISHED`, `ARCHIVED` |
| `ess_announcement_audience_kind` | `ALL`, `DEPARTMENT`, `LOCATION`, `EMPLOYMENT_TYPE`, `EMPLOYEE` |
| `ess_ticket_status` | `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `WAITING_ON_EMPLOYEE`, `RESOLVED`, `CLOSED`, `REOPENED`, `CANCELLED` |
| `ess_ticket_priority` | `LOW`, `NORMAL`, `HIGH`, `URGENT` |
| `ess_ticket_comment_visibility` | `PUBLIC`, `INTERNAL` |
| `ess_approval_task_kind` | `LEAVE_REQUEST`, `EXPENSE_CLAIM`, `ATTENDANCE_PERIOD`, `PROFILE_CHANGE`, `DOCUMENT_REQUEST` |
| `ess_approval_task_status` | `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`, `REASSIGNED` |
| `ess_approval_decision_outcome` | `APPROVED`, `REJECTED`, `REASSIGNED`, `AUTO_APPROVED`, `AUTO_ESCALATED` |
| `ess_notification_kind` | `PAYSLIP_PUBLISHED`, `LEAVE_SUBMITTED`, `LEAVE_DECIDED`, `EXPENSE_SUBMITTED`, `EXPENSE_DECIDED`, `EXPENSE_REIMBURSED`, `POLICY_ASSIGNED`, `POLICY_OVERDUE`, `ANNOUNCEMENT_PUBLISHED`, `TICKET_UPDATED`, `TICKET_RESOLVED`, `DOCUMENT_ISSUED`, `APPROVAL_PENDING`, `ATTENDANCE_APPROVAL_PENDING`, `PAYROLL_CYCLE_STATE`, `FORM16_ISSUED`, `SECURITY_ALERT` |
| `ess_notification_tone` | `GREEN`, `AMBER`, `RED`, `BLUE`, `GRAY` |
| `ess_file_scan_status` | `PENDING`, `CLEAN`, `INFECTED`, `SCAN_FAILED`, `SKIPPED` |
| `ess_file_purpose` | `EXPENSE_BILL`, `TICKET_ATTACHMENT`, `EMPLOYEE_DOCUMENT`, `POLICY_PDF`, `PAYSLIP_PDF`, `FORM16_PDF`, `PAYROLL_INPUT_UPLOAD`, `ATTENDANCE_UPLOAD`, `BENEFIT_DOCUMENT`, `LETTER_PDF`, `PROFILE_PROOF`, `ORG_ASSET` |
| `ess_email_status` | `QUEUED`, `SENDING`, `SENT`, `FAILED`, `SUPPRESSED`, `CANCELLED` |
| `ess_email_kind` | `HELPDESK_TICKET_CREATED`, `HELPDESK_TICKET_UPDATED`, `PAYSLIP_PUBLISHED`, `PAYSLIP_COPY_REQUESTED`, `LEAVE_DECISION`, `EXPENSE_DECISION`, `POLICY_REMINDER`, `DOCUMENT_ISSUED`, `USER_INVITE`, `PASSWORD_RESET`, `MFA_ENROLLED`, `SECURITY_ALERT` |
| `ess_audit_action` | see §17.1 — `CREATE`, `UPDATE`, `DELETE`, `READ_SENSITIVE`, `LOGIN`, `LOGOUT`, `STATE_TRANSITION`, `EXPORT`, `DOWNLOAD`, `PERMISSION_GRANT`, `PERMISSION_REVOKE`, `IMPERSONATE`, `CONFIG_CHANGE`, `CRYPTO_REWRAP` |
| `ess_actor_kind` | `USER`, `SYSTEM`, `SCHEDULER`, `MIGRATION` |
| `ess_persona` | `EMPLOYEE`, `MANAGER`, `HR`, `ACCOUNTS` |

### 2.1 `state_transition` — the single allowed-transition table

Every state machine in this system is declared here as **seeded reference data**. No
transition may be performed by the API unless a matching row exists; the service layer
calls `assertTransition(machine, from, to, actorScopes)` before every state change, and
a database trigger (`trg_guard_state_transition`) re-checks it on `UPDATE` for the
tables that carry `status`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `machine` | `text` | no | — | e.g. `leave_request`, `expense_claim`, `payroll_cycle` |
| `from_state` | `text` | yes | — | `NULL` = the creation transition (initial state) |
| `to_state` | `text` | no | — | |
| `required_permission_code` | `text` | yes | — | FK → `permission(code)` `ON DELETE RESTRICT`; `NULL` = system-only transition |
| `guard_key` | `text` | yes | — | Names a code-side guard predicate, e.g. `payroll.attendance_fully_approved`. Documented in §19. |
| `is_terminal` | `boolean` | no | `false` | `to_state` admits no outgoing transitions |
| `emits_notification_kind` | `ess_notification_kind` | yes | — | If set, the transition **must** create a `notification` row in the same transaction |
| `emits_email_kind` | `ess_email_kind` | yes | — | If set, the transition **must** enqueue an `email_outbox` row in the same transaction |
| `display_order` | `smallint` | no | `0` | |

Constraints:
```sql
PRIMARY KEY (id),
CONSTRAINT ux_state_transition__machine_from_to UNIQUE (machine, from_state, to_state),
CONSTRAINT ck_state_transition__distinct CHECK (from_state IS DISTINCT FROM to_state),
CONSTRAINT fk_state_transition__permission FOREIGN KEY (required_permission_code)
  REFERENCES permission(code) ON DELETE RESTRICT
```
Indexes: `ix_state_transition__machine_from (machine, from_state)`.

The full seeded contents are listed per module (§8.4 leave, §9.5 attendance,
§10.2 payroll cycle, §13.3 expenses, §14.3 document requests, §15.4 policy
acknowledgement, §16.4 help desk, §12.x tax declaration, §19 approval tasks).

---

## 3. RBAC: roles, permissions, personas

### 3.1 `permission` — reference data, seeded

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `code` | `text` | no | — | **Unique.** Format `<resource>:<action>[:<scope>]`, scope ∈ `self` \| `team` \| `any` |
| `resource` | `text` | no | — | Generated: `split_part(code, ':', 1)` |
| `action` | `text` | no | — | Generated: `split_part(code, ':', 2)` |
| `scope` | `text` | no | `'self'` | Generated: `coalesce(nullif(split_part(code, ':', 3), ''), 'self')` |
| `description` | `text` | no | — | Shown in the HR role-management screen |
| `is_sensitive` | `boolean` | no | `false` | Exercising it writes an `audit_event` with `action = 'READ_SENSITIVE'` |

```sql
CONSTRAINT ux_permission__code UNIQUE (code),
CONSTRAINT ck_permission__code_shape CHECK (code ~ '^[a-z_]+:[a-z_]+(:(self|team|any))?$')
```
Not tenant-scoped (global reference data; no `organization_id`).

**Seeded permission codes** (complete list; the four personas are composed from these):

```
auth:login                         profile:read:self                 profile:read:team
profile:read:any                   profile:update:self               profile:update:any
profile:read_sensitive:self        profile:read_sensitive:any
payslip:read:self                  payslip:read:any                  payslip:download:self
payslip:download:any               payslip:email:self
tax:declaration:read:self          tax:declaration:write:self        tax:declaration:read:any
tax:declaration:verify             tax:form16:read:self              tax:form16:read:any
tax:form16:issue                   tax:quarter:read:self             tax:quarter:read:any
tax:quarter:manage
leave:request:read:self            leave:request:read:team           leave:request:read:any
leave:request:create:self          leave:request:withdraw:self       leave:request:approve:team
leave:request:approve:any          leave:balance:read:self           leave:balance:read:team
leave:balance:read:any             leave:balance:adjust               leave:config:manage
holiday:read                       holiday:manage
attendance:read:self               attendance:read:team              attendance:read:any
attendance:capture                 attendance:submit                 attendance:approve:team
attendance:approve:any             attendance:reopen
payroll:cycle:read                 payroll:cycle:create              payroll:cycle:transition
payroll:input:upload               payroll:input:read                payroll:input:commit
payroll:validate                   payroll:calculate                 payroll:approve
payroll:publish                    payroll:close                     payroll:salary_structure:read:any
payroll:salary_structure:write     payroll:component:manage
benefit:read:self                  benefit:read:any                  benefit:enrol:self
benefit:manage                     dependent:read:self                dependent:write:self
dependent:read:any                 dependent:verify
expense:claim:read:self            expense:claim:read:team           expense:claim:read:any
expense:claim:create:self          expense:claim:withdraw:self       expense:claim:approve:team
expense:claim:approve:finance      expense:reimburse                 expense:config:manage
document:read:self                 document:read:any                 document:upload:any
document:request:create:self       document:request:read:self        document:request:read:any
document:request:fulfil            document:type:manage
policy:read                        policy:acknowledge:self           policy:ack:read:any
policy:author                      policy:publish
directory:read                     directory:read_contact
announcement:read                  announcement:author               announcement:publish
ticket:create:self                 ticket:read:self                  ticket:read:any
ticket:comment:self                ticket:comment:any                ticket:assign
ticket:resolve                     ticket:config:manage
approval:task:read:self            approval:task:read:any            approval:task:act
notification:read:self             notification:mark_read:self
org:read                           org:manage                        employee:create
employee:read:any                  employee:update:any               employee:deactivate
role:read                          role:assign                       role:manage
audit:read                         audit:export                      security:session:revoke
security:mfa:reset                 file:download:self                file:download:any
report:payroll:read                report:leave:read                 report:expense:read
```

`is_sensitive = true` for: `profile:read_sensitive:*`, `payslip:read:any`,
`payslip:download:any`, `payroll:salary_structure:read:any`,
`tax:declaration:read:any`, `audit:read`, `audit:export`, `file:download:any`,
`employee:read:any`, `security:mfa:reset`, `security:session:revoke`.

### 3.2 `role` — reference data, seeded (exactly four)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `persona` | `ess_persona` | no | — | The four personas. **Unique per organization.** |
| `name` | `text` | no | — | `Employee`, `Manager`, `HR`, `Accounts` |
| `description` | `text` | no | — | |
| `is_assignable` | `boolean` | no | `true` | `EMPLOYEE` is auto-assigned on employee activation and cannot be revoked while the employee is `ACTIVE` |
| `nav_group_label` | `text` | yes | — | Extra sidebar group this persona unlocks (`Manager`, `People Ops`, `Payroll`). `NULL` for `EMPLOYEE`. |

```sql
CONSTRAINT ux_role__org_persona UNIQUE (organization_id, persona)
```

### 3.3 `role_permission`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `role_id` | `uuid` | no | — | FK → `role(id)` `ON DELETE CASCADE` |
| `permission_id` | `uuid` | no | — | FK → `permission(id)` `ON DELETE RESTRICT` |
| `granted_at` | `timestamptz` | no | `now()` | |
| `granted_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |

```sql
PRIMARY KEY (role_id, permission_id)
```
Index: `ix_role_permission__permission (permission_id)`.
Every insert/delete writes an `audit_event` with `action` `PERMISSION_GRANT` /
`PERMISSION_REVOKE`.

**Seeded persona → permission mapping (authoritative):**

- **EMPLOYEE** — `auth:login`, `profile:read:self`, `profile:update:self`,
  `profile:read_sensitive:self`, `payslip:read:self`, `payslip:download:self`,
  `payslip:email:self`, all `tax:*:self` + `tax:declaration:write:self`,
  `leave:request:{read,create,withdraw}:self`, `leave:balance:read:self`,
  `holiday:read`, `attendance:read:self`, `benefit:read:self`, `benefit:enrol:self`,
  `dependent:{read,write}:self`, `expense:claim:{read,create,withdraw}:self`,
  `document:read:self`, `document:request:{create,read}:self`, `policy:read`,
  `policy:acknowledge:self`, `directory:read`, `directory:read_contact`,
  `announcement:read`, `ticket:{create,read,comment}:self`,
  `approval:task:read:self`, `notification:{read,mark_read}:self`,
  `file:download:self`, `org:read`.
- **MANAGER** — everything in EMPLOYEE, plus `profile:read:team`,
  `leave:request:read:team`, `leave:request:approve:team`, `leave:balance:read:team`,
  `attendance:read:team`, `attendance:approve:team`, `expense:claim:read:team`,
  `expense:claim:approve:team`, `approval:task:{read:any,act}`, `report:leave:read`.
  Manager scope is **always** bounded by `employee_reporting_closure` (§5.5) — a
  Manager never sees an employee outside their subtree.
- **HR** — everything in EMPLOYEE, plus `profile:read:any`, `profile:update:any`,
  `profile:read_sensitive:any`, `employee:{create,read:any,update:any,deactivate}`,
  `leave:*:any` + `leave:balance:adjust` + `leave:config:manage`, `holiday:manage`,
  `attendance:{read:any,capture,submit,reopen}`, `attendance:approve:any`
  (escalation only, guarded — see §9.5), `benefit:manage`, `dependent:{read:any,verify}`,
  `document:{read:any,upload:any,type:manage}`, `document:request:{read:any,fulfil}`,
  `policy:{author,publish}`, `policy:ack:read:any`,
  `announcement:{author,publish}`, `ticket:{read:any,comment:any,assign,resolve,config:manage}`,
  `role:{read,assign}`, `org:manage`, `audit:read`, `security:{session:revoke,mfa:reset}`,
  `file:download:any`, `report:{leave,expense}:read`, `payroll:cycle:read`,
  `tax:form16:read:any`.
  **HR does not hold** `payroll:calculate`, `payroll:approve`, `payroll:publish`,
  `payroll:input:*`, or `payroll:salary_structure:*` — separation of duties.
- **ACCOUNTS** — everything in EMPLOYEE, plus `payroll:cycle:{read,create,transition}`,
  `payroll:input:{upload,read,commit}`, `payroll:{validate,calculate,approve,publish,close}`,
  `payroll:salary_structure:{read:any,write}`, `payroll:component:manage`,
  `payslip:{read:any,download:any}`, `tax:{declaration:read:any,declaration:verify,form16:{read:any,issue},quarter:{read:any,manage}}`,
  `expense:{claim:read:any,claim:approve:finance,reimburse,config:manage}`,
  `attendance:read:any`, `report:payroll:read`, `audit:read`, `file:download:any`.
  **ACCOUNTS does not hold** `attendance:submit` or `attendance:approve:*` — the payroll
  operator cannot manufacture their own attendance inputs.

> **Dual control.** `payroll:approve` and `payroll:publish` are held by ACCOUNTS, but
> the guard `payroll.distinct_approver` (§10.2) forbids the same `app_user` from being
> both `calculated_by_user_id` and `approved_by_user_id` on a cycle. Two Accounts users
> are therefore required to publish payroll.

### 3.4 `user_role`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE CASCADE` |
| `role_id` | `uuid` | no | — | FK → `role(id)` `ON DELETE RESTRICT` |
| `granted_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `granted_at` | `timestamptz` | no | `now()` | |
| `valid_from` | `date` | no | `CURRENT_DATE` | |
| `valid_to` | `date` | yes | — | `NULL` = open-ended |
| `revoked_at` | `timestamptz` | yes | — | |
| `revoked_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `reason` | `text` | yes | — | Required (enforced in API) when revoking |

```sql
CONSTRAINT ck_user_role__valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
CONSTRAINT ck_user_role__revocation  CHECK (num_nulls(revoked_at, revoked_by_user_id) IN (0, 2))
```
Indexes:
- `ux_user_role__active (app_user_id, role_id) WHERE revoked_at IS NULL` — one live grant per role.
- `ix_user_role__org_role (organization_id, role_id) WHERE revoked_at IS NULL`.
- `ix_user_role__user_active (app_user_id) WHERE revoked_at IS NULL AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`.

**A user may hold more than one persona** (the prototype's `role` prop toggles the
Manager group; in production the sidebar renders a group per held persona). The
effective permission set is the union of all live `user_role` → `role_permission`
codes, computed once per access token and embedded as the `scopes` claim.

---
## 4. Tenancy and organisation

### 4.1 `organization`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `code` | `citext` | no | — | Unique. `WDT` |
| `legal_name` | `text` | no | — | `Widedrop Technologies Private Limited` |
| `display_name` | `text` | no | — | `Widedrop` — sidebar line 1 |
| `portal_name` | `text` | no | `'Employee portal'` | Sidebar line 2 |
| `logo_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `timezone` | `text` | no | `'Asia/Kolkata'` | IANA zone; drives every `date` interpretation |
| `locale` | `text` | no | `'en-IN'` | Drives number/date formatting |
| `currency_code` | `char(3)` | no | `'INR'` | ISO 4217 |
| `currency_minor_unit_scale` | `smallint` | no | `2` | paise per rupee = 10^2 |
| `fy_start_month` | `smallint` | no | `4` | April |
| `leave_year_start_month` | `smallint` | no | `1` | The prototype's Leave screen reads "Leave year Jan – Dec 2026" |
| `week_off_days` | `smallint[]` | no | `'{0,6}'` | ISO-ish day numbers (0 = Sunday). Drives working-day counting. |
| `helpdesk_email` | `citext` | no | `'helpdesk@widedroptech.com'` | Destination for §16 dispatch |
| `payroll_pay_day_rule` | `text` | no | `'LAST_WORKING_DAY'` | `LAST_WORKING_DAY` \| `FIXED_DAY` |
| `payroll_pay_day_of_month` | `smallint` | yes | — | Required when rule = `FIXED_DAY` |
| `expense_cutoff_day_of_month` | `smallint` | no | `25` | Drives the Expenses copy "approved by the 25th" |
| `default_holiday_calendar_id` | `uuid` | yes | — | FK → `holiday_calendar(id)` `ON DELETE SET NULL` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_organization__code UNIQUE (code),
CONSTRAINT ck_organization__fy_month CHECK (fy_start_month BETWEEN 1 AND 12),
CONSTRAINT ck_organization__leave_month CHECK (leave_year_start_month BETWEEN 1 AND 12),
CONSTRAINT ck_organization__cutoff CHECK (expense_cutoff_day_of_month BETWEEN 1 AND 28),
CONSTRAINT ck_organization__pay_day CHECK (
  (payroll_pay_day_rule = 'FIXED_DAY' AND payroll_pay_day_of_month BETWEEN 1 AND 28)
  OR (payroll_pay_day_rule = 'LAST_WORKING_DAY' AND payroll_pay_day_of_month IS NULL)
),
CONSTRAINT ck_organization__minor_scale CHECK (currency_minor_unit_scale BETWEEN 0 AND 4)
```

### 4.2 `department`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `parent_department_id` | `uuid` | yes | — | FK → `department(id)` `ON DELETE RESTRICT` — self-referential hierarchy |
| `code` | `citext` | no | — | `PLAT-ENG` |
| `name` | `text` | no | — | `Platform Engineering` |
| `business_unit` | `text` | yes | — | `Product & Engineering` — rendered on the Employment profile tab |
| `head_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE SET NULL` (deferrable; employees reference departments) |
| `accent_colour_hex` | `char(7)` | yes | — | Directory avatar tint (Design System §1). `NULL` → UI falls back to `--bg-selected` `#1B365D`. |
| `is_active` | `boolean` | no | `true` | |
| `display_order` | `smallint` | no | `0` | |

```sql
CONSTRAINT ux_department__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_department__hex CHECK (accent_colour_hex IS NULL OR accent_colour_hex ~ '^#[0-9A-Fa-f]{6}$'),
CONSTRAINT ck_department__not_self_parent CHECK (parent_department_id IS DISTINCT FROM id)
```
Indexes: `ix_department__org_active (organization_id, is_active, display_order)`,
`ix_department__parent (parent_department_id)`.
Cycle prevention: trigger `trg_department_no_cycle` walks `parent_department_id` on
insert/update and raises on revisit.

### 4.3 `location`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `BLR-ECO` |
| `name` | `text` | no | — | `Ecospace Campus` |
| `site_label` | `text` | yes | — | `Ecospace Tower A` — the Home sub-header |
| `city` | `text` | no | — | `Bengaluru` |
| `state` | `text` | yes | — | `Karnataka` |
| `country_code` | `char(2)` | no | `'IN'` | ISO 3166-1 |
| `timezone` | `text` | no | `'Asia/Kolkata'` | |
| `holiday_calendar_id` | `uuid` | yes | — | FK → `holiday_calendar(id)` `ON DELETE SET NULL` — the Home "Bengaluru calendar" label comes from `holiday_calendar.name` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_location__org_code UNIQUE (organization_id, code)
```
Index: `ix_location__org_city (organization_id, city) WHERE is_active`.

### 4.4 `cost_centre`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `CC-4120` |
| `name` | `text` | no | — | `Platform` — profile renders `CC-4120 · Platform` |
| `department_id` | `uuid` | yes | — | FK → `department(id)` `ON DELETE RESTRICT` |
| `owner_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE SET NULL` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_cost_centre__org_code UNIQUE (organization_id, code)
```

### 4.5 `designation`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `SSE` |
| `title` | `text` | no | — | `Senior Software Engineer` |
| `job_level` | `smallint` | yes | — | For band-based leave/expense rules |
| `job_family` | `text` | yes | — | `Engineering` |
| `is_people_manager_track` | `boolean` | no | `false` | Informational only; management rights come from `user_role`, never from a title |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_designation__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_designation__level CHECK (job_level IS NULL OR job_level BETWEEN 1 AND 20)
```

### 4.6 `fiscal_year` and `fiscal_quarter` — reference data, generated at seed

`fiscal_year`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `text` | no | — | `FY2026-27` |
| `label` | `text` | no | — | `FY 2026–27` (en-dash, as the prototype renders) |
| `start_date` | `date` | no | — | `2026-04-01` |
| `end_date` | `date` | no | — | `2027-03-31` |
| `standard_deduction_minor` | `money_minor` | yes | — | Statutory; `75000_00` for FY 2026-27. `NULL` until Finance sets it. |
| `cess_rate` | `numeric(12,6)` | no | `0.040000` | Health & education cess |
| `declaration_window_opens_on` | `date` | yes | — | Tax screen copy |
| `declaration_window_closes_on` | `date` | yes | — | |
| `proof_window_opens_on` | `date` | yes | — | `2026-12-01` |
| `proof_window_closes_on` | `date` | yes | — | `2027-01-15` |
| `is_current` | `boolean` | no | `false` | Maintained by `trg_fiscal_year_single_current` |

```sql
CONSTRAINT ux_fiscal_year__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_fiscal_year__range CHECK (end_date > start_date),
CONSTRAINT ex_fiscal_year__no_overlap EXCLUDE USING gist (
  organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&
),
CONSTRAINT ux_fiscal_year__one_current UNIQUE (organization_id, is_current) WHERE is_current
```

`fiscal_quarter`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE CASCADE` |
| `quarter_no` | `smallint` | no | — | 1…4 |
| `label` | `text` | no | — | `Q1 · Apr – Jun 2026` — the Tax screen row label, persisted, not formatted ad hoc |
| `start_date` | `date` | no | — | |
| `end_date` | `date` | no | — | |
| `statutory_due_date` | `date` | yes | — | Form 24Q filing due date |

```sql
CONSTRAINT ux_fiscal_quarter__fy_no UNIQUE (fiscal_year_id, quarter_no),
CONSTRAINT ck_fiscal_quarter__no CHECK (quarter_no BETWEEN 1 AND 4),
CONSTRAINT ck_fiscal_quarter__range CHECK (end_date > start_date)
```

---

## 5. Identity

### 5.1 `app_user` — authentication principal

One row per person who can sign in. An `app_user` **may** have no `employee`
(a service account or an HR/Accounts contractor); an `employee` **may** have no
`app_user` (pre-joining, or exited with access revoked).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `email` | `citext` | no | — | Work email; the login identifier |
| `email_verified_at` | `timestamptz` | yes | — | |
| `password_hash` | `text` | yes | — | **Argon2id** PHC string (`$argon2id$v=19$m=65536,t=3,p=4$…`). `NULL` only while `status = 'INVITED'`. |
| `password_algo` | `text` | no | `'argon2id'` | Future-proofs a rehash campaign |
| `password_updated_at` | `timestamptz` | yes | — | |
| `password_must_change` | `boolean` | no | `false` | Set on admin reset |
| `status` | `ess_user_status` | no | `'INVITED'` | |
| `failed_login_count` | `smallint` | no | `0` | Reset to 0 on success |
| `locked_until` | `timestamptz` | yes | — | Progressive lockout (§6.4) |
| `last_login_at` | `timestamptz` | yes | — | |
| `last_login_ip` | `inet` | yes | — | |
| `mfa_enforced_at` | `timestamptz` | yes | — | Non-NULL ⇒ MFA mandatory for this user |
| `is_service_account` | `boolean` | no | `false` | Cannot hold an `employee`; cannot use interactive login |
| `token_epoch` | `integer` | no | `1` | Bumped on password change, role change, or "revoke all sessions". Access tokens carry `epc`; a mismatch ⇒ `401`. |
| `terms_accepted_at` | `timestamptz` | yes | — | |
| `disabled_at` | `timestamptz` | yes | — | |
| `disabled_reason` | `text` | yes | — | |

```sql
CONSTRAINT ux_app_user__org_email UNIQUE (organization_id, email),
CONSTRAINT ck_app_user__password_present CHECK (status = 'INVITED' OR password_hash IS NOT NULL),
CONSTRAINT ck_app_user__service_no_login CHECK (NOT is_service_account OR mfa_enforced_at IS NULL),
CONSTRAINT ck_app_user__failed_count CHECK (failed_login_count >= 0),
CONSTRAINT ck_app_user__disabled CHECK (num_nulls(disabled_at, disabled_reason) IN (0, 2))
```
Indexes:
- `ux_app_user__org_email (organization_id, email)`
- `ix_app_user__status (organization_id, status)`
- `ix_app_user__locked (locked_until) WHERE locked_until IS NOT NULL`

### 5.2 `employee` — the identity spine

Holds only the **stable, non-sensitive** identity. Effective-dated employment facts live
in `employee_employment` (§5.3); encrypted personal facts in `employee_personal_detail`
(§5.6).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `app_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL`; **unique** |
| `employee_number` | `citext` | no | — | `WDT-01847`. Unique per org. Generated by `employee_number_seq` + org prefix; never reused. |
| `first_name` | `text` | no | — | |
| `middle_name` | `text` | yes | — | |
| `last_name` | `text` | no | — | |
| `full_name` | `text` | no | *(generated)* | `GENERATED ALWAYS AS (btrim(first_name \|\| ' ' \|\| coalesce(middle_name \|\| ' ', '') \|\| last_name)) STORED` — the Directory/Profile display name |
| `preferred_name` | `text` | yes | — | |
| `initials` | `text` | no | *(generated)* | `GENERATED ALWAYS AS (upper(left(first_name,1) \|\| left(last_name,1))) STORED` — avatar initials, so the UI never derives them client-side |
| `work_email` | `citext` | no | — | `priya.raghavan@widedrop.com`. Unique per org. |
| `work_phone` | `text` | yes | — | Directory phone. Not encrypted (it is a published work number); gated by `directory:read_contact`. |
| `date_of_joining` | `date` | no | — | Tenure is computed from this, never stored |
| `probation_end_date` | `date` | yes | — | |
| `date_of_exit` | `date` | yes | — | |
| `employment_status` | `ess_employment_status` | no | `'PRE_JOINING'` | |
| `is_directory_listed` | `boolean` | no | `true` | An employee may be hidden from Directory by HR |
| `photo_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL`. When NULL the UI renders `initials` on the department accent — never a stock image. |

```sql
CONSTRAINT ux_employee__org_number UNIQUE (organization_id, employee_number),
CONSTRAINT ux_employee__org_work_email UNIQUE (organization_id, work_email),
CONSTRAINT ux_employee__app_user UNIQUE (app_user_id),
CONSTRAINT ck_employee__exit_after_join CHECK (date_of_exit IS NULL OR date_of_exit >= date_of_joining),
CONSTRAINT ck_employee__exited_has_date CHECK (employment_status <> 'EXITED' OR date_of_exit IS NOT NULL),
CONSTRAINT ck_employee__probation CHECK (probation_end_date IS NULL OR probation_end_date >= date_of_joining)
```
Indexes:
- `ix_employee__org_status (organization_id, employment_status)`
- `ix_employee__org_directory (organization_id, is_directory_listed, full_name) WHERE employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD')`
- `ix_employee__search_trgm` — `GIN ((full_name || ' ' || work_email) gin_trgm_ops)` for Directory and global search
- `ix_employee__org_joining (organization_id, date_of_joining)`

### 5.3 `employee_employment` — effective-dated employment facts

Never updated in place for a change of designation/department/manager/notice period; a
new row is inserted and the previous row's `effective_to` is closed. This is what makes
payroll reproducible: a payslip resolves the row effective on its period end date.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `effective_from` | `date` | no | — | |
| `effective_to` | `date` | yes | — | `NULL` = current row |
| `designation_id` | `uuid` | no | — | FK → `designation(id)` `ON DELETE RESTRICT` |
| `department_id` | `uuid` | no | — | FK → `department(id)` `ON DELETE RESTRICT` |
| `location_id` | `uuid` | no | — | FK → `location(id)` `ON DELETE RESTRICT` |
| `cost_centre_id` | `uuid` | yes | — | FK → `cost_centre(id)` `ON DELETE RESTRICT` |
| `employment_type` | `ess_employment_type` | no | — | Profile renders `Full-time · Permanent` from this |
| `hr_business_partner_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE SET NULL` — profile's "HR business partner" |
| `notice_period_days` | `smallint` | no | `0` | Profile's "Notice period" |
| `weekly_off_days` | `smallint[]` | yes | — | Overrides `organization.week_off_days` for shift workers |
| `holiday_calendar_id` | `uuid` | yes | — | FK → `holiday_calendar(id)` `ON DELETE RESTRICT`. Resolution order: this → `location.holiday_calendar_id` → `organization.default_holiday_calendar_id`. |
| `change_reason` | `text` | no | — | `NEW_HIRE`, `PROMOTION`, `TRANSFER`, `MANAGER_CHANGE`, `CORRECTION`, `EXIT` |
| `effective_document_id` | `uuid` | yes | — | FK → `employee_document(id)` `ON DELETE SET NULL` — e.g. the promotion letter that evidences this row |

```sql
CONSTRAINT ck_employee_employment__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
CONSTRAINT ck_employee_employment__notice CHECK (notice_period_days BETWEEN 0 AND 365),
CONSTRAINT ex_employee_employment__no_overlap EXCLUDE USING gist (
  employee_id WITH =, daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') WITH &&
)
```
Indexes:
- `ux_employee_employment__current (employee_id) WHERE effective_to IS NULL`
- `ix_employee_employment__dept_current (organization_id, department_id) WHERE effective_to IS NULL`
- `ix_employee_employment__asof (employee_id, effective_from DESC)`

Resolution helper (used everywhere a "current" employment fact is needed):

```sql
CREATE FUNCTION employment_as_of(p_employee uuid, p_on date)
RETURNS employee_employment LANGUAGE sql STABLE AS $$
  SELECT * FROM employee_employment
  WHERE employee_id = p_employee
    AND effective_from <= p_on
    AND (effective_to IS NULL OR effective_to >= p_on)
  ORDER BY effective_from DESC LIMIT 1
$$;
```

### 5.4 `employee_manager` — reporting relationship history

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `manager_employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `relationship_kind` | `text` | no | `'PRIMARY'` | `PRIMARY` \| `DOTTED_LINE` \| `DELEGATE` |
| `effective_from` | `date` | no | — | |
| `effective_to` | `date` | yes | — | `NULL` = current |
| `assigned_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `reason` | `text` | yes | — | |

```sql
CONSTRAINT ck_employee_manager__not_self CHECK (employee_id <> manager_employee_id),
CONSTRAINT ck_employee_manager__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
CONSTRAINT ck_employee_manager__kind CHECK (relationship_kind IN ('PRIMARY','DOTTED_LINE','DELEGATE')),
CONSTRAINT ex_employee_manager__one_primary EXCLUDE USING gist (
  employee_id WITH =, relationship_kind WITH =,
  daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]') WITH &&
) WHERE (relationship_kind = 'PRIMARY')
```
Indexes:
- `ux_employee_manager__current_primary (employee_id) WHERE effective_to IS NULL AND relationship_kind = 'PRIMARY'`
- `ix_employee_manager__manager_current (manager_employee_id) WHERE effective_to IS NULL`
- `ix_employee_manager__org_manager (organization_id, manager_employee_id, effective_from DESC)`

The **direct manager FK** the prototype needs (`Reporting manager`, "Goes to Arjun
Malhotra", "Awaiting Arjun Malhotra") is
`employee_manager WHERE employee_id = :me AND relationship_kind='PRIMARY' AND effective_to IS NULL`.
Cycle prevention: trigger `trg_employee_manager_no_cycle` rejects an insert whose
`manager_employee_id` already appears in the employee's descendant set.

### 5.5 `employee_reporting_closure` — resolved reporting chain

Transitive closure of the **current primary** reporting graph, maintained by trigger
`trg_rebuild_reporting_closure` on `employee_manager` insert/update/delete (and by the
nightly `reporting-closure-verify` job, which recomputes and diffs). It exists so that
"everyone under manager X", "the chain above employee Y", and the Manager RLS policy are
single index scans rather than recursive CTEs on every request.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `ancestor_employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `descendant_employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `depth` | `smallint` | no | — | `0` = self, `1` = direct report, `n` = n levels down |
| `path_employee_ids` | `uuid[]` | no | — | Ancestor → descendant, inclusive. Renders the Directory "Your reporting line" strip. |
| `computed_at` | `timestamptz` | no | `now()` | |

```sql
PRIMARY KEY (ancestor_employee_id, descendant_employee_id),
CONSTRAINT ck_closure__depth CHECK (depth >= 0),
CONSTRAINT ck_closure__self CHECK ((depth = 0) = (ancestor_employee_id = descendant_employee_id))
```
Indexes:
- `ix_closure__descendant (descendant_employee_id, depth)` — resolves the chain **above** an employee
- `ix_closure__ancestor_depth (organization_id, ancestor_employee_id, depth)` — resolves a manager's team slice
- `ix_closure__direct_reports (ancestor_employee_id) WHERE depth = 1` — the Home "Team today" card and the Approvals "3 reports" count

No audit columns (derived table); it is rebuilt, not edited.

### 5.6 `employee_personal_detail` — encrypted personal facts (1:1)

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE`; **unique** |
| `gender` | `ess_gender` | no | `'UNDISCLOSED'` | |
| `marital_status` | `ess_marital_status` | no | `'UNDISCLOSED'` | |
| `blood_group` | `ess_blood_group` | no | `'UNKNOWN'` | |
| `nationality` | `text` | yes | — | `Indian` |
| `date_of_birth_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | Mask renders `14 Feb 1994` only to `profile:read_sensitive:self|any`; otherwise the field is omitted from the payload entirely |
| `personal_email_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | Mask `p•••••••@gmail.com` |
| `personal_email_fpr` | `bytea` | yes | — | Blind index (duplicate detection) |
| `personal_mobile_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | Mask `+91 ••••• 12234` |
| `current_address_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | Mask = city + PIN only |
| `permanent_address_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | |

```sql
CONSTRAINT ux_employee_personal_detail__employee UNIQUE (employee_id)
-- plus the five envelope CHECK sets from §1.6
```
Index: `ux_employee_personal_detail__email_fpr (organization_id, personal_email_fpr) WHERE personal_email_fpr IS NOT NULL`.

### 5.7 `employee_statutory_id`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `kind` | `ess_statutory_id_kind` | no | — | |
| `value_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | e.g. PAN mask `AXYPR••••K` |
| `value_fpr` | `bytea` | no | — | Blind index; detects the same PAN on two employees |
| `is_verified` | `boolean` | no | `false` | |
| `verified_at` | `timestamptz` | yes | — | |
| `verified_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `proof_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `is_applicable` | `boolean` | no | `true` | `false` renders the profile's `Not applicable` (the prototype's ESI row) — a persisted fact, not a UI fallback |

```sql
CONSTRAINT ux_employee_statutory_id__employee_kind UNIQUE (employee_id, kind),
CONSTRAINT ux_employee_statutory_id__org_kind_fpr UNIQUE (organization_id, kind, value_fpr),
CONSTRAINT ck_employee_statutory_id__verified CHECK (num_nulls(verified_at, verified_by_user_id) IN (0, 2)),
CONSTRAINT ck_employee_statutory_id__verified_flag CHECK (is_verified = (verified_at IS NOT NULL))
```

### 5.8 `employee_bank_account`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `bank_name` | `text` | no | — | `HDFC Bank` — plaintext |
| `branch_name` | `text` | yes | — | |
| `ifsc_code` | `citext` | no | — | Plaintext, public code. `CHECK (ifsc_code ~ '^[A-Z]{4}0[A-Z0-9]{6}$')` |
| `account_type` | `text` | no | `'SAVINGS'` | `SAVINGS` \| `CURRENT` |
| `account_number_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | Mask `•••• •••• 4412` |
| `account_number_fpr` | `bytea` | no | — | Blind index |
| `account_number_last4` | `char(4)` | no | — | Denormalised for the payslip header `HDFC Bank ••4412` |
| `account_holder_name_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | |
| `is_primary` | `boolean` | no | `true` | Salary credit account |
| `is_verified` | `boolean` | no | `false` | Payroll verifies against a cancelled cheque |
| `verified_at` | `timestamptz` | yes | — | |
| `verified_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `proof_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `effective_from` | `date` | no | `CURRENT_DATE` | |
| `effective_to` | `date` | yes | — | |

```sql
CONSTRAINT ux_employee_bank_account__one_primary UNIQUE (employee_id, is_primary) WHERE is_primary AND effective_to IS NULL,
CONSTRAINT ck_employee_bank_account__last4 CHECK (account_number_last4 ~ '^[0-9]{4}$'),
CONSTRAINT ck_employee_bank_account__range CHECK (effective_to IS NULL OR effective_to >= effective_from)
```
Index: `ix_employee_bank_account__employee_current (employee_id) WHERE effective_to IS NULL`.

> A payroll cycle may only include an employee whose primary bank account is
> `is_verified = true` (guard `payroll.bank_verified`, §10.2). This is surfaced as a
> `payroll_validation_result` ERROR, not silently skipped.

### 5.9 `employee_emergency_contact`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `priority` | `smallint` | no | — | `1` = Primary contact, `2` = Secondary contact (the prototype's two rows) |
| `contact_name_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | |
| `relationship` | `ess_dependent_relationship` | no | — | Rendered as `Spouse`, `Mother` |
| `relationship_note_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | Free text when `relationship = 'OTHER'` |
| `phone_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | Mask `+91 ••••• 44521` |

```sql
CONSTRAINT ux_employee_emergency_contact__employee_priority UNIQUE (employee_id, priority),
CONSTRAINT ck_employee_emergency_contact__priority CHECK (priority BETWEEN 1 AND 3)
```
Visible to the employee, their current primary manager, and `profile:read_sensitive:any`
— matching the prototype's note "visible only to People Ops and your manager".

---
## 6. Sessions, MFA and login security

### 6.1 `refresh_token` — rotating, hashed, family-tracked

Access tokens are stateless JWTs (10 min TTL, never persisted). Refresh tokens are
opaque 256-bit random values delivered in an `httpOnly; Secure; SameSite=Strict;
Path=/api/auth` cookie and persisted **only as a hash**.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK. Also the token's `jti`. |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE CASCADE` |
| `family_id` | `uuid` | no | — | Lineage root. Constant across every rotation descended from one login. |
| `parent_token_id` | `uuid` | yes | — | FK → `refresh_token(id)` `ON DELETE SET NULL`. `NULL` on the first token of a family. |
| `generation` | `integer` | no | `0` | Monotonic within a family; `parent.generation + 1` |
| `token_hash` | `bytea` | no | — | `sha256(raw_token)`, 32 bytes. The raw token never touches the database, the logs, or any audit row. |
| `issued_at` | `timestamptz` | no | `now()` | |
| `expires_at` | `timestamptz` | no | — | `issued_at + interval '14 days'` (sliding cap: family dies at `family_absolute_expires_at`) |
| `family_absolute_expires_at` | `timestamptz` | no | — | `family_created_at + interval '30 days'`; copied down every rotation |
| `rotated_at` | `timestamptz` | yes | — | Set when this token is exchanged |
| `revoked_at` | `timestamptz` | yes | — | |
| `revoked_reason` | `text` | yes | — | `ROTATED`, `LOGOUT`, `REUSE_DETECTED`, `ADMIN_REVOKE`, `PASSWORD_CHANGE`, `ROLE_CHANGE`, `EXPIRED` |
| `user_agent` | `text` | yes | — | Truncated to 512 chars |
| `ip_address` | `inet` | yes | — | |
| `ip_asn` | `integer` | yes | — | Optional enrichment; drives the "new location" security alert |
| `device_label` | `text` | yes | — | Derived from UA; shown in a future "Active sessions" screen |
| `mfa_satisfied_at` | `timestamptz` | yes | — | Non-NULL ⇒ this family cleared MFA |

```sql
CONSTRAINT ux_refresh_token__hash UNIQUE (token_hash),
CONSTRAINT ck_refresh_token__expiry CHECK (expires_at > issued_at),
CONSTRAINT ck_refresh_token__family_cap CHECK (family_absolute_expires_at >= expires_at),
CONSTRAINT ck_refresh_token__generation CHECK (generation >= 0),
CONSTRAINT ck_refresh_token__revocation CHECK (num_nulls(revoked_at, revoked_reason) IN (0, 2))
```
Indexes:
- `ux_refresh_token__hash (token_hash)` — the only lookup path
- `ix_refresh_token__family (family_id, generation)`
- `ix_refresh_token__user_live (app_user_id) WHERE revoked_at IS NULL`
- `ix_refresh_token__expiry_sweep (expires_at) WHERE revoked_at IS NULL`

**Reuse detection.** On presentation of a token whose row has
`rotated_at IS NOT NULL` **or** `revoked_at IS NOT NULL`, the API:
1. `UPDATE refresh_token SET revoked_at = now(), revoked_reason = 'REUSE_DETECTED' WHERE family_id = $1 AND revoked_at IS NULL` — kills the whole family;
2. increments `app_user.token_epoch` — kills every outstanding access token;
3. writes an `audit_event` (`action = 'LOGOUT'`, `metadata.reason = 'refresh_reuse'`);
4. enqueues an `email_outbox` row of kind `SECURITY_ALERT`;
5. creates a `notification` of kind `SECURITY_ALERT`;
6. responds `401` with a generic body. No information about which token was replayed.

No audit columns (`created_by_user_id` etc.); only `issued_at`. Rows are swept 90 days
after `expires_at` by the `session-sweep` job — after their audit trail has been written.

### 6.2 `mfa_credential`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE CASCADE` |
| `method` | `ess_mfa_method` | no | `'TOTP'` | |
| `label` | `text` | no | `'Authenticator app'` | |
| `totp_secret_ct/_iv/_tag/_dek_id` | envelope (no `_mask`) | no | — | Base32 TOTP seed, AES-256-GCM. Never returned by any endpoint after enrolment. |
| `algorithm` | `text` | no | `'SHA1'` | RFC 6238 default for authenticator-app compatibility |
| `digits` | `smallint` | no | `6` | |
| `period_seconds` | `smallint` | no | `30` | |
| `confirmed_at` | `timestamptz` | yes | — | Enrolment is not complete until a code is verified |
| `last_used_at` | `timestamptz` | yes | — | |
| `last_used_counter` | `bigint` | yes | — | Time-step counter of the last accepted code. A code with `counter <= last_used_counter` is **rejected** — TOTP replay protection. |
| `disabled_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ux_mfa_credential__user_method UNIQUE (app_user_id, method) WHERE disabled_at IS NULL,
CONSTRAINT ck_mfa_credential__digits CHECK (digits IN (6, 8)),
CONSTRAINT ck_mfa_credential__period CHECK (period_seconds IN (30, 60))
```

### 6.3 `mfa_recovery_code`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE CASCADE` |
| `code_hash` | `text` | no | — | **Argon2id** PHC string. Recovery codes are credentials, so they are hashed, not encrypted. |
| `batch_id` | `uuid` | no | — | 10 codes are issued as one batch; issuing a new batch invalidates the previous one |
| `used_at` | `timestamptz` | yes | — | |
| `used_ip` | `inet` | yes | — | |
| `invalidated_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ck_mfa_recovery_code__single_use CHECK (used_at IS NULL OR invalidated_at IS NULL)
```
Indexes: `ix_mfa_recovery_code__user_live (app_user_id) WHERE used_at IS NULL AND invalidated_at IS NULL`,
`ix_mfa_recovery_code__batch (batch_id)`.

### 6.4 `login_attempt`

Append-only. Every authentication decision is recorded, successful or not — this is the
evidence base for lockout, rate limiting and intrusion review.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | yes | — | FK → `organization(id)` `ON DELETE SET NULL`. NULL when the email matched no tenant. |
| `app_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for `UNKNOWN_USER`. |
| `email_attempted_fpr` | `bytea` | no | — | `HMAC-SHA256(pepper, lower(email))`. The raw attempted email is **not** stored — an attacker who reads this table learns no addresses. |
| `outcome` | `ess_login_outcome` | no | — | |
| `ip_address` | `inet` | no | — | |
| `user_agent` | `text` | yes | — | |
| `mfa_method` | `ess_mfa_method` | yes | — | |
| `request_id` | `uuid` | no | — | Correlates with `audit_event.request_id` and the access log |
| `occurred_at` | `timestamptz` | no | `now()` | |

No `updated_at`, no actor columns; `INSERT`-only (enforced by
`trg_append_only_login_attempt`, which raises on `UPDATE`/`DELETE`).
Indexes:
- `ix_login_attempt__user_time (app_user_id, occurred_at DESC)`
- `ix_login_attempt__ip_time (ip_address, occurred_at DESC)`
- `ix_login_attempt__fpr_time (email_attempted_fpr, occurred_at DESC)`
- `ix_login_attempt__failures (occurred_at DESC) WHERE outcome <> 'SUCCESS'`

**Lockout rule (deterministic, computed from this table):** 5 non-`SUCCESS` outcomes for
one `app_user_id` inside 15 minutes sets `app_user.locked_until = now() + 15 min`;
each further failure after a lockout doubles the window to a 24-hour cap. Independently,
20 failures from one `/24` (IPv4) or `/64` (IPv6) inside 10 minutes triggers an IP-level
`RATE_LIMITED` outcome. Responses are constant-time and identical for
`UNKNOWN_USER` and `BAD_CREDENTIALS`.

### 6.5 `password_reset_token`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE CASCADE` |
| `token_hash` | `bytea` | no | — | `sha256(raw)`, unique |
| `expires_at` | `timestamptz` | no | — | `issued_at + interval '30 minutes'` |
| `used_at` | `timestamptz` | yes | — | |
| `invalidated_at` | `timestamptz` | yes | — | Set when a newer token is issued or the password changes |
| `requested_ip` | `inet` | yes | — | |
| `issued_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ux_password_reset_token__hash UNIQUE (token_hash),
CONSTRAINT ck_password_reset_token__expiry CHECK (expires_at > issued_at)
```
Consuming a token bumps `app_user.token_epoch` and revokes every live `refresh_token`
family for that user.

---

## 7. Calendar and the working-day model

### 7.1 `holiday_calendar` — reference data, seeded per location

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `BLR-2026` |
| `name` | `text` | no | — | `Bengaluru calendar` — rendered verbatim on the Home holidays card |
| `calendar_year` | `smallint` | no | — | `2026` |
| `restricted_holiday_allowance` | `numeric(5,2)` | no | `0` | How many RH days an employee may take from this calendar in the year |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_holiday_calendar__org_code_year UNIQUE (organization_id, code, calendar_year),
CONSTRAINT ck_holiday_calendar__rh CHECK (restricted_holiday_allowance >= 0)
```

### 7.2 `holiday`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `holiday_calendar_id` | `uuid` | no | — | FK → `holiday_calendar(id)` `ON DELETE CASCADE` |
| `holiday_date` | `date` | no | — | |
| `name` | `text` | no | — | `Dussehra · Vijaya Dashami` |
| `kind` | `ess_holiday_kind` | no | `'PUBLIC'` | `RESTRICTED` rows are optional and consume the RH allowance |
| `is_observed_shift` | `boolean` | no | `false` | `true` for "Diwali (observed)" — the actual festival falls on a non-working day |
| `note` | `text` | yes | — | |

```sql
CONSTRAINT ux_holiday__calendar_date_name UNIQUE (holiday_calendar_id, holiday_date, name)
```
Indexes:
- `ix_holiday__calendar_date (holiday_calendar_id, holiday_date)`
- `ix_holiday__upcoming (holiday_calendar_id, holiday_date) WHERE kind = 'PUBLIC'`

The prototype's `h.day` / `h.mon` / `h.dow` are **not** stored: they are
`to_char(holiday_date, 'DD')`, `'Mon'`, `'Dy'` rendered client-side in `en-IN` from the
one persisted `holiday_date`.

### 7.3 Working-day resolution (the single source of "is this a payable day?")

```sql
-- Which calendar applies to an employee on a date?
CREATE FUNCTION holiday_calendar_for(p_employee uuid, p_on date) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(ee.holiday_calendar_id, l.holiday_calendar_id, o.default_holiday_calendar_id)
  FROM employee e
  JOIN organization o ON o.id = e.organization_id
  LEFT JOIN LATERAL employment_as_of(e.id, p_on) ee ON true
  LEFT JOIN location l ON l.id = ee.location_id
  WHERE e.id = p_employee
$$;

-- Working days between two dates for one employee (weekends + holidays excluded)
CREATE FUNCTION working_days(p_employee uuid, p_from date, p_to date) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT count(*)::numeric
  FROM generate_series(p_from, p_to, interval '1 day') AS d(day)
  WHERE extract(dow FROM d.day)::smallint <> ALL (
          coalesce((employment_as_of(p_employee, d.day::date)).weekly_off_days,
                   (SELECT week_off_days FROM organization o
                      JOIN employee e ON e.organization_id = o.id WHERE e.id = p_employee)))
    AND NOT EXISTS (
          SELECT 1 FROM holiday h
          WHERE h.holiday_calendar_id = holiday_calendar_for(p_employee, d.day::date)
            AND h.holiday_date = d.day::date
            AND h.kind = 'PUBLIC')
$$;
```

The prototype's client-side weekday counter (`submitLeave`'s
`if(w!==0&&w!==6) days++`) is replaced by `working_days()`. The browser may show a
provisional count for responsiveness, but the **stored** `leave_request.total_days` is
always the server's value, recomputed on submit and again on approval.

---

## 8. Leave

### 8.1 `leave_type` — reference data, seeded

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `EL`, `CL`, `SL`, `COMP_OFF`, `RH`, `LOP`, `MATERNITY`, `PATERNITY`, `BEREAVEMENT` |
| `name` | `text` | no | — | `Earned leave` — the Leave screen tile label and the request-type dropdown option |
| `short_name` | `text` | no | — | `EL` |
| `unit` | `ess_leave_unit` | no | `'DAY'` | `HALF_DAY` permits `0.5` requests |
| `is_paid` | `boolean` | no | `true` | `LOP` is the only seeded `false` |
| `affects_payroll_lop` | `boolean` | no | `false` | `true` for LOP: approved days increment `attendance_record.lop_days` |
| `requires_attachment_after_days` | `numeric(5,2)` | yes | — | `2.00` for Sick leave (the policy's medical-certificate rule) |
| `min_notice_days` | `smallint` | no | `0` | `3` for Earned leave |
| `max_consecutive_days` | `numeric(5,2)` | yes | — | |
| `allows_negative_balance` | `boolean` | no | `false` | |
| `is_encashable` | `boolean` | no | `false` | |
| `consumes_restricted_holiday_allowance` | `boolean` | no | `false` | `true` for `RH` |
| `display_order` | `smallint` | no | `0` | Fixes the Leave tile order without any client-side sort |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_leave_type__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_leave_type__notice CHECK (min_notice_days BETWEEN 0 AND 90),
CONSTRAINT ck_leave_type__lop_unpaid CHECK (NOT affects_payroll_lop OR NOT is_paid)
```

### 8.2 `leave_period` — the leave year

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `text` | no | — | `LY2026` |
| `label` | `text` | no | — | `Leave year Jan – Dec 2026` — the Leave screen sub-header, persisted |
| `start_date` | `date` | no | — | |
| `end_date` | `date` | no | — | |
| `is_current` | `boolean` | no | `false` | |
| `closed_at` | `timestamptz` | yes | — | After close, no ledger entry may be written with `effective_on` inside the period |

```sql
CONSTRAINT ux_leave_period__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_leave_period__range CHECK (end_date > start_date),
CONSTRAINT ex_leave_period__no_overlap EXCLUDE USING gist (
  organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&),
CONSTRAINT ux_leave_period__one_current UNIQUE (organization_id, is_current) WHERE is_current
```

### 8.3 `leave_scheme` and `leave_entitlement_rule`

`leave_scheme` — a named bundle of entitlements assigned to a population.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `IN-FT-2026` |
| `name` | `text` | no | — | `India · Full-time · 2026` |
| `leave_period_id` | `uuid` | no | — | FK → `leave_period(id)` `ON DELETE RESTRICT` |
| `applies_employment_types` | `ess_employment_type[]` | no | `'{}'` | Empty = all |
| `applies_location_ids` | `uuid[]` | no | `'{}'` | Empty = all |
| `source_policy_version_id` | `uuid` | yes | — | FK → `policy_version(id)` `ON DELETE SET NULL` — ties the numbers to the published Leave Policy |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_leave_scheme__org_code_period UNIQUE (organization_id, code, leave_period_id)
```

`leave_entitlement_rule` — one row per leave type in a scheme.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `leave_scheme_id` | `uuid` | no | — | FK → `leave_scheme(id)` `ON DELETE CASCADE` |
| `leave_type_id` | `uuid` | no | — | FK → `leave_type(id)` `ON DELETE RESTRICT` |
| `annual_entitlement_days` | `numeric(5,2)` | no | — | `18.00` EL, `12.00` CL, `10.00` SL |
| `accrual_frequency` | `ess_leave_accrual_frequency` | no | `'MONTHLY'` | |
| `accrual_days_per_cycle` | `numeric(5,2)` | yes | — | `1.50` EL/month (the Leave Policy's rule) |
| `accrual_on_day_of_month` | `smallint` | yes | — | `1` |
| `prorate_on_joining` | `boolean` | no | `true` | |
| `max_carry_forward_days` | `numeric(5,2)` | no | `0` | `30.00` EL |
| `carry_forward_expiry_months` | `smallint` | yes | — | |
| `lapses_at_period_end` | `boolean` | no | `true` | CL lapses (policy: "Unused casual leave lapses on 31 December") |
| `max_balance_days` | `numeric(5,2)` | yes | — | Accrual cap |
| `eligible_after_days_of_service` | `smallint` | no | `0` | |

```sql
CONSTRAINT ux_leave_entitlement_rule__scheme_type UNIQUE (leave_scheme_id, leave_type_id),
CONSTRAINT ck_ler__entitlement CHECK (annual_entitlement_days >= 0),
CONSTRAINT ck_ler__carry CHECK (max_carry_forward_days >= 0 AND max_carry_forward_days <= annual_entitlement_days + 60),
CONSTRAINT ck_ler__accrual CHECK (
  (accrual_frequency = 'NONE' AND accrual_days_per_cycle IS NULL)
  OR (accrual_frequency <> 'NONE' AND accrual_days_per_cycle IS NOT NULL AND accrual_days_per_cycle >= 0))
```

`employee_leave_scheme` — assignment (effective-dated).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `leave_scheme_id` | `uuid` | no | — | FK → `leave_scheme(id)` `ON DELETE RESTRICT` |
| `effective_from` | `date` | no | — | |
| `effective_to` | `date` | yes | — | |

```sql
CONSTRAINT ex_employee_leave_scheme__no_overlap EXCLUDE USING gist (
  employee_id WITH =, daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&)
```

### 8.4 `leave_balance_ledger` (append-only) and `leave_balance` (projection)

The balances the Home and Leave screens render are **never** hand-entered. Every
movement is a ledger row; `leave_balance` is a materialised fold of the ledger, so the
displayed number is always reconstructible from primary evidence.

`leave_balance_ledger` — append-only, no `updated_at`, no `UPDATE`/`DELETE` (trigger
`trg_append_only_leave_ledger`).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `leave_type_id` | `uuid` | no | — | FK → `leave_type(id)` `ON DELETE RESTRICT` |
| `leave_period_id` | `uuid` | no | — | FK → `leave_period(id)` `ON DELETE RESTRICT` |
| `kind` | `ess_leave_ledger_kind` | no | — | |
| `delta_days` | `numeric(5,2)` | no | — | **Signed.** `+1.50` accrual, `-5.00` consumption, `+5.00` reversal on withdrawal |
| `effective_on` | `date` | no | — | The date the movement belongs to (drives period allocation) |
| `leave_request_id` | `uuid` | yes | — | FK → `leave_request(id)` `ON DELETE RESTRICT` — set for `CONSUMPTION`/`CONSUMPTION_REVERSAL` |
| `source_ledger_id` | `uuid` | yes | — | FK → `leave_balance_ledger(id)` `ON DELETE RESTRICT` — a reversal points at what it reverses |
| `reason` | `text` | yes | — | Mandatory (API-enforced) for `ADJUSTMENT` |
| `actor_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for scheduler accruals. |
| `audit_event_id` | `uuid` | yes | — | FK → `audit_event(id)` `ON DELETE SET NULL` |
| `created_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ck_llg__delta_nonzero CHECK (delta_days <> 0),
CONSTRAINT ck_llg__half_days CHECK ((delta_days * 2) = trunc(delta_days * 2)),
CONSTRAINT ck_llg__consumption_sign CHECK (
  (kind IN ('CONSUMPTION','CARRY_FORWARD_OUT','LAPSE','ENCASHMENT') AND delta_days < 0)
  OR (kind IN ('OPENING','ACCRUAL','CARRY_FORWARD_IN','CONSUMPTION_REVERSAL') AND delta_days > 0)
  OR kind = 'ADJUSTMENT'),
CONSTRAINT ck_llg__request_link CHECK (
  (kind IN ('CONSUMPTION','CONSUMPTION_REVERSAL')) = (leave_request_id IS NOT NULL)),
CONSTRAINT ux_llg__one_consumption_per_request UNIQUE (leave_request_id, kind)
```
Indexes:
- `ix_llg__balance_fold (organization_id, employee_id, leave_period_id, leave_type_id, effective_on)` — the fold query
- `ix_llg__request (leave_request_id) WHERE leave_request_id IS NOT NULL`
- `ix_llg__period_type (leave_period_id, leave_type_id)`

`leave_balance` — the projection. Recomputed inside the same transaction as every
ledger insert by `fn_refresh_leave_balance(employee, type, period)`, and re-verified
nightly by the `leave-balance-verify` job (a mismatch raises a P1 alert and an
`audit_event`).

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `leave_type_id` | `uuid` | no | — | FK → `leave_type(id)` `ON DELETE RESTRICT` |
| `leave_period_id` | `uuid` | no | — | FK → `leave_period(id)` `ON DELETE RESTRICT` |
| `opening_days` | `numeric(5,2)` | no | `0` | Σ `OPENING` |
| `accrued_days` | `numeric(5,2)` | no | `0` | Σ `ACCRUAL` |
| `carried_in_days` | `numeric(5,2)` | no | `0` | Σ `CARRY_FORWARD_IN` |
| `carried_out_days` | `numeric(5,2)` | no | `0` | Σ −`CARRY_FORWARD_OUT` |
| `used_days` | `numeric(5,2)` | no | `0` | Σ −(`CONSUMPTION` + `CONSUMPTION_REVERSAL`) |
| `pending_days` | `numeric(5,2)` | no | `0` | Σ `total_days` of the employee's `PENDING_APPROVAL` requests of this type in this period (a soft hold, **not** a ledger entry) |
| `encashed_days` | `numeric(5,2)` | no | `0` | Σ −`ENCASHMENT` |
| `lapsed_days` | `numeric(5,2)` | no | `0` | Σ −`LAPSE` |
| `adjustment_days` | `numeric(5,2)` | no | `0` | Σ `ADJUSTMENT` (signed) |
| `entitlement_days` | `numeric(5,2)` | no | `0` | `leave_entitlement_rule.annual_entitlement_days` resolved for this employee/period — the **"/ total"** denominator on the tiles |
| `available_days` | `numeric(5,2)` | no | *(generated)* | `GENERATED ALWAYS AS (opening_days + accrued_days + carried_in_days + adjustment_days - used_days - encashed_days - lapsed_days - carried_out_days) STORED` — the **"left"** numerator on the tiles |
| `last_ledger_id` | `uuid` | yes | — | FK → `leave_balance_ledger(id)` `ON DELETE SET NULL` — the fold watermark |
| `recomputed_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ux_leave_balance__emp_type_period UNIQUE (employee_id, leave_type_id, leave_period_id),
CONSTRAINT ck_leave_balance__pending CHECK (pending_days >= 0),
CONSTRAINT ck_leave_balance__entitlement CHECK (entitlement_days >= 0)
```
Indexes:
- `ux_leave_balance__emp_type_period (employee_id, leave_type_id, leave_period_id)`
- `ix_leave_balance__period_display (organization_id, leave_period_id, employee_id)` — the Leave tiles, joined to `leave_type.display_order`

> **Empty state.** If an employee has no `leave_balance` row for the current period (a
> new joiner before first accrual), the Leave screen renders the designed empty state
> and the Home tile shows `—` with the sub-label "Balances start after your first
> accrual on <accrual_on_day_of_month of next month>". It never renders `0 / 0` as if
> it were data, and never invents an entitlement.

### 8.5 `leave_request`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `reference_no` | `citext` | no | — | `WDT-LV-2026-000481`. Unique per org; from `leave_reference_seq`. |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `leave_type_id` | `uuid` | no | — | FK → `leave_type(id)` `ON DELETE RESTRICT` |
| `leave_period_id` | `uuid` | no | — | FK → `leave_period(id)` `ON DELETE RESTRICT` |
| `start_date` | `date` | no | — | |
| `end_date` | `date` | no | — | |
| `start_portion` | `ess_leave_day_portion` | no | `'FULL'` | |
| `end_portion` | `ess_leave_day_portion` | no | `'FULL'` | |
| `total_days` | `numeric(5,2)` | no | — | **Server-computed** from `leave_request_day` rows; never client-supplied |
| `reason` | `text` | yes | — | The prototype's optional "Reason" textarea; ≤ 2000 chars |
| `status` | `ess_leave_request_status` | no | `'DRAFT'` | |
| `submitted_at` | `timestamptz` | yes | — | |
| `decided_at` | `timestamptz` | yes | — | |
| `decided_by_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE SET NULL` — the approving manager |
| `decision_note` | `text` | yes | — | Rejection reason; shown on the request row |
| `withdrawn_at` | `timestamptz` | yes | — | |
| `approver_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE RESTRICT` — snapshot of the primary manager at submit time, so a later re-org cannot orphan the request |
| `attachment_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` — medical certificate |
| `balance_after_days` | `numeric(5,2)` | yes | — | Snapshot at submit; renders the Approvals card's "Balance after: 9.5 days" |
| `attendance_record_id` | `uuid` | yes | — | FK → `attendance_record(id)` `ON DELETE SET NULL` — set once the approved leave has been folded into an attendance period |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_leave_request__org_reference UNIQUE (organization_id, reference_no),
CONSTRAINT ck_leave_request__range CHECK (end_date >= start_date),
CONSTRAINT ck_leave_request__days CHECK (total_days > 0 AND (total_days * 2) = trunc(total_days * 2)),
CONSTRAINT ck_leave_request__submitted CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
CONSTRAINT ck_leave_request__decided CHECK (
  (status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL AND decided_by_employee_id IS NOT NULL)),
CONSTRAINT ck_leave_request__rejection_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL),
CONSTRAINT ck_leave_request__withdrawn CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)),
CONSTRAINT ck_leave_request__half_day_single CHECK (
  (start_portion = 'FULL' AND end_portion = 'FULL') OR start_date = end_date OR
  (start_portion <> 'FULL' OR end_portion <> 'FULL'))
```
Indexes:
- `ix_leave_request__employee_period (employee_id, leave_period_id, start_date DESC)` — "My requests"
- `ix_leave_request__approver_pending (approver_employee_id, submitted_at DESC) WHERE status = 'PENDING_APPROVAL'` — the Approvals queue
- `ix_leave_request__org_dates (organization_id, start_date, end_date)` — team-calendar and "Team today"
- `ix_leave_request__type_period (leave_type_id, leave_period_id) WHERE status = 'APPROVED'`
- `ex_leave_request__no_self_overlap EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('PENDING_APPROVAL','APPROVED'))` — an employee cannot double-book a day

`leave_request_day` — one row per calendar day the request touches. This is what makes
"Team today · On leave", the LOP day count and the attendance fold exact.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `leave_request_id` | `uuid` | no | — | FK → `leave_request(id)` `ON DELETE CASCADE` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` — denormalised for the "today" index |
| `leave_date` | `date` | no | — | |
| `portion` | `ess_leave_day_portion` | no | `'FULL'` | |
| `day_fraction` | `numeric(3,2)` | no | — | `1.00` or `0.50` |
| `is_working_day` | `boolean` | no | — | `false` for a weekend/holiday inside the span; such rows exist for display but contribute `0` |
| `counts_toward_balance` | `boolean` | no | — | `is_working_day AND leave_type.is_paid` |

```sql
CONSTRAINT ux_leave_request_day__request_date UNIQUE (leave_request_id, leave_date),
CONSTRAINT ck_lrd__fraction CHECK (day_fraction IN (0.00, 0.50, 1.00)),
CONSTRAINT ck_lrd__nonworking_zero CHECK (is_working_day OR day_fraction = 0.00)
```
Indexes:
- `ix_lrd__employee_date (employee_id, leave_date)` — "who is on leave today"
- `ix_lrd__date (organization_id, leave_date) WHERE counts_toward_balance`

`leave_request.total_days` is maintained by trigger as
`SUM(day_fraction) FILTER (WHERE counts_toward_balance)`; the trigger raises if an
application tries to set it directly.

### 8.6 Leave request state machine (`machine = 'leave_request'`)

| from | to | permission | guard | notification | email |
|---|---|---|---|---|---|
| `NULL` | `DRAFT` | `leave:request:create:self` | `leave.self_only` | — | — |
| `DRAFT` | `PENDING_APPROVAL` | `leave:request:create:self` | `leave.sufficient_balance`, `leave.no_overlap`, `leave.min_notice`, `leave.attachment_if_required`, `leave.manager_exists` | `LEAVE_SUBMITTED` (→ manager) | — |
| `NULL` | `PENDING_APPROVAL` | `leave:request:create:self` | same as above | `LEAVE_SUBMITTED` | — |
| `PENDING_APPROVAL` | `APPROVED` | `leave:request:approve:team` | `approval.actor_is_assigned_approver`, `leave.period_open` | `LEAVE_DECIDED` (→ employee) | `LEAVE_DECISION` |
| `PENDING_APPROVAL` | `REJECTED` | `leave:request:approve:team` | `approval.actor_is_assigned_approver`, `approval.note_required` | `LEAVE_DECIDED` | `LEAVE_DECISION` |
| `PENDING_APPROVAL` | `WITHDRAWN` | `leave:request:withdraw:self` | `leave.self_only` | `LEAVE_DECIDED` (→ manager) | — |
| `APPROVED` | `CANCELLED` | `leave:request:approve:any` | `leave.not_yet_locked_by_attendance` | `LEAVE_DECIDED` | `LEAVE_DECISION` |
| `APPROVED` | `WITHDRAWN` | `leave:request:withdraw:self` | `leave.starts_in_future`, `leave.not_yet_locked_by_attendance` | `LEAVE_DECIDED` | — |
| `DRAFT` | `CANCELLED` | `leave:request:withdraw:self` | `leave.self_only` | — | — |

Terminal: `REJECTED`, `WITHDRAWN`, `CANCELLED`. `APPROVED` becomes effectively terminal
once `attendance_record_id` is set (guard `leave.not_yet_locked_by_attendance` fails).

Ledger effects, all inside the transition transaction:
- → `PENDING_APPROVAL`: `leave_balance.pending_days += total_days`; create an
  `approval_task` (§19).
- → `APPROVED`: one `CONSUMPTION` ledger row of `-total_days`; `pending_days -= total_days`.
- → `REJECTED` / `WITHDRAWN` from `PENDING_APPROVAL`: `pending_days -= total_days`; no ledger row.
- → `CANCELLED`/`WITHDRAWN` from `APPROVED`: one `CONSUMPTION_REVERSAL` row of
  `+total_days` with `source_ledger_id` pointing at the original consumption.

---
## 9. Attendance

Attendance is step 2 and 3 of the mandated payroll workflow: **HR submits, the
respective Manager approves.** Nothing here may be written by Accounts.

### 9.1 `attendance_period`

One row per organisation per calendar month. Created together with the
`payroll_cycle` for the same month (1:1), so the two state machines stay in lock-step.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `period_code` | `text` | no | — | `2026-08` |
| `label` | `text` | no | — | `August 2026` — the payslip month label, persisted once |
| `start_date` | `date` | no | — | `2026-08-01` |
| `end_date` | `date` | no | — | `2026-08-31` |
| `total_calendar_days` | `smallint` | no | — | `31` — the denominator of the payslip's "Days paid 31 / 31" |
| `status` | `ess_attendance_period_status` | no | `'OPEN'` | |
| `capture_opened_at` | `timestamptz` | yes | — | |
| `hr_submitted_at` | `timestamptz` | yes | — | |
| `hr_submitted_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `approvals_completed_at` | `timestamptz` | yes | — | Set when the last `attendance_approval` reaches `APPROVED` |
| `locked_at` | `timestamptz` | yes | — | Set when the payroll cycle leaves `ATTENDANCE_APPROVED`; blocks all further edits |
| `reopened_at` | `timestamptz` | yes | — | |
| `reopened_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `reopen_reason` | `text` | yes | — | Mandatory when reopening |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_attendance_period__org_code UNIQUE (organization_id, period_code),
CONSTRAINT ck_attendance_period__range CHECK (end_date >= start_date),
CONSTRAINT ck_attendance_period__days CHECK (total_calendar_days = (end_date - start_date + 1)),
CONSTRAINT ck_attendance_period__submitted CHECK (
  num_nulls(hr_submitted_at, hr_submitted_by_user_id) IN (0, 2)),
CONSTRAINT ck_attendance_period__reopen CHECK (
  num_nulls(reopened_at, reopened_by_user_id, reopen_reason) IN (0, 3)),
CONSTRAINT ex_attendance_period__no_overlap EXCLUDE USING gist (
  organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
```
Index: `ix_attendance_period__org_status (organization_id, status, start_date DESC)`.

### 9.2 `attendance_record` — one row per employee per period

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `attendance_period_id` | `uuid` | no | — | FK → `attendance_period(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `manager_employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` — snapshot of the primary manager on `attendance_period.end_date`; determines which manager must approve |
| `department_id` | `uuid` | no | — | FK → `department(id)` `ON DELETE RESTRICT` — snapshot, for reporting slices |
| `attendance_approval_id` | `uuid` | yes | — | FK → `attendance_approval(id)` `ON DELETE SET NULL` — the team slice this record belongs to |
| `status` | `ess_attendance_record_status` | no | `'DRAFT'` | |
| `source` | `ess_attendance_source` | no | `'HR_MANUAL'` | |
| `source_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` — the HR bulk upload that produced this row |
| `calendar_days` | `smallint` | no | — | Copy of `attendance_period.total_calendar_days` |
| `eligible_days` | `numeric(5,2)` | no | — | Days the employee was on the payroll in this period (joins/exits prorate) |
| `present_days` | `numeric(5,2)` | no | `0` | |
| `paid_leave_days` | `numeric(5,2)` | no | `0` | Approved paid leave falling in the period |
| `holiday_days` | `numeric(5,2)` | no | `0` | `PUBLIC` holidays in the period on the employee's calendar |
| `week_off_days` | `numeric(5,2)` | no | `0` | |
| `absent_days` | `numeric(5,2)` | no | `0` | Unapproved absence |
| `lop_days` | `numeric(5,2)` | no | `0` | Loss-of-pay days. `absent_days` + approved unpaid leave, unless overridden by a committed `LOP_OVERRIDE` payroll input. |
| `payable_days` | `numeric(5,2)` | no | *(generated)* | `GENERATED ALWAYS AS (eligible_days - lop_days) STORED` — the numerator of "Days paid 31 / 31" and the prorating basis for `PRORATED_FIXED` components |
| `overtime_hours` | `numeric(6,2)` | no | `0` | |
| `hr_note` | `text` | yes | — | |
| `manager_note` | `text` | yes | — | Set when a manager rejects the slice |
| `computed_at` | `timestamptz` | yes | — | When the system-derived figures were last recalculated |
| `locked_at` | `timestamptz` | yes | — | |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_attendance_record__period_employee UNIQUE (attendance_period_id, employee_id),
CONSTRAINT ck_ar__nonneg CHECK (
  eligible_days >= 0 AND present_days >= 0 AND paid_leave_days >= 0 AND holiday_days >= 0
  AND week_off_days >= 0 AND absent_days >= 0 AND lop_days >= 0 AND overtime_hours >= 0),
CONSTRAINT ck_ar__eligible_bound CHECK (eligible_days <= calendar_days),
CONSTRAINT ck_ar__lop_bound CHECK (lop_days <= eligible_days),
CONSTRAINT ck_ar__day_identity CHECK (
  present_days + paid_leave_days + holiday_days + week_off_days + absent_days = eligible_days),
CONSTRAINT ck_ar__half_days CHECK (
  (present_days*2)=trunc(present_days*2) AND (paid_leave_days*2)=trunc(paid_leave_days*2)
  AND (absent_days*2)=trunc(absent_days*2) AND (lop_days*2)=trunc(lop_days*2))
```
Indexes:
- `ux_attendance_record__period_employee (attendance_period_id, employee_id)`
- `ix_attendance_record__manager_slice (attendance_period_id, manager_employee_id, status)` — the Manager approval queue
- `ix_attendance_record__approval (attendance_approval_id)`
- `ix_attendance_record__employee_period (employee_id, attendance_period_id)` — payslip generation lookup
- `ix_attendance_record__pending (organization_id, status) WHERE status IN ('DRAFT','SUBMITTED')`

> `ck_ar__day_identity` is the integrity spine: the day counts must exactly partition
> the eligible days. HR cannot submit a record where they do not.

### 9.3 `attendance_submission` — the HR act

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `attendance_period_id` | `uuid` | no | — | FK → `attendance_period(id)` `ON DELETE RESTRICT` |
| `submitted_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `submitted_at` | `timestamptz` | no | `now()` | |
| `record_count` | `integer` | no | — | Rows moved `DRAFT → SUBMITTED` |
| `employee_count_expected` | `integer` | no | — | Active employees on `end_date`; a mismatch is an ERROR validation |
| `total_payable_days` | `numeric(12,2)` | no | — | Control total, recomputed on approval; a drift raises `ATT_TOTALS_DRIFT` |
| `total_lop_days` | `numeric(12,2)` | no | — | Control total |
| `source_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `payload_sha256` | `bytea` | no | — | SHA-256 over the canonical JSON of every submitted record — the traceability anchor |
| `note` | `text` | yes | — | |
| `superseded_by_submission_id` | `uuid` | yes | — | FK → `attendance_submission(id)` `ON DELETE SET NULL` — set when the period is reopened and resubmitted |

```sql
CONSTRAINT ck_attsub__counts CHECK (record_count >= 0 AND employee_count_expected >= 0),
CONSTRAINT ck_attsub__sha_len CHECK (octet_length(payload_sha256) = 32),
CONSTRAINT ux_attsub__period_live UNIQUE (attendance_period_id) WHERE superseded_by_submission_id IS NULL
```
Immutable after insert except `superseded_by_submission_id` (trigger
`trg_immutable_attendance_submission`).

### 9.4 `attendance_approval` — the Manager act, per team slice

One row per (period × manager). It is the unit the Manager sees and decides; the
records it covers are found through `attendance_record.attendance_approval_id`.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `attendance_period_id` | `uuid` | no | — | FK → `attendance_period(id)` `ON DELETE RESTRICT` |
| `attendance_submission_id` | `uuid` | no | — | FK → `attendance_submission(id)` `ON DELETE RESTRICT` |
| `manager_employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `status` | `ess_attendance_approval_status` | no | `'PENDING'` | |
| `record_count` | `integer` | no | — | Records in this slice |
| `total_payable_days` | `numeric(12,2)` | no | — | Slice control total at submission |
| `total_lop_days` | `numeric(12,2)` | no | — | |
| `assigned_at` | `timestamptz` | no | `now()` | |
| `due_at` | `timestamptz` | yes | — | `assigned_at + org SLA`; drives escalation |
| `decided_at` | `timestamptz` | yes | — | |
| `decided_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `decision_note` | `text` | yes | — | Mandatory on `REJECTED` |
| `escalated_at` | `timestamptz` | yes | — | |
| `escalated_to_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` — the HR user who acted under `attendance:approve:any` |
| `escalation_reason` | `text` | yes | — | Mandatory when escalated |
| `approval_task_id` | `uuid` | yes | — | FK → `approval_task(id)` `ON DELETE SET NULL` |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_attendance_approval__period_manager UNIQUE (attendance_period_id, manager_employee_id),
CONSTRAINT ck_attappr__decided CHECK (
  (status IN ('APPROVED','REJECTED','AUTO_ESCALATED')) = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)),
CONSTRAINT ck_attappr__reject_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL),
CONSTRAINT ck_attappr__escalation CHECK (
  num_nulls(escalated_at, escalated_to_user_id, escalation_reason) IN (0, 3)),
CONSTRAINT ck_attappr__escalated_status CHECK ((escalated_at IS NOT NULL) = (status = 'AUTO_ESCALATED') OR escalated_at IS NULL)
```
Indexes:
- `ix_attendance_approval__manager_pending (manager_employee_id, status) WHERE status = 'PENDING'`
- `ix_attendance_approval__period_status (attendance_period_id, status)`
- `ix_attendance_approval__overdue (due_at) WHERE status = 'PENDING'`

### 9.5 Attendance state machines

`machine = 'attendance_period'`

| from | to | permission | guard | notification |
|---|---|---|---|---|
| `NULL` | `OPEN` | `payroll:cycle:create` | `attendance.cycle_exists` | — |
| `OPEN` | `HR_SUBMITTED` | `attendance:submit` | `attendance.all_active_employees_have_records`, `attendance.day_identity_holds`, `attendance.payroll_inputs_locked` | — |
| `HR_SUBMITTED` | `MANAGER_APPROVAL_PENDING` | *(system)* | `attendance.slices_created` | `ATTENDANCE_APPROVAL_PENDING` (→ each manager) |
| `MANAGER_APPROVAL_PENDING` | `APPROVED` | *(system)* | `attendance.every_slice_approved` | `PAYROLL_CYCLE_STATE` (→ Accounts) |
| `MANAGER_APPROVAL_PENDING` | `OPEN` | `attendance:reopen` | `attendance.any_slice_rejected` | — |
| `APPROVED` | `LOCKED` | *(system)* | `attendance.cycle_left_attendance_approved` | — |
| `APPROVED` | `REOPENED` | `attendance:reopen` | `attendance.cycle_not_calculated`, `approval.note_required` | `PAYROLL_CYCLE_STATE` |
| `LOCKED` | `REOPENED` | `attendance:reopen` | `attendance.cycle_not_published`, `approval.note_required` | `PAYROLL_CYCLE_STATE` |
| `REOPENED` | `OPEN` | `attendance:reopen` | — | — |

`machine = 'attendance_record'`: `NULL→DRAFT` (`attendance:capture`) ·
`DRAFT→SUBMITTED` (`attendance:submit`) · `SUBMITTED→APPROVED` (`attendance:approve:team`,
guard `approval.actor_is_assigned_approver`) · `SUBMITTED→REJECTED`
(`attendance:approve:team`, guard `approval.note_required`) · `REJECTED→DRAFT`
(`attendance:capture`) · `APPROVED→LOCKED` (system) · `LOCKED→DRAFT`
(`attendance:reopen`, guard `attendance.cycle_not_published`).

`machine = 'attendance_approval'`: `NULL→PENDING` (system) ·
`PENDING→APPROVED` (`attendance:approve:team`) · `PENDING→REJECTED`
(`attendance:approve:team`) · `PENDING→AUTO_ESCALATED` (`attendance:approve:any`, guard
`attendance.approval_overdue` — HR may only escalate **after** `due_at` has passed, and
the escalation is audited with a mandatory reason).

---

## 10. Payroll

> **The mandated order is enforced by `payroll_cycle.status` and nothing else.**
> Accounts uploads payroll data → HR submits attendance → the respective Manager
> approves attendance → the system validates required payroll inputs → payroll/payslips
> are generated automatically → the payslip becomes visible to the employee.
> A payslip row cannot exist before `CALCULATED`, and cannot be read by an employee
> before a live `payslip_publication` row exists (§10.8).

### 10.1 `payroll_cycle`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `period_code` | `text` | no | — | `2026-08`. Unique per org. |
| `label` | `text` | no | — | `August 2026` — the payslip's month label |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `attendance_period_id` | `uuid` | no | — | FK → `attendance_period(id)` `ON DELETE RESTRICT`; **unique** (1:1) |
| `period_start` | `date` | no | — | |
| `period_end` | `date` | no | — | |
| `scheduled_pay_date` | `date` | no | — | Derived from `organization.payroll_pay_day_rule` at creation; persisted |
| `actual_pay_date` | `date` | yes | — | Set at publication; the payslip's "Credited 31 Aug 2026" |
| `status` | `ess_payroll_cycle_status` | no | `'DRAFT'` | |
| `inputs_locked_at` | `timestamptz` | yes | — | |
| `inputs_locked_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `validated_at` | `timestamptz` | yes | — | |
| `calculated_at` | `timestamptz` | yes | — | |
| `calculated_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `approved_at` | `timestamptz` | yes | — | |
| `approved_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `published_at` | `timestamptz` | yes | — | |
| `published_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `closed_at` | `timestamptz` | yes | — | |
| `cancelled_at` | `timestamptz` | yes | — | |
| `cancel_reason` | `text` | yes | — | |
| `employee_count` | `integer` | no | `0` | Employees in scope; set at `VALIDATED` |
| `payslip_count` | `integer` | no | `0` | Set at `CALCULATED` |
| `control_gross_minor` | `money_minor` | yes | — | Run control total, write-once at `CALCULATED`, re-verified at `PUBLISHED`. Not encrypted: an org-level aggregate, visible only to `payroll:cycle:read`. |
| `control_net_minor` | `money_minor` | yes | — | |
| `control_deductions_minor` | `money_minor` | yes | — | |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_payroll_cycle__org_period UNIQUE (organization_id, period_code),
CONSTRAINT ux_payroll_cycle__attendance_period UNIQUE (attendance_period_id),
CONSTRAINT ck_payroll_cycle__range CHECK (period_end >= period_start),
CONSTRAINT ck_payroll_cycle__pay_date CHECK (scheduled_pay_date >= period_end),
CONSTRAINT ck_payroll_cycle__distinct_approver CHECK (
  approved_by_user_id IS NULL OR calculated_by_user_id IS NULL
  OR approved_by_user_id <> calculated_by_user_id),
CONSTRAINT ck_payroll_cycle__published CHECK (
  num_nulls(published_at, published_by_user_id, actual_pay_date) IN (0, 3)),
CONSTRAINT ck_payroll_cycle__cancel CHECK (num_nulls(cancelled_at, cancel_reason) IN (0, 2)),
CONSTRAINT ck_payroll_cycle__controls_nonneg CHECK (
  coalesce(control_gross_minor,0) >= 0 AND coalesce(control_net_minor,0) >= 0
  AND coalesce(control_deductions_minor,0) >= 0)
```
Indexes:
- `ux_payroll_cycle__org_period (organization_id, period_code)`
- `ix_payroll_cycle__org_status (organization_id, status, period_start DESC)`
- `ix_payroll_cycle__published (organization_id, published_at DESC) WHERE status IN ('PUBLISHED','CLOSED')`

`ck_payroll_cycle__distinct_approver` is the **database-level dual-control guarantee**:
the user who calculated payroll can never be the user who approved it.

### 10.2 Payroll cycle state machine (`machine = 'payroll_cycle'`)

| # | from | to | permission | guards | notification |
|---|---|---|---|---|---|
| 1 | `NULL` | `DRAFT` | `payroll:cycle:create` | `payroll.no_open_cycle_for_period`, `payroll.prior_cycle_closed` | — |
| 2 | `DRAFT` | `INPUTS_OPEN` | `payroll:cycle:transition` | `payroll.attendance_period_open` | `PAYROLL_CYCLE_STATE` → HR |
| 3 | `INPUTS_OPEN` | `INPUTS_LOCKED` | `payroll:input:commit` | `payroll.at_least_one_committed_batch`, `payroll.no_uncommitted_batches`, `payroll.all_batches_validated` | `PAYROLL_CYCLE_STATE` → HR |
| 4 | `INPUTS_LOCKED` | `ATTENDANCE_SUBMITTED` | `attendance:submit` | `attendance.period_is_hr_submitted` | `ATTENDANCE_APPROVAL_PENDING` → managers |
| 5 | `ATTENDANCE_SUBMITTED` | `ATTENDANCE_APPROVED` | *(system)* | `attendance.every_slice_approved` | `PAYROLL_CYCLE_STATE` → Accounts |
| 6 | `ATTENDANCE_SUBMITTED` | `INPUTS_LOCKED` | `attendance:reopen` | `attendance.any_slice_rejected`, `approval.note_required` | `PAYROLL_CYCLE_STATE` |
| 7 | `ATTENDANCE_APPROVED` | `VALIDATING` | `payroll:validate` | `payroll.attendance_locked` | — |
| 8 | `VALIDATING` | `VALIDATED` | *(system)* | `payroll.no_error_validations` | `PAYROLL_CYCLE_STATE` |
| 9 | `VALIDATING` | `VALIDATION_FAILED` | *(system)* | `payroll.has_error_validations` | `PAYROLL_CYCLE_STATE` |
| 10 | `VALIDATION_FAILED` | `INPUTS_OPEN` | `payroll:cycle:transition` | `approval.note_required` | `PAYROLL_CYCLE_STATE` |
| 11 | `VALIDATION_FAILED` | `VALIDATING` | `payroll:validate` | — | — |
| 12 | `VALIDATED` | `CALCULATING` | `payroll:calculate` | `payroll.validated_recently` (validation ≤ 24 h old and no input/attendance change since) | — |
| 13 | `CALCULATING` | `CALCULATED` | *(system)* | `payroll.run_succeeded`, `payroll.payslip_count_matches_employee_count`, `payroll.controls_balance` | `PAYROLL_CYCLE_STATE` → Accounts |
| 14 | `CALCULATING` | `VALIDATION_FAILED` | *(system)* | `payroll.run_failed` | `PAYROLL_CYCLE_STATE` |
| 15 | `CALCULATED` | `APPROVED` | `payroll:approve` | `payroll.distinct_approver`, `payroll.controls_balance` | `PAYROLL_CYCLE_STATE` |
| 16 | `CALCULATED` | `VALIDATED` | `payroll:cycle:transition` | `approval.note_required` (discards the run; payslips → `SUPERSEDED`) | `PAYROLL_CYCLE_STATE` |
| 17 | `APPROVED` | `PUBLISHED` | `payroll:publish` | `payroll.distinct_approver`, `payroll.every_payslip_generated`, `payroll.pay_date_set` | `PAYSLIP_PUBLISHED` → every employee in the run |
| 18 | `PUBLISHED` | `CLOSED` | `payroll:close` | `payroll.pay_date_passed`, `payroll.reimbursements_settled` | — |
| 19 | `DRAFT`/`INPUTS_OPEN`/`INPUTS_LOCKED`/`VALIDATION_FAILED` | `CANCELLED` | `payroll:cycle:transition` | `payroll.no_payslips_exist`, `approval.note_required` | `PAYROLL_CYCLE_STATE` |

Terminal: `CLOSED`, `CANCELLED`. There is **no** transition from `PUBLISHED` back to any
earlier state — a correction is a new cycle or an off-cycle run producing a superseding
payslip revision (§10.7).

### 10.3 `pay_component` — reference data, seeded

The earning and deduction lines the payslip renders (`Basic salary`, `House rent
allowance`, `Special allowance`, `Leave travel allowance`, `Conveyance allowance`,
`Provident fund (employee)`, `Income tax (TDS)`, `Professional tax`,
`Group insurance premium`, `Performance incentive`, …) are rows here — never string
literals in code.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `BASIC`, `HRA`, `SPECIAL`, `LTA`, `CONVEYANCE`, `PF_EE`, `PF_ER`, `TDS`, `PT`, `GROUP_INS`, `INCENTIVE`, `ARREAR`, `LOP_DEDUCTION` |
| `name` | `text` | no | — | The exact payslip line label |
| `kind` | `ess_pay_component_kind` | no | — | |
| `calculation` | `ess_pay_component_calc` | no | — | |
| `calculation_basis_component_id` | `uuid` | yes | — | FK → `pay_component(id)` `ON DELETE RESTRICT` — e.g. `PF_EE` is a percent of `BASIC` |
| `rate` | `numeric(12,6)` | yes | — | `0.120000` for PF |
| `is_taxable` | `boolean` | no | `true` | |
| `is_prorated_by_payable_days` | `boolean` | no | `false` | `true` for `PRORATED_FIXED` |
| `affects_gross` | `boolean` | no | *(generated)* | `GENERATED ALWAYS AS (kind = 'EARNING') STORED` |
| `statutory_key` | `text` | yes | — | `EPF`, `ESI`, `PT_KA`, `TDS_24Q` — links to the statutory engine |
| `display_order` | `smallint` | no | `0` | **Fixes the payslip line order.** The UI never sorts. |
| `display_group` | `text` | no | — | `EARNINGS` \| `DEDUCTIONS` \| `EMPLOYER` \| `INFO` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_pay_component__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_pay_component__rate CHECK (
  (calculation IN ('PERCENT_OF_BASIC','PERCENT_OF_GROSS') AND rate IS NOT NULL AND rate >= 0 AND rate <= 1)
  OR (calculation NOT IN ('PERCENT_OF_BASIC','PERCENT_OF_GROSS'))),
CONSTRAINT ck_pay_component__basis CHECK (
  calculation <> 'PERCENT_OF_BASIC' OR calculation_basis_component_id IS NOT NULL),
CONSTRAINT ck_pay_component__group CHECK (display_group IN ('EARNINGS','DEDUCTIONS','EMPLOYER','INFO'))
```
Index: `ix_pay_component__org_order (organization_id, display_group, display_order) WHERE is_active`.

### 10.4 `salary_structure` and `salary_structure_component` (effective-dated)

| `salary_structure` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `effective_from` | `date` | no | — | |
| `effective_to` | `date` | yes | — | `NULL` = current |
| `annual_ctc_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | no | — | Encrypted; needed for `MULTIPLE_OF_CTC` benefits |
| `pay_frequency` | `text` | no | `'MONTHLY'` | |
| `revision_reason` | `text` | no | — | `NEW_HIRE`, `ANNUAL_REVISION`, `PROMOTION`, `CORRECTION` |
| `source_document_id` | `uuid` | yes | — | FK → `employee_document(id)` `ON DELETE SET NULL` — the salary revision letter |
| `approved_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `approved_at` | `timestamptz` | no | `now()` | |
| `structure_sha256` | `bytea` | no | — | SHA-256 over the canonical JSON of the component set; copied into every payslip generated from it |

```sql
CONSTRAINT ck_salary_structure__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
CONSTRAINT ex_salary_structure__no_overlap EXCLUDE USING gist (
  employee_id WITH =, daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&),
CONSTRAINT ck_salary_structure__sha CHECK (octet_length(structure_sha256) = 32)
```
Indexes: `ux_salary_structure__current (employee_id) WHERE effective_to IS NULL`,
`ix_salary_structure__asof (employee_id, effective_from DESC)`.
**Immutable once referenced by a payslip** (trigger `trg_immutable_referenced_structure`);
a change is a new effective-dated row.

| `salary_structure_component` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `salary_structure_id` | `uuid` | no | — | FK → `salary_structure(id)` `ON DELETE CASCADE` |
| `pay_component_id` | `uuid` | no | — | FK → `pay_component(id)` `ON DELETE RESTRICT` |
| `amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | yes | — | Encrypted monthly amount for `FIXED`/`PRORATED_FIXED` |
| `rate_override` | `numeric(12,6)` | yes | — | Overrides `pay_component.rate` |
| `display_order` | `smallint` | no | `0` | Falls back to `pay_component.display_order` |

```sql
CONSTRAINT ux_ssc__structure_component UNIQUE (salary_structure_id, pay_component_id),
CONSTRAINT ck_ssc__value_present CHECK (amount_minor_ct IS NOT NULL OR rate_override IS NOT NULL)
```

### 10.5 `payroll_input_batch` and `payroll_input_item` — the Accounts upload

| `payroll_input_batch` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payroll_cycle_id` | `uuid` | no | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` |
| `batch_no` | `integer` | no | — | Sequential within the cycle |
| `file_object_id` | `uuid` | no | — | FK → `file_object(id)` `ON DELETE RESTRICT` — the uploaded CSV/XLSX, retained as evidence |
| `original_filename` | `text` | no | — | |
| `file_sha256` | `bytea` | no | — | 32 bytes; duplicate uploads are rejected |
| `status` | `ess_payroll_input_batch_status` | no | `'UPLOADING'` | |
| `row_count_total` | `integer` | no | `0` | |
| `row_count_valid` | `integer` | no | `0` | |
| `row_count_rejected` | `integer` | no | `0` | |
| `declared_total_minor` | `money_minor` | yes | — | Control total typed by the uploader; must equal the parsed sum or the batch fails `VALIDATED` |
| `parsed_total_minor` | `money_minor` | yes | — | Computed at parse |
| `uploaded_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `uploaded_at` | `timestamptz` | no | `now()` | |
| `committed_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `committed_at` | `timestamptz` | yes | — | |
| `superseded_by_batch_id` | `uuid` | yes | — | FK → `payroll_input_batch(id)` `ON DELETE SET NULL` |
| `parse_error` | `jsonb` | yes | — | `{ "line": 42, "column": "amount", "message": "…" }[]` — rendered in the Accounts upload screen, never in an employee surface |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_pib__cycle_batch_no UNIQUE (payroll_cycle_id, batch_no),
CONSTRAINT ux_pib__cycle_file_sha UNIQUE (payroll_cycle_id, file_sha256),
CONSTRAINT ck_pib__sha CHECK (octet_length(file_sha256) = 32),
CONSTRAINT ck_pib__counts CHECK (row_count_total = row_count_valid + row_count_rejected),
CONSTRAINT ck_pib__committed CHECK (num_nulls(committed_at, committed_by_user_id) IN (0, 2)),
CONSTRAINT ck_pib__commit_status CHECK (status <> 'COMMITTED' OR committed_at IS NOT NULL),
CONSTRAINT ck_pib__totals_match CHECK (
  status <> 'VALIDATED' OR declared_total_minor IS NULL OR declared_total_minor = parsed_total_minor)
```
Indexes: `ix_pib__cycle_status (payroll_cycle_id, status)`,
`ix_pib__uploader (uploaded_by_user_id, uploaded_at DESC)`.

| `payroll_input_item` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payroll_input_batch_id` | `uuid` | no | — | FK → `payroll_input_batch(id)` `ON DELETE CASCADE` |
| `payroll_cycle_id` | `uuid` | no | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — denormalised for the generator's single-scan read |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `source_row_no` | `integer` | no | — | Line in the uploaded file — traceability to the source artefact |
| `kind` | `ess_payroll_input_kind` | no | — | |
| `pay_component_id` | `uuid` | yes | — | FK → `pay_component(id)` `ON DELETE RESTRICT`. Required for every kind except `LOP_OVERRIDE`. |
| `amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | yes | — | Encrypted. Required unless `kind = 'LOP_OVERRIDE'`. |
| `lop_days_override` | `numeric(5,2)` | yes | — | Only for `kind = 'LOP_OVERRIDE'` |
| `effective_period_code` | `text` | yes | — | For `ARREAR`: which past period the arrear relates to |
| `narration` | `text` | yes | — | Rendered as the payslip line's sub-label when present |
| `expense_claim_id` | `uuid` | yes | — | FK → `expense_claim(id)` `ON DELETE RESTRICT` — set for `REIMBURSEMENT_PAYOUT`, closing the loop to §13 |
| `is_rejected` | `boolean` | no | `false` | Parse/validation rejected this row |
| `rejection_reason` | `text` | yes | — | |

```sql
CONSTRAINT ck_pii__component_required CHECK (kind = 'LOP_OVERRIDE' OR pay_component_id IS NOT NULL),
CONSTRAINT ck_pii__amount_required CHECK (kind = 'LOP_OVERRIDE' OR amount_minor_ct IS NOT NULL),
CONSTRAINT ck_pii__lop_only CHECK ((kind = 'LOP_OVERRIDE') = (lop_days_override IS NOT NULL)),
CONSTRAINT ck_pii__lop_range CHECK (lop_days_override IS NULL OR lop_days_override >= 0),
CONSTRAINT ck_pii__rejection CHECK (is_rejected = (rejection_reason IS NOT NULL)),
CONSTRAINT ck_pii__reimb_link CHECK (kind <> 'REIMBURSEMENT_PAYOUT' OR expense_claim_id IS NOT NULL),
CONSTRAINT ux_pii__batch_row UNIQUE (payroll_input_batch_id, source_row_no)
```
Indexes:
- `ix_pii__cycle_employee (payroll_cycle_id, employee_id) WHERE NOT is_rejected` — the generator's hot path
- `ix_pii__employee_kind (employee_id, kind)`
- `ux_pii__one_lop_override_per_employee_cycle UNIQUE (payroll_cycle_id, employee_id) WHERE kind = 'LOP_OVERRIDE' AND NOT is_rejected`
- `ux_pii__one_payout_per_claim UNIQUE (expense_claim_id) WHERE kind = 'REIMBURSEMENT_PAYOUT' AND NOT is_rejected`

### 10.6 `payroll_validation_result` and `payroll_run`

| `payroll_validation_result` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payroll_cycle_id` | `uuid` | no | — | FK → `payroll_cycle(id)` `ON DELETE CASCADE` |
| `validation_pass_no` | `integer` | no | — | Increments each time `VALIDATING` is entered |
| `rule_code` | `text` | no | — | `PAY_NO_SALARY_STRUCTURE`, `PAY_BANK_UNVERIFIED`, `PAY_ATTENDANCE_MISSING`, `PAY_LOP_EXCEEDS_ELIGIBLE`, `PAY_NEGATIVE_NET`, `PAY_INPUT_ORPHAN_EMPLOYEE`, `PAY_DUPLICATE_INPUT`, `PAY_TDS_MISSING_PAN`, `PAY_CTC_MISSING`, `ATT_TOTALS_DRIFT`, `PAY_CONTROL_TOTAL_MISMATCH` |
| `severity` | `ess_payroll_validation_severity` | no | — | |
| `employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE CASCADE`. NULL = cycle-level finding. |
| `entity_type` | `text` | yes | — | `payroll_input_item`, `attendance_record`, `salary_structure` |
| `entity_id` | `uuid` | yes | — | Not an FK (polymorphic) |
| `message` | `text` | no | — | Human-readable, no amounts in plaintext |
| `detail` | `jsonb` | yes | — | Redacted structured context |
| `resolved_at` | `timestamptz` | yes | — | |
| `resolved_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `resolution_note` | `text` | yes | — | |
| `created_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ck_pvr__resolution CHECK (num_nulls(resolved_at, resolved_by_user_id, resolution_note) IN (0, 3)),
CONSTRAINT ux_pvr__pass_rule_entity UNIQUE (payroll_cycle_id, validation_pass_no, rule_code, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid))
```
Indexes: `ix_pvr__cycle_severity (payroll_cycle_id, validation_pass_no, severity)`,
`ix_pvr__unresolved_errors (payroll_cycle_id) WHERE severity = 'ERROR' AND resolved_at IS NULL`.

Guard `payroll.no_error_validations` is exactly
`NOT EXISTS (SELECT 1 FROM payroll_validation_result WHERE payroll_cycle_id = $1 AND validation_pass_no = $2 AND severity = 'ERROR' AND resolved_at IS NULL)`.

| `payroll_run` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payroll_cycle_id` | `uuid` | no | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` |
| `run_no` | `integer` | no | — | Sequential per cycle; a re-run supersedes the previous |
| `status` | `ess_payroll_run_status` | no | `'QUEUED'` | |
| `engine_version` | `text` | no | — | Semver of the calculation engine — reproducibility anchor |
| `ruleset_sha256` | `bytea` | no | — | SHA-256 over the active `pay_component` set + statutory tables used |
| `started_at` | `timestamptz` | yes | — | |
| `finished_at` | `timestamptz` | yes | — | |
| `triggered_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `employee_count` | `integer` | no | `0` | |
| `payslip_count` | `integer` | no | `0` | |
| `error_message` | `text` | yes | — | |
| `error_detail` | `jsonb` | yes | — | |
| `input_manifest_sha256` | `bytea` | no | — | SHA-256 over the ordered list of every `payroll_input_item.id`, `attendance_record.id` and `salary_structure.id` the run consumed |
| `superseded_by_run_id` | `uuid` | yes | — | FK → `payroll_run(id)` `ON DELETE SET NULL` |

```sql
CONSTRAINT ux_payroll_run__cycle_run_no UNIQUE (payroll_cycle_id, run_no),
CONSTRAINT ck_payroll_run__sha CHECK (octet_length(ruleset_sha256) = 32 AND octet_length(input_manifest_sha256) = 32),
CONSTRAINT ck_payroll_run__times CHECK (finished_at IS NULL OR started_at IS NOT NULL),
CONSTRAINT ck_payroll_run__failure CHECK (status <> 'FAILED' OR error_message IS NOT NULL),
CONSTRAINT ux_payroll_run__one_live UNIQUE (payroll_cycle_id) WHERE status = 'SUCCEEDED' AND superseded_by_run_id IS NULL
```

### 10.7 `payslip` — immutable, versioned, hash-traceable

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payroll_cycle_id` | `uuid` | no | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` |
| `payroll_run_id` | `uuid` | no | — | FK → `payroll_run(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `reference_no` | `citext` | no | — | `WDT-PS-2608-1847` — exactly the prototype's format: `<org>-PS-<YYMM>-<employee numeric suffix>`. Unique per org. |
| `revision` | `smallint` | no | `1` | |
| `supersedes_payslip_id` | `uuid` | yes | — | FK → `payslip(id)` `ON DELETE RESTRICT` |
| `status` | `ess_payslip_status` | no | `'GENERATED'` | |
| `period_label` | `text` | no | — | `August 2026` — copied from the cycle, frozen |
| `period_start` | `date` | no | — | |
| `period_end` | `date` | no | — | |
| `pay_date` | `date` | no | — | Rendered as "Credited 31 Aug 2026" |
| `payment_mode` | `text` | no | `'NEFT'` | Rendered in the payslip meta line |
| `bank_account_last4` | `char(4)` | no | — | Snapshot; the header renders `HDFC Bank ••4412` from `bank_name_snapshot` + this |
| `bank_name_snapshot` | `text` | no | — | |
| `payable_days` | `numeric(5,2)` | no | — | Snapshot of `attendance_record.payable_days` |
| `total_days` | `numeric(5,2)` | no | — | Snapshot of `attendance_record.calendar_days`. Together they render `31 / 31`. |
| `lop_days` | `numeric(5,2)` | no | `0` | |
| `gross_earnings_minor_ct/_iv/_tag/_dek_id` | envelope | no | — | Encrypted |
| `total_deductions_minor_ct/…` | envelope | no | — | Encrypted |
| `net_pay_minor_ct/…` | envelope | no | — | Encrypted |
| `employer_pf_minor_ct/…` | envelope | yes | — | Encrypted; "Employer PF" meta |
| `tds_minor_ct/…` | envelope | no | — | Encrypted; "TDS this month" meta |
| `attendance_record_id` | `uuid` | no | — | FK → `attendance_record(id)` `ON DELETE RESTRICT` — source traceability |
| `salary_structure_id` | `uuid` | no | — | FK → `salary_structure(id)` `ON DELETE RESTRICT` — source traceability |
| `salary_structure_sha256` | `bytea` | no | — | Copy of `salary_structure.structure_sha256` at generation |
| `input_snapshot` | `jsonb` | no | — | **Canonical, redacted** record of every input that produced this payslip: attendance day counts, the ordered list of `payroll_input_item` ids with their kinds, the resolved component set, the tax projection id, the engine + ruleset versions. Money values inside are stored as minor-unit **strings**. |
| `input_sha256` | `bytea` | no | — | SHA-256 over the canonical serialisation of `input_snapshot`. Recomputing it is the audit test "this payslip still matches its inputs". |
| `pdf_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` — generated at publication |
| `generated_at` | `timestamptz` | no | `now()` | |
| `revoked_at` | `timestamptz` | yes | — | |
| `revoked_reason` | `text` | yes | — | |

```sql
CONSTRAINT ux_payslip__org_reference UNIQUE (organization_id, reference_no),
CONSTRAINT ux_payslip__cycle_employee_revision UNIQUE (payroll_cycle_id, employee_id, revision),
CONSTRAINT ck_payslip__revision CHECK (revision >= 1),
CONSTRAINT ck_payslip__supersede CHECK ((revision > 1) = (supersedes_payslip_id IS NOT NULL)),
CONSTRAINT ck_payslip__days CHECK (payable_days >= 0 AND payable_days <= total_days AND lop_days >= 0),
CONSTRAINT ck_payslip__period CHECK (period_end >= period_start AND pay_date >= period_end),
CONSTRAINT ck_payslip__sha CHECK (octet_length(input_sha256) = 32 AND octet_length(salary_structure_sha256) = 32),
CONSTRAINT ck_payslip__last4 CHECK (bank_account_last4 ~ '^[0-9]{4}$'),
CONSTRAINT ck_payslip__revoked CHECK (num_nulls(revoked_at, revoked_reason) IN (0, 2)),
CONSTRAINT ck_payslip__revoked_status CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
```
Indexes:
- `ux_payslip__cycle_employee_revision (payroll_cycle_id, employee_id, revision)`
- `ix_payslip__employee_period (employee_id, period_end DESC) WHERE status = 'PUBLISHED'` — the Payslips list, newest first
- `ix_payslip__employee_fy (employee_id, fiscal_year_id) WHERE status = 'PUBLISHED'` — the YTD tiles and TDS aggregation
- `ix_payslip__cycle_status (payroll_cycle_id, status)`
- `ix_payslip__search (organization_id, period_label)` — the global search "Payslip" result kind
- `ux_payslip__one_live_per_cycle_employee UNIQUE (payroll_cycle_id, employee_id) WHERE status IN ('GENERATED','PUBLISHED')`

**Immutability.** Trigger `trg_payslip_immutable` (BEFORE UPDATE) rejects any change to
any column **except** `status`, `pdf_file_object_id`, `supersedes_payslip_id` (on the
superseded row), `revoked_at`, `revoked_reason`, `updated_at`, `updated_by_user_id`.
`DELETE` is rejected outright. Corrections create `revision = n+1` and set the old row's
`status = 'SUPERSEDED'`.

**Visibility gate (the hard rule).** The employee-facing query is *always*:

```sql
SELECT p.* FROM payslip p
JOIN payslip_publication pub ON pub.payslip_id = p.id
WHERE p.employee_id = :me
  AND p.status = 'PUBLISHED'
  AND pub.published_at <= now()
  AND pub.revoked_at IS NULL
ORDER BY p.period_end DESC;
```

No other path exists in the employee API. Before publication the Payslips screen shows
its designed empty state ("No payslips yet — your first payslip appears once August
payroll is published"), driven by
`payroll_cycle.status` for the employee's earliest in-scope cycle. It never renders a
draft, a provisional total, or a synthetic figure.

### 10.8 `payslip_line` and `payslip_publication`

| `payslip_line` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payslip_id` | `uuid` | no | — | FK → `payslip(id)` `ON DELETE RESTRICT` |
| `pay_component_id` | `uuid` | no | — | FK → `pay_component(id)` `ON DELETE RESTRICT` |
| `kind` | `ess_payslip_line_kind` | no | — | Drives which column the line renders in |
| `label_snapshot` | `text` | no | — | `pay_component.name` frozen at generation, so renaming a component never rewrites history |
| `narration` | `text` | yes | — | From `payroll_input_item.narration` |
| `amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | no | — | Encrypted, **signed** value |
| `quantity` | `numeric(10,2)` | yes | — | e.g. overtime hours |
| `rate_applied` | `numeric(12,6)` | yes | — | e.g. `0.120000` for PF — makes the line reproducible |
| `basis_amount_minor_ct/…` | envelope | yes | — | The base the rate was applied to |
| `source_input_item_id` | `uuid` | yes | — | FK → `payroll_input_item(id)` `ON DELETE RESTRICT` — a line that came from an Accounts upload points back at the exact uploaded row |
| `display_order` | `smallint` | no | — | Snapshot of `pay_component.display_order` |
| `is_taxable_snapshot` | `boolean` | no | — | |

```sql
CONSTRAINT ux_payslip_line__slip_component_order UNIQUE (payslip_id, pay_component_id, display_order),
CONSTRAINT ck_payslip_line__order CHECK (display_order >= 0)
```
Indexes: `ix_payslip_line__slip_order (payslip_id, kind, display_order)` — the exact read
order of the Earnings and Deductions columns; `ix_payslip_line__source (source_input_item_id)`.
Same immutability trigger as `payslip`: no `UPDATE`, no `DELETE`.

| `payslip_publication` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payslip_id` | `uuid` | no | — | FK → `payslip(id)` `ON DELETE RESTRICT` |
| `payroll_cycle_id` | `uuid` | no | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` — denormalised so the visibility gate needs no join to `payslip` |
| `published_at` | `timestamptz` | no | `now()` | May be future-dated for a scheduled release |
| `published_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `notification_id` | `uuid` | yes | — | FK → `notification(id)` `ON DELETE SET NULL` — the "Your payslip for August 2026 is ready" notification |
| `email_outbox_id` | `uuid` | yes | — | FK → `email_outbox(id)` `ON DELETE SET NULL` |
| `first_viewed_at` | `timestamptz` | yes | — | Set once, on the employee's first successful read |
| `first_downloaded_at` | `timestamptz` | yes | — | |
| `download_count` | `integer` | no | `0` | Incremented on each PDF fetch; every fetch also writes an `audit_event` (`DOWNLOAD`) |
| `revoked_at` | `timestamptz` | yes | — | |
| `revoked_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `revoked_reason` | `text` | yes | — | |

```sql
CONSTRAINT ux_payslip_publication__payslip UNIQUE (payslip_id),
CONSTRAINT ck_pp__revocation CHECK (num_nulls(revoked_at, revoked_by_user_id, revoked_reason) IN (0, 3)),
CONSTRAINT ck_pp__downloads CHECK (download_count >= 0)
```
Indexes:
- `ix_pp__employee_live (employee_id, published_at DESC) WHERE revoked_at IS NULL` — the visibility gate's driving index
- `ix_pp__cycle (payroll_cycle_id)`

### 10.9 `payslip_fy_rollup` — queryable YTD totals without decrypting

Written in the same transaction as each `payslip_publication` insert (and reversed on
revocation) by `fn_refresh_payslip_fy_rollup(employee, fiscal_year)`. It exists solely so
the Payslips YTD tiles are a single indexed read, and it holds only figures the employee
is already entitled to see.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `payslip_count` | `integer` | no | `0` | → tile sub-label "5 payslips" |
| `first_period_label` | `text` | yes | — | `April 2026` |
| `last_period_label` | `text` | yes | — | `August 2026` — together they render "Apr – Aug 2026" |
| `gross_earned_minor` | `money_minor` | no | `0` | → "Gross earned" |
| `net_credited_minor` | `money_minor` | no | `0` | → "Net credited" |
| `total_deductions_minor` | `money_minor` | no | `0` | |
| `tds_minor` | `money_minor` | no | `0` | → "TDS deducted" |
| `employee_pf_minor` | `money_minor` | no | `0` | |
| `employer_pf_minor` | `money_minor` | no | `0` | `employee_pf + employer_pf` → "PF contributed" |
| `recomputed_at` | `timestamptz` | no | `now()` | |
| `source_payslip_ids` | `uuid[]` | no | `'{}'` | The exact rows folded — makes the tile auditable |

```sql
CONSTRAINT ux_psfy__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_psfy__nonneg CHECK (
  payslip_count >= 0 AND gross_earned_minor >= 0 AND net_credited_minor >= 0
  AND total_deductions_minor >= 0 AND tds_minor >= 0
  AND employee_pf_minor >= 0 AND employer_pf_minor >= 0)
```
Index: `ux_psfy__employee_fy (employee_id, fiscal_year_id)`.

> **Security note.** This rollup is per-employee and non-reversible: it exposes no
> per-component breakdown and no other employee's figures, and it is protected by the
> same RLS self/scope policy as `payslip`. A row exists **only** after at least one
> publication, so a zero row is never rendered — with no row, the tiles show `—` and
> the sub-label "No published payslips in FY 2026–27 yet".

---

## 11. Reimbursement batches — the payroll ↔ expense bridge

| `reimbursement_batch` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `payroll_cycle_id` | `uuid` | yes | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — **the cycle that paid it**. NULL only while `DRAFT`. |
| `batch_no` | `citext` | no | — | `RB-2026-09`. Unique per org. |
| `cutoff_date` | `date` | no | — | `organization.expense_cutoff_day_of_month` resolved for the month |
| `status` | `ess_reimbursement_batch_status` | no | `'DRAFT'` | |
| `claim_count` | `integer` | no | `0` | |
| `total_amount_minor` | `money_minor` | no | `0` | Org-level control total (not per-employee), `payroll:reimburse` scope only |
| `locked_at` | `timestamptz` | yes | — | |
| `locked_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `paid_at` | `timestamptz` | yes | — | Set when the payroll cycle publishes |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_reimbursement_batch__org_no UNIQUE (organization_id, batch_no),
CONSTRAINT ck_rb__cycle_required CHECK (status = 'DRAFT' OR payroll_cycle_id IS NOT NULL),
CONSTRAINT ck_rb__totals CHECK (claim_count >= 0 AND total_amount_minor >= 0),
CONSTRAINT ck_rb__paid CHECK ((status = 'PAID') = (paid_at IS NOT NULL))
```

| `reimbursement_batch_item` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `reimbursement_batch_id` | `uuid` | no | — | FK → `reimbursement_batch(id)` `ON DELETE CASCADE` |
| `expense_claim_id` | `uuid` | no | — | FK → `expense_claim(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `amount_minor` | `money_minor` | no | — | Approved amount; `CHECK (amount_minor > 0)` |
| `payroll_input_item_id` | `uuid` | yes | — | FK → `payroll_input_item(id)` `ON DELETE SET NULL` — the `REIMBURSEMENT_PAYOUT` row created for the cycle |

```sql
CONSTRAINT ux_rbi__claim UNIQUE (expense_claim_id),
CONSTRAINT ux_rbi__batch_claim UNIQUE (reimbursement_batch_id, expense_claim_id)
```
Index: `ix_rbi__employee (employee_id, reimbursement_batch_id)`.

State machine `machine = 'reimbursement_batch'`: `NULL→DRAFT` (`expense:reimburse`) ·
`DRAFT→LOCKED` (`expense:reimburse`, guard `reimb.all_claims_finance_approved`) ·
`LOCKED→SENT_TO_PAYROLL` (`expense:reimburse`, guard `reimb.cycle_inputs_open`,
creates one `payroll_input_item` of kind `REIMBURSEMENT_PAYOUT` per item) ·
`SENT_TO_PAYROLL→PAID` (system, guard `reimb.cycle_published`; moves every linked claim
to `REIMBURSED` and emits `EXPENSE_REIMBURSED` notifications) · `DRAFT|LOCKED→CANCELLED`
(`expense:reimburse`, guard `approval.note_required`).

---
## 12. Tax and benefits

### 12.1 `tax_regime` — reference data, seeded

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `code` | `ess_tax_regime_code` | no | — | `NEW` / `OLD` |
| `name` | `text` | no | — | `New regime` — the Tax screen chip renders `New regime · FY 2026–27` from this + `fiscal_year.label` |
| `standard_deduction_minor` | `money_minor` | no | — | Regime-specific |
| `slabs` | `jsonb` | no | — | `[{"from_minor":"0","to_minor":"400000_00","rate":"0.00"}, …]` — minor units as strings |
| `surcharge_rules` | `jsonb` | no | `'[]'` | |
| `cess_rate` | `numeric(12,6)` | no | `0.040000` | |
| `rebate_87a_limit_minor` | `money_minor` | yes | — | |
| `allows_chapter_via_deductions` | `boolean` | no | — | `false` for `NEW` |
| `is_default` | `boolean` | no | `false` | Applied when an employee makes no election |

```sql
CONSTRAINT ux_tax_regime__fy_code UNIQUE (fiscal_year_id, code),
CONSTRAINT ux_tax_regime__fy_default UNIQUE (fiscal_year_id, is_default) WHERE is_default
```

### 12.2 `employee_tax_regime_election`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `tax_regime_id` | `uuid` | no | — | FK → `tax_regime(id)` `ON DELETE RESTRICT` |
| `elected_at` | `timestamptz` | no | `now()` | |
| `elected_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `is_locked` | `boolean` | no | `false` | Locked once the first payslip of the FY publishes |
| `locked_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ux_etre__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_etre__locked CHECK (is_locked = (locked_at IS NOT NULL))
```

### 12.3 `employee_tax_declaration` and `employee_tax_declaration_item`

| `employee_tax_declaration` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `tax_regime_id` | `uuid` | no | — | FK → `tax_regime(id)` `ON DELETE RESTRICT` |
| `status` | `ess_tax_declaration_status` | no | `'DRAFT'` | |
| `form_reference` | `text` | no | `'12BB'` | The Tax screen's "Investment declaration · Form 12BB" |
| `submitted_at` | `timestamptz` | yes | — | Renders "Declared on 18 Apr 2026" |
| `proof_submitted_at` | `timestamptz` | yes | — | |
| `verified_at` | `timestamptz` | yes | — | |
| `verified_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `rejection_reason` | `text` | yes | — | |
| `declared_total_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | yes | — | Encrypted; sum of items, recomputed server-side |
| `verified_total_minor_ct/…` | envelope | yes | — | Encrypted; amount actually allowed after proof verification |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_etd__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_etd__submitted CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
CONSTRAINT ck_etd__verified CHECK (num_nulls(verified_at, verified_by_user_id) IN (0, 2)),
CONSTRAINT ck_etd__rejected CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL)
```

| `employee_tax_declaration_item` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_tax_declaration_id` | `uuid` | no | — | FK → `employee_tax_declaration(id)` `ON DELETE CASCADE` |
| `section_code` | `text` | no | — | `80C`, `80D`, `80CCD1B`, `24B`, `HRA`, `LTA` |
| `sub_category` | `text` | yes | — | `ELSS`, `PPF`, `Life insurance premium` |
| `declared_amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | no | — | Encrypted |
| `verified_amount_minor_ct/…` | envelope | yes | — | Encrypted |
| `proof_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `proof_status` | `text` | no | `'NOT_SUBMITTED'` | `NOT_SUBMITTED` \| `SUBMITTED` \| `ACCEPTED` \| `REJECTED` |
| `reviewer_note` | `text` | yes | — | |
| `display_order` | `smallint` | no | `0` | |

```sql
CONSTRAINT ux_etdi__declaration_section_sub UNIQUE (employee_tax_declaration_id, section_code, coalesce(sub_category, '')),
CONSTRAINT ck_etdi__proof_status CHECK (proof_status IN ('NOT_SUBMITTED','SUBMITTED','ACCEPTED','REJECTED'))
```

State machine `machine = 'employee_tax_declaration'`: `NULL→DRAFT`
(`tax:declaration:write:self`) · `DRAFT→SUBMITTED` (`tax:declaration:write:self`, guard
`tax.declaration_window_open`) · `SUBMITTED→PROOF_PENDING` (system, guard
`tax.proof_window_open`) · `PROOF_PENDING→PROOF_SUBMITTED`
(`tax:declaration:write:self`, guard `tax.all_items_have_proof`) ·
`PROOF_SUBMITTED→VERIFIED` (`tax:declaration:verify`) · `PROOF_SUBMITTED→REJECTED`
(`tax:declaration:verify`, guard `approval.note_required`) · `REJECTED→PROOF_PENDING`
(`tax:declaration:write:self`). Terminal: `VERIFIED`.

### 12.4 `employee_tax_projection` — the persisted output the Tax screen reads

Written by every successful `payroll_run`, one row per employee per run. Nothing on the
Tax screen is computed in the browser.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `payroll_run_id` | `uuid` | no | — | FK → `payroll_run(id)` `ON DELETE RESTRICT` |
| `tax_regime_id` | `uuid` | no | — | FK → `tax_regime(id)` `ON DELETE RESTRICT` |
| `as_of_period_code` | `text` | no | — | `2026-08` |
| `projected_gross_minor` | `money_minor` | no | — | → "Projected gross" |
| `standard_deduction_minor` | `money_minor` | no | — | → "Standard deduction" |
| `declared_deductions_minor` | `money_minor` | no | `0` | Chapter VI-A allowed under the regime |
| `taxable_income_minor` | `money_minor` | no | — | |
| `tax_before_cess_minor` | `money_minor` | no | — | |
| `surcharge_minor` | `money_minor` | no | `0` | |
| `cess_minor` | `money_minor` | no | — | |
| `projected_annual_tax_minor` | `money_minor` | no | — | → the headline "₹2,74,320 · Projected annual tax including 4% cess" |
| `tds_deducted_to_date_minor` | `money_minor` | no | — | Σ of published payslips' TDS in this FY at run time → "Deducted Apr – Aug" |
| `tds_remaining_minor` | `money_minor` | no | *(generated)* | `GENERATED ALWAYS AS (greatest(projected_annual_tax_minor - tds_deducted_to_date_minor, 0)) STORED` → "₹1,58,090 remaining" |
| `remaining_months` | `smallint` | no | — | Payroll cycles left in the FY → "over 7 months" |
| `monthly_tds_minor` | `money_minor` | no | — | This period's TDS → "Monthly TDS" |
| `next_month_tds_estimate_minor` | `money_minor` | no | — | `ceil(tds_remaining / remaining_months)` → "about ₹22,584 per month" |
| `is_current` | `boolean` | no | `false` | Exactly one current row per employee/FY |
| `computed_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ux_etp__employee_fy_run UNIQUE (employee_id, fiscal_year_id, payroll_run_id),
CONSTRAINT ux_etp__one_current UNIQUE (employee_id, fiscal_year_id, is_current) WHERE is_current,
CONSTRAINT ck_etp__nonneg CHECK (
  projected_gross_minor >= 0 AND standard_deduction_minor >= 0 AND declared_deductions_minor >= 0
  AND taxable_income_minor >= 0 AND tax_before_cess_minor >= 0 AND surcharge_minor >= 0
  AND cess_minor >= 0 AND projected_annual_tax_minor >= 0 AND tds_deducted_to_date_minor >= 0
  AND monthly_tds_minor >= 0 AND next_month_tds_estimate_minor >= 0),
CONSTRAINT ck_etp__months CHECK (remaining_months BETWEEN 0 AND 12)
```
Index: `ix_etp__employee_current (employee_id, fiscal_year_id) WHERE is_current`.

> Projection figures are **not** encrypted: they are per-employee derived totals read
> only by the owning employee and `tax:declaration:read:any`, protected by RLS, and the
> Tax screen needs the percentage arithmetic server-side. The per-component salary
> detail that would let someone reconstruct compensation stays encrypted in
> `payslip_line`. If an organisation's threat model requires it, this table can be moved
> to the envelope pattern at the cost of folding the percentage in the API layer.
> **Empty state:** no `is_current` row ⇒ the TDS summary card renders `—` for every
> figure with the sub-label "Your first payroll of FY 2026–27 has not run yet".

### 12.5 `tds_quarter`

One row per employee per FY quarter, created when the FY is seeded so the Tax screen can
render all four rows — `UPCOMING` quarters legitimately have **no** amount and render `—`
(exactly the prototype's Q3/Q4 behaviour), which is a persisted status, not a fabricated
value.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_quarter_id` | `uuid` | no | — | FK → `fiscal_quarter(id)` `ON DELETE RESTRICT` |
| `status` | `ess_tds_quarter_status` | no | `'UPCOMING'` | |
| `tds_deducted_minor` | `money_minor` | yes | — | `NULL` while `UPCOMING`. Recomputed as Σ `payslip.tds_minor` over published payslips whose `period_end` falls in the quarter. |
| `payslip_count` | `integer` | no | `0` | |
| `source_payslip_ids` | `uuid[]` | no | `'{}'` | Traceability |
| `form_24q_ack_no` | `text` | yes | — | Set when filed |
| `filed_at` | `timestamptz` | yes | — | |
| `filed_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `revised_at` | `timestamptz` | yes | — | |
| `recomputed_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ux_tds_quarter__employee_quarter UNIQUE (employee_id, fiscal_quarter_id),
CONSTRAINT ck_tdsq__amount CHECK (tds_deducted_minor IS NULL OR tds_deducted_minor >= 0),
CONSTRAINT ck_tdsq__upcoming_null CHECK (status <> 'UPCOMING' OR tds_deducted_minor IS NULL),
CONSTRAINT ck_tdsq__filed CHECK ((status IN ('FILED','REVISED')) = (filed_at IS NOT NULL)),
CONSTRAINT ck_tdsq__filed_ack CHECK (status <> 'FILED' OR form_24q_ack_no IS NOT NULL)
```
Index: `ix_tdsq__employee_fq (employee_id, fiscal_quarter_id)`.

**Status derivation (deterministic, run nightly and after every publication):**
`FILED`/`REVISED` are set by Accounts. Otherwise `IN_PROGRESS` when
`CURRENT_DATE BETWEEN fiscal_quarter.start_date AND fiscal_quarter.end_date` or at least
one payslip exists in it; `UPCOMING` when `fiscal_quarter.start_date > CURRENT_DATE`.
Chip tones follow Design System §1: `FILED`→green, `IN_PROGRESS`→amber,
`UPCOMING`→gray, `REVISED`→blue.

### 12.6 `form16_document`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `status` | `ess_form16_status` | no | `'PENDING'` | |
| `revision` | `smallint` | no | `1` | |
| `file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE RESTRICT`. NULL while `PENDING`. |
| `file_name` | `text` | yes | — | `Form16_FY2025-26.pdf` — the exact string the row renders |
| `includes_part_a` | `boolean` | no | `true` | |
| `includes_part_b` | `boolean` | no | `true` | |
| `is_digitally_signed` | `boolean` | no | `false` | Drives the card sub-label "Part A and Part B · digitally signed" |
| `traces_ack_no` | `text` | yes | — | |
| `issued_at` | `timestamptz` | yes | — | Renders "Issued 12 Jun 2026" |
| `issued_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `withdrawn_at` | `timestamptz` | yes | — | |
| `withdrawn_reason` | `text` | yes | — | |

```sql
CONSTRAINT ux_form16__employee_fy_revision UNIQUE (employee_id, fiscal_year_id, revision),
CONSTRAINT ck_form16__issued CHECK (
  (status IN ('ISSUED','REVISED')) = (issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL AND file_object_id IS NOT NULL)),
CONSTRAINT ck_form16__withdrawn CHECK (num_nulls(withdrawn_at, withdrawn_reason) IN (0, 2)),
CONSTRAINT ck_form16__revision CHECK (revision >= 1)
```
Index: `ix_form16__employee_issued (employee_id, issued_at DESC) WHERE status IN ('ISSUED','REVISED')`.
Every download writes an `audit_event` (`DOWNLOAD`, `is_sensitive` path).

### 12.7 Benefits — `benefit_plan`, `benefit_plan_year`

| `benefit_plan` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `GMC`, `GTL`, `NPS` |
| `name` | `text` | no | — | `Group health insurance` |
| `category` | `ess_benefit_category` | no | — | Renders the card eyebrow (`Health`, `Life`, `Retirement`) |
| `provider_name` | `text` | yes | — | `ICICI Lombard` |
| `policy_reference` | `text` | yes | — | `WDT-GMC-2026` |
| `description` | `text` | yes | — | |
| `primary_action` | `ess_benefit_action` | no | `'NONE'` | Drives the card button. `NONE` ⇒ no button is rendered. |
| `primary_action_label` | `text` | yes | — | `Download e-card` — persisted, not hardcoded |
| `supports_dependents` | `boolean` | no | `false` | |
| `max_dependents` | `smallint` | yes | — | |
| `display_order` | `smallint` | no | `0` | |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_benefit_plan__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_benefit_plan__action_label CHECK ((primary_action = 'NONE') = (primary_action_label IS NULL))
```

| `benefit_plan_year` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `benefit_plan_id` | `uuid` | no | — | FK → `benefit_plan(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `label` | `text` | no | — | `Plan year Apr 2026 – Mar 2027` — the Benefits sub-header, persisted |
| `coverage_kind` | `ess_benefit_coverage_kind` | no | — | |
| `coverage_amount_minor` | `money_minor` | yes | — | `500000_00` → `₹5,00,000` |
| `coverage_multiple` | `numeric(6,2)` | yes | — | `3.00` → `3× annual CTC` |
| `coverage_rate` | `numeric(12,6)` | yes | — | `0.100000` → NPS "10% of basic" |
| `employer_contribution_pay_component_id` | `uuid` | yes | — | FK → `pay_component(id)` `ON DELETE RESTRICT` — makes the NPS card's `₹8,600 / mo` a **read of the employee's own payslip line**, not a stored guess |
| `enrolment_window_opens_on` | `date` | yes | — | `2026-04-01` — the "Add dependent" window |
| `enrolment_window_closes_on` | `date` | yes | — | `2026-04-15` |
| `plan_document_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_bpy__plan_fy UNIQUE (benefit_plan_id, fiscal_year_id),
CONSTRAINT ck_bpy__coverage CHECK (
  (coverage_kind = 'FIXED_SUM_INSURED'  AND coverage_amount_minor IS NOT NULL)
  OR (coverage_kind = 'MULTIPLE_OF_CTC' AND coverage_multiple IS NOT NULL)
  OR (coverage_kind = 'MONTHLY_AMOUNT'  AND (coverage_amount_minor IS NOT NULL OR employer_contribution_pay_component_id IS NOT NULL))
  OR (coverage_kind = 'PERCENT_OF_BASIC' AND coverage_rate IS NOT NULL)
  OR (coverage_kind = 'NON_MONETARY')),
CONSTRAINT ck_bpy__window CHECK (
  enrolment_window_closes_on IS NULL OR enrolment_window_opens_on IS NULL
  OR enrolment_window_closes_on >= enrolment_window_opens_on)
```

### 12.8 `benefit_enrolment`, `benefit_enrolment_dependent`

| `benefit_enrolment` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `benefit_plan_year_id` | `uuid` | no | — | FK → `benefit_plan_year(id)` `ON DELETE RESTRICT` |
| `status` | `ess_benefit_enrolment_status` | no | `'ELIGIBLE'` | Only `ENROLLED` rows render a Benefits card |
| `member_reference` | `text` | yes | — | `••••4471` style masked member/PRAN id supplied by the provider; stored already masked (the full id lives in `employee_statutory_id`) |
| `sum_insured_minor` | `money_minor` | yes | — | Per-employee override of the plan-year coverage; `NULL` ⇒ use the plan year's |
| `employee_contribution_minor` | `money_minor` | yes | — | |
| `enrolled_at` | `timestamptz` | yes | — | |
| `effective_from` | `date` | no | — | |
| `effective_to` | `date` | yes | — | |
| `ecard_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL`. NULL ⇒ the "Download e-card" button renders disabled with the reason "E-cards are issued from 1 Oct" (from `benefit_plan_year`), never a dead link. |
| `waiver_reason` | `text` | yes | — | |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_be__employee_plan_year UNIQUE (employee_id, benefit_plan_year_id),
CONSTRAINT ck_be__enrolled CHECK ((status = 'ENROLLED') = (enrolled_at IS NOT NULL)),
CONSTRAINT ck_be__waived CHECK (status <> 'WAIVED' OR waiver_reason IS NOT NULL),
CONSTRAINT ck_be__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
CONSTRAINT ck_be__amounts CHECK (
  coalesce(sum_insured_minor,0) >= 0 AND coalesce(employee_contribution_minor,0) >= 0)
```
Index: `ix_be__employee_active (employee_id, status) WHERE status = 'ENROLLED'`.

| `benefit_enrolment_dependent` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `benefit_enrolment_id` | `uuid` | no | — | FK → `benefit_enrolment(id)` `ON DELETE CASCADE` |
| `dependent_id` | `uuid` | no | — | FK → `dependent(id)` `ON DELETE RESTRICT` |
| `covered_from` | `date` | no | — | |
| `covered_to` | `date` | yes | — | |
| `added_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |

```sql
PRIMARY KEY (benefit_enrolment_id, dependent_id),
CONSTRAINT ck_bed__range CHECK (covered_to IS NULL OR covered_to >= covered_from)
```

### 12.9 `dependent` and `nominee`

| `dependent` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `full_name_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | Mask = full name to the owning employee, initials-only to anyone else |
| `initials` | `text` | no | — | `KR` — stored plaintext so the avatar renders without decrypting |
| `relationship` | `ess_dependent_relationship` | no | — | |
| `date_of_birth_ct/_iv/_tag/_dek_id/_mask` | envelope | no | — | |
| `age_years` | `smallint` | no | *(maintained)* | Recomputed nightly by `dependent-age-refresh` from the encrypted DOB, so the card can render `33 years` without a decrypt on every read |
| `gender` | `ess_gender` | no | `'UNDISCLOSED'` | |
| `is_verified` | `boolean` | no | `false` | |
| `verified_at` | `timestamptz` | yes | — | |
| `verified_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `proof_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ck_dependent__age CHECK (age_years BETWEEN 0 AND 130),
CONSTRAINT ck_dependent__initials CHECK (initials ~ '^[A-Z]{1,3}$'),
CONSTRAINT ck_dependent__verified CHECK (num_nulls(verified_at, verified_by_user_id) IN (0, 2))
```
Index: `ix_dependent__employee_active (employee_id) WHERE is_active`.

| `nominee` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `benefit_plan_id` | `uuid` | yes | — | FK → `benefit_plan(id)` `ON DELETE CASCADE`. NULL = a general (PF/gratuity) nomination. |
| `dependent_id` | `uuid` | yes | — | FK → `dependent(id)` `ON DELETE RESTRICT` — when the nominee is an existing dependent |
| `full_name_ct/_iv/_tag/_dek_id/_mask` | envelope | yes | — | Required when `dependent_id IS NULL` |
| `relationship_ct/…` | envelope | yes | — | |
| `share_percent` | `numeric(5,2)` | no | — | `100.00` — renders `Nominee: Karthik Raghavan (100%)` |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ck_nominee__identity CHECK (num_nulls(dependent_id, full_name_ct) = 1),
CONSTRAINT ck_nominee__share CHECK (share_percent > 0 AND share_percent <= 100)
```
Index: `ix_nominee__employee_plan (employee_id, benefit_plan_id) WHERE is_active`.
Trigger `trg_nominee_share_sum` rejects a write that would make the active shares for one
`(employee_id, benefit_plan_id)` exceed `100.00`.

---

## 13. Expenses

### 13.1 `expense_category` and `expense_limit` — reference data, seeded

| `expense_category` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `TRAVEL`, `MEALS`, `REMOTE_WORK`, `EQUIPMENT`, `LEARNING`, `OTHER` |
| `name` | `text` | no | — | `Travel`, `Meals & entertainment`, `Remote work`, `Equipment`, `Learning`, `Other` — the exact dropdown options |
| `requires_receipt` | `boolean` | no | `true` | |
| `receipt_required_above_minor` | `money_minor` | yes | — | |
| `requires_finance_approval` | `boolean` | no | `true` | `false` ⇒ manager approval settles the claim |
| `default_pay_component_id` | `uuid` | yes | — | FK → `pay_component(id)` `ON DELETE RESTRICT` — which payslip line the reimbursement lands on |
| `gl_code` | `text` | yes | — | |
| `display_order` | `smallint` | no | `0` | |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_expense_category__org_code UNIQUE (organization_id, code)
```

| `expense_limit` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `expense_category_id` | `uuid` | no | — | FK → `expense_category(id)` `ON DELETE CASCADE` |
| `basis` | `ess_expense_limit_basis` | no | — | |
| `cap_amount_minor` | `money_minor` | no | — | `1500_00` = the ₹1,500 monthly internet cap |
| `applies_employment_types` | `ess_employment_type[]` | no | `'{}'` | Empty = all |
| `applies_job_level_min` | `smallint` | yes | — | |
| `applies_job_level_max` | `smallint` | yes | — | |
| `effective_from` | `date` | no | — | |
| `effective_to` | `date` | yes | — | |
| `source_policy_version_id` | `uuid` | yes | — | FK → `policy_version(id)` `ON DELETE SET NULL` — the Travel & Expense Policy version that set the cap |
| `is_hard_limit` | `boolean` | no | `true` | `true` ⇒ submission blocked; `false` ⇒ flagged for finance |

```sql
CONSTRAINT ck_expense_limit__cap CHECK (cap_amount_minor > 0),
CONSTRAINT ck_expense_limit__levels CHECK (
  applies_job_level_min IS NULL OR applies_job_level_max IS NULL
  OR applies_job_level_max >= applies_job_level_min),
CONSTRAINT ex_expense_limit__no_overlap EXCLUDE USING gist (
  expense_category_id WITH =, basis WITH =,
  daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&)
```

### 13.2 `expense_claim`, `expense_claim_line`, `expense_attachment`

| `expense_claim` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `claim_no` | `citext` | no | — | `EXP-2291`. Unique per org, from `expense_claim_seq`. |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` — derived from `spend_date` |
| `title` | `text` | no | — | The claim description, e.g. `Client visit — cab rides` |
| `expense_category_id` | `uuid` | no | — | FK → `expense_category(id)` `ON DELETE RESTRICT` — header category (single-category claims, as the prototype's form) |
| `spend_date` | `date` | no | — | `24 Sep 2026` |
| `total_amount_minor` | `money_minor` | no | — | Maintained by trigger as Σ `expense_claim_line.amount_minor` |
| `approved_amount_minor` | `money_minor` | yes | — | May be less than claimed after partial approval |
| `currency_code` | `char(3)` | no | `'INR'` | |
| `status` | `ess_expense_claim_status` | no | `'DRAFT'` | |
| `submitted_at` | `timestamptz` | yes | — | |
| `manager_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE RESTRICT` — snapshot of the approver at submit |
| `manager_decided_at` | `timestamptz` | yes | — | |
| `manager_decided_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `manager_note` | `text` | yes | — | Rejection reason, rendered as the claim's sub-note (`Use the L&D budget flow`) |
| `finance_decided_at` | `timestamptz` | yes | — | |
| `finance_decided_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `finance_note` | `text` | yes | — | |
| `reimbursement_batch_id` | `uuid` | yes | — | FK → `reimbursement_batch(id)` `ON DELETE SET NULL` |
| `reimbursed_at` | `timestamptz` | yes | — | |
| `paid_in_payroll_cycle_id` | `uuid` | yes | — | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — "paid with September salary" is a **join**, not a caption |
| `policy_flag_codes` | `text[]` | no | `'{}'` | `LIMIT_EXCEEDED`, `LATE_SUBMISSION`, `MISSING_RECEIPT` |
| `withdrawn_at` | `timestamptz` | yes | — | |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_expense_claim__org_no UNIQUE (organization_id, claim_no),
CONSTRAINT ck_ec__total CHECK (total_amount_minor > 0),
CONSTRAINT ck_ec__approved CHECK (approved_amount_minor IS NULL OR (approved_amount_minor >= 0 AND approved_amount_minor <= total_amount_minor)),
CONSTRAINT ck_ec__submitted CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
CONSTRAINT ck_ec__manager_decision CHECK (num_nulls(manager_decided_at, manager_decided_by_user_id) IN (0, 2)),
CONSTRAINT ck_ec__manager_reject_note CHECK (status <> 'MANAGER_REJECTED' OR manager_note IS NOT NULL),
CONSTRAINT ck_ec__finance_decision CHECK (num_nulls(finance_decided_at, finance_decided_by_user_id) IN (0, 2)),
CONSTRAINT ck_ec__finance_reject_note CHECK (status <> 'FINANCE_REJECTED' OR finance_note IS NOT NULL),
CONSTRAINT ck_ec__reimbursed CHECK (
  (status = 'REIMBURSED') = (reimbursed_at IS NOT NULL AND paid_in_payroll_cycle_id IS NOT NULL)),
CONSTRAINT ck_ec__spend_not_future CHECK (spend_date <= CURRENT_DATE)
```
Indexes:
- `ix_ec__employee_status (employee_id, status, spend_date DESC)` — "My claims"
- `ix_ec__employee_fy (employee_id, fiscal_year_id)` — the FY stat tiles
- `ix_ec__manager_pending (manager_employee_id, submitted_at DESC) WHERE status = 'PENDING_MANAGER'` — the Approvals queue
- `ix_ec__finance_queue (organization_id, status) WHERE status = 'PENDING_FINANCE'`
- `ix_ec__batch (reimbursement_batch_id)`
- `ix_ec__cycle (paid_in_payroll_cycle_id)`

| `expense_claim_line` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `expense_claim_id` | `uuid` | no | — | FK → `expense_claim(id)` `ON DELETE CASCADE` |
| `line_no` | `smallint` | no | — | |
| `expense_category_id` | `uuid` | no | — | FK → `expense_category(id)` `ON DELETE RESTRICT` |
| `description` | `text` | no | — | `Uber — client visit to Manyata` |
| `merchant_name` | `text` | yes | — | |
| `spend_date` | `date` | no | — | |
| `amount_minor` | `money_minor` | no | — | `CHECK (amount_minor > 0)` |
| `tax_amount_minor` | `money_minor` | no | `0` | GST component |
| `approved_amount_minor` | `money_minor` | yes | — | |
| `is_within_limit` | `boolean` | no | `true` | Evaluated against `expense_limit` at submit; persisted so the decision is reviewable |
| `limit_applied_minor` | `money_minor` | yes | — | The cap that was applied — renders "Within ₹1,500 cap" on the Approvals card |
| `rejection_reason` | `text` | yes | — | |

```sql
CONSTRAINT ux_ecl__claim_line UNIQUE (expense_claim_id, line_no),
CONSTRAINT ck_ecl__tax CHECK (tax_amount_minor >= 0 AND tax_amount_minor <= amount_minor),
CONSTRAINT ck_ecl__approved CHECK (approved_amount_minor IS NULL OR (approved_amount_minor >= 0 AND approved_amount_minor <= amount_minor))
```

| `expense_attachment` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `expense_claim_id` | `uuid` | no | — | FK → `expense_claim(id)` `ON DELETE CASCADE` |
| `expense_claim_line_id` | `uuid` | yes | — | FK → `expense_claim_line(id)` `ON DELETE CASCADE` |
| `file_object_id` | `uuid` | no | — | FK → `file_object(id)` `ON DELETE RESTRICT` |
| `kind` | `text` | no | `'RECEIPT'` | `RECEIPT` \| `INVOICE` \| `BOARDING_PASS` \| `OTHER` |
| `uploaded_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |

```sql
CONSTRAINT ux_expense_attachment__claim_file UNIQUE (expense_claim_id, file_object_id)
```

### 13.3 Expense claim state machine (`machine = 'expense_claim'`)

| from | to | permission | guards | notification | email |
|---|---|---|---|---|---|
| `NULL` | `DRAFT` | `expense:claim:create:self` | `expense.self_only` | — | — |
| `DRAFT` | `SUBMITTED` | `expense:claim:create:self` | `expense.has_lines`, `expense.receipt_if_required`, `expense.within_hard_limits`, `expense.manager_exists`, `expense.spend_within_claim_window` | — | — |
| `SUBMITTED` | `PENDING_MANAGER` | *(system)* | `expense.approval_task_created` | `EXPENSE_SUBMITTED` → manager | — |
| `PENDING_MANAGER` | `MANAGER_APPROVED` | `expense:claim:approve:team` | `approval.actor_is_assigned_approver` | `EXPENSE_DECIDED` → employee | `EXPENSE_DECISION` |
| `PENDING_MANAGER` | `MANAGER_REJECTED` | `expense:claim:approve:team` | `approval.actor_is_assigned_approver`, `approval.note_required` | `EXPENSE_DECIDED` | `EXPENSE_DECISION` |
| `MANAGER_APPROVED` | `PENDING_FINANCE` | *(system)* | `expense.category_requires_finance` | — | — |
| `MANAGER_APPROVED` | `QUEUED_FOR_PAYMENT` | *(system)* | `expense.category_skips_finance` | — | — |
| `PENDING_FINANCE` | `FINANCE_APPROVED` | `expense:claim:approve:finance` | — | `EXPENSE_DECIDED` | — |
| `PENDING_FINANCE` | `FINANCE_REJECTED` | `expense:claim:approve:finance` | `approval.note_required` | `EXPENSE_DECIDED` | `EXPENSE_DECISION` |
| `FINANCE_APPROVED` | `QUEUED_FOR_PAYMENT` | `expense:reimburse` | `reimb.batch_open` | — | — |
| `QUEUED_FOR_PAYMENT` | `REIMBURSED` | *(system)* | `reimb.cycle_published` | `EXPENSE_REIMBURSED` | — |
| `DRAFT` | `CANCELLED` | `expense:claim:withdraw:self` | `expense.self_only` | — | — |
| `SUBMITTED`/`PENDING_MANAGER` | `WITHDRAWN` | `expense:claim:withdraw:self` | `expense.self_only`, `expense.not_yet_decided` | — | — |

Terminal: `REIMBURSED`, `MANAGER_REJECTED`, `FINANCE_REJECTED`, `WITHDRAWN`, `CANCELLED`.

UI status-chip mapping (Design System §1 tones):
`PENDING_MANAGER`/`SUBMITTED`/`PENDING_FINANCE` → `Awaiting approval`, amber ·
`MANAGER_APPROVED`/`FINANCE_APPROVED`/`QUEUED_FOR_PAYMENT` → `Approved`, green ·
`REIMBURSED` → `Reimbursed`, blue · `MANAGER_REJECTED`/`FINANCE_REJECTED` → `Rejected`,
red · `DRAFT` → `Draft`, gray · `WITHDRAWN`/`CANCELLED` → `Withdrawn`, gray.

### 13.4 `expense_fy_rollup` — the Expenses stat tiles

Maintained by trigger on every `expense_claim` status change. Exists for the same reason
as `payslip_fy_rollup`: three indexed reads instead of three scans, with the exact source
claim ids retained so each tile is auditable.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `fiscal_year_id` | `uuid` | no | — | FK → `fiscal_year(id)` `ON DELETE RESTRICT` |
| `awaiting_count` | `integer` | no | `0` | Claims in `SUBMITTED`/`PENDING_MANAGER`/`PENDING_FINANCE` |
| `awaiting_amount_minor` | `money_minor` | no | `0` | → tile 1 value |
| `approved_unpaid_count` | `integer` | no | `0` | `MANAGER_APPROVED`/`FINANCE_APPROVED`/`QUEUED_FOR_PAYMENT` |
| `approved_unpaid_amount_minor` | `money_minor` | no | `0` | → tile 2 value |
| `reimbursed_count` | `integer` | no | `0` | → tile 3 sub-label "4 claims since April" |
| `reimbursed_amount_minor` | `money_minor` | no | `0` | → tile 3 value |
| `rejected_count` | `integer` | no | `0` | |
| `recomputed_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ux_efy__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_efy__nonneg CHECK (
  awaiting_count >= 0 AND approved_unpaid_count >= 0 AND reimbursed_count >= 0 AND rejected_count >= 0
  AND awaiting_amount_minor >= 0 AND approved_unpaid_amount_minor >= 0 AND reimbursed_amount_minor >= 0)
```

---
## 14. Documents

### 14.1 `document_type` — reference data, seeded

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `OFFER_LETTER`, `APPOINTMENT_LETTER`, `PROMOTION_LETTER`, `APPRAISAL_LETTER`, `SALARY_REVISION_LETTER`, `RELIEVING_LETTER`, `EXPERIENCE_LETTER`, `ID_PROOF`, `EDUCATION_CERTIFICATE` |
| `name` | `text` | no | — | `Salary revision letter` |
| `category_label` | `text` | no | — | `Compensation`, `Performance`, `Career`, `Onboarding` — the exact sub-label the document row renders |
| `default_visibility` | `ess_document_visibility` | no | `'EMPLOYEE_AND_HR'` | |
| `is_employee_uploadable` | `boolean` | no | `false` | |
| `retention_years` | `smallint` | no | `8` | Feeds the retention job (§18) |
| `display_order` | `smallint` | no | `0` | |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_document_type__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_document_type__retention CHECK (retention_years BETWEEN 1 AND 50)
```

### 14.2 `employee_document`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `document_type_id` | `uuid` | no | — | FK → `document_type(id)` `ON DELETE RESTRICT` |
| `title` | `text` | no | — | `Salary revision letter — FY 2026–27` — the exact row title |
| `file_object_id` | `uuid` | no | — | FK → `file_object(id)` `ON DELETE RESTRICT` |
| `document_date` | `date` | no | — | `1 Apr 2026` — the document's own date, not the upload time |
| `visibility` | `ess_document_visibility` | no | — | Defaults from `document_type` |
| `issued_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `document_request_id` | `uuid` | yes | — | FK → `document_request(id)` `ON DELETE SET NULL` — set when this document fulfils a letter request |
| `is_system_generated` | `boolean` | no | `false` | |
| `version` | `smallint` | no | `1` | |
| `supersedes_document_id` | `uuid` | yes | — | FK → `employee_document(id)` `ON DELETE SET NULL` |
| `archived_at` | `timestamptz` | yes | — | Hidden from the employee list; retained for audit |
| `download_count` | `integer` | no | `0` | |
| `last_downloaded_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ck_employee_document__version CHECK (version >= 1),
CONSTRAINT ck_employee_document__downloads CHECK (download_count >= 0)
```
Indexes:
- `ix_ed__employee_live (employee_id, document_date DESC) WHERE archived_at IS NULL` — the "My documents" list
- `ix_ed__type (document_type_id)`
- `ix_ed__request (document_request_id)`

Every download writes an `audit_event` (`DOWNLOAD`) and increments `download_count`.

### 14.3 `letter_template` and `document_request`

| `letter_template` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `EMPLOYMENT_VERIFICATION`, `SALARY_CERTIFICATE`, `ADDRESS_PROOF`, `BONAFIDE_VISA`, `NOC` |
| `name` | `text` | no | — | `Employment verification letter`, `Salary certificate`, `Address proof letter`, `Bonafide letter (visa)`, `No objection certificate` — the exact dropdown options |
| `body_template` | `text` | no | — | Handlebars-style template; placeholders are resolved server-side from persisted data only |
| `requires_addressee` | `boolean` | no | `false` | |
| `includes_salary_details` | `boolean` | no | `false` | `true` for the salary certificate ⇒ issuing it writes a `READ_SENSITIVE` audit event |
| `sla_working_days` | `smallint` | no | `1` | Renders "issued within 1 working day" — persisted, not a hardcoded caption |
| `requires_hr_approval` | `boolean` | no | `true` | |
| `display_order` | `smallint` | no | `0` | |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_letter_template__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_letter_template__sla CHECK (sla_working_days BETWEEN 0 AND 30)
```

| `document_request` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `request_no` | `citext` | no | — | `WDT-DOC-2026-00214`. Unique per org. |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `letter_template_id` | `uuid` | no | — | FK → `letter_template(id)` `ON DELETE RESTRICT` |
| `addressee` | `text` | yes | — | `HDFC Bank, Koramangala branch` → renders "Addressed to …"; when NULL the row renders "General purpose" |
| `purpose_note` | `text` | yes | — | |
| `status` | `ess_document_request_status` | no | `'SUBMITTED'` | |
| `requested_at` | `timestamptz` | no | `now()` | Renders "Requested 18 Sep 2026" |
| `due_at` | `timestamptz` | no | — | `requested_at + sla_working_days` resolved against the holiday calendar |
| `assigned_to_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `issued_at` | `timestamptz` | yes | — | |
| `issued_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `employee_document_id` | `uuid` | yes | — | FK → `employee_document(id)` `ON DELETE SET NULL` — the issued PDF; its presence is what enables the row's download button |
| `rejection_reason` | `text` | yes | — | |
| `cancelled_at` | `timestamptz` | yes | — | |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_document_request__org_no UNIQUE (organization_id, request_no),
CONSTRAINT ck_dr__issued CHECK (
  (status = 'ISSUED') = (issued_at IS NOT NULL AND issued_by_user_id IS NOT NULL AND employee_document_id IS NOT NULL)),
CONSTRAINT ck_dr__rejected CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
CONSTRAINT ck_dr__cancelled CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
CONSTRAINT ck_dr__due CHECK (due_at >= requested_at)
```
Indexes:
- `ix_dr__employee (employee_id, requested_at DESC)` — the "Letter requests" list
- `ix_dr__queue (organization_id, status, due_at) WHERE status IN ('SUBMITTED','IN_REVIEW','PROCESSING')` — the HR queue
- `ix_dr__assignee (assigned_to_user_id, status)`

State machine `machine = 'document_request'`:
`NULL→SUBMITTED` (`document:request:create:self`) ·
`SUBMITTED→IN_REVIEW` (`document:request:fulfil`) ·
`IN_REVIEW→PROCESSING` (`document:request:fulfil`) ·
`PROCESSING→ISSUED` (`document:request:fulfil`, guard `docreq.document_attached`,
emits `DOCUMENT_ISSUED` + `DOCUMENT_ISSUED` email) ·
`SUBMITTED|IN_REVIEW|PROCESSING→REJECTED` (`document:request:fulfil`, guard
`approval.note_required`, emits `DOCUMENT_ISSUED` notification) ·
`SUBMITTED→CANCELLED` (`document:request:create:self`, guard `docreq.self_only`).
Terminal: `ISSUED`, `REJECTED`, `CANCELLED`.
Chip tones: `SUBMITTED`/`IN_REVIEW`/`PROCESSING` → `Processing`, amber ·
`ISSUED` → `Issued`, green · `REJECTED` → `Rejected`, red · `CANCELLED` → gray.

---

## 15. Policies

### 15.1 `policy`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `COC`, `ISP`, `LEAVE`, `WFH`, `TNE`, `POSH`, `ABC`, `DPP` |
| `name` | `text` | no | — | `Code of Conduct` |
| `owner_label` | `text` | no | — | `People Ops`, `IT & Security`, `Finance`, `Legal`, `Internal Committee` — the detail-panel eyebrow |
| `owner_department_id` | `uuid` | yes | — | FK → `department(id)` `ON DELETE SET NULL` |
| `contact_email` | `citext` | no | — | `ethics@widedrop.com` — the "Questions" field |
| `status` | `ess_policy_status` | no | `'DRAFT'` | |
| `display_order` | `smallint` | no | `0` | Fixes the list order |
| `archived_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ux_policy__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_policy__archived CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
```

### 15.2 `policy_version` — version-controlled, never mutated after publication

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `policy_id` | `uuid` | no | — | FK → `policy(id)` `ON DELETE RESTRICT` |
| `version_major` | `smallint` | no | — | `3` |
| `version_minor` | `smallint` | no | — | `1` |
| `version_label` | `text` | no | *(generated)* | `GENERATED ALWAYS AS ('v' \|\| version_major \|\| '.' \|\| version_minor) STORED` → `v3.1` |
| `status` | `ess_policy_version_status` | no | `'DRAFT'` | |
| `summary` | `text` | no | — | The detail-panel paragraph |
| `body_markdown` | `text` | no | — | Full policy text |
| `body_sha256` | `bytea` | no | — | SHA-256 over `body_markdown`; what the employee acknowledged is provably this text |
| `pdf_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL`. NULL ⇒ the "Download PDF" button is not rendered. |
| `applies_to_label` | `text` | no | — | `All employees & contractors` — the human summary of the rules in §15.3 |
| `effective_from` | `date` | no | — | `1 Jan 2026` |
| `effective_to` | `date` | yes | — | Set when a later version supersedes it |
| `next_review_on` | `date` | yes | — | `Jan 2027` |
| `last_updated_label` | `text` | no | — | `Jan 2026` — the list row's "Updated …", persisted at publication |
| `requires_acknowledgement` | `boolean` | no | `true` | |
| `acknowledgement_due_days` | `smallint` | yes | — | Days from assignment; produces the per-employee due date |
| `acknowledgement_due_on` | `date` | yes | — | An absolute org-wide due date (`15 Oct 2026`). Exactly one of the two is set. |
| `published_at` | `timestamptz` | yes | — | |
| `published_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `supersedes_version_id` | `uuid` | yes | — | FK → `policy_version(id)` `ON DELETE RESTRICT` |
| `withdrawn_at` | `timestamptz` | yes | — | |
| `withdrawn_reason` | `text` | yes | — | |

```sql
CONSTRAINT ux_policy_version__policy_version UNIQUE (policy_id, version_major, version_minor),
CONSTRAINT ck_pv__versions CHECK (version_major >= 0 AND version_minor >= 0 AND (version_major + version_minor) > 0),
CONSTRAINT ck_pv__sha CHECK (octet_length(body_sha256) = 32),
CONSTRAINT ck_pv__published CHECK (
  (status IN ('PUBLISHED','SUPERSEDED')) = (published_at IS NOT NULL AND published_by_user_id IS NOT NULL)),
CONSTRAINT ck_pv__due CHECK (
  NOT requires_acknowledgement
  OR num_nulls(acknowledgement_due_days, acknowledgement_due_on) = 1),
CONSTRAINT ck_pv__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
CONSTRAINT ck_pv__withdrawn CHECK (num_nulls(withdrawn_at, withdrawn_reason) IN (0, 2)),
CONSTRAINT ex_policy_version__one_effective EXCLUDE USING gist (
  policy_id WITH =, daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&
) WHERE (status IN ('PUBLISHED','SUPERSEDED'))
```
Indexes:
- `ix_pv__policy_status (policy_id, status, effective_from DESC)`
- `ux_pv__policy_current (policy_id) WHERE status = 'PUBLISHED' AND effective_to IS NULL`
- `ix_pv__search (organization_id, status)` — the global-search "Policy" result kind

**Immutability.** Trigger `trg_policy_version_immutable` rejects any update to
`body_markdown`, `body_sha256`, `summary`, `version_major`, `version_minor`,
`effective_from`, `requires_acknowledgement`, `acknowledgement_due_days`,
`acknowledgement_due_on` once `status <> 'DRAFT'`. A correction is a new version.
Only `status`, `effective_to`, `supersedes_version_id`, `withdrawn_at/reason`,
`pdf_file_object_id`, `last_updated_label` and the audit columns may change after
publication.

### 15.3 `policy_version_point` and `policy_applicability_rule`

| `policy_version_point` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `policy_version_id` | `uuid` | no | — | FK → `policy_version(id)` `ON DELETE CASCADE` |
| `point_no` | `smallint` | no | — | |
| `text` | `text` | no | — | One bullet of "What this policy covers" |

```sql
CONSTRAINT ux_pvp__version_point UNIQUE (policy_version_id, point_no),
CONSTRAINT ck_pvp__point_no CHECK (point_no >= 1)
```
Same immutability trigger as `policy_version` (no edits after the version leaves `DRAFT`).
When a version has no points, the detail panel omits the "What this policy covers" block
entirely rather than rendering an empty card.

| `policy_applicability_rule` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `policy_version_id` | `uuid` | no | — | FK → `policy_version(id)` `ON DELETE CASCADE` |
| `dimension` | `ess_policy_applicability_dimension` | no | — | |
| `is_include` | `boolean` | no | `true` | `false` = exclusion, evaluated after includes |
| `department_id` | `uuid` | yes | — | FK → `department(id)` `ON DELETE CASCADE` |
| `location_id` | `uuid` | yes | — | FK → `location(id)` `ON DELETE CASCADE` |
| `designation_id` | `uuid` | yes | — | FK → `designation(id)` `ON DELETE CASCADE` |
| `cost_centre_id` | `uuid` | yes | — | FK → `cost_centre(id)` `ON DELETE CASCADE` |
| `employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `employment_type` | `ess_employment_type` | yes | — | |
| `includes_department_descendants` | `boolean` | no | `true` | |

```sql
CONSTRAINT ck_par__target CHECK (
  (dimension = 'ALL'             AND num_nonnulls(department_id, location_id, designation_id, cost_centre_id, employee_id, employment_type) = 0)
OR (dimension = 'DEPARTMENT'     AND department_id IS NOT NULL)
OR (dimension = 'LOCATION'       AND location_id IS NOT NULL)
OR (dimension = 'DESIGNATION'    AND designation_id IS NOT NULL)
OR (dimension = 'COST_CENTRE'    AND cost_centre_id IS NOT NULL)
OR (dimension = 'EMPLOYEE'       AND employee_id IS NOT NULL)
OR (dimension = 'EMPLOYMENT_TYPE' AND employment_type IS NOT NULL))
```
Index: `ix_par__version (policy_version_id, dimension)`.

**Resolution.** On publication, the `policy-assignment` job materialises
`policy_assignment` rows for every matching active employee: an employee is in scope if
at least one `is_include` rule matches and no `is_include = false` rule matches. Matching
uses `employment_as_of(employee, policy_version.effective_from)`.

### 15.4 `policy_assignment` and `policy_acknowledgement`

`policy_assignment` — "this employee must acknowledge this version by this date".
It is what makes the Policies list's per-employee status and the Home "Needs your
attention" item a query rather than an inference.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `policy_version_id` | `uuid` | no | — | FK → `policy_version(id)` `ON DELETE RESTRICT` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `assigned_at` | `timestamptz` | no | `now()` | |
| `due_on` | `date` | yes | — | Resolved from `acknowledgement_due_on` or `assigned_at + acknowledgement_due_days`. NULL ⇒ no due date, and the UI shows no "Due …" text. |
| `is_required` | `boolean` | no | `true` | |
| `superseded_at` | `timestamptz` | yes | — | Set when a newer version is assigned; a superseded assignment never appears in the pending count |
| `notification_id` | `uuid` | yes | — | FK → `notification(id)` `ON DELETE SET NULL` |

```sql
CONSTRAINT ux_pa__version_employee UNIQUE (policy_version_id, employee_id)
```
Indexes:
- `ix_pa__employee_open (employee_id, due_on) WHERE superseded_at IS NULL` — the pending count
- `ix_pa__version (policy_version_id) WHERE superseded_at IS NULL` — HR compliance reporting

`policy_acknowledgement` — the record of the act. **Append-only** (trigger
`trg_append_only_policy_ack`): an acknowledgement is never edited or deleted; a
re-acknowledgement of a new version is a new row against that version.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `policy_assignment_id` | `uuid` | no | — | FK → `policy_assignment(id)` `ON DELETE RESTRICT` |
| `policy_version_id` | `uuid` | no | — | FK → `policy_version(id)` `ON DELETE RESTRICT` — denormalised; the required (employee, policy version) pair |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE RESTRICT` |
| `status` | `ess_policy_ack_status` | no | — | `ACKNOWLEDGED` or `WAIVED` (a `PENDING`/`OVERDUE` state is the **absence** of a row, computed from `policy_assignment`) |
| `acknowledged_at` | `timestamptz` | no | — | The required timestamp; renders "Acknowledged on 12 Jan 2026" |
| `acknowledged_body_sha256` | `bytea` | no | — | Copy of `policy_version.body_sha256` at the moment of the click — proof of *what* was acknowledged |
| `acknowledgement_text` | `text` | no | — | The exact consent sentence shown, e.g. `I have read and acknowledge` |
| `ip_address` | `inet` | yes | — | |
| `user_agent` | `text` | yes | — | |
| `app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` — who clicked |
| `waived_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `waiver_reason` | `text` | yes | — | |
| `audit_event_id` | `uuid` | yes | — | FK → `audit_event(id)` `ON DELETE SET NULL` |
| `created_at` | `timestamptz` | no | `now()` | |

```sql
CONSTRAINT ux_pack__assignment UNIQUE (policy_assignment_id),
CONSTRAINT ux_pack__employee_version UNIQUE (employee_id, policy_version_id),
CONSTRAINT ck_pack__status CHECK (status IN ('ACKNOWLEDGED','WAIVED')),
CONSTRAINT ck_pack__waiver CHECK ((status = 'WAIVED') = (num_nulls(waived_by_user_id, waiver_reason) = 0)),
CONSTRAINT ck_pack__sha CHECK (octet_length(acknowledged_body_sha256) = 32)
```
Indexes: `ix_pack__employee (employee_id, acknowledged_at DESC)`,
`ix_pack__version (policy_version_id, acknowledged_at)`.

**Derived per-employee policy status** (what the list chip and the pending badge show):

```sql
CASE
  WHEN ack.id IS NOT NULL                          THEN 'ACKNOWLEDGED'   -- green
  WHEN pa.due_on IS NOT NULL AND pa.due_on < CURRENT_DATE THEN 'OVERDUE' -- red
  WHEN pa.id IS NOT NULL                           THEN 'PENDING'        -- amber
  ELSE 'NOT_APPLICABLE'                                                  -- gray, row hidden
END
```

State machine `machine = 'policy_version'`: `NULL→DRAFT` (`policy:author`) ·
`DRAFT→IN_REVIEW` (`policy:author`) · `IN_REVIEW→DRAFT` (`policy:author`) ·
`IN_REVIEW→PUBLISHED` (`policy:publish`, guards `policy.has_body`,
`policy.effective_date_set`, `policy.applicability_defined`; emits `POLICY_ASSIGNED`
to every newly assigned employee) · `PUBLISHED→SUPERSEDED` (system, on the next
version's publication) · `DRAFT|IN_REVIEW|PUBLISHED→WITHDRAWN` (`policy:publish`, guard
`approval.note_required`). Terminal: `SUPERSEDED`, `WITHDRAWN`.
`machine = 'policy_acknowledgement'`: `NULL→ACKNOWLEDGED` (`policy:acknowledge:self`,
guard `policy.assignment_open`) · `NULL→WAIVED` (`policy:publish`, guard
`approval.note_required`).

---

## 16. Communications: announcements, help desk, notifications

### 16.1 `announcement`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `title` | `text` | no | — | |
| `body_markdown` | `text` | no | — | Paragraphs are the markdown's blocks — the prototype's `body: [para, para]` is a rendering of this single field, not an array column |
| `category_label` | `text` | no | — | `People Ops`, `Finance`, `Leadership`, `Benefits`, `Workplace`, `IT & Security` — the chip the list row shows |
| `author_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE SET NULL` |
| `author_byline` | `text` | no | — | `Ananya Bose · People Ops` or `Facilities` — persisted so a non-employee author (a team) is representable |
| `status` | `ess_announcement_status` | no | `'DRAFT'` | |
| `is_pinned` | `boolean` | no | `false` | |
| `pinned_until` | `date` | yes | — | |
| `publish_at` | `timestamptz` | yes | — | Future-dated ⇒ `SCHEDULED` |
| `published_at` | `timestamptz` | yes | — | Renders the row date `26 Sep 2026` |
| `published_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT` |
| `expires_at` | `timestamptz` | yes | — | After this the item leaves the list without being deleted |
| `archived_at` | `timestamptz` | yes | — | |
| `attachment_file_object_id` | `uuid` | yes | — | FK → `file_object(id)` `ON DELETE SET NULL` |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ck_ann__published CHECK (
  (status = 'PUBLISHED') = (published_at IS NOT NULL AND published_by_user_id IS NOT NULL)),
CONSTRAINT ck_ann__scheduled CHECK (status <> 'SCHEDULED' OR publish_at > now()),
CONSTRAINT ck_ann__pin CHECK (NOT is_pinned OR status = 'PUBLISHED'),
CONSTRAINT ck_ann__expiry CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at)
```
Indexes:
- `ix_ann__feed (organization_id, is_pinned DESC, published_at DESC) WHERE status = 'PUBLISHED' AND archived_at IS NULL` — the exact list order (pinned first, then newest)
- `ix_ann__schedule (publish_at) WHERE status = 'SCHEDULED'`

### 16.2 `announcement_audience`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `announcement_id` | `uuid` | no | — | FK → `announcement(id)` `ON DELETE CASCADE` |
| `kind` | `ess_announcement_audience_kind` | no | — | |
| `department_id` | `uuid` | yes | — | FK → `department(id)` `ON DELETE CASCADE` |
| `location_id` | `uuid` | yes | — | FK → `location(id)` `ON DELETE CASCADE` |
| `employment_type` | `ess_employment_type` | yes | — | |
| `employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `includes_department_descendants` | `boolean` | no | `true` | |

```sql
CONSTRAINT ck_aa__target CHECK (
  (kind = 'ALL'             AND num_nonnulls(department_id, location_id, employee_id, employment_type) = 0)
OR (kind = 'DEPARTMENT'     AND department_id IS NOT NULL)
OR (kind = 'LOCATION'       AND location_id IS NOT NULL)
OR (kind = 'EMPLOYMENT_TYPE' AND employment_type IS NOT NULL)
OR (kind = 'EMPLOYEE'       AND employee_id IS NOT NULL)),
CONSTRAINT ux_aa__unique_target UNIQUE (announcement_id, kind,
  coalesce(department_id,'00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(location_id,'00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(employee_id,'00000000-0000-0000-0000-000000000000'::uuid))
```
Index: `ix_aa__announcement (announcement_id, kind)`.
An announcement with **no** audience row is visible to nobody (fail-closed).

### 16.3 `announcement_read`

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `announcement_id` | `uuid` | no | — | FK → `announcement(id)` `ON DELETE CASCADE` |
| `employee_id` | `uuid` | no | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `first_read_at` | `timestamptz` | no | `now()` | |
| `read_count` | `integer` | no | `1` | |
| `last_read_at` | `timestamptz` | no | `now()` | |

```sql
PRIMARY KEY (announcement_id, employee_id),
CONSTRAINT ck_ar__count CHECK (read_count >= 1)
```
Index: `ix_annread__employee (employee_id, first_read_at DESC)`.
Drives the unread dot on the Announcements nav item and the notification bell state.

### 16.4 `ticket_category` and `helpdesk_ticket`

| `ticket_category` (reference data, seeded) | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `code` | `citext` | no | — | `PAYROLL_TAX`, `LEAVE`, `BENEFITS`, `IT_ACCESS`, `DOCUMENTS`, `TOWN_HALL`, `OTHER` |
| `name` | `text` | no | — | `Payroll & tax`, `Leave`, `Benefits`, `IT & access`, `Documents`, `Town hall`, `Other` — the exact dropdown options |
| `default_assignee_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `default_assignee_role_id` | `uuid` | yes | — | FK → `role(id)` `ON DELETE SET NULL` |
| `routing_email` | `citext` | no | — | Defaults to `organization.helpdesk_email` (`helpdesk@widedroptech.com`); a category may override it |
| `first_response_sla_hours` | `smallint` | no | `8` | 1 working day ⇒ the persisted source of the copy "first response within 1 working day" |
| `resolution_sla_hours` | `smallint` | no | `40` | |
| `is_anonymous_allowed` | `boolean` | no | `false` | `true` for `TOWN_HALL` (the prototype's anonymous questions) |
| `display_order` | `smallint` | no | `0` | |
| `is_active` | `boolean` | no | `true` | |

```sql
CONSTRAINT ux_ticket_category__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_tc__sla CHECK (first_response_sla_hours > 0 AND resolution_sla_hours >= first_response_sla_hours)
```

| `helpdesk_ticket` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `ticket_no` | `citext` | no | — | `HD-4821`. Unique per org, from `helpdesk_ticket_seq`. |
| `ticket_category_id` | `uuid` | no | — | FK → `ticket_category(id)` `ON DELETE RESTRICT` |
| `raised_by_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE RESTRICT`. NULL only when `is_anonymous`. |
| `raised_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE RESTRICT`. NULL only when `is_anonymous`. |
| `is_anonymous` | `boolean` | no | `false` | Permitted only when the category allows it |
| `subject` | `text` | no | — | ≤ 200 chars |
| `description` | `text` | yes | — | ≤ 5000 chars |
| `status` | `ess_ticket_status` | no | `'OPEN'` | |
| `priority` | `ess_ticket_priority` | no | `'NORMAL'` | |
| `assigned_to_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL`. NULL renders the meta "unassigned" — a persisted fact. |
| `assigned_at` | `timestamptz` | yes | — | |
| `first_response_due_at` | `timestamptz` | no | — | `created_at + first_response_sla_hours` on the working-hours calendar |
| `first_responded_at` | `timestamptz` | yes | — | Set by the first `PUBLIC` agent comment |
| `resolution_due_at` | `timestamptz` | no | — | |
| `resolved_at` | `timestamptz` | yes | — | Renders "Resolved 12 Sep" |
| `resolved_by_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL` |
| `resolution_summary` | `text` | yes | — | |
| `closed_at` | `timestamptz` | yes | — | |
| `reopened_count` | `smallint` | no | `0` | |
| `sla_first_response_breached` | `boolean` | no | *(generated)* | `GENERATED ALWAYS AS (first_responded_at IS NOT NULL AND first_responded_at > first_response_due_at) STORED` |
| `sla_resolution_breached` | `boolean` | no | *(generated)* | `GENERATED ALWAYS AS (resolved_at IS NOT NULL AND resolved_at > resolution_due_at) STORED` |
| `satisfaction_rating` | `smallint` | yes | — | 1–5 |
| `related_entity_type` | `text` | yes | — | `payslip`, `employee_bank_account`, `form16_document` — set when the ticket was raised from a module ("Request a change" on the profile) |
| `related_entity_id` | `uuid` | yes | — | Not an FK (polymorphic) |
| `email_outbox_id` | `uuid` | yes | — | FK → `email_outbox(id)` `ON DELETE SET NULL` — the dispatch to `helpdesk@widedroptech.com` |
| `row_version` | `integer` | no | `1` | |

```sql
CONSTRAINT ux_helpdesk_ticket__org_no UNIQUE (organization_id, ticket_no),
CONSTRAINT ck_ht__anonymity CHECK (is_anonymous = (raised_by_employee_id IS NULL)),
CONSTRAINT ck_ht__anon_user CHECK (is_anonymous = (raised_by_user_id IS NULL)),
CONSTRAINT ck_ht__assigned CHECK (num_nulls(assigned_to_user_id, assigned_at) IN (0, 2)),
CONSTRAINT ck_ht__resolved CHECK (
  (status IN ('RESOLVED','CLOSED')) = (resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL)),
CONSTRAINT ck_ht__resolution_summary CHECK (status NOT IN ('RESOLVED','CLOSED') OR resolution_summary IS NOT NULL),
CONSTRAINT ck_ht__closed CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
CONSTRAINT ck_ht__rating CHECK (satisfaction_rating IS NULL OR satisfaction_rating BETWEEN 1 AND 5),
CONSTRAINT ck_ht__related CHECK (num_nulls(related_entity_type, related_entity_id) IN (0, 2)),
CONSTRAINT ck_ht__due CHECK (resolution_due_at >= first_response_due_at)
```
Indexes:
- `ix_ht__employee (raised_by_employee_id, created_at DESC)` — "My tickets"
- `ix_ht__queue (organization_id, status, first_response_due_at) WHERE status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING_ON_EMPLOYEE','REOPENED')` — the HR queue
- `ix_ht__assignee (assigned_to_user_id, status)`
- `ix_ht__category (ticket_category_id, created_at DESC)`
- `ix_ht__sla_breach (organization_id) WHERE sla_resolution_breached`

**State machine** `machine = 'helpdesk_ticket'`:
`NULL→OPEN` (`ticket:create:self`, emits `HELPDESK_TICKET_CREATED` email to the
category's `routing_email` and a `TICKET_UPDATED` notification to the raiser) ·
`OPEN→ASSIGNED` (`ticket:assign`) · `ASSIGNED→IN_PROGRESS` (`ticket:comment:any`) ·
`IN_PROGRESS→WAITING_ON_EMPLOYEE` (`ticket:comment:any`) ·
`WAITING_ON_EMPLOYEE→IN_PROGRESS` (`ticket:comment:self`) ·
`OPEN|ASSIGNED|IN_PROGRESS|WAITING_ON_EMPLOYEE→RESOLVED` (`ticket:resolve`, guard
`ticket.resolution_summary_present`, emits `TICKET_RESOLVED`) ·
`RESOLVED→CLOSED` (system after 7 days, or `ticket:resolve`) ·
`RESOLVED→REOPENED` (`ticket:create:self`, guard `ticket.within_reopen_window` (14 days),
increments `reopened_count`) · `REOPENED→ASSIGNED` (`ticket:assign`) ·
`OPEN→CANCELLED` (`ticket:create:self`, guard `ticket.self_only`).
Terminal: `CLOSED`, `CANCELLED`.
Chip tones: `OPEN`/`ASSIGNED`/`IN_PROGRESS`/`REOPENED` → amber (`Open`, `In progress`) ·
`WAITING_ON_EMPLOYEE` → blue · `RESOLVED`/`CLOSED` → green · `CANCELLED` → gray.

### 16.5 `ticket_comment` and `ticket_attachment`

| `ticket_comment` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `helpdesk_ticket_id` | `uuid` | no | — | FK → `helpdesk_ticket(id)` `ON DELETE CASCADE` |
| `author_user_id` | `uuid` | yes | — | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for system notes. |
| `author_kind` | `text` | no | — | `EMPLOYEE` \| `AGENT` \| `SYSTEM` |
| `visibility` | `ess_ticket_comment_visibility` | no | `'PUBLIC'` | `INTERNAL` is never returned to the raiser — enforced in the query and by RLS |
| `body` | `text` | no | — | |
| `is_edited` | `boolean` | no | `false` | |
| `edited_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ck_tcm__author_kind CHECK (author_kind IN ('EMPLOYEE','AGENT','SYSTEM')),
CONSTRAINT ck_tcm__system_author CHECK ((author_kind = 'SYSTEM') = (author_user_id IS NULL)),
CONSTRAINT ck_tcm__edited CHECK (is_edited = (edited_at IS NOT NULL))
```
Index: `ix_tcm__ticket_time (helpdesk_ticket_id, created_at)`,
`ix_tcm__ticket_public (helpdesk_ticket_id, created_at) WHERE visibility = 'PUBLIC'`.

| `ticket_attachment` | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `helpdesk_ticket_id` | `uuid` | no | — | FK → `helpdesk_ticket(id)` `ON DELETE CASCADE` |
| `ticket_comment_id` | `uuid` | yes | — | FK → `ticket_comment(id)` `ON DELETE CASCADE` |
| `file_object_id` | `uuid` | no | — | FK → `file_object(id)` `ON DELETE RESTRICT` |
| `uploaded_by_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE RESTRICT` |

```sql
CONSTRAINT ux_ticket_attachment__ticket_file UNIQUE (helpdesk_ticket_id, file_object_id)
```

### 16.6 `faq_article` — reference data, seeded

The Help desk "Common questions" accordion. Content is configuration, authored by HR, not
operational data — but it is still persisted, versioned by `updated_at`, and read from
the database.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE RESTRICT` |
| `ticket_category_id` | `uuid` | yes | — | FK → `ticket_category(id)` `ON DELETE SET NULL` |
| `question` | `text` | no | — | |
| `answer_markdown` | `text` | no | — | |
| `display_order` | `smallint` | no | `0` | |
| `is_published` | `boolean` | no | `true` | |
| `view_count` | `integer` | no | `0` | |

```sql
CONSTRAINT ck_faq__view_count CHECK (view_count >= 0)
```
Index: `ix_faq__org_order (organization_id, display_order) WHERE is_published`.
With no published rows, the accordion card is not rendered at all.

### 16.7 `notification`

Every row must be traceable to a persisted event: either a `state_transition` that
declared `emits_notification_kind`, or a scheduled job whose rule is named in
`source_rule_code`. The API has **no** endpoint that creates an arbitrary notification.

| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | `gen_random_uuid()` | PK |
| `organization_id` | `uuid` | no | — | FK → `organization(id)` `ON DELETE CASCADE` |
| `recipient_app_user_id` | `uuid` | no | — | FK → `app_user(id)` `ON DELETE CASCADE` |
| `recipient_employee_id` | `uuid` | yes | — | FK → `employee(id)` `ON DELETE CASCADE` |
| `kind` | `ess_notification_kind` | no | — | |
| `tone` | `ess_notification_tone` | no | — | Maps to the popover's colour dot (Design System §1) |
| `title` | `text` | no | — | The notification sentence |
| `context_label` | `text` | no | — | `Payroll`, `Approvals`, `IT & Security` — the meta's right half |
| `occurred_at` | `timestamptz` | no | `now()` | The meta renders `31 Aug · Payroll` from this + `context_label` |
| `entity_type` | `text` | no | — | `payslip`, `leave_request`, `policy_version`, `helpdesk_ticket`, … |
| `entity_id` | `uuid` | no | — | Not an FK (polymorphic); the deep-link target |
| `deep_link_screen` | `text` | no | — | `payslips`, `approvals`, `policies`, … — the nav id the click navigates to |
| `deep_link_params` | `jsonb` | no | `'{}'` | `{"payslipId":"…"}` |
| `source_audit_event_id` | `uuid` | yes | — | FK → `audit_event(id)` `ON DELETE SET NULL` — the event that caused it |
| `source_rule_code` | `text` | yes | — | For job-generated notices, e.g. `POLICY_DUE_IN_3_DAYS` |
| `read_at` | `timestamptz` | yes | — | |
| `dismissed_at` | `timestamptz` | yes | — | |
| `expires_at` | `timestamptz` | yes | — | |

```sql
CONSTRAINT ck_notification__source CHECK (num_nonnulls(source_audit_event_id, source_rule_code) >= 1),
CONSTRAINT ux_notification__dedupe UNIQUE (recipient_app_user_id, kind, entity_type, entity_id, coalesce(source_rule_code, ''))
```
Indexes:
- `ix_notification__inbox (recipient_app_user_id, occurred_at DESC) WHERE dismissed_at IS NULL` — the popover's list
- `ix_notification__unread (recipient_app_user_id) WHERE read_at IS NULL AND dismissed_at IS NULL` — the bell's dot
- `ix_notification__entity (entity_type, entity_id)`

The unique dedupe constraint is what stops a retried job from producing two identical
notifications — the count on the bell is therefore exact, not approximate.

---
