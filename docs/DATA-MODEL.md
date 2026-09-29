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
