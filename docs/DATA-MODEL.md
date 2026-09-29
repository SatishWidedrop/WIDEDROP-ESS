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
> `payslip_fy_rollup` (§10.9) and `expense_fy_rollup` (§13.6), both written inside the
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
