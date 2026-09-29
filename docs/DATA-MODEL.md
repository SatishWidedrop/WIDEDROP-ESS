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

| Rule            | Definition                                                                                                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary key     | `id uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid()` on **every** table unless the table is explicitly a link/ledger table with a stated composite PK.                                                                      |
| Tenancy         | Every business table carries `organization_id uuid NOT NULL REFERENCES organization(id) ON DELETE RESTRICT`. Every user-facing index is composite and **leads with `organization_id`**.                                         |
| Creation stamp  | `created_at timestamptz NOT NULL DEFAULT now()`                                                                                                                                                                                 |
| Update stamp    | `updated_at timestamptz NOT NULL DEFAULT now()`, maintained by trigger `trg_touch_updated_at` (`BEFORE UPDATE … SET NEW.updated_at = now()`).                                                                                   |
| Actor stamps    | `created_by_user_id uuid NULL REFERENCES app_user(id) ON DELETE SET NULL`, `updated_by_user_id uuid NULL REFERENCES app_user(id) ON DELETE SET NULL`. NULL only for rows written by the system (migrations, schedulers, seeds). |
| Optimistic lock | `row_version integer NOT NULL DEFAULT 1` on every table that has a state machine; incremented by the same trigger. API sends `If-Match: <row_version>`; mismatch → `409`.                                                       |
| Soft delete     | **Not used.** Lifecycle is expressed by status enums and `is_active boolean`. Physically deleting operational rows is forbidden (Section 18).                                                                                   |

Columns listed per table below **omit** these standard columns; assume they are present
on every table unless the table description says "no audit columns" (only
`audit_event`, `leave_balance_ledger` and other append-only ledgers say that, and they
carry only `created_at`).

**Constraint-syntax legality (binding on every `CONSTRAINT … UNIQUE` written below).**
PostgreSQL does **not** accept a `WHERE` predicate, nor an expression such as
`coalesce(...)`, inside a table-level `UNIQUE` **constraint**. Wherever this document
writes

```sql
CONSTRAINT ux_x__y UNIQUE (a, b) WHERE <pred>          -- notation only
CONSTRAINT ux_x__y UNIQUE (a, coalesce(b, '…'))        -- notation only
```

the implementer **must** emit a partial / expression **unique index** instead:

```sql
CREATE UNIQUE INDEX ux_x__y ON ess.x (a, b) WHERE <pred>;
CREATE UNIQUE INDEX ux_x__y ON ess.x (a, coalesce(b, '…'));
```

This applies to every `ux_…` in this document whose definition carries a `WHERE` clause
or an expression, without exception: `ux_user_role__active`, `ux_fiscal_year__one_current`,
`ux_leave_period__one_current`, `ux_employee_bank_account__one_primary`,
`ux_attsub__period_live`, `ux_pvr__pass_rule_entity`, `ux_payroll_run__one_live`,
`ux_payslip__one_live_per_cycle_employee`, `ux_pii__one_lop_override_per_employee_cycle`,
`ux_pii__one_payout_per_claim`, `ux_tax_regime__fy_default`, `ux_etp__one_current`,
`ux_etdi__declaration_section_sub`, `ux_aa__unique_target`, `ux_notification__dedupe`,
`ux_dek__one_active`, `ux_approval_task__live_entity`, `ux_mfa_credential__user_method`,
`ux_pcrf__request_field_target`, `ux_email_suppression__live`, `ux_jwks__one_current`,
`ux_user_invitation__live`, `ux_user_invitation__fpr`, `ux_payslip_publication__live`,
`ux_payroll_cycle__attendance_period`, `ux_payroll_run__one_active`,
`ux_employee_statutory_id__org_kind_fpr`, `ux_tax_regime__fy_default`,
`ux_pv__policy_current`, `ux_employee_personal_detail__email_fpr`,
`ux_employee_employment__current`, `ux_employee_manager__current_primary`,
`ux_salary_structure__current`, `ux_user_invitation__live`, `ux_session__live`.
A unique _index_ is not a unique _constraint_: it cannot be the target of a foreign key
and it is not named in `information_schema.table_constraints`. §21.2 checks for it in
`pg_indexes` instead.

**Immutability in `CHECK` (binding).** A `CHECK` constraint must contain only
`IMMUTABLE` expressions over the row being written. `now()`, `CURRENT_DATE`,
`CURRENT_TIMESTAMP` and `localtimestamp` are **forbidden** in every `CHECK` and in every
**partial-index predicate** in this schema: PostgreSQL rejects the index outright, and a
`CHECK` written that way silently poisons the table (a row that was valid at insert
becomes unrestorable, and every later `UPDATE` of that row fails). Where this document
previously expressed such a rule it is restated as a `BEFORE INSERT OR UPDATE` trigger;
the three affected rules are `ck_ec__spend_not_future` (§13.2),
`ck_ann__scheduled` (§16.1) and `ix_user_role__user_active` (§3.4).

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

| Suffix           | Type    | Null          | Meaning                                                                                   |
| ---------------- | ------- | ------------- | ----------------------------------------------------------------------------------------- |
| `<field>_ct`     | `bytea` | see table     | AES-256-GCM ciphertext of the UTF-8 plaintext                                             |
| `<field>_iv`     | `bytea` | same as `_ct` | 12-byte random nonce, unique per write                                                    |
| `<field>_tag`    | `bytea` | same as `_ct` | 16-byte GCM authentication tag                                                            |
| `<field>_dek_id` | `uuid`  | same as `_ct` | FK → `data_encryption_key(id)` — identifies the wrapped DEK and therefore the key version |
| `<field>_mask`   | `text`  | same as `_ct` | **Deterministic masked projection**, computed at write time, safe to read and render      |

Plus, where equality lookup or duplicate detection is required (PAN, Aadhaar, bank
account number):

| Suffix                       | Type       | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<field>_fpr`                | `bytea`    | `HMAC-SHA256(pepper_v<n>, normalise(plaintext))`, 32 bytes. Blind index for uniqueness and search. Never reversible. The pepper lives in the secret manager, not in the database.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `<field>_fpr_pepper_version` | `smallint` | The `<n>` of the pepper used. **Mandatory wherever `_fpr` exists.** Without it a pepper rotation silently invalidates every uniqueness constraint that depends on the blind index (two rows peppered under different versions can never collide, so duplicates slip through). Rotation is therefore a two-phase job: `crypto-rewrap` recomputes every `_fpr` under the new pepper and bumps the version inside one transaction per row; the uniqueness indexes are `(organization_id, <field>_fpr_pepper_version, <field>_fpr)` so both generations stay enforceable during the roll. |

`normalise()` is fixed per field and is part of the schema contract, because two
spellings of the same value must produce the same fingerprint: **PAN** → `upper(trim())`;
**Aadhaar / bank account / UAN / PRAN / ESI / PF account** → strip every character that is
not `[0-9A-Za-z]`, then `upper()`; **email** → `lower(trim())`; **phone** → strip
everything but digits, then keep the last 10 digits. Any other normalisation is a bug.

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

| Field                                        | Mask rule                                                                                                     | Example (prototype)   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------- |
| Bank account number                          | last 4 digits, grouped: `'•••• •••• '                                                                         |                       | right(digits, 4)`                                                                                                                                                                                                                   | `•••• •••• 4412` |
| Date of birth                                | **year only**: `'••/••/'                                                                                      |                       | to_char(dob,'YYYY')`. The mask is a *reduced* projection; the full date is produced only by decryption, gated on `profile:read_sensitive:self\|any`and audited`READ_SENSITIVE`. A mask that reproduces the plaintext is not a mask. | `••/••/1994`     |
| Personal mobile                              | country code + 4 bullets + last 4 digits                                                                      | `+91 •••• •2234`      |
| Personal email                               | first character of the local part + bullets + domain                                                          | `p•••••@gmail.com`    |
| Address                                      | `city                                                                                                         |                       | ' '                                                                                                                                                                                                                                 |                  | pin` only | `Bengaluru 560095` |
| Dependent / nominee / emergency-contact name | **initials only**                                                                                             | `KR`                  |
| Bank account (inline, e.g. payslip header)   | `'••'                                                                                                         |                       | right(digits, 4)`                                                                                                                                                                                                                   | `••4412`         |
| IFSC                                         | **not encrypted** — IFSC is a public bank-branch code, stored plaintext                                       | `HDFC0000523`         |
| PAN                                          | first 5 + 4 bullets + last 1                                                                                  | `AXYPR••••K`          |
| Aadhaar                                      | `'•••• •••• '                                                                                                 |                       | right(digits, 4)`                                                                                                                                                                                                                   | `•••• •••• 8821` |
| PF account                                   | last 7 characters, rest bulleted                                                                              | `••••••••••••0001847` |
| ESI                                          | last 4 digits                                                                                                 | `••••••••••8821`      |
| UAN                                          | **encrypted**; mask = first 8 digits in groups of 4 + 4 bullets                                               | `1012 3456 ••••`      |
| PRAN (NPS)                                   | `'••••'                                                                                                       |                       | right(digits, 4)`                                                                                                                                                                                                                   | `••••4471`       |
| Tax declaration amounts                      | no mask; whole row is permission-gated, decrypted only for the owning employee and `tax:declaration:read:any` | —                     |

**Which columns are encrypted.** Exactly these, and nothing else:

| Table                           | Encrypted fields                                                                                                                                       | Blind index                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| `employee_bank_account`         | `account_number`, `account_holder_name`                                                                                                                | `account_number_fpr`                        |
| `employee_statutory_id`         | `value` (PAN / Aadhaar / UAN / PRAN / ESI / PF account)                                                                                                | `value_fpr`                                 |
| `employee_personal_detail`      | `personal_email`, `personal_mobile`, `date_of_birth`, `current_address`, `permanent_address`, `gender`, `marital_status`, `blood_group`, `nationality` | `personal_email_fpr`, `personal_mobile_fpr` |
| `employee_emergency_contact`    | `contact_name`, `phone`, `relationship_note`                                                                                                           | —                                           |
| `ticket_comment`                | `body`                                                                                                                                                 | —                                           |
| `profile_change_request_field`  | `proposed_value`, `previous_value`                                                                                                                     | —                                           |
| `dependent`                     | `full_name`, `date_of_birth`, `relationship_note`                                                                                                      | —                                           |
| `nominee`                       | `full_name`, `relationship`, `share_percent_note`                                                                                                      | —                                           |
| `employee_tax_declaration_item` | `declared_amount_minor` (as decimal string)                                                                                                            | —                                           |
| `salary_structure_component`    | `amount_minor` (as decimal string)                                                                                                                     | —                                           |
| `payroll_input_item`            | `amount_minor` (as decimal string)                                                                                                                     | —                                           |
| `payslip_line`                  | `amount_minor` (as decimal string)                                                                                                                     | —                                           |
| `payslip`                       | `gross_earnings_minor`, `total_deductions_minor`, `net_pay_minor`, `employer_pf_minor`, `tds_minor` (as decimal strings)                               | —                                           |
| `mfa_credential`                | `totp_secret`                                                                                                                                          | —                                           |
| `mfa_recovery_code`             | _(not encrypted — Argon2id hashed, see §6.3)_                                                                                                          | —                                           |

> **Why salary amounts are encrypted.** Payroll amounts are the highest-value target in
> an ESS. Encrypting them at the application layer means a stolen database dump, a
> leaked read replica, or a logical-replication tap yields **no per-component
> compensation detail** without a live KMS grant. The cost is that **aggregates over
> money must be computed in the API layer, not in SQL**. Section 20 therefore specifies,
> for every money aggregate, the exact row set the API fetches and folds — never a SQL
> `SUM()` over an encrypted column.

**Money-confidentiality classes (binding; this is the _complete_ classification — no
amount column exists outside it).** The earlier draft of this section claimed a dump
yields _no_ compensation data. That claim was false, because several derived tables held
plaintext per-employee money. The classification below is the corrected, enforced rule.

| Class                                      | Rule                                                                                                                                                                                                                                                    | Columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 — envelope-encrypted**                | Never plaintext at rest. Every per-employee _component-level_ or _total_ compensation figure.                                                                                                                                                           | `salary_structure.annual_ctc_minor`, `salary_structure_component.amount_minor`, `payroll_input_item.amount_minor`, `payslip_line.amount_minor`, `payslip_line.basis_amount_minor`, `payslip.{gross_earnings,total_deductions,net_pay,employer_pf,tds}_minor`, `employee_tax_declaration{,_item}` amounts, **and (corrected) `payslip_fy_rollup.{gross_earned,net_credited,total_deductions,tds,employee_pf,employer_pf}_minor`** and **`tds_quarter.tds_deducted_minor`**. A rollup is one row per employee per FY, so a single-row decrypt costs one AES-GCM operation per screen — the "single indexed read" argument for plaintext never justified handing an attacker a ready-made annual-compensation table. |
| **M2 — plaintext, org-level aggregate**    | Not attributable to any individual; readable only under `payroll:cycle:read` / `expense:reimburse`; excluded from every employee-facing payload.                                                                                                        | `payroll_cycle.{control_gross,control_net,control_deductions}_minor`, `payroll_input_batch.{declared_total,parsed_total}_minor`, `reimbursement_batch.total_amount_minor`, `attendance_submission.total_*_days`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **M3 — plaintext, employee-reimbursement** | Expense amounts are evidence the employee themself typed and their manager must read in a queue; they are not compensation, they are already visible to employee + manager + Finance, and RLS + §19 scope them. This is a deliberate, stated exception. | `expense_claim.{total_amount,approved_amount}_minor`, `expense_claim_line.*_minor`, `expense_fy_rollup.*_minor`, `reimbursement_batch_item.amount_minor`, `approval_task.amount_minor`, `expense_limit.cap_amount_minor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **M4 — plaintext, configuration**          | No person attached.                                                                                                                                                                                                                                     | `tax_regime.*`, `fiscal_year.*`, `benefit_plan_year.coverage_amount_minor`, `statutory_rate_set.*`, `statutory_pt_slab.*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **M5 — plaintext, derived tax projection** | Per-employee derived totals with a _stated_ residual risk (§1.6.1).                                                                                                                                                                                     | `employee_tax_projection.*_minor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**§1.6.1 Residual risk accepted for M5.** `employee_tax_projection` holds a per-employee
projected annual gross and tax. A database compromise therefore reveals an approximate
annual salary for every employee, even though M1 hides the component breakdown. This is
accepted **only** because the Tax screen's percentage and per-month arithmetic must be
reproducible server-side and re-derivable by an auditor without a KMS grant. The
compensating controls are mandatory and testable: (a) the table carries the same RLS
self/scope policy as `payslip`; (b) `ess_app` holds `SELECT` on it only through the
row-level policy, and no `report:*` role may `SELECT` it in bulk without writing an
`EXPORT` audit event; (c) it is excluded from every logical-replication publication and
from every non-production database clone (the `db:anonymise` fixture nulls it); (d) it is
listed in the DPDP record of processing as a high-sensitivity derived attribute. An
organisation whose threat model does not accept (a)–(d) moves it to M1 and folds the
percentages in the API layer; the schema change is additive and the query patterns in
§20.4 are unaffected.

Where a money aggregate must be queryable, a **pre-aggregated rollup** is persisted:
`payslip_fy_rollup` (§10.9, class M1) and `expense_fy_rollup` (§13.4, class M3), both
written inside the same transaction as the underlying row and both holding only
per-employee, per-FY totals that the employee is already entitled to see. Neither is ever
`SUM()`-ed in SQL across employees.

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

#### 1.8.1 Database roles (exact DDL)

```sql
CREATE ROLE ess_owner     NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ess_app       LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
CREATE ROLE ess_job       LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS     NOINHERIT;
CREATE ROLE ess_migrator  LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS     NOINHERIT;
CREATE ROLE ess_readonly  LOGIN   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;

ALTER SCHEMA ess OWNER TO ess_owner;  ALTER SCHEMA ess_ops OWNER TO ess_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;          -- no unqualified object creation
REVOKE CREATE ON SCHEMA ess, ess_ops FROM PUBLIC;
GRANT USAGE ON SCHEMA ess, ess_ops TO ess_app, ess_job, ess_readonly;

-- search_path is pinned per role so no object can be shadowed by a public-schema decoy
ALTER ROLE ess_app      SET search_path = ess, ess_ops, pg_catalog;
ALTER ROLE ess_job      SET search_path = ess, ess_ops, pg_catalog;
ALTER ROLE ess_migrator SET search_path = ess, ess_ops, pg_catalog;
```

- `ess_app` is **not** the owner, is `NOINHERIT`, and is granted no `SET ROLE` to
  `ess_owner`, `ess_job` or `ess_migrator`. It therefore cannot reach `BYPASSRLS` from a
  request path by any route.
- Every table carries `ALTER TABLE … ENABLE ROW LEVEL SECURITY` **and**
  `ALTER TABLE … FORCE ROW LEVEL SECURITY`. Without `FORCE`, the owning role silently
  bypasses every policy, which would make the whole of this section decorative in any
  migration or psql session run as the owner.
- `ess_readonly` exists for the analytics replica only; it holds `SELECT` on nothing in
  class M1/M5 (§1.6) and is not `BYPASSRLS`.
- Every `LANGUAGE sql` / `plpgsql` function and every trigger function in this schema is
  created with `SET search_path = ess, pg_catalog` attached, and none is
  `SECURITY DEFINER` unless this document names it as such (only
  `fn_audit_next_sequence`, §17.1, is).

#### 1.8.2 Request context

Every request opens its transaction with, in this order:

```sql
SET LOCAL ess.organization_id   = $1;   -- always present
SET LOCAL ess.actor_user_id     = $2;   -- always present
SET LOCAL ess.actor_employee_id = $3;   -- '' when the principal has no employee row
SET LOCAL ess.actor_persona     = $4;   -- the persona the route resolved (§17.1)
SET LOCAL ess.scopes            = $5;   -- comma-separated permission codes
```

`SET LOCAL` is used so the settings die with the transaction; the pool additionally runs
`DISCARD ALL` when a connection is returned outside a transaction. An unauthenticated
route opens no transaction against `ess_app` at all.

**Reading the context (binding helper functions).** A bare
`current_setting('ess.actor_employee_id')::uuid` **raises `42704` when the GUC is unset
and `22P02` when it is the empty string** — which is the normal case for an HR or
Accounts contractor who has an `app_user` but no `employee`. Every policy therefore goes
through these `IMMUTABLE`-free but `STABLE` helpers, never through `current_setting`
directly:

```sql
CREATE FUNCTION ess.ctx_org()      RETURNS uuid LANGUAGE sql STABLE SET search_path = ess, pg_catalog
  AS $$ SELECT nullif(current_setting('ess.organization_id', true), '')::uuid $$;
CREATE FUNCTION ess.ctx_employee() RETURNS uuid LANGUAGE sql STABLE SET search_path = ess, pg_catalog
  AS $$ SELECT nullif(current_setting('ess.actor_employee_id', true), '')::uuid $$;
CREATE FUNCTION ess.ctx_user()     RETURNS uuid LANGUAGE sql STABLE SET search_path = ess, pg_catalog
  AS $$ SELECT nullif(current_setting('ess.actor_user_id', true), '')::uuid $$;
CREATE FUNCTION ess.has_scope(p_code text) RETURNS boolean LANGUAGE sql STABLE SET search_path = ess, pg_catalog
  AS $$ SELECT p_code = ANY (string_to_array(coalesce(current_setting('ess.scopes', true), ''), ',')) $$;
```

`has_scope()` compares whole array elements. The earlier draft used
`current_setting('ess.scopes') LIKE '%<code>:read:any%'`, which is a **privilege-escalation
bug**: `LIKE '%ticket:read:any%'` is satisfied by the unrelated scope
`ticket:read:anything`, and `LIKE '%leave:request:read:any%'` by
`xleave:request:read:any`. Substring matching on a permission list is never acceptable;
`= ANY(string_to_array(...))` is the only permitted form.

#### 1.8.3 Policy shapes

- **Tenancy (every tenant-scoped table, `FOR ALL`)**:
  `USING (organization_id = ess.ctx_org()) WITH CHECK (organization_id = ess.ctx_org())`.
  The `WITH CHECK` half is not optional: `USING` alone constrains reads and the _old_ row
  of an update, and does nothing at all on `INSERT`. Without it a query-construction bug
  can write a row into another tenant even though it could never read it back. Every
  policy in this schema that permits `INSERT` or `UPDATE` carries a `WITH CHECK`.
- **Global reference tables** (`permission`, `state_transition`) have no
  `organization_id`. They still carry `ENABLE`/`FORCE ROW LEVEL SECURITY` with the
  explicit policy `FOR SELECT USING (true)`, and `ess_app` is granted `SELECT` only —
  no `INSERT`/`UPDATE`/`DELETE`. This is what satisfies §21 rule 5 for them; the CI
  check accepts a read-only policy for exactly these two tables and no others.
- **Employee-owned tables**, self/team/any policy, `FOR SELECT`:

  ```sql
  USING (
       employee_id = ess.ctx_employee()
    OR ess.has_scope('<resource>:read:any')
    OR (ess.has_scope('<resource>:read:team') AND EXISTS (
          SELECT 1 FROM ess.employee_reporting_closure c
          WHERE c.ancestor_employee_id = ess.ctx_employee()
            AND c.descendant_employee_id = employee_id
            AND c.depth > 0))
  )
  ```

  The team branch is **gated on holding the `:read:team` scope**. The earlier draft
  granted the whole reporting subtree unconditionally, which meant any principal with an
  employee row could read their subordinates' rows on every employee-owned table,
  including `employee_bank_account` — a manager is not entitled to a report's bank
  account. Write policies on employee-owned tables are `USING (employee_id = ess.ctx_employee())
WITH CHECK (employee_id = ess.ctx_employee())` unless a table below states otherwise.

- **Depth-limited tables.** `employee_emergency_contact` uses `c.depth = 1` (the _direct_
  manager only, matching the prototype's note "visible only to People Ops and your
  manager"), never `depth > 0`. `employee_bank_account`, `employee_statutory_id`,
  `employee_personal_detail`, `employee_tax_declaration{,_item}`, `payslip`,
  `payslip_line`, `payslip_fy_rollup`, `employee_tax_projection`, `form16_document`,
  `tds_quarter`, `salary_structure{,_component}` and `dependent`/`nominee` have **no team
  branch at all**: self, or `:read:any`, or nothing.
- `payslip`, `payslip_line` and `payslip_fy_rollup` additionally require the publication
  gate in §10.7 inside the policy itself, so the gate cannot be forgotten by a caller:
  `AND (ess.has_scope('payslip:read:any') OR EXISTS (SELECT 1 FROM ess.payslip_publication pub WHERE pub.payslip_id = payslip.id AND pub.published_at <= now() AND pub.revoked_at IS NULL))`.
- `helpdesk_ticket` rows with `is_anonymous = true` have **no owner branch**: they are
  visible only under `ticket:read:any`. An anonymous ticket is deliberately invisible to
  its own raiser after submission, and the Help-desk screen says so.
- `ticket_comment` adds `AND (visibility = 'PUBLIC' OR ess.has_scope('ticket:read:any'))`
  so an internal note can never reach the raiser even through a mis-built query.
- Migrations and scheduled jobs run as `ess_migrator` / `ess_job`, which carry
  `BYPASSRLS` and are never reachable from an HTTP request path. `ess_job` sets the same
  GUCs anyway, so audit rows written by a job still carry an organisation.
- **RLS is the second control, never the first.** The API performs the authorization
  decision before the query is built (SECURITY.md §4). A row that RLS filters out is a
  bug that must fail CI, not a feature: the integration suite asserts that every
  employee-scoped endpoint returns `404` from the _application_ check, with RLS disabled,
  before it re-runs the same suite with RLS enabled.

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

| Enum                                 | Values                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ess_employment_status`              | `PRE_JOINING`, `ACTIVE`, `ON_LEAVE`, `NOTICE_PERIOD`, `SUSPENDED`, `EXITED`                                                                                                                                                                                                                                                                               |
| `ess_employment_type`                | `FULL_TIME_PERMANENT`, `FULL_TIME_PROBATION`, `FIXED_TERM`, `INTERN`, `CONTRACTOR`, `CONSULTANT`                                                                                                                                                                                                                                                          |
| `ess_gender`                         | `FEMALE`, `MALE`, `NON_BINARY`, `UNDISCLOSED`                                                                                                                                                                                                                                                                                                             |
| `ess_marital_status`                 | `SINGLE`, `MARRIED`, `DIVORCED`, `WIDOWED`, `UNDISCLOSED`                                                                                                                                                                                                                                                                                                 |
| `ess_blood_group`                    | `A_POS`, `A_NEG`, `B_POS`, `B_NEG`, `AB_POS`, `AB_NEG`, `O_POS`, `O_NEG`, `UNKNOWN`                                                                                                                                                                                                                                                                       |
| `ess_user_status`                    | `INVITED`, `ACTIVE`, `LOCKED`, `DISABLED`                                                                                                                                                                                                                                                                                                                 |
| `ess_mfa_method`                     | `TOTP`                                                                                                                                                                                                                                                                                                                                                    |
| `ess_login_outcome`                  | `SUCCESS`, `BAD_CREDENTIALS`, `UNKNOWN_USER`, `MFA_REQUIRED`, `MFA_FAILED`, `LOCKED`, `DISABLED`, `RATE_LIMITED`                                                                                                                                                                                                                                          |
| `ess_statutory_id_kind`              | `PAN`, `AADHAAR`, `UAN`, `PF_ACCOUNT`, `ESI`, `PRAN`, `PASSPORT`                                                                                                                                                                                                                                                                                          |
| `ess_leave_unit`                     | `DAY`, `HALF_DAY`                                                                                                                                                                                                                                                                                                                                         |
| `ess_leave_accrual_frequency`        | `MONTHLY`, `QUARTERLY`, `ANNUAL`, `NONE`                                                                                                                                                                                                                                                                                                                  |
| `ess_leave_request_status`           | `DRAFT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `CANCELLED`                                                                                                                                                                                                                                                                             |
| `ess_leave_day_portion`              | `FULL`, `FIRST_HALF`, `SECOND_HALF`                                                                                                                                                                                                                                                                                                                       |
| `ess_leave_ledger_kind`              | `OPENING`, `ACCRUAL`, `CARRY_FORWARD_IN`, `CARRY_FORWARD_OUT`, `CONSUMPTION`, `CONSUMPTION_REVERSAL`, `ENCASHMENT`, `LAPSE`, `ADJUSTMENT`                                                                                                                                                                                                                 |
| `ess_holiday_kind`                   | `PUBLIC`, `RESTRICTED`, `WEEKEND_COMPENSATORY`                                                                                                                                                                                                                                                                                                            |
| `ess_attendance_period_status`       | `OPEN`, `HR_SUBMITTED`, `MANAGER_APPROVAL_PENDING`, `APPROVED`, `LOCKED`, `REOPENED`                                                                                                                                                                                                                                                                      |
| `ess_attendance_record_status`       | `DRAFT`, `SUBMITTED`, `APPROVED`, `REJECTED`, `LOCKED`                                                                                                                                                                                                                                                                                                    |
| `ess_attendance_approval_status`     | `PENDING`, `APPROVED`, `REJECTED`, `AUTO_ESCALATED`                                                                                                                                                                                                                                                                                                       |
| `ess_attendance_source`              | `HR_MANUAL`, `HR_BULK_UPLOAD`, `BIOMETRIC_IMPORT`, `SYSTEM_DERIVED`                                                                                                                                                                                                                                                                                       |
| `ess_pay_component_kind`             | `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `INFORMATIONAL`                                                                                                                                                                                                                                                                                          |
| `ess_pay_component_calc`             | `FIXED`, `PERCENT_OF_BASIC`, `PERCENT_OF_GROSS`, `SLAB`, `INPUT_DRIVEN`, `STATUTORY_ENGINE`, `PRORATED_FIXED`                                                                                                                                                                                                                                             |
| `ess_payroll_cycle_status`           | `DRAFT`, `INPUTS_OPEN`, `INPUTS_LOCKED`, `ATTENDANCE_SUBMITTED`, `ATTENDANCE_APPROVED`, `VALIDATING`, `VALIDATION_FAILED`, `VALIDATED`, `CALCULATING`, `CALCULATED`, `APPROVED`, `PUBLISHED`, `CLOSED`, `CANCELLED`                                                                                                                                       |
| `ess_payroll_input_batch_status`     | `UPLOADING`, `PARSED`, `PARSE_FAILED`, `VALIDATED`, `COMMITTED`, `SUPERSEDED`, `DISCARDED`                                                                                                                                                                                                                                                                |
| `ess_payroll_input_kind`             | `VARIABLE_PAY`, `INCENTIVE`, `BONUS`, `ARREAR`, `ONE_OFF_DEDUCTION`, `LOP_OVERRIDE`, `REIMBURSEMENT_PAYOUT`, `ADVANCE_RECOVERY`, `TDS_OVERRIDE`                                                                                                                                                                                                           |
| `ess_payroll_validation_severity`    | `INFO`, `WARNING`, `ERROR`                                                                                                                                                                                                                                                                                                                                |
| `ess_payroll_run_status`             | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SUPERSEDED`                                                                                                                                                                                                                                                                                                  |
| `ess_payslip_status`                 | `GENERATED`, `PUBLISHED`, `SUPERSEDED`, `REVOKED`                                                                                                                                                                                                                                                                                                         |
| `ess_payslip_line_kind`              | `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `INFORMATIONAL`                                                                                                                                                                                                                                                                                          |
| `ess_tax_regime_code`                | `OLD`, `NEW`                                                                                                                                                                                                                                                                                                                                              |
| `ess_tax_declaration_status`         | `DRAFT`, `SUBMITTED`, `PROOF_PENDING`, `PROOF_SUBMITTED`, `VERIFIED`, `REJECTED`                                                                                                                                                                                                                                                                          |
| `ess_tds_quarter_status`             | `UPCOMING`, `IN_PROGRESS`, `FILED`, `REVISED`                                                                                                                                                                                                                                                                                                             |
| `ess_form16_status`                  | `PENDING`, `ISSUED`, `REVISED`, `WITHDRAWN`                                                                                                                                                                                                                                                                                                               |
| `ess_benefit_category`               | `HEALTH`, `LIFE`, `ACCIDENT`, `RETIREMENT`, `WELLNESS`, `ALLOWANCE`, `OTHER`                                                                                                                                                                                                                                                                              |
| `ess_benefit_coverage_kind`          | `FIXED_SUM_INSURED`, `MULTIPLE_OF_CTC`, `MONTHLY_AMOUNT`, `PERCENT_OF_BASIC`, `NON_MONETARY`                                                                                                                                                                                                                                                              |
| `ess_benefit_enrolment_status`       | `ELIGIBLE`, `ENROLLED`, `WAIVED`, `PENDING_DOCUMENTS`, `LAPSED`, `TERMINATED`                                                                                                                                                                                                                                                                             |
| `ess_benefit_action`                 | `NONE`, `DOWNLOAD_ECARD`, `VIEW_POLICY_DOCUMENT`, `CHANGE_CONTRIBUTION`, `ADD_DEPENDENT`, `RAISE_TICKET`                                                                                                                                                                                                                                                  |
| `ess_dependent_relationship`         | `SPOUSE`, `SON`, `DAUGHTER`, `FATHER`, `MOTHER`, `FATHER_IN_LAW`, `MOTHER_IN_LAW`, `SIBLING`, `OTHER`                                                                                                                                                                                                                                                     |
| `ess_expense_claim_status`           | `DRAFT`, `SUBMITTED`, `PENDING_MANAGER`, `MANAGER_APPROVED`, `MANAGER_REJECTED`, `PENDING_FINANCE`, `FINANCE_APPROVED`, `FINANCE_REJECTED`, `QUEUED_FOR_PAYMENT`, `REIMBURSED`, `WITHDRAWN`, `CANCELLED`                                                                                                                                                  |
| `ess_expense_limit_basis`            | `PER_CLAIM`, `PER_LINE`, `PER_DAY`, `PER_MONTH`, `PER_FY`                                                                                                                                                                                                                                                                                                 |
| `ess_reimbursement_batch_status`     | `DRAFT`, `LOCKED`, `SENT_TO_PAYROLL`, `PAID`, `CANCELLED`                                                                                                                                                                                                                                                                                                 |
| `ess_document_request_status`        | `SUBMITTED`, `IN_REVIEW`, `PROCESSING`, `ISSUED`, `REJECTED`, `CANCELLED`                                                                                                                                                                                                                                                                                 |
| `ess_document_visibility`            | `EMPLOYEE_AND_HR`, `HR_ONLY`, `EMPLOYEE_MANAGER_HR`                                                                                                                                                                                                                                                                                                       |
| `ess_policy_status`                  | `DRAFT`, `PUBLISHED`, `ARCHIVED`                                                                                                                                                                                                                                                                                                                          |
| `ess_policy_version_status`          | `DRAFT`, `IN_REVIEW`, `PUBLISHED`, `SUPERSEDED`, `WITHDRAWN`                                                                                                                                                                                                                                                                                              |
| `ess_policy_ack_status`              | `PENDING`, `ACKNOWLEDGED`, `WAIVED`, `OVERDUE`                                                                                                                                                                                                                                                                                                            |
| `ess_policy_applicability_dimension` | `ALL`, `DEPARTMENT`, `LOCATION`, `EMPLOYMENT_TYPE`, `DESIGNATION`, `COST_CENTRE`, `EMPLOYEE`                                                                                                                                                                                                                                                              |
| `ess_announcement_status`            | `DRAFT`, `SCHEDULED`, `PUBLISHED`, `ARCHIVED`                                                                                                                                                                                                                                                                                                             |
| `ess_announcement_audience_kind`     | `ALL`, `DEPARTMENT`, `LOCATION`, `EMPLOYMENT_TYPE`, `EMPLOYEE`                                                                                                                                                                                                                                                                                            |
| `ess_ticket_status`                  | `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `WAITING_ON_EMPLOYEE`, `RESOLVED`, `CLOSED`, `REOPENED`, `CANCELLED`                                                                                                                                                                                                                                                   |
| `ess_ticket_priority`                | `LOW`, `NORMAL`, `HIGH`, `URGENT`                                                                                                                                                                                                                                                                                                                         |
| `ess_ticket_comment_visibility`      | `PUBLIC`, `INTERNAL`                                                                                                                                                                                                                                                                                                                                      |
| `ess_approval_task_kind`             | `LEAVE_REQUEST`, `EXPENSE_CLAIM`, `ATTENDANCE_PERIOD`, `PROFILE_CHANGE`, `DOCUMENT_REQUEST`                                                                                                                                                                                                                                                               |
| `ess_approval_task_status`           | `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`, `REASSIGNED`                                                                                                                                                                                                                                                                                   |
| `ess_approval_decision_outcome`      | `APPROVED`, `REJECTED`, `REASSIGNED`, `AUTO_APPROVED`, `AUTO_ESCALATED`                                                                                                                                                                                                                                                                                   |
| `ess_notification_kind`              | `PAYSLIP_PUBLISHED`, `LEAVE_SUBMITTED`, `LEAVE_DECIDED`, `EXPENSE_SUBMITTED`, `EXPENSE_DECIDED`, `EXPENSE_REIMBURSED`, `POLICY_ASSIGNED`, `POLICY_OVERDUE`, `ANNOUNCEMENT_PUBLISHED`, `TICKET_UPDATED`, `TICKET_RESOLVED`, `DOCUMENT_ISSUED`, `APPROVAL_PENDING`, `ATTENDANCE_APPROVAL_PENDING`, `PAYROLL_CYCLE_STATE`, `FORM16_ISSUED`, `SECURITY_ALERT` |
| `ess_notification_tone`              | `GREEN`, `AMBER`, `RED`, `BLUE`, `GRAY`                                                                                                                                                                                                                                                                                                                   |
| `ess_file_scan_status`               | `PENDING`, `CLEAN`, `INFECTED`, `SCAN_FAILED`, `SKIPPED`                                                                                                                                                                                                                                                                                                  |
| `ess_file_purpose`                   | `EXPENSE_BILL`, `TICKET_ATTACHMENT`, `EMPLOYEE_DOCUMENT`, `POLICY_PDF`, `PAYSLIP_PDF`, `FORM16_PDF`, `PAYROLL_INPUT_UPLOAD`, `ATTENDANCE_UPLOAD`, `BENEFIT_DOCUMENT`, `LETTER_PDF`, `PROFILE_PROOF`, `ORG_ASSET`                                                                                                                                          |
| `ess_email_status`                   | `QUEUED`, `SENDING`, `SENT`, `FAILED`, `SUPPRESSED`, `CANCELLED`                                                                                                                                                                                                                                                                                          |
| `ess_email_kind`                     | `HELPDESK_TICKET_CREATED`, `HELPDESK_TICKET_UPDATED`, `PAYSLIP_PUBLISHED`, `PAYSLIP_COPY_REQUESTED`, `LEAVE_DECISION`, `EXPENSE_DECISION`, `POLICY_REMINDER`, `DOCUMENT_ISSUED`, `USER_INVITE`, `PASSWORD_RESET`, `MFA_ENROLLED`, `SECURITY_ALERT`                                                                                                        |
| `ess_audit_action`                   | see §17.1 — `CREATE`, `UPDATE`, `DELETE`, `READ_SENSITIVE`, `LOGIN`, `LOGOUT`, `STATE_TRANSITION`, `EXPORT`, `DOWNLOAD`, `PERMISSION_GRANT`, `PERMISSION_REVOKE`, `IMPERSONATE`, `CONFIG_CHANGE`, `CRYPTO_REWRAP`                                                                                                                                         |
| `ess_actor_kind`                     | `USER`, `SYSTEM`, `SCHEDULER`, `MIGRATION`                                                                                                                                                                                                                                                                                                                |
| `ess_persona`                        | `EMPLOYEE`, `MANAGER`, `HR`, `ACCOUNTS`                                                                                                                                                                                                                                                                                                                   |
| `ess_payroll_scope_disposition`      | `INCLUDED`, `EXCLUDED`, `DEFERRED`                                                                                                                                                                                                                                                                                                                        |
| `ess_payroll_cycle_kind`             | `REGULAR`, `SUPPLEMENTARY`, `OFF_CYCLE`, `CORRECTION`                                                                                                                                                                                                                                                                                                     |
| `ess_payroll_run_kind`               | `REGULAR`, `CORRECTION`                                                                                                                                                                                                                                                                                                                                   |
| `ess_payroll_correction_status`      | `RAISED`, `APPROVED`, `CALCULATING`, `CALCULATED`, `PUBLISHED`, `REJECTED`, `FAILED`                                                                                                                                                                                                                                                                      |
| `ess_profile_change_status`          | `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `CANCELLED`, `APPLIED`                                                                                                                                                                                                                                                                         |
| `ess_profile_change_field`           | `PERSONAL_EMAIL`, `PERSONAL_MOBILE`, `CURRENT_ADDRESS`, `PERMANENT_ADDRESS`, `MARITAL_STATUS`, `EMERGENCY_CONTACT`, `BANK_ACCOUNT`, `STATUTORY_ID`, `NAME`, `DATE_OF_BIRTH`                                                                                                                                                                               |
| `ess_session_status`                 | `ACTIVE`, `EXPIRED`, `REVOKED`                                                                                                                                                                                                                                                                                                                            |
| `ess_jwks_status`                    | `NEXT`, `CURRENT`, `RETIRED`                                                                                                                                                                                                                                                                                                                              |
| `ess_attendance_lop_source`          | `DERIVED`, `HR_OVERRIDE`, `PAYROLL_INPUT_OVERRIDE`                                                                                                                                                                                                                                                                                                        |

> `ess_user_status` above is **extended** (forward-only `ALTER TYPE … ADD VALUE`) to
> `INVITED`, `PENDING_MFA`, `ACTIVE`, `LOCKED`, `SUSPENDED`, `DISABLED`, `OFFBOARDED`.
> SECURITY.md §2.7 requires `PENDING_MFA` (a role grant to a user without active MFA
> parks them there) and §2.5 requires `SUSPENDED`/`OFFBOARDED` to be distinct from an
> administrative `DISABLED`, because they carry different session-revocation and
> retention consequences. The four-value list previously printed in §2 could not express
> either rule.

### 2.1 `state_transition` — the single allowed-transition table

Every state machine in this system is declared here as **seeded reference data**. No
transition may be performed by the API unless a matching row exists; the service layer
calls `assertTransition(machine, from, to, actorScopes)` before every state change, and
a database trigger (`trg_guard_state_transition`) re-checks it on `UPDATE` for the
tables that carry `status`.

| Column                     | Type                    | Null | Default             | Notes                                                                                           |
| -------------------------- | ----------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                              |
| `machine`                  | `text`                  | no   | —                   | e.g. `leave_request`, `expense_claim`, `payroll_cycle`                                          |
| `from_state`               | `text`                  | yes  | —                   | `NULL` = the creation transition (initial state)                                                |
| `to_state`                 | `text`                  | no   | —                   |                                                                                                 |
| `required_permission_code` | `text`                  | yes  | —                   | FK → `permission(code)` `ON DELETE RESTRICT`; `NULL` = system-only transition                   |
| `guard_key`                | `text`                  | yes  | —                   | Names a code-side guard predicate, e.g. `payroll.attendance_fully_approved`. Documented in §19. |
| `is_terminal`              | `boolean`               | no   | `false`             | `to_state` admits no outgoing transitions                                                       |
| `emits_notification_kind`  | `ess_notification_kind` | yes  | —                   | If set, the transition **must** create a `notification` row in the same transaction             |
| `emits_email_kind`         | `ess_email_kind`        | yes  | —                   | If set, the transition **must** enqueue an `email_outbox` row in the same transaction           |
| `display_order`            | `smallint`              | no   | `0`                 |                                                                                                 |

Constraints:

```sql
PRIMARY KEY (id),
CONSTRAINT ux_state_transition__machine_from_to UNIQUE (machine, from_state, to_state),
CONSTRAINT ck_state_transition__distinct CHECK (from_state IS DISTINCT FROM to_state),
CONSTRAINT fk_state_transition__permission FOREIGN KEY (required_permission_code)
  REFERENCES permission(code) ON DELETE RESTRICT
```

Indexes: `ix_state_transition__machine_from (machine, from_state)`.

The full seeded contents are listed per module. **Every table in this schema that carries
a `status` column has a machine here; there are no exceptions, because
`trg_guard_state_transition` fires on any such `UPDATE` and a missing machine means an
unguarded status column.** The complete index:

| Machine                                                         | Defined in |
| --------------------------------------------------------------- | ---------- |
| `leave_request`                                                 | §8.6       |
| `attendance_period`, `attendance_record`, `attendance_approval` | §9.5       |
| `payroll_cycle`                                                 | §10.2      |
| `payroll_input_batch`                                           | §10.5.1    |
| `payroll_run`                                                   | §10.6.1    |
| `payslip`                                                       | §10.7.1    |
| `payslip_publication`                                           | §10.8.1    |
| `payroll_correction`                                            | §10.11     |
| `reimbursement_batch`                                           | §11        |
| `employee_tax_declaration`                                      | §12.3      |
| `tds_quarter`                                                   | §12.5.1    |
| `form16_document`                                               | §12.6.1    |
| `benefit_enrolment`                                             | §12.8.1    |
| `expense_claim`                                                 | §13.3      |
| `document_request`                                              | §14.3      |
| `policy_version`, `policy_acknowledgement`                      | §15.4      |
| `announcement`                                                  | §16.1.1    |
| `helpdesk_ticket`                                               | §16.4      |
| `approval_task`                                                 | §19.2      |
| `profile_change_request`                                        | §5.11      |
| `app_user` (account lifecycle)                                  | §5.1.1     |
| `session`                                                       | §6.6       |

A `state_transition` row whose `machine` is not in this table, or a `status` column whose
machine is absent from `state_transition`, fails `db:verify-schema` (§21 rule 13).

---

## 3. RBAC: roles, permissions, personas

### 3.1 `permission` — reference data, seeded

| Column         | Type                   | Null | Default             | Notes                                                                                             |
| -------------- | ---------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `id`           | `uuid`                 | no   | `gen_random_uuid()` | PK                                                                                                |
| `code`         | `text`                 | no   | —                   | **Unique.** Format `<domain>[:<subdomain>]:<action>[:<scope>]` — 2 to 4 colon-separated segments  |
| `domain`       | `text`                 | no   | —                   | **Stored, supplied by the seed** (not generated): `payroll`, `leave`, `tax`, …                    |
| `subdomain`    | `text`                 | yes  | —                   | **Stored**: `request`, `claim`, `declaration`, `salary_structure`, … `NULL` for two-segment codes |
| `action`       | `text`                 | no   | —                   | **Stored**: `read`, `create`, `approve`, `publish`, …                                             |
| `scope`        | `ess_permission_scope` | no   | `'global'`          | **Stored**: `self` \| `team` \| `any` \| `finance` \| `global`                                    |
| `description`  | `text`                 | no   | —                   | Shown in the HR role-management screen                                                            |
| `is_sensitive` | `boolean`              | no   | `false`             | Exercising it writes an `audit_event` with `action = 'READ_SENSITIVE'`                            |

```sql
CONSTRAINT ux_permission__code UNIQUE (code),
CONSTRAINT ck_permission__code_shape CHECK (code ~ '^[a-z_]+(:[a-z_]+){1,3}$'),
CONSTRAINT ck_permission__code_matches_parts CHECK (
  code = domain
      || coalesce(':' || subdomain, '')
      || ':' || action
      || CASE WHEN scope = 'global' THEN '' ELSE ':' || scope::text END)
```

New enum `ess_permission_scope` = `self`, `team`, `any`, `finance`, `global`.
Not tenant-scoped (global reference data; no `organization_id`).

> **Why these are stored columns and not generated ones.** The previous definition —
> regex `^[a-z_]+:[a-z_]+(:(self|team|any))?$` with `resource/action/scope` generated by
> `split_part` — is **wrong for the majority of the codes seeded below**. It rejects
> every four-segment code (`tax:declaration:read:self`, `leave:request:approve:team`,
> `payroll:salary_structure:read:any`, `approval:task:read:any`, `expense:claim:approve:finance`,
> `document:request:fulfil`, `profile:read_sensitive:self`, `security:session:revoke`, …),
> it rejects the scope `finance`, and for a two-segment org-wide code such as
> `payroll:validate` it would silently derive `scope = 'self'`, which is the opposite of
> that permission's meaning. Because `has_scope()` (§1.8.2) and the seeded persona
> mapping are both keyed on the exact code string, a derivation bug here is an
> authorization bug. The parts are therefore stated explicitly by the seed and the
> `ck_permission__code_matches_parts` constraint proves the two agree.

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
approval:task:read:self            approval:task:read:team           approval:task:read:any
approval:task:act
notification:read:self             notification:mark_read:self
profile:change_request:create:self profile:change_request:read:self  profile:change_request:read:any
profile:change_request:decide
payroll:correction:raise           payroll:correction:approve        payroll:correction:read
payroll:statutory:manage
expense:claim:approve:skip_level
org:read                           org:manage                        org:setting:read
org:setting:update                 employee:create
employee:read:any                  employee:update:any               employee:deactivate
role:read                          role:assign                       role:manage
audit:read                         audit:export                      security:session:revoke
security:mfa:reset                 file:download:self                file:download:any
report:payroll:read                report:leave:read                 report:expense:read
```

`is_sensitive = true` for: `profile:read_sensitive:*`, `payslip:read:any`,
`payslip:download:any`, `payroll:salary_structure:read:any`,
`tax:declaration:read:any`, `audit:read`, `audit:export`, `file:download:any`,
`employee:read:any`, `security:mfa:reset`, `security:session:revoke`,
`profile:change_request:read:any`, `payroll:correction:approve`.

**No permission code may be orphaned.** Every code seeded here must appear in at least
one persona's grant in §3.3, and `db:verify-schema` (§21 rule 14) fails otherwise. The
previous draft left `role:manage` and `audit:export` granted to nobody, which is not
"least privilege" — it is an unreachable capability that will be granted ad hoc in
production by someone with `psql`. Both are assigned to HR below, and both are
`is_sensitive`, step-up-MFA-gated (SECURITY.md §2.7) and dual-logged.

### 3.2 `role` — reference data, seeded (exactly four)

| Column            | Type          | Null | Default             | Notes                                                                                                   |
| ----------------- | ------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`              | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                                      |
| `organization_id` | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                            |
| `persona`         | `ess_persona` | no   | —                   | The four personas. **Unique per organization.**                                                         |
| `name`            | `text`        | no   | —                   | `Employee`, `Manager`, `HR`, `Accounts`                                                                 |
| `description`     | `text`        | no   | —                   |                                                                                                         |
| `is_assignable`   | `boolean`     | no   | `true`              | `EMPLOYEE` is auto-assigned on employee activation and cannot be revoked while the employee is `ACTIVE` |
| `nav_group_label` | `text`        | yes  | —                   | Extra sidebar group this persona unlocks (`Manager`, `People Ops`, `Payroll`). `NULL` for `EMPLOYEE`.   |

```sql
CONSTRAINT ux_role__org_persona UNIQUE (organization_id, persona)
```

### 3.3 `role_permission`

| Column               | Type          | Null | Default | Notes                                      |
| -------------------- | ------------- | ---- | ------- | ------------------------------------------ |
| `role_id`            | `uuid`        | no   | —       | FK → `role(id)` `ON DELETE CASCADE`        |
| `permission_id`      | `uuid`        | no   | —       | FK → `permission(id)` `ON DELETE RESTRICT` |
| `granted_at`         | `timestamptz` | no   | `now()` |                                            |
| `granted_by_user_id` | `uuid`        | yes  | —       | FK → `app_user(id)` `ON DELETE SET NULL`   |

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
  `expense:claim:approve:team`, `approval:task:{read:team,act}`, `report:leave:read`.
  Manager scope is **always** bounded by `employee_reporting_closure` (§5.5) — a
  Manager never sees an employee outside their subtree.
  > **Corrected.** The previous draft granted MANAGER `approval:task:read:any`. That is a
  > privilege escalation and it contradicts the sentence immediately after it: the RLS
  > policy shape of §1.8.3 admits a row when the actor `has_scope('<resource>:read:any')`,
  > so a Manager holding `approval:task:read:any` could read **every** manager's approval
  > queue in the organisation, including tasks about their own peers and seniors, with the
  > amount, subject name and subtitle attached. `approval:task:read:team` is the correct
  > grant; it is bounded by `assignee_employee_id = :me` in the query and by the team
  > branch of the policy. `approval:task:read:any` is held by HR only, for the
  > escalation and audit surfaces.
  > A Manager holds **no** `:read:any` code of any kind. A Manager also does **not**
  > receive `profile:read_sensitive:*`: a manager may see a report's emergency contact
  > (§5.9, depth 1) and nothing else that is envelope-encrypted.
  > Holding the MANAGER persona is _not_ what makes someone an approver: routing is by
  > `approval_task.assignee_employee_id`, which is derived from `employee_manager`. A user
  > can hold MANAGER and have no reports, in which case every team-scoped query returns
  > zero rows and every Manager surface renders its empty state.
- **HR** — everything in EMPLOYEE, plus `profile:read:any`, `profile:update:any`,
  `profile:read_sensitive:any`, `employee:{create,read:any,update:any,deactivate}`,
  `leave:*:any` + `leave:balance:adjust` + `leave:config:manage`, `holiday:manage`,
  `attendance:{read:any,capture,submit,reopen}`, `attendance:approve:any`
  (escalation only, guarded — see §9.5), `benefit:manage`, `dependent:{read:any,verify}`,
  `document:{read:any,upload:any,type:manage}`, `document:request:{read:any,fulfil}`,
  `policy:{author,publish}`, `policy:ack:read:any`,
  `announcement:{author,publish}`, `ticket:{read:any,comment:any,assign,resolve,config:manage}`,
  `role:{read,assign,manage}`, `org:{manage,setting:read,setting:update}`,
  `audit:{read,export}`, `security:{session:revoke,mfa:reset}`,
  `file:download:any`, `report:{leave,expense}:read`, `payroll:cycle:read`,
  `tax:form16:read:any`, `approval:task:read:any`,
  `profile:change_request:{read:any,decide}`.
  **HR does not hold** `payroll:calculate`, `payroll:approve`, `payroll:publish`,
  `payroll:input:*`, `payroll:correction:*`, `payslip:read:any`, or
  `payroll:salary_structure:*` — separation of duties. HR can see that a payroll cycle
  exists and what state it is in (`payroll:cycle:read`); HR can never see an amount on
  anyone's payslip.
- **ACCOUNTS** — everything in EMPLOYEE, plus `payroll:cycle:{read,create,transition}`,
  `payroll:input:{upload,read,commit}`, `payroll:{validate,calculate,approve,publish,close}`,
  `payroll:salary_structure:{read:any,write}`, `payroll:component:manage`,
  `payslip:{read:any,download:any}`, `tax:{declaration:read:any,declaration:verify,form16:{read:any,issue},quarter:{read:any,manage}}`,
  `expense:{claim:read:any,claim:approve:finance,reimburse,config:manage}`,
  `attendance:read:any`, `report:payroll:read`, `audit:read`, `file:download:any`,
  `payroll:correction:{raise,approve,read}`, `payroll:statutory:manage`,
  `org:setting:read`.
  **ACCOUNTS does not hold** `attendance:submit`, `attendance:capture` or
  `attendance:approve:*` — the payroll operator cannot manufacture their own attendance
  inputs. ACCOUNTS also does not hold `employee:*`, `role:*` or `profile:update:any`: it
  cannot create the employee whose payroll it runs, nor grant itself a second Accounts
  identity to satisfy dual control.

> **Dual control.** `payroll:approve` and `payroll:publish` are held by ACCOUNTS, but
> the guard `payroll.distinct_approver` (§10.2) forbids the same `app_user` from being
> both `calculated_by_user_id` and `approved_by_user_id` on a cycle, **and**
> `published_by_user_id` from equalling `calculated_by_user_id` (§10.1). Two Accounts
> users are therefore structurally required to publish payroll.
>
> **Dual control needs two people to exist.** A guard that compares two user ids is
> vacuous if the organisation has one Accounts user, because the cycle simply cannot
> advance and someone will "temporarily" grant the second role to the same human's second
> account. Two controls make that visible rather than silent:
>
> 1. `bootstrap:admin` and the HR role-assignment surface both refuse to leave the
>    organisation with fewer than **two distinct, `ACTIVE`, MFA-enrolled `app_user` rows
>    holding the ACCOUNTS persona**, and `payroll:cycle:create` returns
>    `409 {"code":"DUAL_CONTROL_UNAVAILABLE"}` when that count is below two. The count is
>    a query, not a setting: `SELECT count(DISTINCT ur.app_user_id) FROM user_role ur JOIN role r ON r.id = ur.role_id JOIN app_user u ON u.id = ur.app_user_id WHERE r.persona = 'ACCOUNTS' AND ur.revoked_at IS NULL AND u.status = 'ACTIVE' AND EXISTS (SELECT 1 FROM mfa_credential m WHERE m.app_user_id = u.id AND m.confirmed_at IS NOT NULL AND m.disabled_at IS NULL)`.
> 2. Granting a second persona to a user who already holds ACCOUNTS, or granting ACCOUNTS
>    to a user who already holds HR, writes a `PERMISSION_GRANT` audit event with
>    `metadata.sod_conflict = true` and raises a standing compliance finding on the HR
>    audit screen until it is revoked. The grant is not blocked — a small organisation may
>    need it — but it can never be quiet.
>
> **Separation of duties, stated as invariants** (each is asserted by
> `apps/api/test/separation.test.ts` against the seeded `role_permission` rows, so a seed
> edit that breaks one fails CI):
>
> | #     | Invariant                                                                                                                                                             |
> | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | SoD-1 | No persona holds both `attendance:submit` and `payroll:calculate`.                                                                                                    |
> | SoD-2 | No persona holds both `attendance:submit` and `attendance:approve:team`.                                                                                              |
> | SoD-3 | No persona holds both `payroll:input:upload` and `attendance:capture`.                                                                                                |
> | SoD-4 | No persona holds both `payslip:read:any` and `employee:update:any` (the payroll reader cannot edit the employee whose pay they read).                                 |
> | SoD-5 | No persona holds both `role:assign` and `payroll:approve`.                                                                                                            |
> | SoD-6 | `payroll:correction:raise` and `payroll:correction:approve` are held by the same persona but the DB `CHECK` on `payroll_correction` forbids the same user doing both. |

### 3.4 `user_role`

| Column               | Type          | Null | Default             | Notes                                        |
| -------------------- | ------------- | ---- | ------------------- | -------------------------------------------- |
| `id`                 | `uuid`        | no   | `gen_random_uuid()` | PK                                           |
| `organization_id`    | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT` |
| `app_user_id`        | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`      |
| `role_id`            | `uuid`        | no   | —                   | FK → `role(id)` `ON DELETE RESTRICT`         |
| `granted_by_user_id` | `uuid`        | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`     |
| `granted_at`         | `timestamptz` | no   | `now()`             |                                              |
| `valid_from`         | `date`        | no   | `CURRENT_DATE`      |                                              |
| `valid_to`           | `date`        | yes  | —                   | `NULL` = open-ended                          |
| `revoked_at`         | `timestamptz` | yes  | —                   |                                              |
| `revoked_by_user_id` | `uuid`        | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`     |
| `reason`             | `text`        | yes  | —                   | Required (enforced in API) when revoking     |

```sql
CONSTRAINT ck_user_role__valid_range CHECK (valid_to IS NULL OR valid_to >= valid_from),
CONSTRAINT ck_user_role__revocation  CHECK (num_nulls(revoked_at, revoked_by_user_id) IN (0, 2))
```

Indexes:

- `ux_user_role__active` — `CREATE UNIQUE INDEX ux_user_role__active ON ess.user_role (app_user_id, role_id) WHERE revoked_at IS NULL;` — one live grant per role.
- `ix_user_role__org_role (organization_id, role_id) WHERE revoked_at IS NULL`.
- `ix_user_role__user_active (app_user_id, valid_to) WHERE revoked_at IS NULL`.
  **Corrected:** the predicate previously read
  `… AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`. PostgreSQL rejects that index —
  a partial-index predicate must be `IMMUTABLE`, and `CURRENT_DATE` is `STABLE`. The
  date comparison moves into the query (`AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`),
  which the index above still supports.

**Scope resolution is re-read, never trusted from the token.** The `scopes` claim is a
cache. On every request the guard compares the token's `ver` against
`app_user.token_version`; on a mismatch it re-resolves from `user_role` → `role_permission`
and returns `401 {"code":"TOKEN_STALE"}` so the SPA refreshes once. A change to
`role_permission` (which is organisation-wide) therefore also bumps `token_version` for
**every** `app_user` in that organisation, in the same transaction as the grant — a
permission removed from a persona must not stay live in outstanding tokens for their full
10-minute TTL.

**A user may hold more than one persona** (the prototype's `role` prop toggles the
Manager group; in production the sidebar renders a group per held persona). The
effective permission set is the union of all live `user_role` → `role_permission`
codes, computed once per access token and embedded as the `scopes` claim.

---

## 4. Tenancy and organisation

### 4.1 `organization`

| Column                        | Type         | Null | Default                       | Notes                                                          |
| ----------------------------- | ------------ | ---- | ----------------------------- | -------------------------------------------------------------- |
| `id`                          | `uuid`       | no   | `gen_random_uuid()`           | PK                                                             |
| `code`                        | `citext`     | no   | —                             | Unique. `WDT`                                                  |
| `legal_name`                  | `text`       | no   | —                             | `Widedrop Technologies Private Limited`                        |
| `display_name`                | `text`       | no   | —                             | `Widedrop` — sidebar line 1                                    |
| `portal_name`                 | `text`       | no   | `'Employee portal'`           | Sidebar line 2                                                 |
| `logo_file_object_id`         | `uuid`       | yes  | —                             | FK → `file_object(id)` `ON DELETE SET NULL`                    |
| `timezone`                    | `text`       | no   | `'Asia/Kolkata'`              | IANA zone; drives every `date` interpretation                  |
| `locale`                      | `text`       | no   | `'en-IN'`                     | Drives number/date formatting                                  |
| `currency_code`               | `char(3)`    | no   | `'INR'`                       | ISO 4217                                                       |
| `currency_minor_unit_scale`   | `smallint`   | no   | `2`                           | paise per rupee = 10^2                                         |
| `fy_start_month`              | `smallint`   | no   | `4`                           | April                                                          |
| `leave_year_start_month`      | `smallint`   | no   | `1`                           | The prototype's Leave screen reads "Leave year Jan – Dec 2026" |
| `week_off_days`               | `smallint[]` | no   | `'{0,6}'`                     | ISO-ish day numbers (0 = Sunday). Drives working-day counting. |
| `helpdesk_email`              | `citext`     | no   | `'helpdesk@widedroptech.com'` | Destination for §16 dispatch                                   |
| `payroll_pay_day_rule`        | `text`       | no   | `'LAST_WORKING_DAY'`          | `LAST_WORKING_DAY` \| `FIXED_DAY`                              |
| `payroll_pay_day_of_month`    | `smallint`   | yes  | —                             | Required when rule = `FIXED_DAY`                               |
| `expense_cutoff_day_of_month` | `smallint`   | no   | `25`                          | Drives the Expenses copy "approved by the 25th"                |
| `default_holiday_calendar_id` | `uuid`       | yes  | —                             | FK → `holiday_calendar(id)` `ON DELETE SET NULL`               |
| `is_active`                   | `boolean`    | no   | `true`                        |                                                                |

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

| Column                 | Type       | Null | Default             | Notes                                                                                          |
| ---------------------- | ---------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`     | no   | `gen_random_uuid()` | PK                                                                                             |
| `organization_id`      | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                   |
| `parent_department_id` | `uuid`     | yes  | —                   | FK → `department(id)` `ON DELETE RESTRICT` — self-referential hierarchy                        |
| `code`                 | `citext`   | no   | —                   | `PLAT-ENG`                                                                                     |
| `name`                 | `text`     | no   | —                   | `Platform Engineering`                                                                         |
| `business_unit`        | `text`     | yes  | —                   | `Product & Engineering` — rendered on the Employment profile tab                               |
| `head_employee_id`     | `uuid`     | yes  | —                   | FK → `employee(id)` `ON DELETE SET NULL` (deferrable; employees reference departments)         |
| `accent_colour_hex`    | `char(7)`  | yes  | —                   | Directory avatar tint (Design System §1). `NULL` → UI falls back to `--bg-selected` `#1B365D`. |
| `is_active`            | `boolean`  | no   | `true`              |                                                                                                |
| `display_order`        | `smallint` | no   | `0`                 |                                                                                                |

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

| Column                | Type      | Null | Default             | Notes                                                                                                                     |
| --------------------- | --------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `uuid`    | no   | `gen_random_uuid()` | PK                                                                                                                        |
| `organization_id`     | `uuid`    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                              |
| `code`                | `citext`  | no   | —                   | `BLR-ECO`                                                                                                                 |
| `name`                | `text`    | no   | —                   | `Ecospace Campus`                                                                                                         |
| `site_label`          | `text`    | yes  | —                   | `Ecospace Tower A` — the Home sub-header                                                                                  |
| `city`                | `text`    | no   | —                   | `Bengaluru`                                                                                                               |
| `state`               | `text`    | yes  | —                   | `Karnataka`                                                                                                               |
| `country_code`        | `char(2)` | no   | `'IN'`              | ISO 3166-1                                                                                                                |
| `timezone`            | `text`    | no   | `'Asia/Kolkata'`    |                                                                                                                           |
| `holiday_calendar_id` | `uuid`    | yes  | —                   | FK → `holiday_calendar(id)` `ON DELETE SET NULL` — the Home "Bengaluru calendar" label comes from `holiday_calendar.name` |
| `is_active`           | `boolean` | no   | `true`              |                                                                                                                           |

```sql
CONSTRAINT ux_location__org_code UNIQUE (organization_id, code)
```

Index: `ix_location__org_city (organization_id, city) WHERE is_active`.

### 4.4 `cost_centre`

| Column              | Type      | Null | Default             | Notes                                             |
| ------------------- | --------- | ---- | ------------------- | ------------------------------------------------- |
| `id`                | `uuid`    | no   | `gen_random_uuid()` | PK                                                |
| `organization_id`   | `uuid`    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`      |
| `code`              | `citext`  | no   | —                   | `CC-4120`                                         |
| `name`              | `text`    | no   | —                   | `Platform` — profile renders `CC-4120 · Platform` |
| `department_id`     | `uuid`    | yes  | —                   | FK → `department(id)` `ON DELETE RESTRICT`        |
| `owner_employee_id` | `uuid`    | yes  | —                   | FK → `employee(id)` `ON DELETE SET NULL`          |
| `is_active`         | `boolean` | no   | `true`              |                                                   |

```sql
CONSTRAINT ux_cost_centre__org_code UNIQUE (organization_id, code)
```

### 4.5 `designation`

| Column                    | Type       | Null | Default             | Notes                                                                           |
| ------------------------- | ---------- | ---- | ------------------- | ------------------------------------------------------------------------------- |
| `id`                      | `uuid`     | no   | `gen_random_uuid()` | PK                                                                              |
| `organization_id`         | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                    |
| `code`                    | `citext`   | no   | —                   | `SSE`                                                                           |
| `title`                   | `text`     | no   | —                   | `Senior Software Engineer`                                                      |
| `job_level`               | `smallint` | yes  | —                   | For band-based leave/expense rules                                              |
| `job_family`              | `text`     | yes  | —                   | `Engineering`                                                                   |
| `is_people_manager_track` | `boolean`  | no   | `false`             | Informational only; management rights come from `user_role`, never from a title |
| `is_active`               | `boolean`  | no   | `true`              |                                                                                 |

```sql
CONSTRAINT ux_designation__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_designation__level CHECK (job_level IS NULL OR job_level BETWEEN 1 AND 20)
```

### 4.6 `fiscal_year` and `fiscal_quarter` — reference data, generated at seed

`fiscal_year`

| Column                         | Type      | Null | Default             | Notes                                            |
| ------------------------------ | --------- | ---- | ------------------- | ------------------------------------------------ |
| `id`                           | `uuid`    | no   | `gen_random_uuid()` | PK                                               |
| `organization_id`              | `uuid`    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`     |
| `code`                         | `text`    | no   | —                   | `FY2026-27`                                      |
| `label`                        | `text`    | no   | —                   | `FY 2026–27` (en-dash, as the prototype renders) |
| `start_date`                   | `date`    | no   | —                   | `2026-04-01`                                     |
| `end_date`                     | `date`    | no   | —                   | `2027-03-31`                                     |
| `declaration_form_reference`   | `text`    | no   | `'12BB'`            | The Tax screen's form label                      |
| `declaration_window_opens_on`  | `date`    | yes  | —                   | Tax screen copy                                  |
| `declaration_window_closes_on` | `date`    | yes  | —                   |                                                  |
| `proof_window_opens_on`        | `date`    | yes  | —                   | `2026-12-01`                                     |
| `proof_window_closes_on`       | `date`    | yes  | —                   | `2027-01-15`                                     |
| `is_current`                   | `boolean` | no   | `false`             | Maintained by `trg_fiscal_year_single_current`   |

```sql
CONSTRAINT ux_fiscal_year__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_fiscal_year__range CHECK (end_date > start_date),
CONSTRAINT ck_fiscal_year__windows CHECK (
  (declaration_window_closes_on IS NULL OR declaration_window_opens_on IS NULL
    OR declaration_window_closes_on >= declaration_window_opens_on)
  AND (proof_window_closes_on IS NULL OR proof_window_opens_on IS NULL
    OR proof_window_closes_on >= proof_window_opens_on)),
CONSTRAINT ex_fiscal_year__no_overlap EXCLUDE USING gist (
  organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&
),
CONSTRAINT ck_fiscal_year__current_flag CHECK (is_current IN (true, false))
```

```sql
CREATE UNIQUE INDEX ux_fiscal_year__one_current
  ON ess.fiscal_year (organization_id) WHERE is_current;      -- §1.2
```

`fiscal_quarter`

| Column               | Type       | Null | Default             | Notes                                                                             |
| -------------------- | ---------- | ---- | ------------------- | --------------------------------------------------------------------------------- |
| `id`                 | `uuid`     | no   | `gen_random_uuid()` | PK                                                                                |
| `organization_id`    | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                      |
| `fiscal_year_id`     | `uuid`     | no   | —                   | FK → `fiscal_year(id)` `ON DELETE CASCADE`                                        |
| `quarter_no`         | `smallint` | no   | —                   | 1…4                                                                               |
| `label`              | `text`     | no   | —                   | `Q1 · Apr – Jun 2026` — the Tax screen row label, persisted, not formatted ad hoc |
| `start_date`         | `date`     | no   | —                   |                                                                                   |
| `end_date`           | `date`     | no   | —                   |                                                                                   |
| `statutory_due_date` | `date`     | yes  | —                   | Form 24Q filing due date                                                          |

> **Corrected — standard deduction and cess are regime facts, not year facts.**
> `fiscal_year` previously carried `standard_deduction_minor` and `cess_rate`, and
> `tax_regime` (§12.1) carries both as well, with no stated precedence. Under the Indian
> regime split the two differ _by regime within the same year_, so a year-level column is
> not merely redundant, it is wrong, and two writers of the same number guarantee they
> will disagree. `tax_regime.standard_deduction_minor` and `tax_regime.cess_rate` are the
> **only** sources; the year-level columns are removed. `employee_tax_projection` records
> the resolved values it actually used (§12.4) so a past projection stays reproducible
> after a regime table is corrected.

```sql
CONSTRAINT ux_fiscal_quarter__fy_no UNIQUE (fiscal_year_id, quarter_no),
CONSTRAINT ck_fiscal_quarter__no CHECK (quarter_no BETWEEN 1 AND 4),
CONSTRAINT ck_fiscal_quarter__range CHECK (end_date > start_date)
```

### 4.6.1 `org_setting` — typed, auditable configuration

SECURITY.md reads `org_setting.mfa_grace_days` and `org_setting.helpdesk_email`;
DEPLOYMENT and the DPDP notice read the grievance-officer contact from it. It is a typed
key/value table so that a policy-relevant number (an MFA grace period, an SLA, a claim
window) is a **row with an audit trail**, not a redeploy.

| Column                    | Type      | Null | Default             | Notes                                                                                                                                                                                    |
| ------------------------- | --------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid`    | no   | `gen_random_uuid()` | PK                                                                                                                                                                                       |
| `organization_id`         | `uuid`    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                             |
| `key`                     | `citext`  | no   | —                   | `mfa_grace_days`, `expense_claim_window_days`, `business_hours_start`, `business_hours_end`, `grievance_officer_name`, `grievance_officer_email`, `payslip_publication_delay_minutes`, … |
| `value_type`              | `text`    | no   | —                   | `INTEGER` \| `BOOLEAN` \| `TEXT` \| `EMAIL` \| `TIME` \| `DATE` \| `JSON`                                                                                                                |
| `value`                   | `text`    | no   | —                   | Canonical string form; parsed per `value_type`                                                                                                                                           |
| `min_value` / `max_value` | `numeric` | yes  | —                   | Enforced for `INTEGER` — an operator cannot set `mfa_grace_days = 3650`                                                                                                                  |
| `is_secret`               | `boolean` | no   | `false`             | **Always `false` here.** Secrets live in the platform secret store; this column exists so the constraint below can forbid them.                                                          |
| `description`             | `text`    | no   | —                   | Shown on the HR settings screen                                                                                                                                                          |
| `updated_by_user_id`      | `uuid`    | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                 |

```sql
CONSTRAINT ux_org_setting__org_key UNIQUE (organization_id, key),
CONSTRAINT ck_org_setting__type CHECK (value_type IN ('INTEGER','BOOLEAN','TEXT','EMAIL','TIME','DATE','JSON')),
CONSTRAINT ck_org_setting__no_secrets CHECK (is_secret = false),
CONSTRAINT ck_org_setting__bounds CHECK (
  value_type <> 'INTEGER'
  OR ((min_value IS NULL OR value::numeric >= min_value)
      AND (max_value IS NULL OR value::numeric <= max_value)))
```

Every write is `org:setting:update` (HR only), step-up-MFA gated, and writes a
`CONFIG_CHANGE` audit event with before/after. Reads are `org:setting:read`.

> **One source of truth per setting.** `organization` already carries `helpdesk_email`,
> `expense_cutoff_day_of_month`, `week_off_days`, `fy_start_month`,
> `leave_year_start_month`, `payroll_pay_day_rule` and `payroll_pay_day_of_month`. Those
> columns stay **canonical** — they are structural, they are foreign-keyed and
> `CHECK`-ed, and several are referenced by generated columns. `org_setting` must not
> shadow them. The rule, enforced by `trg_org_setting_no_shadow` and by §21 rule 15:
> a `key` that names an `organization` column is **rejected on write**, and the settings
> resolver exposes those values read-through under the same names so SECURITY.md's
> `org_setting.helpdesk_email` resolves to `organization.helpdesk_email` and can never
> diverge from it. Directive 8 names one address; the schema must make it impossible for
> two rows to disagree about what it is.

**Seeded keys (complete for v1):**

| Key                                                  | Type         | Seed              | Bounds | Read by                                   |
| ---------------------------------------------------- | ------------ | ----------------- | ------ | ----------------------------------------- |
| `mfa_grace_days`                                     | INTEGER      | `14`              | 0–30   | SECURITY §2.7                             |
| `expense_claim_window_days`                          | INTEGER      | `30`              | 1–180  | guard `expense.spend_within_claim_window` |
| `expense_skip_level_threshold_minor`                 | INTEGER      | `2500000`         | ≥ 0    | §13.1 escalation                          |
| `business_hours_start` / `business_hours_end`        | TIME         | `09:30` / `18:30` | —      | SLA clocks (§16.4, §14.3)                 |
| `business_days`                                      | JSON         | `[1,2,3,4,5]`     | —      | SLA clocks                                |
| `attendance_approval_sla_hours`                      | INTEGER      | `48`              | 1–336  | `attendance_approval.due_at`              |
| `approval_task_sla_hours`                            | INTEGER      | `72`              | 1–336  | `approval_task.due_at`                    |
| `ticket_auto_close_days`                             | INTEGER      | `7`               | 1–90   | §16.4                                     |
| `ticket_reopen_window_days`                          | INTEGER      | `14`              | 1–90   | guard `ticket.within_reopen_window`       |
| `payroll_validation_max_age_hours`                   | INTEGER      | `24`              | 1–168  | guard `payroll.validated_recently`        |
| `grievance_officer_name` / `grievance_officer_email` | TEXT / EMAIL | from config       | —      | DPDP notice                               |

**Business-hours clock (the single definition).** Every "within N working hours" figure in
this schema — `helpdesk_ticket.first_response_due_at` and `.resolution_due_at`,
`document_request.due_at`, `attendance_approval.due_at`, `approval_task.due_at` — is
computed by one function and nothing else:

```sql
CREATE FUNCTION ess.add_business_time(p_org uuid, p_from timestamptz, p_hours integer,
                                      p_calendar uuid DEFAULT NULL)
RETURNS timestamptz LANGUAGE plpgsql STABLE SET search_path = ess, pg_catalog AS $$ … $$;
```

It advances `p_from` in the organisation's timezone, counting only minutes that fall
inside `business_hours_start … business_hours_end` on a weekday listed in `business_days`
that is not a `PUBLIC` holiday on `p_calendar` (defaulting to
`organization.default_holiday_calendar_id`). "1 working day" is therefore
`add_business_time(org, now(), 8)` and renders as the persisted
`ticket_category.first_response_sla_hours`, never as a hardcoded caption. Without this
function the SLA columns are unimplementable: the previous draft said "on the working-hours
calendar" and no working-hours calendar existed anywhere in the schema.

### 4.7 `ui_copy` — persisted interface copy (reference data, seeded)

Explanatory strings the prototype hardcodes (the four profile-tab notes, the Payslips
"Reflected in Form 26AS" caption, the Documents letterhead note, every empty-state
headline and explanation) are rows here, so that copy is reviewable, translatable and
changeable by HR without a deploy. They are **configuration, never operational data** —
they carry no counts, amounts, dates or statuses.

| Column            | Type      | Null | Default             | Notes                                                                     |
| ----------------- | --------- | ---- | ------------------- | ------------------------------------------------------------------------- |
| `id`              | `uuid`    | no   | `gen_random_uuid()` | PK                                                                        |
| `organization_id` | `uuid`    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                              |
| `key`             | `citext`  | no   | —                   | `profile.tab_note.bank`, `payslips.ytd.tds.sub`, `empty.payslips.none`, … |
| `locale`          | `text`    | no   | `'en-IN'`           |                                                                           |
| `value`           | `text`    | no   | —                   | The rendered string                                                       |
| `description`     | `text`    | yes  | —                   | Where it appears, for the HR editor                                       |
| `is_active`       | `boolean` | no   | `true`              |                                                                           |

```sql
CONSTRAINT ux_ui_copy__org_key_locale UNIQUE (organization_id, key, locale),
CONSTRAINT ck_ui_copy__key_shape CHECK (key ~ '^[a-z0-9_]+([.][a-z0-9_]+)+$'),
CONSTRAINT ck_ui_copy__value CHECK (length(btrim(value)) > 0)
```

Index: `ix_ui_copy__org_locale (organization_id, locale) WHERE is_active`.

**A missing key can never render as a blank string.** The mechanism, which the previous
one-line claim left unbuildable:

1. `packages/shared/src/ui-copy-keys.ts` exports `UI_COPY_KEYS`, a frozen object mapping
   every key to its **packaged default string**. It is the single enumeration; the web app
   may only read keys through a typed accessor, so an unlisted key is a TypeScript error.
2. The seed inserts a row for every key in that object. `db:verify-schema` rule 16 fails
   the build when the seeded key set and `UI_COPY_KEYS` differ in either direction.
3. At runtime the resolver is
   `ui_copy(org, key, locale) ?? ui_copy(org, key, 'en-IN') ?? UI_COPY_KEYS[key]`. The
   packaged default is the last line of defence, so a row deleted or deactivated in
   production degrades to the reviewed English string — never to `''`, never to the raw
   key, never to a React `undefined`.
4. `is_active = false` is refused by `trg_ui_copy_required_active` for any key in the
   required manifest; deactivation is for optional promotional copy only.

`ui_copy` is **configuration, and it is not allowed to contain data.**
`ck_ui_copy__no_data CHECK (value !~ '[0-9]{2,}' OR key LIKE 'static.%')` blocks a
well-meaning HR edit from baking "5 payslips" or "₹5,00,000" into a caption; anything
with a number in it is a template rendered from a query result, and its parameters are
named in `description`. Templates use `{{name}}` placeholders substituted server-side from
persisted values only.

**Required key families** (the manifest is exhaustive; this table names its shape so an
implementer can enumerate it against the screens):

| Family                                              | Example keys                                                                                                                                 | Used by                           |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `profile.tab_note.*`                                | `.personal`, `.employment`, `.bank`, `.emergency`                                                                                            | §20.5                             |
| `payslips.ytd.*.sub`                                | `.tds.sub`, `.pf.sub`, `.gross.sub`, `.net.sub`                                                                                              | §20.3                             |
| `home.greeting.*`                                   | `.morning`, `.afternoon`, `.evening`, `.morning_until`, `.afternoon_until`                                                                   | §20.2                             |
| `empty.<screen>.<case>.title` / `.body` / `.action` | see §20.16                                                                                                                                   | every screen                      |
| `disabled.<control>.<reason>`                       | `disabled.payslip_pdf.generating`, `disabled.ecard.not_issued`, `disabled.declaration.window_closed`, `disabled.add_dependent.window_closed` | every disabled control            |
| `status.<enum>.<value>`                             | `status.expense_claim.PENDING_MANAGER` → `Awaiting approval`                                                                                 | every status chip                 |
| `leave.tile.earned_only`, `leave.weekend_note`      | —                                                                                                                                            | §20.7                             |
| `documents.letterhead_note`, `help.sla_note`        | —                                                                                                                                            | §20.10, §20.13                    |
| `static.*`                                          | copy that legitimately contains digits (`static.posh.act_year`)                                                                              | exempt from `ck_ui_copy__no_data` |

> Status chips are `ui_copy` rows, not literals, for a reason directive 1 makes concrete:
> the prototype's chip labels (`Awaiting approval`, `Reimbursed`, `Acknowledged`,
> `Upcoming`) are part of its visual language and must be preserved exactly, while the
> underlying enum values are implementation names. One mapping table, seeded, keyed by
> `status.<enum>.<value>`, is what keeps the two from drifting apart.

---

## 5. Identity

### 5.1 `app_user` — authentication principal

One row per person who can sign in. An `app_user` **may** have no `employee`
(a service account or an HR/Accounts contractor); an `employee` **may** have no
`app_user` (pre-joining, or exited with access revoked).

| Column                 | Type              | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`            | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                             |
| `organization_id`      | `uuid`            | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                   |
| `email`                | `citext`          | no   | —                   | Work email; the login identifier                                                                                                                                                                                                                                                                                                                                                               |
| `email_verified_at`    | `timestamptz`     | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |
| `password_hash`        | `text`            | yes  | —                   | **Argon2id** PHC string (`$argon2id$v=19$m=65536,t=3,p=4$…`). `NULL` only while `status = 'INVITED'`.                                                                                                                                                                                                                                                                                          |
| `password_algo`        | `text`            | no   | `'argon2id'`        | Future-proofs a rehash campaign                                                                                                                                                                                                                                                                                                                                                                |
| `password_updated_at`  | `timestamptz`     | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |
| `password_must_change` | `boolean`         | no   | `false`             | Set on admin reset                                                                                                                                                                                                                                                                                                                                                                             |
| `status`               | `ess_user_status` | no   | `'INVITED'`         |                                                                                                                                                                                                                                                                                                                                                                                                |
| `failed_login_count`   | `smallint`        | no   | `0`                 | Reset to 0 on success                                                                                                                                                                                                                                                                                                                                                                          |
| `locked_until`         | `timestamptz`     | yes  | —                   | Progressive lockout (§6.4)                                                                                                                                                                                                                                                                                                                                                                     |
| `last_login_at`        | `timestamptz`     | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |
| `last_login_ip`        | `inet`            | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |
| `mfa_enforced_at`      | `timestamptz`     | yes  | —                   | Non-NULL ⇒ MFA is blocking **now** for this user (grace exhausted or never granted)                                                                                                                                                                                                                                                                                                            |
| `is_service_account`   | `boolean`         | no   | `false`             | Machine principal: holds no `employee`, is refused by the interactive login route, authenticates only by mTLS/OIDC workload identity                                                                                                                                                                                                                                                           |
| `token_version`        | `integer`         | no   | `1`                 | Bumped on password change, role grant/revoke, `role_permission` change, MFA reset, status change to `SUSPENDED`/`DISABLED`/`OFFBOARDED`, refresh-token reuse detection, and "sign out everywhere". Access tokens carry this as the `ver` claim; a mismatch ⇒ `401 {"code":"TOKEN_STALE"}`. **Renamed** from `token_epoch`/`epc` to match SECURITY.md §2.9 and §3.1 — one name for one concept. |
| `mfa_required_from`    | `date`            | yes  | —                   | When MFA becomes blocking for this user. Set to `CURRENT_DATE` on any grant of MANAGER/HR/ACCOUNTS (no grace, SECURITY.md §2.7); set to `activation_date + org_setting.mfa_grace_days` for an EMPLOYEE-only account.                                                                                                                                                                           |
| `mfa_enrolled_at`      | `timestamptz`     | yes  | —                   | First `mfa_credential.confirmed_at`. NULL while unenrolled.                                                                                                                                                                                                                                                                                                                                    |
| `terms_accepted_at`    | `timestamptz`     | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |
| `disabled_at`          | `timestamptz`     | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |
| `disabled_reason`      | `text`            | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                |

```sql
CONSTRAINT ux_app_user__org_email UNIQUE (organization_id, email),
CONSTRAINT ck_app_user__password_present CHECK (
  status IN ('INVITED','OFFBOARDED') OR is_service_account OR password_hash IS NOT NULL),
CONSTRAINT ck_app_user__service_no_password CHECK (NOT is_service_account OR password_hash IS NULL),
CONSTRAINT ck_app_user__failed_count CHECK (failed_login_count >= 0),
CONSTRAINT ck_app_user__token_version CHECK (token_version >= 1),
CONSTRAINT ck_app_user__disabled CHECK (num_nulls(disabled_at, disabled_reason) IN (0, 2)),
CONSTRAINT ck_app_user__mfa_enrolled CHECK (status <> 'ACTIVE' OR mfa_enforced_at IS NULL OR mfa_enrolled_at IS NOT NULL)
```

Trigger `trg_app_user_service_has_no_employee` (`AFTER INSERT OR UPDATE`) raises when
`is_service_account` and an `employee` row references this user; the symmetric check runs
on `employee`. (A `CHECK` cannot express it: it spans two tables.)

> **Corrected — the previous `ck_app_user__service_no_login` was backwards.** It read
> `CHECK (NOT is_service_account OR mfa_enforced_at IS NULL)`, i.e. _"a service account
> must NOT have MFA enforced"_. That constraint forbids the safe state and permits every
> unsafe one: it does not stop a service account holding an `employee`, does not stop it
> using the interactive login route, and does not stop a human account from having MFA
> silently un-enforced. The replacement forbids a service account from having a password
> at all (so the password route cannot authenticate it), moves the "no employee" rule to
> a trigger that can actually see both tables, and adds
> `ck_app_user__mfa_enrolled` so an account cannot sit in `ACTIVE` with MFA blocking and
> no enrolled credential.

**§5.1.1 Account lifecycle (`machine = 'app_user'`).**

| from                            | to            | permission                              | guard                                       | effect                                                                                               |
| ------------------------------- | ------------- | --------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `NULL`                          | `INVITED`     | `employee:create`                       | `user.email_unique_in_org`                  | creates `user_invitation` (§6.5.1) + `USER_INVITE` email                                             |
| `INVITED`                       | `PENDING_MFA` | _(system, on invitation acceptance)_    | `user.invitation_live`, `user.password_set` | —                                                                                                    |
| `PENDING_MFA`                   | `ACTIVE`      | _(system)_                              | `user.mfa_confirmed_or_within_grace`        | grants the EMPLOYEE persona when an `employee` row exists                                            |
| `ACTIVE`                        | `PENDING_MFA` | `role:assign`                           | `user.privileged_role_granted_without_mfa`  | bumps `token_version`, revokes every session                                                         |
| `ACTIVE`                        | `LOCKED`      | _(system)_                              | `user.lockout_threshold_reached` (§6.4)     | sets `locked_until`                                                                                  |
| `LOCKED`                        | `ACTIVE`      | _(system or `security:session:revoke`)_ | `user.lockout_expired_or_admin_cleared`     | clears counters                                                                                      |
| `ACTIVE`/`LOCKED`/`PENDING_MFA` | `SUSPENDED`   | `employee:deactivate`                   | `approval.note_required`                    | revokes every session + refresh family, bumps `token_version`                                        |
| `SUSPENDED`                     | `ACTIVE`      | `employee:deactivate`                   | `approval.note_required`                    | —                                                                                                    |
| any                             | `DISABLED`    | `employee:deactivate`                   | `approval.note_required`                    | administrative disable; sessions revoked                                                             |
| any                             | `OFFBOARDED`  | `employee:deactivate`                   | `user.employee_exited`                      | terminal; `password_hash` nulled, MFA credentials disabled, sessions revoked, row retained for audit |

Terminal: `OFFBOARDED`. Every transition writes an `audit_event`
(`action = 'STATE_TRANSITION'`, `entity_type = 'app_user'`) and, for
`SUSPENDED`/`DISABLED`/`OFFBOARDED`, a `SECURITY_ALERT` email to the user's work address.
Indexes:

- `ux_app_user__org_email (organization_id, email)`
- `ix_app_user__status (organization_id, status)`
- `ix_app_user__locked (locked_until) WHERE locked_until IS NOT NULL`

### 5.2 `employee` — the identity spine

Holds only the **stable, non-sensitive** identity. Effective-dated employment facts live
in `employee_employment` (§5.3); encrypted personal facts in `employee_personal_detail`
(§5.6).

| Column                 | Type                    | Null | Default             | Notes                                                                                                                                                 |
| ---------------------- | ----------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                                                                                    |
| `organization_id`      | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                          |
| `app_user_id`          | `uuid`                  | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`; **unique**                                                                                                  |
| `employee_number`      | `citext`                | no   | —                   | `WDT-01847`. Unique per org. Generated by `employee_number_seq` + org prefix; never reused.                                                           |
| `first_name`           | `text`                  | no   | —                   |                                                                                                                                                       |
| `middle_name`          | `text`                  | yes  | —                   |                                                                                                                                                       |
| `last_name`            | `text`                  | no   | —                   |                                                                                                                                                       |
| `full_name`            | `text`                  | no   | _(generated)_       | `GENERATED ALWAYS AS (btrim(first_name \|\| ' ' \|\| coalesce(middle_name \|\| ' ', '') \|\| last_name)) STORED` — the Directory/Profile display name |
| `preferred_name`       | `text`                  | yes  | —                   |                                                                                                                                                       |
| `initials`             | `text`                  | no   | _(generated)_       | `GENERATED ALWAYS AS (upper(left(first_name,1) \|\| left(last_name,1))) STORED` — avatar initials, so the UI never derives them client-side           |
| `work_email`           | `citext`                | no   | —                   | `priya.raghavan@widedrop.com`. Unique per org.                                                                                                        |
| `work_phone`           | `text`                  | yes  | —                   | Directory phone. Not encrypted (it is a published work number); gated by `directory:read_contact`.                                                    |
| `date_of_joining`      | `date`                  | no   | —                   | Tenure is computed from this, never stored                                                                                                            |
| `probation_end_date`   | `date`                  | yes  | —                   |                                                                                                                                                       |
| `date_of_exit`         | `date`                  | yes  | —                   |                                                                                                                                                       |
| `employment_status`    | `ess_employment_status` | no   | `'PRE_JOINING'`     |                                                                                                                                                       |
| `is_directory_listed`  | `boolean`               | no   | `true`              | An employee may be hidden from Directory by HR                                                                                                        |
| `photo_file_object_id` | `uuid`                  | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`. When NULL the UI renders `initials` on the department accent — never a stock image.                      |

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
- `ix_employee__search_trgm` — `GIN ((full_name || ' ' || work_email::text) gin_trgm_ops)` for Directory and global search. The `::text` cast is required: `work_email` is `citext` and `gin_trgm_ops` is defined for `text`; without it the index cannot be created and the expression in the query would not match it.
- `ix_employee__org_joining (organization_id, date_of_joining)`

### 5.3 `employee_employment` — effective-dated employment facts

Never updated in place for a change of designation/department/manager/notice period; a
new row is inserted and the previous row's `effective_to` is closed. This is what makes
payroll reproducible: a payslip resolves the row effective on its period end date.

| Column                            | Type                  | Null | Default             | Notes                                                                                                                                                   |
| --------------------------------- | --------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                              | `uuid`                | no   | `gen_random_uuid()` | PK                                                                                                                                                      |
| `organization_id`                 | `uuid`                | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                            |
| `employee_id`                     | `uuid`                | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                 |
| `effective_from`                  | `date`                | no   | —                   |                                                                                                                                                         |
| `effective_to`                    | `date`                | yes  | —                   | `NULL` = current row                                                                                                                                    |
| `designation_id`                  | `uuid`                | no   | —                   | FK → `designation(id)` `ON DELETE RESTRICT`                                                                                                             |
| `department_id`                   | `uuid`                | no   | —                   | FK → `department(id)` `ON DELETE RESTRICT`                                                                                                              |
| `location_id`                     | `uuid`                | no   | —                   | FK → `location(id)` `ON DELETE RESTRICT`                                                                                                                |
| `cost_centre_id`                  | `uuid`                | yes  | —                   | FK → `cost_centre(id)` `ON DELETE RESTRICT`                                                                                                             |
| `employment_type`                 | `ess_employment_type` | no   | —                   | Profile renders `Full-time · Permanent` from this                                                                                                       |
| `hr_business_partner_employee_id` | `uuid`                | yes  | —                   | FK → `employee(id)` `ON DELETE SET NULL` — profile's "HR business partner"                                                                              |
| `notice_period_days`              | `smallint`            | no   | `0`                 | Profile's "Notice period"                                                                                                                               |
| `weekly_off_days`                 | `smallint[]`          | yes  | —                   | Overrides `organization.week_off_days` for shift workers                                                                                                |
| `holiday_calendar_id`             | `uuid`                | yes  | —                   | FK → `holiday_calendar(id)` `ON DELETE RESTRICT`. Resolution order: this → `location.holiday_calendar_id` → `organization.default_holiday_calendar_id`. |
| `change_reason`                   | `text`                | no   | —                   | `NEW_HIRE`, `PROMOTION`, `TRANSFER`, `MANAGER_CHANGE`, `CORRECTION`, `EXIT`                                                                             |
| `effective_document_id`           | `uuid`                | yes  | —                   | FK → `employee_document(id)` `ON DELETE SET NULL` — e.g. the promotion letter that evidences this row                                                   |

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

| Column                | Type   | Null | Default             | Notes                                        |
| --------------------- | ------ | ---- | ------------------- | -------------------------------------------- |
| `id`                  | `uuid` | no   | `gen_random_uuid()` | PK                                           |
| `organization_id`     | `uuid` | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id`         | `uuid` | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`      |
| `manager_employee_id` | `uuid` | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`     |
| `relationship_kind`   | `text` | no   | `'PRIMARY'`         | `PRIMARY` \| `DOTTED_LINE` \| `DELEGATE`     |
| `effective_from`      | `date` | no   | —                   |                                              |
| `effective_to`        | `date` | yes  | —                   | `NULL` = current                             |
| `assigned_by_user_id` | `uuid` | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`     |
| `reason`              | `text` | yes  | —                   |                                              |

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

| Column                   | Type          | Null | Default | Notes                                                                                |
| ------------------------ | ------------- | ---- | ------- | ------------------------------------------------------------------------------------ |
| `organization_id`        | `uuid`        | no   | —       | FK → `organization(id)` `ON DELETE CASCADE`                                          |
| `ancestor_employee_id`   | `uuid`        | no   | —       | FK → `employee(id)` `ON DELETE CASCADE`                                              |
| `descendant_employee_id` | `uuid`        | no   | —       | FK → `employee(id)` `ON DELETE CASCADE`                                              |
| `depth`                  | `smallint`    | no   | —       | `0` = self, `1` = direct report, `n` = n levels down                                 |
| `path_employee_ids`      | `uuid[]`      | no   | —       | Ancestor → descendant, inclusive. Renders the Directory "Your reporting line" strip. |
| `computed_at`            | `timestamptz` | no   | `now()` |                                                                                      |

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

| Column                                        | Type               | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------ | ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                          | `uuid`             | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                        |
| `organization_id`                             | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                              |
| `employee_id`                                 | `uuid`             | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`; **unique**                                                                                                                                                                                                                                                                                                       |
| `gender_ct/_iv/_tag/_dek_id`                  | envelope (no mask) | yes  | —                   | Plaintext is one of `ess_gender`. Encrypted because gender, marital status, blood group and nationality are special-category personal data under the DPDP Act 2023 and are exactly the attributes SECURITY.md §7.1 requires at Layer 2. `NULL` envelope ⇒ not recorded; the UI omits the row rather than rendering `UNDISCLOSED` as if it were an answer. |
| `marital_status_ct/_iv/_tag/_dek_id`          | envelope (no mask) | yes  | —                   | Plaintext is one of `ess_marital_status`                                                                                                                                                                                                                                                                                                                  |
| `blood_group_ct/_iv/_tag/_dek_id`             | envelope (no mask) | yes  | —                   | Plaintext is one of `ess_blood_group`. **Health data** — never returned to a manager, only to the employee and `profile:read_sensitive:any`.                                                                                                                                                                                                              |
| `nationality_ct/_iv/_tag/_dek_id`             | envelope (no mask) | yes  | —                   | `Indian`                                                                                                                                                                                                                                                                                                                                                  |
| `date_of_birth_ct/_iv/_tag/_dek_id/_mask`     | envelope           | yes  | —                   | Mask renders `14 Feb 1994` only to `profile:read_sensitive:self                                                                                                                                                                                                                                                                                           | any`; otherwise the field is omitted from the payload entirely |
| `personal_email_ct/_iv/_tag/_dek_id/_mask`    | envelope           | yes  | —                   | Mask `p•••••••@gmail.com`                                                                                                                                                                                                                                                                                                                                 |
| `personal_email_fpr`                          | `bytea`            | yes  | —                   | Blind index (duplicate detection)                                                                                                                                                                                                                                                                                                                         |
| `personal_email_fpr_pepper_version`           | `smallint`         | yes  | —                   | §1.6                                                                                                                                                                                                                                                                                                                                                      |
| `personal_mobile_fpr`                         | `bytea`            | yes  | —                   | Blind index; SECURITY.md §7.1 requires it (a shared personal mobile across two employee records is a duplicate-identity signal)                                                                                                                                                                                                                           |
| `personal_mobile_fpr_pepper_version`          | `smallint`         | yes  | —                   | §1.6                                                                                                                                                                                                                                                                                                                                                      |
| `personal_mobile_ct/_iv/_tag/_dek_id/_mask`   | envelope           | yes  | —                   | Mask `+91 ••••• 12234`                                                                                                                                                                                                                                                                                                                                    |
| `current_address_ct/_iv/_tag/_dek_id/_mask`   | envelope           | yes  | —                   | Mask = city + PIN only                                                                                                                                                                                                                                                                                                                                    |
| `permanent_address_ct/_iv/_tag/_dek_id/_mask` | envelope           | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                           |

```sql
CONSTRAINT ux_employee_personal_detail__employee UNIQUE (employee_id)
-- plus the five envelope CHECK sets from §1.6
```

```sql
CREATE UNIQUE INDEX ux_employee_personal_detail__email_fpr
  ON ess.employee_personal_detail (organization_id, personal_email_fpr_pepper_version, personal_email_fpr)
  WHERE personal_email_fpr IS NOT NULL;                        -- §1.2
CREATE INDEX ix_employee_personal_detail__mobile_fpr
  ON ess.employee_personal_detail (organization_id, personal_mobile_fpr_pepper_version, personal_mobile_fpr)
  WHERE personal_mobile_fpr IS NOT NULL;   -- non-unique: a family may share a number
```

### 5.7 `employee_statutory_id`

| Column                            | Type                    | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                              | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                     |
| `organization_id`                 | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                           |
| `employee_id`                     | `uuid`                  | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                                                |
| `kind`                            | `ess_statutory_id_kind` | no   | —                   |                                                                                                                                                                                                                                                                                                                                                        |
| `value_ct/_iv/_tag/_dek_id/_mask` | envelope                | yes  | —                   | e.g. PAN mask `AXYPR••••K`. **Nullable**, because a row may legitimately record _the absence_ of an identifier (`is_applicable = false` — the prototype's `ESI · Not applicable`). Requiring a ciphertext there would force an implementer to invent an ESI number to say the employee has none, which is exactly the fabrication directive 2 forbids. |
| `value_fpr`                       | `bytea`                 | yes  | —                   | Blind index; detects the same PAN on two employees. NULL exactly when `value_ct` is NULL.                                                                                                                                                                                                                                                              |
| `value_fpr_pepper_version`        | `smallint`              | yes  | —                   | §1.6                                                                                                                                                                                                                                                                                                                                                   |
| `is_verified`                     | `boolean`               | no   | `false`             |                                                                                                                                                                                                                                                                                                                                                        |
| `verified_at`                     | `timestamptz`           | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                        |
| `verified_by_user_id`             | `uuid`                  | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                               |
| `proof_file_object_id`            | `uuid`                  | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                            |
| `is_applicable`                   | `boolean`               | no   | `true`              | `false` renders the profile's `Not applicable` (the prototype's ESI row) — a persisted fact, not a UI fallback                                                                                                                                                                                                                                         |

```sql
CONSTRAINT ux_employee_statutory_id__employee_kind UNIQUE (employee_id, kind),
CONSTRAINT ck_employee_statutory_id__verified CHECK (num_nulls(verified_at, verified_by_user_id) IN (0, 2)),
CONSTRAINT ck_employee_statutory_id__verified_flag CHECK (is_verified = (verified_at IS NOT NULL)),
CONSTRAINT ck_employee_statutory_id__applicable CHECK (
  (is_applicable = false AND value_ct IS NULL AND value_fpr IS NULL AND is_verified = false)
  OR (is_applicable = true AND value_ct IS NOT NULL AND value_fpr IS NOT NULL)),
CONSTRAINT ck_employee_statutory_id__fpr_pair CHECK (
  num_nulls(value_fpr, value_fpr_pepper_version) IN (0, 2))
```

```sql
-- partial + composite (see §1.6 on pepper rotation, §1.2 on syntax)
CREATE UNIQUE INDEX ux_employee_statutory_id__org_kind_fpr
  ON ess.employee_statutory_id (organization_id, kind, value_fpr_pepper_version, value_fpr)
  WHERE value_fpr IS NOT NULL;
```

A collision on this index means two employees were given the same PAN/Aadhaar/UAN. The
API surfaces it as `409 {"code":"STATUTORY_ID_DUPLICATE"}` naming only the _kind_, never
the other employee — the error must not become an oracle for testing whether a PAN is
already on file.

### 5.8 `employee_bank_account`

| Column                                          | Type          | Null | Default             | Notes                                                                  |
| ----------------------------------------------- | ------------- | ---- | ------------------- | ---------------------------------------------------------------------- |
| `id`                                            | `uuid`        | no   | `gen_random_uuid()` | PK                                                                     |
| `organization_id`                               | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                           |
| `employee_id`                                   | `uuid`        | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                |
| `bank_name`                                     | `text`        | no   | —                   | `HDFC Bank` — plaintext                                                |
| `branch_name`                                   | `text`        | yes  | —                   |                                                                        |
| `ifsc_code`                                     | `citext`      | no   | —                   | Plaintext, public code. `CHECK (ifsc_code ~ '^[A-Z]{4}0[A-Z0-9]{6}$')` |
| `account_type`                                  | `text`        | no   | `'SAVINGS'`         | `SAVINGS` \| `CURRENT`                                                 |
| `account_number_ct/_iv/_tag/_dek_id/_mask`      | envelope      | no   | —                   | Mask `•••• •••• 4412`                                                  |
| `account_number_fpr`                            | `bytea`       | no   | —                   | Blind index; detects the same account on two employees                 |
| `account_number_fpr_pepper_version`             | `smallint`    | no   | —                   | §1.6                                                                   |
| `account_number_last4`                          | `char(4)`     | no   | —                   | Denormalised for the payslip header `HDFC Bank ••4412`                 |
| `account_holder_name_ct/_iv/_tag/_dek_id/_mask` | envelope      | no   | —                   |                                                                        |
| `is_primary`                                    | `boolean`     | no   | `true`              | Salary credit account                                                  |
| `is_verified`                                   | `boolean`     | no   | `false`             | Payroll verifies against a cancelled cheque                            |
| `verified_at`                                   | `timestamptz` | yes  | —                   |                                                                        |
| `verified_by_user_id`                           | `uuid`        | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                               |
| `proof_file_object_id`                          | `uuid`        | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                            |
| `effective_from`                                | `date`        | no   | `CURRENT_DATE`      |                                                                        |
| `effective_to`                                  | `date`        | yes  | —                   |                                                                        |

```sql
CONSTRAINT ck_employee_bank_account__last4 CHECK (account_number_last4 ~ '^[0-9]{4}$'),
CONSTRAINT ck_employee_bank_account__fpr_pair CHECK (num_nulls(account_number_fpr, account_number_fpr_pepper_version) IN (0, 2)),
CONSTRAINT ck_employee_bank_account__range CHECK (effective_to IS NULL OR effective_to >= effective_from)
```

```sql
CREATE UNIQUE INDEX ux_employee_bank_account__one_primary
  ON ess.employee_bank_account (employee_id)
  WHERE is_primary AND effective_to IS NULL;                  -- §1.2
```

Index: `ix_employee_bank_account__employee_current (employee_id) WHERE effective_to IS NULL`.

> A payroll cycle may only include an employee whose primary bank account is
> `is_verified = true` (guard `payroll.bank_verified`, §10.2). This is surfaced as a
> `payroll_validation_result` ERROR, not silently skipped.

### 5.9 `employee_emergency_contact`

| Column                                        | Type                         | Null | Default             | Notes                                                                     |
| --------------------------------------------- | ---------------------------- | ---- | ------------------- | ------------------------------------------------------------------------- |
| `id`                                          | `uuid`                       | no   | `gen_random_uuid()` | PK                                                                        |
| `organization_id`                             | `uuid`                       | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                              |
| `employee_id`                                 | `uuid`                       | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                   |
| `priority`                                    | `smallint`                   | no   | —                   | `1` = Primary contact, `2` = Secondary contact (the prototype's two rows) |
| `contact_name_ct/_iv/_tag/_dek_id/_mask`      | envelope                     | no   | —                   |                                                                           |
| `relationship`                                | `ess_dependent_relationship` | no   | —                   | Rendered as `Spouse`, `Mother`                                            |
| `relationship_note_ct/_iv/_tag/_dek_id/_mask` | envelope                     | yes  | —                   | Free text when `relationship = 'OTHER'`                                   |
| `phone_ct/_iv/_tag/_dek_id/_mask`             | envelope                     | no   | —                   | Mask `+91 ••••• 44521`                                                    |

```sql
CONSTRAINT ux_employee_emergency_contact__employee_priority UNIQUE (employee_id, priority),
CONSTRAINT ck_employee_emergency_contact__priority CHECK (priority BETWEEN 1 AND 3)
```

Visible to the employee, their **current primary manager only** (`employee_reporting_closure`
`depth = 1`, not the whole subtree — see §1.8.3), and `profile:read_sensitive:any`,
matching the prototype's note "visible only to People Ops and your manager". A
second-level manager, a skip-level manager and a peer all read zero rows.

An employee with no recorded contacts is a normal state: the tab renders the designed
empty state (`ui_copy` key `empty.profile.emergency`) with a "Add a contact" action that
opens a `profile_change_request` (§5.11). It never renders a blank table or a placeholder
name.

### 5.10 `employee_reporting_closure` rebuild contract

The trigger `trg_rebuild_reporting_closure` is the only writer. Its contract, because the
Manager RLS branch and every team query depend on it being exactly right:

- It rebuilds the closure for the **affected subtree only** — the inserted/updated/deleted
  employee, every current ancestor of it before and after the change, and every
  descendant — inside the same transaction as the `employee_manager` write, holding
  `pg_advisory_xact_lock(hashtext('closure:' || organization_id))` so two concurrent
  re-orgs cannot interleave into a corrupt closure.
- Only `relationship_kind = 'PRIMARY'` rows with `effective_to IS NULL` participate.
  `DOTTED_LINE` and `DELEGATE` never widen anyone's data scope; a delegate approver is
  expressed by `approval_task.assignee_employee_id`, not by the closure.
- `depth = 0` self-rows exist for every employee, including employees with no manager and
  no reports, so `ancestor = descendant` joins never lose a row.
- `path_employee_ids` is ancestor → descendant inclusive, `cardinality = depth + 1`.
- Cycles are impossible by `trg_employee_manager_no_cycle`; the closure builder
  additionally aborts if it revisits a node, so a trigger-ordering bug fails loudly
  instead of looping.
- The nightly `reporting-closure-verify` job recomputes the whole closure into a temp
  table and diffs. A difference writes a `CONFIG_CHANGE` audit event, raises a P1, and
  **does not auto-repair** — a silent repair would erase the evidence of the bug that
  caused it.

### 5.11 `profile_change_request` and `profile_change_request_field`

Required by API.md §13.2 (`POST /me/profile-change-requests`) and WORKFLOWS.md §8, and by
`ess_approval_task_kind.PROFILE_CHANGE`, whose `ck_at__entity_fk` branch previously
pointed at no table at all. It also resolves the prototype's contradiction: the Personal
tab's note says address and contact changes "update instantly after HR review", which is
not instant — it is a reviewed change with a before/after record. This table is that
record.

`profile_change_request`

| Column                 | Type                        | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | --------------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`                      | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                              |
| `organization_id`      | `uuid`                      | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                    |
| `request_no`           | `citext`                    | no   | —                   | `WDT-PCR-2026-00318`. Unique per org.                                                                                                                                                                                                                                                                                                           |
| `employee_id`          | `uuid`                      | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — the subject **and** the requester; an employee may only request changes to their own profile (`profile:change_request:create:self`)                                                                                                                                                                  |
| `status`               | `ess_profile_change_status` | no   | `'DRAFT'`           |                                                                                                                                                                                                                                                                                                                                                 |
| `submitted_at`         | `timestamptz`               | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                 |
| `assigned_to_user_id`  | `uuid`                      | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL` — the HR reviewer                                                                                                                                                                                                                                                                                      |
| `decided_at`           | `timestamptz`               | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                 |
| `decided_by_user_id`   | `uuid`                      | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                        |
| `decision_note`        | `text`                      | yes  | —                   | Mandatory on `REJECTED`                                                                                                                                                                                                                                                                                                                         |
| `applied_at`           | `timestamptz`               | yes  | —                   | When the approved values were written to the target tables                                                                                                                                                                                                                                                                                      |
| `proof_file_object_id` | `uuid`                      | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL` — cancelled cheque, government ID                                                                                                                                                                                                                                                                   |
| `requires_proof`       | `boolean`                   | no   | _(generated)_       | `GENERATED ALWAYS AS (false) STORED` is **not** usable here; it is maintained by trigger as "true when any field row has `ess_profile_change_field` ∈ (`NAME`,`DATE_OF_BIRTH`,`BANK_ACCOUNT`,`STATUTORY_ID`)" — the prototype's rule "Name and date of birth changes need a government ID … Bank and statutory changes need a cancelled cheque" |
| `helpdesk_ticket_id`   | `uuid`                      | yes  | —                   | FK → `helpdesk_ticket(id)` `ON DELETE SET NULL` — set when the employee raised it from the Help desk instead of the profile screen                                                                                                                                                                                                              |
| `approval_task_id`     | `uuid`                      | yes  | —                   | FK → `approval_task(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                   |
| `row_version`          | `integer`                   | no   | `1`                 |                                                                                                                                                                                                                                                                                                                                                 |

```sql
CONSTRAINT ux_pcr__org_no UNIQUE (organization_id, request_no),
CONSTRAINT ck_pcr__submitted CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
CONSTRAINT ck_pcr__decided CHECK (
  (status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)),
CONSTRAINT ck_pcr__reject_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL),
CONSTRAINT ck_pcr__applied CHECK ((status = 'APPLIED') = (applied_at IS NOT NULL)),
CONSTRAINT ck_pcr__proof CHECK (NOT requires_proof OR status IN ('DRAFT') OR proof_file_object_id IS NOT NULL)
```

Indexes: `ix_pcr__employee (employee_id, submitted_at DESC)`,
`ix_pcr__queue (organization_id, status) WHERE status IN ('SUBMITTED','IN_REVIEW')`.

`profile_change_request_field` — one row per field changed. **Both the proposed and the
previous value are envelope-encrypted** (§1.6): a change request to a bank account
otherwise stores the account number in plaintext next to the encrypted one it replaces,
which would make this table the softest target in the schema.

| Column                                     | Type                       | Null | Default             | Notes                                                                                                                                       |
| ------------------------------------------ | -------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                       | `uuid`                     | no   | `gen_random_uuid()` | PK                                                                                                                                          |
| `organization_id`                          | `uuid`                     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                |
| `profile_change_request_id`                | `uuid`                     | no   | —                   | FK → `profile_change_request(id)` `ON DELETE CASCADE`                                                                                       |
| `field`                                    | `ess_profile_change_field` | no   | —                   |                                                                                                                                             |
| `target_table`                             | `text`                     | no   | —                   | `employee`, `employee_personal_detail`, `employee_bank_account`, `employee_statutory_id`, `employee_emergency_contact`                      |
| `target_row_id`                            | `uuid`                     | yes  | —                   | NULL when the change creates a new row (a first emergency contact)                                                                          |
| `proposed_value_ct/_iv/_tag/_dek_id/_mask` | envelope                   | no   | —                   | The mask is what the HR reviewer sees by default; revealing the plaintext requires `profile:read_sensitive:any` and writes `READ_SENSITIVE` |
| `previous_value_ct/_iv/_tag/_dek_id/_mask` | envelope                   | yes  | —                   | NULL when there was no prior value                                                                                                          |
| `applied_at`                               | `timestamptz`              | yes  | —                   |                                                                                                                                             |

```sql
CONSTRAINT ux_pcrf__request_field_target UNIQUE (profile_change_request_id, field, coalesce(target_row_id, '00000000-0000-0000-0000-000000000000'::uuid))
```

(As a unique **index**, per §1.2.) Index: `ix_pcrf__request (profile_change_request_id)`.

**State machine** `machine = 'profile_change_request'`:
`NULL→DRAFT` (`profile:change_request:create:self`, guard `profile.self_only`) ·
`DRAFT→SUBMITTED` (`profile:change_request:create:self`, guards `profile.self_only`,
`profile.has_fields`, `profile.proof_if_required`; creates an `approval_task` of kind
`PROFILE_CHANGE` assigned to the employee's HR business partner, falling back to any user
holding `profile:change_request:decide`) ·
`SUBMITTED→IN_REVIEW` (`profile:change_request:decide`) ·
`IN_REVIEW→APPROVED` (`profile:change_request:decide`, guard
`profile.proof_if_required`; step-up MFA required for `BANK_ACCOUNT` and `STATUTORY_ID`,
SECURITY.md §2.7) ·
`IN_REVIEW→REJECTED` (`profile:change_request:decide`, guard `approval.note_required`) ·
`APPROVED→APPLIED` (_system_, guard `profile.target_row_unchanged_since_submit` —
the write is refused if the target row's `row_version` moved after submission, so a
concurrent HR edit is never silently overwritten) ·
`DRAFT|SUBMITTED→CANCELLED` (`profile:change_request:create:self`, guard
`profile.self_only`, only while `decided_at IS NULL`).
Terminal: `APPLIED`, `REJECTED`, `CANCELLED`.
Applying a request writes the new values to the target tables **and** a single
`audit_event` per field with `before_data`/`after_data` redacted per §17.1, plus a
`PROFILE_CHANGE_DECIDED` notification to the employee.

> **The employee never writes a sensitive field directly.** `profile:update:self` covers
> only fields with no identity or payment consequence (preferred name, communication
> preferences). Every field in `ess_profile_change_field` goes through this machine. Bank
> and statutory changes additionally re-set `employee_bank_account.is_verified = false`
> and `employee_statutory_id.is_verified = false` on apply, which makes the affected
> employee fail the `payroll.bank_verified` validation on the next cycle until Payroll
> re-verifies — the prototype's "verified by Payroll within 2 working days", expressed as
> a state the system actually enforces rather than a caption.

---

## 6. Sessions, MFA and login security

### 6.0 `session` — the server-side revocation point

**This table was missing.** SECURITY.md §3.1 puts a `sid` claim in every access token and
looks it up on **every** request; §2.7 reads `session.mfa_verified_at` for step-up; §3.2
deletes `session` rows on refresh-token reuse. Without it, a 10-minute access token
cannot be revoked at all between `token_version` bumps, and step-up MFA has nowhere to
record that it happened. `refresh_token` cannot stand in for it: a refresh family is a
cookie lineage, not a live login, and it is not consulted on ordinary requests.

| Column                | Type                 | Null | Default             | Notes                                                                                                                                                                                    |
| --------------------- | -------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                  | `uuid`               | no   | `gen_random_uuid()` | PK. The `sid` claim.                                                                                                                                                                     |
| `organization_id`     | `uuid`               | no   | —                   | FK → `organization(id)` `ON DELETE CASCADE`                                                                                                                                              |
| `app_user_id`         | `uuid`               | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`                                                                                                                                                  |
| `status`              | `ess_session_status` | no   | `'ACTIVE'`          |                                                                                                                                                                                          |
| `created_at`          | `timestamptz`        | no   | `now()`             |                                                                                                                                                                                          |
| `last_seen_at`        | `timestamptz`        | no   | `now()`             | Updated at most once per 60 s (a write per request would be a hot-row bottleneck)                                                                                                        |
| `absolute_expires_at` | `timestamptz`        | no   | —                   | `created_at + interval '14 days'`; matches the refresh family cap                                                                                                                        |
| `idle_expires_at`     | `timestamptz`        | no   | —                   | `last_seen_at + interval '7 days'`                                                                                                                                                       |
| `auth_time`           | `timestamptz`        | no   | —                   | The original password authentication — the `auth_time` claim                                                                                                                             |
| `mfa_verified_at`     | `timestamptz`        | yes  | —                   | Last successful MFA assertion. **Step-up gate:** a route declaring `stepUp: true` requires `now() - mfa_verified_at < interval '5 minutes'`, else `403 {"code":"MFA_STEP_UP_REQUIRED"}`. |
| `amr`                 | `text[]`             | no   | `'{pwd}'`           | `{pwd}` or `{pwd,otp}` / `{pwd,recovery_code}`                                                                                                                                           |
| `ip_hash`             | `bytea`              | no   | —                   | `HMAC-SHA256(pepper, ip)` — 32 bytes. The raw IP is **not** stored on the session: it is a per-request access-log field with a 30-day life, not a 14-day identity attribute.             |
| `ip_asn`              | `integer`            | yes  | —                   | Coarse enrichment for the "new location" alert                                                                                                                                           |
| `user_agent_hash`     | `bytea`              | no   | —                   | `HMAC-SHA256(pepper, ua)`                                                                                                                                                                |
| `device_label`        | `text`               | yes  | —                   | Coarse, derived (`Chrome on macOS`) — the only human-readable device string, shown on the "Active sessions" screen                                                                       |
| `revoked_at`          | `timestamptz`        | yes  | —                   |                                                                                                                                                                                          |
| `revoked_reason`      | `text`               | yes  | —                   | `LOGOUT`, `LOGOUT_ALL`, `REUSE_DETECTED`, `ADMIN_REVOKE`, `PASSWORD_CHANGE`, `ROLE_CHANGE`, `STATUS_CHANGE`, `IDLE_EXPIRED`, `ABSOLUTE_EXPIRED`                                          |

```sql
CONSTRAINT ck_session__expiry CHECK (absolute_expires_at > created_at AND idle_expires_at > created_at),
CONSTRAINT ck_session__revocation CHECK (num_nulls(revoked_at, revoked_reason) IN (0, 2)),
CONSTRAINT ck_session__revoked_status CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL)),
CONSTRAINT ck_session__hash_len CHECK (octet_length(ip_hash) = 32 AND octet_length(user_agent_hash) = 32),
CONSTRAINT ck_session__amr CHECK (cardinality(amr) BETWEEN 1 AND 4)
```

Indexes:

- `ix_session__user_live (app_user_id, last_seen_at DESC) WHERE status = 'ACTIVE'` — the "Active sessions" screen and bulk revocation
- `ix_session__sweep (idle_expires_at) WHERE status = 'ACTIVE'`
- `ux_session__live` — not required; a user may hold several concurrent sessions by design.

**Lookup cost.** The per-request `sid` check is a single primary-key read and is cached
in-process for 10 s keyed by `(sid, token_version)`; a revocation is therefore effective
within 10 s, not 10 minutes. The cache is invalidated immediately in the process that
performs the revocation and by a Redis pub/sub `session:revoked` message in the others.

**State machine** `machine = 'session'` (see §6.6).

Every `refresh_token` belongs to exactly one `session`; revoking the session revokes the
family, and vice versa.

### 6.1 `refresh_token` — rotating, hashed, family-tracked

Access tokens are stateless JWTs (10 min TTL, never persisted) carrying `sid`; they are
verifiable offline **and** revocable, because §6.0's session row is consulted on every
request. Refresh tokens are opaque 256-bit random values delivered in a
`__Host-wd_rt` cookie (`httpOnly; Secure; SameSite=Strict; Path=/api/auth`; the
`__Host-` prefix pins it to the exact host with no `Domain` attribute, so a compromised
sibling subdomain cannot set it) and persisted **only as a hash**.

| Column                       | Type          | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                         | `uuid`        | no   | `gen_random_uuid()` | PK. Also the token's `jti`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `organization_id`            | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `app_user_id`                | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `session_id`                 | `uuid`        | no   | —                   | FK → `session(id)` `ON DELETE CASCADE`. **Added:** SECURITY.md §3.3 requires it, and it is what makes "revoke this session" and "revoke this family" one act.                                                                                                                                                                                                                                                                                                            |
| `family_id`                  | `uuid`        | no   | —                   | Lineage root. Constant across every rotation descended from one login. Equal to the first token's `id`.                                                                                                                                                                                                                                                                                                                                                                  |
| `parent_token_id`            | `uuid`        | yes  | —                   | FK → `refresh_token(id)` `ON DELETE SET NULL`. `NULL` on the first token of a family.                                                                                                                                                                                                                                                                                                                                                                                    |
| `generation`                 | `integer`     | no   | `0`                 | Monotonic within a family; `parent.generation + 1`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `token_hash`                 | `bytea`       | no   | —                   | `sha256(raw_token)`, 32 bytes. The raw token never touches the database, the logs, or any audit row.                                                                                                                                                                                                                                                                                                                                                                     |
| `issued_at`                  | `timestamptz` | no   | `now()`             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `expires_at`                 | `timestamptz` | no   | —                   | `issued_at + interval '7 days'` (idle TTL). **Corrected** from 14 days: SECURITY.md §3.3 specifies a 7-day idle TTL and a 14-day absolute family TTL, and a data model that persisted 14/30 would silently double the exposure window of a stolen cookie relative to the security design. The two documents now agree; `ACCESS_TOKEN_TTL_SECONDS`, `REFRESH_IDLE_TTL_DAYS` and `REFRESH_FAMILY_TTL_DAYS` are configuration, and the schema stores the resolved instants. |
| `family_absolute_expires_at` | `timestamptz` | no   | —                   | `family_created_at + interval '14 days'`; copied down unchanged on every rotation. Equal to `session.absolute_expires_at`.                                                                                                                                                                                                                                                                                                                                               |
| `used_at`                    | `timestamptz` | yes  | —                   | Set when this token is exchanged. **Renamed** from `rotated_at` to match SECURITY.md §3.3's reuse-detection predicate, which tests `used_at IS NOT NULL`.                                                                                                                                                                                                                                                                                                                |
| `revoked_at`                 | `timestamptz` | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `revoked_reason`             | `text`        | yes  | —                   | `ROTATED`, `LOGOUT`, `REUSE_DETECTED`, `ADMIN_REVOKE`, `PASSWORD_CHANGE`, `ROLE_CHANGE`, `EXPIRED`                                                                                                                                                                                                                                                                                                                                                                       |
| `user_agent_hash`            | `bytea`       | yes  | —                   | `HMAC-SHA256(pepper, ua)`. **Changed from plaintext:** a refresh-token table is not a place to accumulate 7 days of device fingerprints per user; the hash is sufficient for the only use (comparing the presenting client against the issuing client) and is what SECURITY.md §3.2 logs on reuse detection.                                                                                                                                                             |
| `ip_hash`                    | `bytea`       | yes  | —                   | `HMAC-SHA256(pepper, ip)` — same reasoning.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ip_asn`                     | `integer`     | yes  | —                   | Optional enrichment; drives the "new location" security alert                                                                                                                                                                                                                                                                                                                                                                                                            |

```sql
CONSTRAINT ux_refresh_token__hash UNIQUE (token_hash),
CONSTRAINT ck_refresh_token__expiry CHECK (expires_at > issued_at),
CONSTRAINT ck_refresh_token__generation CHECK (generation >= 0),
CONSTRAINT ck_refresh_token__hash_len CHECK (octet_length(token_hash) = 32),
CONSTRAINT ck_refresh_token__revocation CHECK (num_nulls(revoked_at, revoked_reason) IN (0, 2)),
CONSTRAINT ck_refresh_token__root CHECK ((generation = 0) = (parent_token_id IS NULL))
```

`family_absolute_expires_at >= expires_at` is **not** a `CHECK`: the last rotation inside
a family legitimately has an idle expiry beyond the family cap, and the cap — not the
idle expiry — is what the refresh route enforces (`now() < least(expires_at,
family_absolute_expires_at)`). Encoding it as a constraint would reject the final valid
rotation of every long-lived family.
Indexes:

- `ux_refresh_token__hash (token_hash)` — the only lookup path
- `ix_refresh_token__family (family_id, generation)`
- `ix_refresh_token__user_live (app_user_id) WHERE revoked_at IS NULL`
- `ix_refresh_token__expiry_sweep (expires_at) WHERE revoked_at IS NULL`

**Reuse detection.** On presentation of a token whose row has
`rotated_at IS NOT NULL` **or** `revoked_at IS NOT NULL`, the API:

1. `UPDATE refresh_token SET revoked_at = now(), revoked_reason = 'REUSE_DETECTED' WHERE family_id = $1 AND revoked_at IS NULL` — kills the whole family;
2. increments `app_user.token_version` — kills every outstanding access token;
3. deletes/revokes the `session` rows of that family and increments `app_user.token_version`;
4. writes an `audit_event` (`action = 'LOGOUT'`, `event_code = 'AUTH.REFRESH_REUSE_DETECTED'`, `metadata.reason = 'refresh_reuse'`, carrying both `ip_hash` values and both `user_agent_hash` values and **never** the token);
5. enqueues an `email_outbox` row of kind `SECURITY_ALERT`;
6. creates a `notification` of kind `SECURITY_ALERT`;
7. responds `401` with a generic body. No information about which token was replayed.

No audit columns (`created_by_user_id` etc.); only `issued_at`. Rows are swept 90 days
after `expires_at` by the `session-sweep` job — after their audit trail has been written.

**Refresh is a single serialisable act.** `POST /auth/refresh` runs
`SELECT … FROM refresh_token WHERE token_hash = $1 FOR UPDATE` before any decision, so a
genuine double-submit from one client serialises into one rotation and one replay rather
than racing two rotations into existence. The rotation, the `used_at` stamp, the new row
and the `session.last_seen_at` touch are one transaction.

### 6.2 `mfa_credential`

| Column                            | Type                  | Null | Default               | Notes                                                                                                                             |
| --------------------------------- | --------------------- | ---- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`                              | `uuid`                | no   | `gen_random_uuid()`   | PK                                                                                                                                |
| `organization_id`                 | `uuid`                | no   | —                     | FK → `organization(id)` `ON DELETE CASCADE`                                                                                       |
| `app_user_id`                     | `uuid`                | no   | —                     | FK → `app_user(id)` `ON DELETE CASCADE`                                                                                           |
| `method`                          | `ess_mfa_method`      | no   | `'TOTP'`              |                                                                                                                                   |
| `label`                           | `text`                | no   | `'Authenticator app'` |                                                                                                                                   |
| `totp_secret_ct/_iv/_tag/_dek_id` | envelope (no `_mask`) | no   | —                     | Base32 TOTP seed, AES-256-GCM. Never returned by any endpoint after enrolment.                                                    |
| `algorithm`                       | `text`                | no   | `'SHA1'`              | RFC 6238 default for authenticator-app compatibility                                                                              |
| `digits`                          | `smallint`            | no   | `6`                   |                                                                                                                                   |
| `period_seconds`                  | `smallint`            | no   | `30`                  |                                                                                                                                   |
| `confirmed_at`                    | `timestamptz`         | yes  | —                     | Enrolment is not complete until a code is verified                                                                                |
| `last_used_at`                    | `timestamptz`         | yes  | —                     |                                                                                                                                   |
| `last_used_counter`               | `bigint`              | yes  | —                     | Time-step counter of the last accepted code. A code with `counter <= last_used_counter` is **rejected** — TOTP replay protection. |
| `disabled_at`                     | `timestamptz`         | yes  | —                     |                                                                                                                                   |

```sql
CONSTRAINT ck_mfa_credential__digits CHECK (digits IN (6, 8)),
CONSTRAINT ck_mfa_credential__period CHECK (period_seconds IN (30, 60)),
CONSTRAINT ck_mfa_credential__algorithm CHECK (algorithm IN ('SHA1','SHA256','SHA512')),
CONSTRAINT ck_mfa_credential__counter CHECK (last_used_counter IS NULL OR last_used_counter > 0),
CONSTRAINT ck_mfa_credential__confirmed CHECK (confirmed_at IS NULL OR confirmed_at >= created_at)
```

```sql
CREATE UNIQUE INDEX ux_mfa_credential__user_method
  ON ess.mfa_credential (app_user_id, method) WHERE disabled_at IS NULL;   -- §1.2
```

`algorithm = 'SHA1'` is the RFC 6238 default and is what Google Authenticator, Authy and
1Password actually implement; it is retained deliberately for compatibility and is safe
here because HMAC-SHA1 has no practical preimage weakness and the secret is 160 bits from
a CSPRNG. The allowlist exists so a future migration to SHA256 is a data change, not a
code change, and so a client-supplied `algorithm` can never widen it.

**Verification window and replay.** A submitted code is checked against time-steps
`t-1, t, t+1` (±30 s skew) and **only** steps strictly greater than `last_used_counter`
are accepted; on success `last_used_counter` is set to the accepted step inside the same
`UPDATE … WHERE last_used_counter IS DISTINCT FROM <new>` so two concurrent submissions of
the same code cannot both win. Failed MFA attempts write a `login_attempt` row with
`outcome = 'MFA_FAILED'` and count toward the §6.4 lockout — otherwise MFA would be an
unrated brute-force surface behind a rate-limited password.

**Who must have MFA, restated as data** (SECURITY.md §2.7):
`app_user.mfa_required_from` is `CURRENT_DATE` for any user holding MANAGER, HR or
ACCOUNTS (no grace), and `activation_date + org_setting.mfa_grace_days` (seeded 14) for
an EMPLOYEE-only account. `mfa_enforced_at` is set by the `mfa-enforcement` job the first
time `CURRENT_DATE >= mfa_required_from`; from then on the login route completes only
through enrolment. The grace length is persisted configuration, not a literal, so the
compliance date for the Information Security Policy v4.2 clause is auditable.

### 6.3 `mfa_recovery_code`

| Column            | Type          | Null | Default             | Notes                                                                                       |
| ----------------- | ------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------- |
| `id`              | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                          |
| `organization_id` | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE CASCADE`                                                 |
| `app_user_id`     | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`                                                     |
| `code_hash`       | `text`        | no   | —                   | **Argon2id** PHC string. Recovery codes are credentials, so they are hashed, not encrypted. |
| `batch_id`        | `uuid`        | no   | —                   | 10 codes are issued as one batch; issuing a new batch invalidates the previous one          |
| `used_at`         | `timestamptz` | yes  | —                   |                                                                                             |
| `used_ip`         | `inet`        | yes  | —                   |                                                                                             |
| `invalidated_at`  | `timestamptz` | yes  | —                   |                                                                                             |

```sql
CONSTRAINT ck_mfa_recovery_code__usable CHECK (used_at IS NULL OR used_ip IS NOT NULL),
CONSTRAINT ck_mfa_recovery_code__hash CHECK (code_hash LIKE '$argon2id$%')
```

**Corrected:** the previous `CHECK (used_at IS NULL OR invalidated_at IS NULL)` forbids the
ordinary sequence _use one code, then reissue the batch_ — after reissue every code in the
old batch is invalidated, including the one already used, and the constraint would reject
that update. Single use is enforced by the consumption query, which is the only correct
place for it because it must also be atomic:

```sql
UPDATE mfa_recovery_code SET used_at = now(), used_ip = $3
 WHERE id = $1 AND used_at IS NULL AND invalidated_at IS NULL
 RETURNING id;   -- zero rows ⇒ already used or invalidated ⇒ reject
```

Consuming the last live code in a batch enqueues a `SECURITY_ALERT` email and forces
re-issue at next login; a user is never left with zero recovery codes silently.
Indexes: `ix_mfa_recovery_code__user_live (app_user_id) WHERE used_at IS NULL AND invalidated_at IS NULL`,
`ix_mfa_recovery_code__batch (batch_id)`.

### 6.4 `login_attempt`

Append-only. Every authentication decision is recorded, successful or not — this is the
evidence base for lockout, rate limiting and intrusion review.

| Column                               | Type                | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                 | `uuid`              | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `organization_id`                    | `uuid`              | yes  | —                   | FK → `organization(id)` `ON DELETE SET NULL`. NULL when the email matched no tenant.                                                                                                                                                                                                                                                                                                                                                                          |
| `app_user_id`                        | `uuid`              | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for `UNKNOWN_USER`.                                                                                                                                                                                                                                                                                                                                                                                            |
| `email_attempted_fpr`                | `bytea`             | no   | —                   | `HMAC-SHA256(pepper_v<n>, lower(trim(email)))`. The raw attempted email is **not** stored — an attacker who reads this table learns no addresses.                                                                                                                                                                                                                                                                                                             |
| `email_attempted_fpr_pepper_version` | `smallint`          | no   | —                   | §1.6. Without it the lockout and rate-limit lookups (which key on this fingerprint) silently stop matching the moment the pepper rotates, so an attacker could reset their own lockout counter by waiting for a rotation. Historical rows are **not** rewrapped — the fingerprint is not reversible and the lookup window is minutes — so the query matches on `(pepper_version, fpr)` for the current version only, and the previous version's rows age out. |
| `outcome`                            | `ess_login_outcome` | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `ip_address`                         | `inet`              | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `user_agent`                         | `text`              | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mfa_method`                         | `ess_mfa_method`    | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `request_id`                         | `uuid`              | no   | —                   | Correlates with `audit_event.request_id` and the access log                                                                                                                                                                                                                                                                                                                                                                                                   |
| `occurred_at`                        | `timestamptz`       | no   | `now()`             |                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

No `updated_at`, no actor columns; `INSERT`-only (enforced by
`trg_append_only_login_attempt`, which raises on `UPDATE`/`DELETE`).
Indexes:

- `ix_login_attempt__user_time (app_user_id, occurred_at DESC)`
- `ix_login_attempt__ip_time (ip_address, occurred_at DESC)`
- `ix_login_attempt__fpr_time (email_attempted_fpr_pepper_version, email_attempted_fpr, occurred_at DESC)`
- `ix_login_attempt__failures (occurred_at DESC) WHERE outcome <> 'SUCCESS'`

**Lockout rule (deterministic, computed from this table):** 5 non-`SUCCESS` outcomes for
one `app_user_id` inside 15 minutes sets `app_user.locked_until = now() + 15 min`;
each further failure after a lockout doubles the window to a 24-hour cap. Independently,
20 failures from one `/24` (IPv4) or `/64` (IPv6) inside 10 minutes triggers an IP-level
`RATE_LIMITED` outcome. Responses are constant-time and identical for
`UNKNOWN_USER` and `BAD_CREDENTIALS`.

### 6.5 `password_reset_token`

| Column            | Type          | Null | Default             | Notes                                                    |
| ----------------- | ------------- | ---- | ------------------- | -------------------------------------------------------- |
| `id`              | `uuid`        | no   | `gen_random_uuid()` | PK                                                       |
| `organization_id` | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE CASCADE`              |
| `app_user_id`     | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`                  |
| `token_hash`      | `bytea`       | no   | —                   | `sha256(raw)`, unique                                    |
| `expires_at`      | `timestamptz` | no   | —                   | `issued_at + interval '30 minutes'`                      |
| `used_at`         | `timestamptz` | yes  | —                   |                                                          |
| `invalidated_at`  | `timestamptz` | yes  | —                   | Set when a newer token is issued or the password changes |
| `requested_ip`    | `inet`        | yes  | —                   |                                                          |
| `issued_at`       | `timestamptz` | no   | `now()`             |                                                          |

```sql
CONSTRAINT ux_password_reset_token__hash UNIQUE (token_hash),
CONSTRAINT ck_password_reset_token__expiry CHECK (expires_at > issued_at)
```

Consuming a token bumps `app_user.token_version`, revokes every live `session` and
`refresh_token` family for that user, and invalidates every other live
`password_reset_token` for that user in the same transaction. Requesting a reset for an
address that matches no user performs the same Argon2id work and returns the same
response in the same time envelope, so the endpoint is not a user-enumeration oracle.

### 6.5.1 `user_invitation` — first-login activation

Required by SECURITY.md §2.4 (`activation_token`) and WORKFLOWS.md A-6. An invited
`app_user` has `status = 'INVITED'` and no `password_hash`; this row is the only way to
leave that state.

| Column                     | Type          | Null | Default             | Notes                                                                                                                           |
| -------------------------- | ------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                                                              |
| `organization_id`          | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE CASCADE`                                                                                     |
| `app_user_id`              | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`                                                                                         |
| `employee_id`              | `uuid`        | yes  | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                         |
| `token_hash`               | `bytea`       | no   | —                   | `sha256(raw)` of a 32-byte CSPRNG token; unique                                                                                 |
| `token_fpr`                | `bytea`       | no   | —                   | `HMAC-SHA256(pepper, raw)` — the lookup index, so the token is found without a table scan and without storing a reversible form |
| `token_fpr_pepper_version` | `smallint`    | no   | —                   | §1.6                                                                                                                            |
| `expires_at`               | `timestamptz` | no   | —                   | `created_at + interval '7 days'`                                                                                                |
| `sent_email_outbox_id`     | `uuid`        | yes  | —                   | FK → `email_outbox(id)` `ON DELETE SET NULL`                                                                                    |
| `accepted_at`              | `timestamptz` | yes  | —                   |                                                                                                                                 |
| `accepted_ip_hash`         | `bytea`       | yes  | —                   |                                                                                                                                 |
| `revoked_at`               | `timestamptz` | yes  | —                   |                                                                                                                                 |
| `revoked_by_user_id`       | `uuid`        | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                        |
| `attempt_count`            | `smallint`    | no   | `0`                 | Bad-token presentations against this user; 10 ⇒ auto-revoke + `SECURITY_ALERT`                                                  |

```sql
CONSTRAINT ux_user_invitation__token_hash UNIQUE (token_hash),
CONSTRAINT ck_ui__expiry CHECK (expires_at > created_at),
CONSTRAINT ck_ui__single_outcome CHECK (num_nulls(accepted_at, revoked_at) >= 1),
CONSTRAINT ck_ui__revocation CHECK (num_nulls(revoked_at, revoked_by_user_id) IN (0, 2)),
CONSTRAINT ck_ui__attempts CHECK (attempt_count BETWEEN 0 AND 10)
```

```sql
CREATE UNIQUE INDEX ux_user_invitation__live ON ess.user_invitation (app_user_id)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;              -- one live invite per user
CREATE UNIQUE INDEX ux_user_invitation__fpr
  ON ess.user_invitation (token_fpr_pepper_version, token_fpr);
```

Acceptance requires the token, a new password meeting the policy, and immediate MFA
enrolment when `mfa_required_from <= CURRENT_DATE`; it is one transaction that sets
`password_hash`, `accepted_at`, `app_user.status`, and writes an audit event.

### 6.5.2 `jwks` — access-token verification keys

SECURITY.md §3.2 requires it and states the private key never touches Postgres. This table
holds **public** keys and rotation metadata only; it is here because it is persistent
state the API reads on every unknown `kid`.

| Column                     | Type              | Null     | Default   | Notes                                                                                                                                      |
| -------------------------- | ----------------- | -------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `kid`                      | `text`            | no       | —         | PK. Format `wd-ess-<yyyymm>-<4 hex>`                                                                                                       |
| `public_key_pem`           | `text`            | no       | —         | Ed25519 SPKI PEM. **Public material only.**                                                                                                |
| `alg`                      | `text`            | no       | `'EdDSA'` | `CHECK (alg = 'EdDSA')` — a one-value allowlist is the point: an `alg` column that can hold `none` or `HS256` is a token-forgery primitive |
| `status`                   | `ess_jwks_status` | no       | `'NEXT'`  | `NEXT` (verify only) → `CURRENT` (sign) → `RETIRED` (verify for `ACCESS_TOKEN_TTL + 60 s`)                                                 |
| `not_before` / `not_after` | `timestamptz`     | no / yes | —         |                                                                                                                                            |
| `rotated_by_user_id`       | `uuid`            | yes      | —         | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                   |

```sql
CONSTRAINT ck_jwks__kid CHECK (kid ~ '^wd-ess-[0-9]{6}-[0-9a-f]{4}$'),
CONSTRAINT ck_jwks__window CHECK (not_after IS NULL OR not_after > not_before)
```

```sql
CREATE UNIQUE INDEX ux_jwks__one_current ON ess.jwks (status) WHERE status = 'CURRENT';
```

Not tenant-scoped. `ess_app` holds `SELECT` only; rotation runs as `ess_migrator`.
Every status change writes a `CONFIG_CHANGE` audit event.

### 6.6 Session state machine (`machine = 'session'`)

| from     | to        | permission                             | guard                                                                                            |
| -------- | --------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `NULL`   | `ACTIVE`  | `auth:login`                           | `auth.credentials_valid`, `auth.mfa_satisfied_or_not_required`, `auth.user_status_permits_login` |
| `ACTIVE` | `EXPIRED` | _(system)_                             | `session.idle_or_absolute_elapsed`                                                               |
| `ACTIVE` | `REVOKED` | _(self, or `security:session:revoke`)_ | —                                                                                                |

`auth.user_status_permits_login` admits only `ACTIVE` and `PENDING_MFA`; `INVITED`,
`LOCKED`, `SUSPENDED`, `DISABLED` and `OFFBOARDED` are refused with the **same** generic
body and the same timing as bad credentials, and the real reason is recorded only in
`login_attempt.outcome`. A `PENDING_MFA` session is created but carries
`amr = '{pwd}'` and is admitted to the enrolment routes only.

---

## 7. Calendar and the working-day model

### 7.1 `holiday_calendar` — reference data, seeded per location

| Column                         | Type           | Null | Default             | Notes                                                                |
| ------------------------------ | -------------- | ---- | ------------------- | -------------------------------------------------------------------- |
| `id`                           | `uuid`         | no   | `gen_random_uuid()` | PK                                                                   |
| `organization_id`              | `uuid`         | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                         |
| `code`                         | `citext`       | no   | —                   | `BLR-2026`                                                           |
| `name`                         | `text`         | no   | —                   | `Bengaluru calendar` — rendered verbatim on the Home holidays card   |
| `calendar_year`                | `smallint`     | no   | —                   | `2026`                                                               |
| `restricted_holiday_allowance` | `numeric(5,2)` | no   | `0`                 | How many RH days an employee may take from this calendar in the year |
| `is_active`                    | `boolean`      | no   | `true`              |                                                                      |

```sql
CONSTRAINT ux_holiday_calendar__org_code_year UNIQUE (organization_id, code, calendar_year),
CONSTRAINT ck_holiday_calendar__rh CHECK (restricted_holiday_allowance >= 0)
```

### 7.2 `holiday`

| Column                | Type               | Null | Default             | Notes                                                                           |
| --------------------- | ------------------ | ---- | ------------------- | ------------------------------------------------------------------------------- |
| `id`                  | `uuid`             | no   | `gen_random_uuid()` | PK                                                                              |
| `organization_id`     | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                    |
| `holiday_calendar_id` | `uuid`             | no   | —                   | FK → `holiday_calendar(id)` `ON DELETE CASCADE`                                 |
| `holiday_date`        | `date`             | no   | —                   |                                                                                 |
| `name`                | `text`             | no   | —                   | `Dussehra · Vijaya Dashami`                                                     |
| `kind`                | `ess_holiday_kind` | no   | `'PUBLIC'`          | `RESTRICTED` rows are optional and consume the RH allowance                     |
| `is_observed_shift`   | `boolean`          | no   | `false`             | `true` for "Diwali (observed)" — the actual festival falls on a non-working day |
| `note`                | `text`             | yes  | —                   |                                                                                 |

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

| Column                                  | Type             | Null | Default             | Notes                                                                              |
| --------------------------------------- | ---------------- | ---- | ------------------- | ---------------------------------------------------------------------------------- |
| `id`                                    | `uuid`           | no   | `gen_random_uuid()` | PK                                                                                 |
| `organization_id`                       | `uuid`           | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                       |
| `code`                                  | `citext`         | no   | —                   | `EL`, `CL`, `SL`, `COMP_OFF`, `RH`, `LOP`, `MATERNITY`, `PATERNITY`, `BEREAVEMENT` |
| `name`                                  | `text`           | no   | —                   | `Earned leave` — the Leave screen tile label and the request-type dropdown option  |
| `short_name`                            | `text`           | no   | —                   | `EL`                                                                               |
| `unit`                                  | `ess_leave_unit` | no   | `'DAY'`             | `HALF_DAY` permits `0.5` requests                                                  |
| `is_paid`                               | `boolean`        | no   | `true`              | `LOP` is the only seeded `false`                                                   |
| `affects_payroll_lop`                   | `boolean`        | no   | `false`             | `true` for LOP: approved days increment `attendance_record.lop_days`               |
| `requires_attachment_after_days`        | `numeric(5,2)`   | yes  | —                   | `2.00` for Sick leave (the policy's medical-certificate rule)                      |
| `min_notice_days`                       | `smallint`       | no   | `0`                 | `3` for Earned leave                                                               |
| `max_consecutive_days`                  | `numeric(5,2)`   | yes  | —                   |                                                                                    |
| `allows_negative_balance`               | `boolean`        | no   | `false`             |                                                                                    |
| `is_encashable`                         | `boolean`        | no   | `false`             |                                                                                    |
| `consumes_restricted_holiday_allowance` | `boolean`        | no   | `false`             | `true` for `RH`                                                                    |
| `display_order`                         | `smallint`       | no   | `0`                 | Fixes the Leave tile order without any client-side sort                            |
| `is_active`                             | `boolean`        | no   | `true`              |                                                                                    |

```sql
CONSTRAINT ux_leave_type__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_leave_type__notice CHECK (min_notice_days BETWEEN 0 AND 90),
CONSTRAINT ck_leave_type__lop_unpaid CHECK (NOT affects_payroll_lop OR NOT is_paid)
```

### 8.2 `leave_period` — the leave year

| Column            | Type          | Null | Default             | Notes                                                                             |
| ----------------- | ------------- | ---- | ------------------- | --------------------------------------------------------------------------------- |
| `id`              | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                |
| `organization_id` | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                      |
| `code`            | `text`        | no   | —                   | `LY2026`                                                                          |
| `label`           | `text`        | no   | —                   | `Leave year Jan – Dec 2026` — the Leave screen sub-header, persisted              |
| `start_date`      | `date`        | no   | —                   |                                                                                   |
| `end_date`        | `date`        | no   | —                   |                                                                                   |
| `is_current`      | `boolean`     | no   | `false`             |                                                                                   |
| `closed_at`       | `timestamptz` | yes  | —                   | After close, no ledger entry may be written with `effective_on` inside the period |

```sql
CONSTRAINT ux_leave_period__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_leave_period__range CHECK (end_date > start_date),
CONSTRAINT ex_leave_period__no_overlap EXCLUDE USING gist (
  organization_id WITH =, daterange(start_date, end_date, '[]') WITH &&),
CONSTRAINT ck_leave_period__closed CHECK (closed_at IS NULL OR closed_at >= end_date)
```

```sql
CREATE UNIQUE INDEX ux_leave_period__one_current
  ON ess.leave_period (organization_id) WHERE is_current;     -- §1.2
```

### 8.3 `leave_scheme` and `leave_entitlement_rule`

`leave_scheme` — a named bundle of entitlements assigned to a population.

| Column                     | Type                    | Null | Default             | Notes                                                                                           |
| -------------------------- | ----------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                              |
| `organization_id`          | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                    |
| `code`                     | `citext`                | no   | —                   | `IN-FT-2026`                                                                                    |
| `name`                     | `text`                  | no   | —                   | `India · Full-time · 2026`                                                                      |
| `leave_period_id`          | `uuid`                  | no   | —                   | FK → `leave_period(id)` `ON DELETE RESTRICT`                                                    |
| `applies_employment_types` | `ess_employment_type[]` | no   | `'{}'`              | Empty = all                                                                                     |
| `applies_location_ids`     | `uuid[]`                | no   | `'{}'`              | Empty = all                                                                                     |
| `source_policy_version_id` | `uuid`                  | yes  | —                   | FK → `policy_version(id)` `ON DELETE SET NULL` — ties the numbers to the published Leave Policy |
| `is_active`                | `boolean`               | no   | `true`              |                                                                                                 |

```sql
CONSTRAINT ux_leave_scheme__org_code_period UNIQUE (organization_id, code, leave_period_id)
```

`leave_entitlement_rule` — one row per leave type in a scheme.

| Column                           | Type                          | Null | Default             | Notes                                                           |
| -------------------------------- | ----------------------------- | ---- | ------------------- | --------------------------------------------------------------- |
| `id`                             | `uuid`                        | no   | `gen_random_uuid()` | PK                                                              |
| `organization_id`                | `uuid`                        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                    |
| `leave_scheme_id`                | `uuid`                        | no   | —                   | FK → `leave_scheme(id)` `ON DELETE CASCADE`                     |
| `leave_type_id`                  | `uuid`                        | no   | —                   | FK → `leave_type(id)` `ON DELETE RESTRICT`                      |
| `annual_entitlement_days`        | `numeric(5,2)`                | no   | —                   | `18.00` EL, `12.00` CL, `10.00` SL                              |
| `accrual_frequency`              | `ess_leave_accrual_frequency` | no   | `'MONTHLY'`         |                                                                 |
| `accrual_days_per_cycle`         | `numeric(5,2)`                | yes  | —                   | `1.50` EL/month (the Leave Policy's rule)                       |
| `accrual_on_day_of_month`        | `smallint`                    | yes  | —                   | `1`                                                             |
| `prorate_on_joining`             | `boolean`                     | no   | `true`              |                                                                 |
| `max_carry_forward_days`         | `numeric(5,2)`                | no   | `0`                 | `30.00` EL                                                      |
| `carry_forward_expiry_months`    | `smallint`                    | yes  | —                   |                                                                 |
| `lapses_at_period_end`           | `boolean`                     | no   | `true`              | CL lapses (policy: "Unused casual leave lapses on 31 December") |
| `max_balance_days`               | `numeric(5,2)`                | yes  | —                   | Accrual cap                                                     |
| `eligible_after_days_of_service` | `smallint`                    | no   | `0`                 |                                                                 |

```sql
CONSTRAINT ux_leave_entitlement_rule__scheme_type UNIQUE (leave_scheme_id, leave_type_id),
CONSTRAINT ck_ler__entitlement CHECK (annual_entitlement_days >= 0),
CONSTRAINT ck_ler__carry CHECK (max_carry_forward_days >= 0 AND max_carry_forward_days <= annual_entitlement_days + 60),
CONSTRAINT ck_ler__accrual CHECK (
  (accrual_frequency = 'NONE' AND accrual_days_per_cycle IS NULL)
  OR (accrual_frequency <> 'NONE' AND accrual_days_per_cycle IS NOT NULL AND accrual_days_per_cycle >= 0))
```

`employee_leave_scheme` — assignment (effective-dated).

| Column            | Type   | Null | Default             | Notes                                        |
| ----------------- | ------ | ---- | ------------------- | -------------------------------------------- |
| `id`              | `uuid` | no   | `gen_random_uuid()` | PK                                           |
| `organization_id` | `uuid` | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT` |
| `employee_id`     | `uuid` | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`      |
| `leave_scheme_id` | `uuid` | no   | —                   | FK → `leave_scheme(id)` `ON DELETE RESTRICT` |
| `effective_from`  | `date` | no   | —                   |                                              |
| `effective_to`    | `date` | yes  | —                   |                                              |

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

| Column             | Type                    | Null | Default             | Notes                                                                                        |
| ------------------ | ----------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------- |
| `id`               | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                           |
| `organization_id`  | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                 |
| `employee_id`      | `uuid`                  | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                     |
| `leave_type_id`    | `uuid`                  | no   | —                   | FK → `leave_type(id)` `ON DELETE RESTRICT`                                                   |
| `leave_period_id`  | `uuid`                  | no   | —                   | FK → `leave_period(id)` `ON DELETE RESTRICT`                                                 |
| `kind`             | `ess_leave_ledger_kind` | no   | —                   |                                                                                              |
| `delta_days`       | `numeric(5,2)`          | no   | —                   | **Signed.** `+1.50` accrual, `-5.00` consumption, `+5.00` reversal on withdrawal             |
| `effective_on`     | `date`                  | no   | —                   | The date the movement belongs to (drives period allocation)                                  |
| `leave_request_id` | `uuid`                  | yes  | —                   | FK → `leave_request(id)` `ON DELETE RESTRICT` — set for `CONSUMPTION`/`CONSUMPTION_REVERSAL` |
| `source_ledger_id` | `uuid`                  | yes  | —                   | FK → `leave_balance_ledger(id)` `ON DELETE RESTRICT` — a reversal points at what it reverses |
| `reason`           | `text`                  | yes  | —                   | Mandatory (API-enforced) for `ADJUSTMENT`                                                    |
| `actor_user_id`    | `uuid`                  | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for scheduler accruals.                       |
| `audit_event_id`   | `uuid`                  | yes  | —                   | FK → `audit_event(id)` `ON DELETE SET NULL`                                                  |
| `created_at`       | `timestamptz`           | no   | `now()`             |                                                                                              |

```sql
CONSTRAINT ck_llg__delta_nonzero CHECK (delta_days <> 0),
CONSTRAINT ck_llg__half_days CHECK ((delta_days * 2) = trunc(delta_days * 2)),
CONSTRAINT ck_llg__consumption_sign CHECK (
  (kind IN ('CONSUMPTION','CARRY_FORWARD_OUT','LAPSE','ENCASHMENT') AND delta_days < 0)
  OR (kind IN ('OPENING','ACCRUAL','CARRY_FORWARD_IN','CONSUMPTION_REVERSAL') AND delta_days > 0)
  OR kind = 'ADJUSTMENT'),
CONSTRAINT ck_llg__request_link CHECK (
  (kind IN ('CONSUMPTION','CONSUMPTION_REVERSAL')) = (leave_request_id IS NOT NULL)),
CONSTRAINT ck_llg__adjustment_reason CHECK (kind <> 'ADJUSTMENT' OR (reason IS NOT NULL AND length(btrim(reason)) >= 10)),
CONSTRAINT ck_llg__reversal_source CHECK (kind <> 'CONSUMPTION_REVERSAL' OR source_ledger_id IS NOT NULL),
CONSTRAINT ck_llg__actor CHECK (kind <> 'ADJUSTMENT' OR actor_user_id IS NOT NULL)
```

```sql
CREATE UNIQUE INDEX ux_llg__one_consumption_per_request
  ON ess.leave_balance_ledger (leave_request_id, kind) WHERE leave_request_id IS NOT NULL;
```

`ADJUSTMENT` is the only kind a human can author freely, so it is the only kind that can
manufacture a balance out of nothing. It therefore requires a named actor, a ≥ 10-character
reason and the `leave:balance:adjust` permission **in the database**, not only in the API —
this is directive 2 applied to leave days: an entitlement that appears on a tile must be
traceable to an accrual rule, a carry-forward, or a signed, reasoned human act.
Indexes:

- `ix_llg__balance_fold (organization_id, employee_id, leave_period_id, leave_type_id, effective_on)` — the fold query
- `ix_llg__request (leave_request_id) WHERE leave_request_id IS NOT NULL`
- `ix_llg__period_type (leave_period_id, leave_type_id)`

`leave_balance` — the projection. Recomputed inside the same transaction as every
ledger insert by `fn_refresh_leave_balance(employee, type, period)`, and re-verified
nightly by the `leave-balance-verify` job (a mismatch raises a P1 alert and an
`audit_event`).

| Column             | Type           | Null | Default             | Notes                                                                                                                                                                                               |
| ------------------ | -------------- | ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`               | `uuid`         | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                  |
| `organization_id`  | `uuid`         | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                        |
| `employee_id`      | `uuid`         | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                                                             |
| `leave_type_id`    | `uuid`         | no   | —                   | FK → `leave_type(id)` `ON DELETE RESTRICT`                                                                                                                                                          |
| `leave_period_id`  | `uuid`         | no   | —                   | FK → `leave_period(id)` `ON DELETE RESTRICT`                                                                                                                                                        |
| `opening_days`     | `numeric(5,2)` | no   | `0`                 | Σ `OPENING`                                                                                                                                                                                         |
| `accrued_days`     | `numeric(5,2)` | no   | `0`                 | Σ `ACCRUAL`                                                                                                                                                                                         |
| `carried_in_days`  | `numeric(5,2)` | no   | `0`                 | Σ `CARRY_FORWARD_IN`                                                                                                                                                                                |
| `carried_out_days` | `numeric(5,2)` | no   | `0`                 | Σ −`CARRY_FORWARD_OUT`                                                                                                                                                                              |
| `used_days`        | `numeric(5,2)` | no   | `0`                 | Σ −(`CONSUMPTION` + `CONSUMPTION_REVERSAL`)                                                                                                                                                         |
| `pending_days`     | `numeric(5,2)` | no   | `0`                 | Σ `total_days` of the employee's `PENDING_APPROVAL` requests of this type in this period (a soft hold, **not** a ledger entry)                                                                      |
| `encashed_days`    | `numeric(5,2)` | no   | `0`                 | Σ −`ENCASHMENT`                                                                                                                                                                                     |
| `lapsed_days`      | `numeric(5,2)` | no   | `0`                 | Σ −`LAPSE`                                                                                                                                                                                          |
| `adjustment_days`  | `numeric(5,2)` | no   | `0`                 | Σ `ADJUSTMENT` (signed)                                                                                                                                                                             |
| `entitlement_days` | `numeric(5,2)` | no   | `0`                 | `leave_entitlement_rule.annual_entitlement_days` resolved for this employee/period — the **"/ total"** denominator on the tiles                                                                     |
| `available_days`   | `numeric(5,2)` | no   | _(generated)_       | `GENERATED ALWAYS AS (opening_days + accrued_days + carried_in_days + adjustment_days - used_days - encashed_days - lapsed_days - carried_out_days) STORED` — the **"left"** numerator on the tiles |
| `last_ledger_id`   | `uuid`         | yes  | —                   | FK → `leave_balance_ledger(id)` `ON DELETE SET NULL` — the fold watermark                                                                                                                           |
| `recomputed_at`    | `timestamptz`  | no   | `now()`             |                                                                                                                                                                                                     |

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

**Which number the tile renders, exactly.** The tile's numerator is
`available_days`; the tile's _spendable_ figure — used by the request form, the
`leave.sufficient_balance` guard and the Approvals card's "Balance after" — is
`available_days - pending_days`. These differ whenever a request is awaiting approval, so
the API returns **both** (`availableDays`, `pendingDays`, `spendableDays`) and the Leave
screen renders `available_days / entitlement_days` with the sub-label
`'<pending_days> day(s) awaiting approval'` when `pending_days > 0` and no sub-label when
it is zero. A UI that showed only `available_days` would let an employee submit a second
request they cannot fund; one that showed only the spendable figure would contradict the
ledger. Both come from persisted columns; neither is computed in the browser.

**`pending_days` is not a fold of the ledger.** A pending request writes no ledger row (it
is a soft hold), so `fn_refresh_leave_balance` recomputes the other columns from
`leave_balance_ledger` and recomputes `pending_days` separately as
`coalesce(SUM(balance_days) FILTER (WHERE status = 'PENDING_APPROVAL'), 0)` over
`leave_request` for the same (employee, type, period). The nightly
`leave-balance-verify` job checks both definitions; the previous draft described
`leave_balance` as "a materialised fold of the ledger" while carrying a column the ledger
cannot produce, which would have made the verifier fail on every row with a live request.

**Concurrency (this was unspecified and is a real over-draw).** Two requests submitted in
the same second both read the same `available_days`, both pass
`leave.sufficient_balance`, and both commit — the employee ends up with a negative
entitlement and no constraint catches it, because `available_days` is a _generated_ column
over the ledger and pending holds are not in the ledger. Every leave transition therefore
begins with

```sql
SELECT * FROM leave_balance
 WHERE employee_id = :me AND leave_type_id = :t AND leave_period_id = :p
 FOR UPDATE;
```

and the ledger insert, the `pending_days` update and the `leave_request` status change are
one transaction under that lock. `ck_leave_balance__no_overdraw`
`CHECK (available_days - pending_days >= 0)` is **not** added, because
`leave_type.allows_negative_balance` legitimately permits a negative balance for some
types; the invariant is enforced by the guard under the row lock and re-asserted by
`leave-balance-verify`.

### 8.5 `leave_request`

| Column                      | Type                       | Null | Default             | Notes                                                                                                                                                                                                                           |
| --------------------------- | -------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `uuid`                     | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                              |
| `organization_id`           | `uuid`                     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                    |
| `reference_no`              | `citext`                   | no   | —                   | `WDT-LV-2026-000481`. Unique per org; from `leave_reference_seq`.                                                                                                                                                               |
| `employee_id`               | `uuid`                     | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                                                                                                                                        |
| `leave_type_id`             | `uuid`                     | no   | —                   | FK → `leave_type(id)` `ON DELETE RESTRICT`                                                                                                                                                                                      |
| `leave_period_id`           | `uuid`                     | no   | —                   | FK → `leave_period(id)` `ON DELETE RESTRICT`                                                                                                                                                                                    |
| `start_date`                | `date`                     | no   | —                   |                                                                                                                                                                                                                                 |
| `end_date`                  | `date`                     | no   | —                   |                                                                                                                                                                                                                                 |
| `start_portion`             | `ess_leave_day_portion`    | no   | `'FULL'`            |                                                                                                                                                                                                                                 |
| `end_portion`               | `ess_leave_day_portion`    | no   | `'FULL'`            |                                                                                                                                                                                                                                 |
| `total_days`                | `numeric(5,2)`             | no   | —                   | **Server-computed** as `SUM(day_fraction) FILTER (WHERE is_working_day)` over `leave_request_day`; never client-supplied. This is the number the UI renders ("5 days") and the number the attendance fold consumes.             |
| `balance_days`              | `numeric(5,2)`             | no   | —                   | **Server-computed** as `SUM(day_fraction) FILTER (WHERE counts_toward_balance)`. This is the number the ledger moves and the guard tests. For a paid leave type it equals `total_days`; for an **unpaid** type (LOP) it is `0`. |
| `reason`                    | `text`                     | yes  | —                   | The prototype's optional "Reason" textarea; ≤ 2000 chars                                                                                                                                                                        |
| `status`                    | `ess_leave_request_status` | no   | `'DRAFT'`           |                                                                                                                                                                                                                                 |
| `submitted_at`              | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                                 |
| `decided_at`                | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                                 |
| `decided_by_employee_id`    | `uuid`                     | yes  | —                   | FK → `employee(id)` `ON DELETE SET NULL` — the approving manager                                                                                                                                                                |
| `decision_note`             | `text`                     | yes  | —                   | Rejection reason; shown on the request row                                                                                                                                                                                      |
| `withdrawn_at`              | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                                 |
| `approver_employee_id`      | `uuid`                     | yes  | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — snapshot of the primary manager at submit time, so a later re-org cannot orphan the request                                                                                          |
| `attachment_file_object_id` | `uuid`                     | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL` — medical certificate                                                                                                                                                               |
| `balance_after_days`        | `numeric(5,2)`             | yes  | —                   | Snapshot at submit; renders the Approvals card's "Balance after: 9.5 days"                                                                                                                                                      |
| `attendance_record_id`      | `uuid`                     | yes  | —                   | FK → `attendance_record(id)` `ON DELETE SET NULL` — set once the approved leave has been folded into an attendance period                                                                                                       |
| `row_version`               | `integer`                  | no   | `1`                 |                                                                                                                                                                                                                                 |

```sql
CONSTRAINT ux_leave_request__org_reference UNIQUE (organization_id, reference_no),
CONSTRAINT ck_leave_request__range CHECK (end_date >= start_date),
CONSTRAINT ck_leave_request__days CHECK (total_days > 0 AND (total_days * 2) = trunc(total_days * 2)),
CONSTRAINT ck_leave_request__balance_days CHECK (
  balance_days >= 0 AND balance_days <= total_days AND (balance_days * 2) = trunc(balance_days * 2)),
CONSTRAINT ck_leave_request__submitted CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
CONSTRAINT ck_leave_request__decided CHECK (
  (status IN ('APPROVED','REJECTED')) = (decided_at IS NOT NULL AND decided_by_employee_id IS NOT NULL)),
CONSTRAINT ck_leave_request__rejection_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL),
CONSTRAINT ck_leave_request__withdrawn CHECK ((status = 'WITHDRAWN') = (withdrawn_at IS NOT NULL)),
CONSTRAINT ck_leave_request__half_day_single CHECK (
  (start_date = end_date AND (start_portion = end_portion OR end_portion = 'FULL'))
  OR (start_date < end_date AND start_portion IN ('FULL','SECOND_HALF')
                           AND end_portion   IN ('FULL','FIRST_HALF')))
```

> **Corrected.** The previous predicate was
> `(a AND b) OR c OR (NOT a OR NOT b)`, whose last disjunct is the negation of the first:
> it is a tautology and constrained nothing at all. The replacement states the real rule:
> a single-day request may be a half day; a multi-day request may only be half on its
> _outer_ edges — it starts at the second half of the first day and/or ends at the first
> half of the last day. Any other portion combination on a span is meaningless and is now
> rejected.
> Indexes:

- `ix_leave_request__employee_period (employee_id, leave_period_id, start_date DESC)` — "My requests"
- `ix_leave_request__approver_pending (approver_employee_id, submitted_at DESC) WHERE status = 'PENDING_APPROVAL'` — the Approvals queue
- `ix_leave_request__org_dates (organization_id, start_date, end_date)` — team-calendar and "Team today"
- `ix_leave_request__type_period (leave_type_id, leave_period_id) WHERE status = 'APPROVED'`
- `ex_leave_request__no_self_overlap EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&) WHERE (status IN ('PENDING_APPROVAL','APPROVED'))` — an employee cannot double-book a day.
  This is a table **constraint**, not an index, and it needs `btree_gist` for the `uuid`
  equality operator (§1.1). It deliberately also forbids two complementary half-days on
  the same date (first-half casual + second-half sick). That is a real restriction and it
  is accepted for v1: the alternative — an exclusion over `(employee_id, leave_date,
portion)` on `leave_request_day` — is the correct long-term model and is recorded as the
  v2 change. The submit path returns `409 {"code":"LEAVE_DATES_OVERLAP"}` naming the
  conflicting `reference_no`, so the restriction is never silent.

`leave_request_day` — one row per calendar day the request touches. This is what makes
"Team today · On leave", the LOP day count and the attendance fold exact.

| Column                  | Type                    | Null | Default             | Notes                                                                                         |
| ----------------------- | ----------------------- | ---- | ------------------- | --------------------------------------------------------------------------------------------- |
| `id`                    | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                            |
| `organization_id`       | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                  |
| `leave_request_id`      | `uuid`                  | no   | —                   | FK → `leave_request(id)` `ON DELETE CASCADE`                                                  |
| `employee_id`           | `uuid`                  | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE` — denormalised for the "today" index                  |
| `leave_date`            | `date`                  | no   | —                   |                                                                                               |
| `portion`               | `ess_leave_day_portion` | no   | `'FULL'`            |                                                                                               |
| `day_fraction`          | `numeric(3,2)`          | no   | —                   | `1.00` or `0.50`                                                                              |
| `is_working_day`        | `boolean`               | no   | —                   | `false` for a weekend/holiday inside the span; such rows exist for display but contribute `0` |
| `counts_toward_balance` | `boolean`               | no   | —                   | `is_working_day AND leave_type.is_paid`                                                       |

```sql
CONSTRAINT ux_leave_request_day__request_date UNIQUE (leave_request_id, leave_date),
CONSTRAINT ck_lrd__fraction CHECK (day_fraction IN (0.00, 0.50, 1.00)),
CONSTRAINT ck_lrd__nonworking_zero CHECK (is_working_day OR day_fraction = 0.00)
```

Indexes:

- `ix_lrd__employee_date (employee_id, leave_date)` — "who is on leave today"
- `ix_lrd__date (organization_id, leave_date) WHERE counts_toward_balance`

`leave_request.total_days` and `.balance_days` are maintained by trigger
`trg_leave_request_day_totals` (`AFTER INSERT OR UPDATE OR DELETE ON leave_request_day`)
as `SUM(day_fraction) FILTER (WHERE is_working_day)` and
`SUM(day_fraction) FILTER (WHERE counts_toward_balance)` respectively; the trigger raises
if an application tries to set either directly.

> **Corrected — the single-column model made unpaid leave impossible.** The previous
> draft defined `total_days` as the `counts_toward_balance` sum only, while
> `counts_toward_balance = is_working_day AND leave_type.is_paid`. For the seeded `LOP`
> type (`is_paid = false`) every day row has `counts_toward_balance = false`, so
> `total_days` folds to `0` and
> `ck_leave_request__days CHECK (total_days > 0)` rejects the insert: **no loss-of-pay
> leave request could ever be created**, which in turn means `attendance_record.lop_days`
> could never be sourced from approved unpaid leave, which is the only way LOP legitimately
> reaches payroll. Splitting the two figures fixes the whole chain: the UI and the
> attendance fold read `total_days`, the ledger and the balance guard read `balance_days`.

`leave_request_day` rows are generated **server-side only**, by expanding
`[start_date, end_date]` and resolving each day against `working_days()`'s two predicates
(§7.3). `is_working_day` and `counts_toward_balance` are never client-supplied, and the
expansion is re-run on approval so that a holiday calendar edited between submission and
approval cannot leave a stale day set behind.

### 8.6 Leave request state machine (`machine = 'leave_request'`)

| from               | to                 | permission                    | guard                                                                                                                      | notification                  | email            |
| ------------------ | ------------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------- |
| `NULL`             | `DRAFT`            | `leave:request:create:self`   | `leave.self_only`                                                                                                          | —                             | —                |
| `DRAFT`            | `PENDING_APPROVAL` | `leave:request:create:self`   | `leave.sufficient_balance`, `leave.no_overlap`, `leave.min_notice`, `leave.attachment_if_required`, `leave.manager_exists` | `LEAVE_SUBMITTED` (→ manager) | —                |
| `NULL`             | `PENDING_APPROVAL` | `leave:request:create:self`   | same as above                                                                                                              | `LEAVE_SUBMITTED`             | —                |
| `PENDING_APPROVAL` | `APPROVED`         | `leave:request:approve:team`  | `approval.actor_is_assigned_approver`, `leave.period_open`                                                                 | `LEAVE_DECIDED` (→ employee)  | `LEAVE_DECISION` |
| `PENDING_APPROVAL` | `REJECTED`         | `leave:request:approve:team`  | `approval.actor_is_assigned_approver`, `approval.note_required`                                                            | `LEAVE_DECIDED`               | `LEAVE_DECISION` |
| `PENDING_APPROVAL` | `WITHDRAWN`        | `leave:request:withdraw:self` | `leave.self_only`                                                                                                          | `LEAVE_DECIDED` (→ manager)   | —                |
| `APPROVED`         | `CANCELLED`        | `leave:request:approve:any`   | `leave.not_yet_locked_by_attendance`                                                                                       | `LEAVE_DECIDED`               | `LEAVE_DECISION` |
| `APPROVED`         | `WITHDRAWN`        | `leave:request:withdraw:self` | `leave.starts_in_future`, `leave.not_yet_locked_by_attendance`                                                             | `LEAVE_DECIDED`               | —                |
| `DRAFT`            | `CANCELLED`        | `leave:request:withdraw:self` | `leave.self_only`                                                                                                          | —                             | —                |

Terminal: `REJECTED`, `WITHDRAWN`, `CANCELLED`. `APPROVED` becomes effectively terminal
once `attendance_record_id` is set (guard `leave.not_yet_locked_by_attendance` fails).

Ledger effects, all inside the transition transaction, under the `leave_balance … FOR UPDATE`
lock of §8.4, and all in `balance_days` (**not** `total_days` — an unpaid day consumes no
entitlement):

- → `PENDING_APPROVAL`: `leave_balance.pending_days += balance_days`; create an
  `approval_task` (§19). Skipped entirely when `balance_days = 0`.
- → `APPROVED`: one `CONSUMPTION` ledger row of `-balance_days` (omitted when
  `balance_days = 0`); `pending_days -= balance_days`. For a type with
  `affects_payroll_lop`, the approved `total_days` are additionally folded into the open
  `attendance_record.unpaid_leave_days` for each covered period (§9.2).
- → `REJECTED` / `WITHDRAWN` from `PENDING_APPROVAL`: `pending_days -= balance_days`; no ledger row.
- → `CANCELLED`/`WITHDRAWN` from `APPROVED`: one `CONSUMPTION_REVERSAL` row of
  `+balance_days` with `source_ledger_id` pointing at the original consumption, and the
  attendance fold reversed.
- Every one of these writes an `audit_event` with `action = 'STATE_TRANSITION'` and the
  ledger row's id in `metadata`, and stamps `leave_balance_ledger.audit_event_id`, so a
  balance movement and the act that caused it are joined in both directions.

**Approver resolution is snapshotted, not re-derived.** `approver_employee_id` is set at
submit from the current `PRIMARY` `employee_manager` row; the guard
`approval.actor_is_assigned_approver` compares against `approval_task.assignee_employee_id`,
which is set from the same value. A re-org after submission therefore does not silently
move a pending request to a new manager: the original approver stays accountable, and HR
moves it explicitly with `PENDING→REASSIGNED` (§19.2), which is audited and notified. An
employee with no manager resolves to the HR business partner
(`employee_employment.hr_business_partner_employee_id`); if that is also absent the submit
is refused with `422 {"code":"NO_APPROVER"}` — a request is never created with nobody able
to decide it.

---

## 9. Attendance

Attendance is step 2 and 3 of the mandated payroll workflow: **HR submits, the
respective Manager approves.** Nothing here may be written by Accounts.

### 9.1 `attendance_period`

One row per organisation per calendar month. Created together with the
`payroll_cycle` for the same month (1:1), so the two state machines stay in lock-step.

> **Creation order (this was circular).** `payroll_cycle.attendance_period_id` is
> `NOT NULL`, and the `attendance_period` machine's `NULL→OPEN` transition is guarded by
> `attendance.cycle_exists`. As written, neither row could be inserted first. The
> resolution is explicit: `POST /payroll/cycles` creates **the `attendance_period` first**
> in the same transaction, then the `payroll_cycle` referencing it; the guard
> `attendance.cycle_exists` is replaced by `attendance.created_with_cycle`, which asserts
> that the enclosing transaction is the cycle-creation command (the service passes the
> intent explicitly — it is not inferred). The FK is additionally declared
> `DEFERRABLE INITIALLY IMMEDIATE` so a future bulk backfill can defer it without a
> schema change. `attendance_period` rows are never created by any other route or job.

| Column                    | Type                           | Null | Default             | Notes                                                                             |
| ------------------------- | ------------------------------ | ---- | ------------------- | --------------------------------------------------------------------------------- |
| `id`                      | `uuid`                         | no   | `gen_random_uuid()` | PK                                                                                |
| `organization_id`         | `uuid`                         | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                      |
| `period_code`             | `text`                         | no   | —                   | `2026-08`                                                                         |
| `label`                   | `text`                         | no   | —                   | `August 2026` — the payslip month label, persisted once                           |
| `start_date`              | `date`                         | no   | —                   | `2026-08-01`                                                                      |
| `end_date`                | `date`                         | no   | —                   | `2026-08-31`                                                                      |
| `total_calendar_days`     | `smallint`                     | no   | —                   | `31` — the denominator of the payslip's "Days paid 31 / 31"                       |
| `status`                  | `ess_attendance_period_status` | no   | `'OPEN'`            |                                                                                   |
| `capture_opened_at`       | `timestamptz`                  | yes  | —                   |                                                                                   |
| `hr_submitted_at`         | `timestamptz`                  | yes  | —                   |                                                                                   |
| `hr_submitted_by_user_id` | `uuid`                         | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                          |
| `approvals_completed_at`  | `timestamptz`                  | yes  | —                   | Set when the last `attendance_approval` reaches `APPROVED`                        |
| `locked_at`               | `timestamptz`                  | yes  | —                   | Set when the payroll cycle leaves `ATTENDANCE_APPROVED`; blocks all further edits |
| `reopened_at`             | `timestamptz`                  | yes  | —                   |                                                                                   |
| `reopened_by_user_id`     | `uuid`                         | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                          |
| `reopen_reason`           | `text`                         | yes  | —                   | Mandatory when reopening                                                          |
| `row_version`             | `integer`                      | no   | `1`                 |                                                                                   |

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

| Column                       | Type                           | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------ | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `uuid`                         | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `organization_id`            | `uuid`                         | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                               |
| `attendance_period_id`       | `uuid`                         | no   | —                   | FK → `attendance_period(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                          |
| `employee_id`                | `uuid`                         | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `manager_employee_id`        | `uuid`                         | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — snapshot of the primary manager on `attendance_period.end_date`; determines which manager must approve                                                                                                                                                                                                                                                                                                          |
| `department_id`              | `uuid`                         | no   | —                   | FK → `department(id)` `ON DELETE RESTRICT` — snapshot, for reporting slices                                                                                                                                                                                                                                                                                                                                                                                |
| `attendance_approval_id`     | `uuid`                         | yes  | —                   | FK → `attendance_approval(id)` `ON DELETE SET NULL` — the team slice this record belongs to                                                                                                                                                                                                                                                                                                                                                                |
| `status`                     | `ess_attendance_record_status` | no   | `'DRAFT'`           |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `source`                     | `ess_attendance_source`        | no   | `'HR_MANUAL'`       |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `source_file_object_id`      | `uuid`                         | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL` — the HR bulk upload that produced this row                                                                                                                                                                                                                                                                                                                                                                    |
| `calendar_days`              | `smallint`                     | no   | —                   | Copy of `attendance_period.total_calendar_days`                                                                                                                                                                                                                                                                                                                                                                                                            |
| `eligible_days`              | `numeric(5,2)`                 | no   | —                   | Days the employee was on the payroll in this period (joins/exits prorate)                                                                                                                                                                                                                                                                                                                                                                                  |
| `present_days`               | `numeric(5,2)`                 | no   | `0`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `paid_leave_days`            | `numeric(5,2)`                 | no   | `0`                 | Approved paid leave falling in the period                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `holiday_days`               | `numeric(5,2)`                 | no   | `0`                 | `PUBLIC` holidays in the period on the employee's calendar                                                                                                                                                                                                                                                                                                                                                                                                 |
| `week_off_days`              | `numeric(5,2)`                 | no   | `0`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `absent_days`                | `numeric(5,2)`                 | no   | `0`                 | Unapproved absence                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `unpaid_leave_days`          | `numeric(5,2)`                 | no   | `0`                 | **Added.** Approved leave of a type with `is_paid = false` (the seeded `LOP` type) falling in the period. Without this column the day-identity constraint below cannot hold for any employee who took approved unpaid leave: such a day is not `present`, not `paid_leave`, not `holiday`, not `week_off`, and not `absent` (which the schema defines as _unapproved_), so the five buckets could not sum to `eligible_days` and the record was unsavable. |
| `lop_days`                   | `numeric(5,2)`                 | no   | _(maintained)_      | Loss-of-pay days = `absent_days + unpaid_leave_days`, unless `lop_source <> 'DERIVED'`. Maintained by `trg_attendance_record_lop`; never set directly by a client.                                                                                                                                                                                                                                                                                         |
| `lop_source`                 | `ess_attendance_lop_source`    | no   | `'DERIVED'`         | `DERIVED` \| `HR_OVERRIDE` \| `PAYROLL_INPUT_OVERRIDE` — **which act produced the number the manager approved**                                                                                                                                                                                                                                                                                                                                            |
| `lop_override_days`          | `numeric(5,2)`                 | yes  | —                   | The overriding value; NULL when `lop_source = 'DERIVED'`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lop_override_reason`        | `text`                         | yes  | —                   | Mandatory (≥ 10 chars) when overridden                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lop_override_input_item_id` | `uuid`                         | yes  | —                   | FK → `payroll_input_item(id)` `ON DELETE RESTRICT` — the exact uploaded row, when `lop_source = 'PAYROLL_INPUT_OVERRIDE'`                                                                                                                                                                                                                                                                                                                                  |
| `lop_override_by_user_id`    | `uuid`                         | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lop_override_at`            | `timestamptz`                  | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `payable_days`               | `numeric(5,2)`                 | no   | _(generated)_       | `GENERATED ALWAYS AS (eligible_days - lop_days) STORED` — the numerator of "Days paid 31 / 31" and the prorating basis for `PRORATED_FIXED` components                                                                                                                                                                                                                                                                                                     |
| `overtime_hours`             | `numeric(6,2)`                 | no   | `0`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `hr_note`                    | `text`                         | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `manager_note`               | `text`                         | yes  | —                   | Set when a manager rejects the slice                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `computed_at`                | `timestamptz`                  | yes  | —                   | When the system-derived figures were last recalculated                                                                                                                                                                                                                                                                                                                                                                                                     |
| `locked_at`                  | `timestamptz`                  | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `row_version`                | `integer`                      | no   | `1`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

```sql
CONSTRAINT ux_attendance_record__period_employee UNIQUE (attendance_period_id, employee_id),
CONSTRAINT ck_ar__nonneg CHECK (
  eligible_days >= 0 AND present_days >= 0 AND paid_leave_days >= 0 AND holiday_days >= 0
  AND week_off_days >= 0 AND absent_days >= 0 AND unpaid_leave_days >= 0
  AND lop_days >= 0 AND overtime_hours >= 0),
CONSTRAINT ck_ar__eligible_bound CHECK (eligible_days <= calendar_days),
CONSTRAINT ck_ar__lop_bound CHECK (lop_days <= eligible_days),
CONSTRAINT ck_ar__day_identity CHECK (
  present_days + paid_leave_days + holiday_days + week_off_days
    + absent_days + unpaid_leave_days = eligible_days),
CONSTRAINT ck_ar__half_days CHECK (
  (present_days*2)=trunc(present_days*2) AND (paid_leave_days*2)=trunc(paid_leave_days*2)
  AND (absent_days*2)=trunc(absent_days*2) AND (unpaid_leave_days*2)=trunc(unpaid_leave_days*2)
  AND (lop_days*2)=trunc(lop_days*2) AND (eligible_days*2)=trunc(eligible_days*2)),
CONSTRAINT ck_ar__lop_override CHECK (
  (lop_source = 'DERIVED' AND num_nulls(lop_override_days, lop_override_reason,
                                        lop_override_by_user_id, lop_override_at) = 4)
  OR (lop_source <> 'DERIVED' AND lop_override_days IS NOT NULL
      AND length(btrim(lop_override_reason)) >= 10
      AND lop_override_by_user_id IS NOT NULL AND lop_override_at IS NOT NULL)),
CONSTRAINT ck_ar__lop_input_link CHECK (
  (lop_source = 'PAYROLL_INPUT_OVERRIDE') = (lop_override_input_item_id IS NOT NULL)),
CONSTRAINT ck_ar__lop_value CHECK (
  lop_days = CASE WHEN lop_source = 'DERIVED' THEN absent_days + unpaid_leave_days
                  ELSE lop_override_days END)
```

> **Why the LOP override had to move (this was a workflow short-circuit).** The previous
> draft said `lop_days` is "`absent_days` + approved unpaid leave, unless overridden by a
> committed `LOP_OVERRIDE` payroll input", and left the moment of application unstated.
> If the override is applied at _calculation_ time, Accounts silently changes
> `payable_days` — the prorating basis for every `PRORATED_FIXED` component — **after** the
> manager approved the attendance, which defeats directive 6 (the manager must approve the
> attendance that payroll uses) and the separation of duties that keeps the payroll
> operator away from attendance inputs. The corrected rule:
>
> 1. A `LOP_OVERRIDE` input item may only be committed while the cycle is `INPUTS_OPEN`,
>    i.e. **before** `INPUTS_LOCKED` and therefore before HR may submit attendance
>    (guard `attendance.payroll_inputs_locked`).
> 2. At the `INPUTS_OPEN → INPUTS_LOCKED` transition the system **materialises** every
>    committed `LOP_OVERRIDE` into the matching `attendance_record`, setting
>    `lop_source = 'PAYROLL_INPUT_OVERRIDE'`, `lop_override_days`,
>    `lop_override_input_item_id` and the reason from `payroll_input_item.narration`.
>    The manager therefore reviews and approves the _final_ number.
> 3. After `HR_SUBMITTED`, `lop_days`, `lop_source` and every day bucket are immutable
>    until the period is reopened (`trg_attendance_record_locked`), and the calculation
>    engine reads **only** `attendance_record.payable_days`. It never re-applies an input.
>    Guard `payroll.no_lop_override_after_lock` and validation rule
>    `PAY_LOP_OVERRIDE_LATE` both assert this; a late override is an `ERROR` finding that
>    forces the cycle back through attendance, not a silent adjustment.
>    Indexes:

- `ux_attendance_record__period_employee (attendance_period_id, employee_id)`
- `ix_attendance_record__manager_slice (attendance_period_id, manager_employee_id, status)` — the Manager approval queue
- `ix_attendance_record__approval (attendance_approval_id)`
- `ix_attendance_record__employee_period (employee_id, attendance_period_id)` — payslip generation lookup
- `ix_attendance_record__pending (organization_id, status) WHERE status IN ('DRAFT','SUBMITTED')`

> `ck_ar__day_identity` is the integrity spine: the six day buckets must exactly partition
> the eligible days. HR cannot submit a record where they do not.

**`eligible_days` — the exact definition** (previously only "days the employee was on the
payroll in this period (joins/exits prorate)", which an implementer could not build):

```
eligible_days = count of dates d in [attendance_period.start_date, attendance_period.end_date]
                such that  d >= employee.date_of_joining
                      and (employee.date_of_exit IS NULL or d <= employee.date_of_exit)
                      and  employee has an employee_employment row effective on d
```

It counts **calendar** days, not working days, because `week_off_days` and `holiday_days`
are separate buckets that must sum back into it. A mid-month joiner on the 15th of a
31-day month has `eligible_days = 17`; `payable_days = eligible_days - lop_days` therefore
prorates correctly and `payslip.total_days` still renders the month's
`total_calendar_days` as the denominator ("17 / 31"). `computed_at` records when this was
last derived; the HR capture screen recomputes it on open and refuses to submit a record
whose `computed_at` predates the last change to the employee's joining/exit dates or
employment rows.

**`manager_employee_id` when there is no manager.** The column is `NOT NULL`, but an
organisation always has at least one employee at the top of the chain (the prototype's
CTO reports to "Board"). Resolution order at period creation, applied in this order and
recorded in `attendance_record.manager_source`
(`PRIMARY_MANAGER` | `HR_BUSINESS_PARTNER` | `HR_POOL`): the current `PRIMARY`
`employee_manager` on `attendance_period.end_date`; else
`employee_employment.hr_business_partner_employee_id`; else the organisation's designated
HR-pool employee from `org_setting.attendance_fallback_employee_id`. The third case
produces an `attendance_approval` slice owned by HR, which is the only circumstance in
which HR approves attendance without an escalation — and it is recorded as such, so it is
reportable rather than invisible.

### 9.3 `attendance_submission` — the HR act

| Column                        | Type            | Null | Default             | Notes                                                                                                   |
| ----------------------------- | --------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                          | `uuid`          | no   | `gen_random_uuid()` | PK                                                                                                      |
| `organization_id`             | `uuid`          | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                            |
| `attendance_period_id`        | `uuid`          | no   | —                   | FK → `attendance_period(id)` `ON DELETE RESTRICT`                                                       |
| `submitted_by_user_id`        | `uuid`          | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                |
| `submitted_at`                | `timestamptz`   | no   | `now()`             |                                                                                                         |
| `record_count`                | `integer`       | no   | —                   | Rows moved `DRAFT → SUBMITTED`                                                                          |
| `employee_count_expected`     | `integer`       | no   | —                   | Active employees on `end_date`; a mismatch is an ERROR validation                                       |
| `total_payable_days`          | `numeric(12,2)` | no   | —                   | Control total, recomputed on approval; a drift raises `ATT_TOTALS_DRIFT`                                |
| `total_lop_days`              | `numeric(12,2)` | no   | —                   | Control total                                                                                           |
| `source_file_object_id`       | `uuid`          | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                                                             |
| `payload_sha256`              | `bytea`         | no   | —                   | SHA-256 over the canonical JSON of every submitted record — the traceability anchor                     |
| `note`                        | `text`          | yes  | —                   |                                                                                                         |
| `superseded_by_submission_id` | `uuid`          | yes  | —                   | FK → `attendance_submission(id)` `ON DELETE SET NULL` — set when the period is reopened and resubmitted |

```sql
CONSTRAINT ck_attsub__counts CHECK (record_count >= 0 AND employee_count_expected >= 0),
CONSTRAINT ck_attsub__sha_len CHECK (octet_length(payload_sha256) = 32)
```

```sql
CREATE UNIQUE INDEX ux_attsub__period_live ON ess.attendance_submission (attendance_period_id)
  WHERE superseded_by_submission_id IS NULL;   -- §1.2
```

**`payload_sha256` — the canonical serialisation (this must be pinned or the hash proves
nothing).** It is `SHA-256` over the UTF-8 of a JSON array, ordered by
`employee.employee_number` ascending, each element an object whose keys appear in exactly
this order with no whitespace:
`{"employeeNumber","eligibleDays","presentDays","paidLeaveDays","holidayDays","weekOffDays","absentDays","unpaidLeaveDays","lopDays","lopSource","payableDays","overtimeHours"}`,
every numeric value rendered as a fixed two-decimal string (`"17.50"`). The same
serialiser is used to re-verify at approval and at `VALIDATING`; a drift raises
`ATT_TOTALS_DRIFT` as an `ERROR`. Any other ordering or number formatting produces a
different digest and would make the traceability anchor useless.
Immutable after insert except `superseded_by_submission_id` (trigger
`trg_immutable_attendance_submission`).

### 9.4 `attendance_approval` — the Manager act, per team slice

One row per (period × manager). It is the unit the Manager sees and decides; the
records it covers are found through `attendance_record.attendance_approval_id`.

| Column                     | Type                             | Null | Default             | Notes                                                                                           |
| -------------------------- | -------------------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`                           | no   | `gen_random_uuid()` | PK                                                                                              |
| `organization_id`          | `uuid`                           | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                    |
| `attendance_period_id`     | `uuid`                           | no   | —                   | FK → `attendance_period(id)` `ON DELETE RESTRICT`                                               |
| `attendance_submission_id` | `uuid`                           | no   | —                   | FK → `attendance_submission(id)` `ON DELETE RESTRICT`                                           |
| `manager_employee_id`      | `uuid`                           | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                        |
| `status`                   | `ess_attendance_approval_status` | no   | `'PENDING'`         |                                                                                                 |
| `record_count`             | `integer`                        | no   | —                   | Records in this slice                                                                           |
| `total_payable_days`       | `numeric(12,2)`                  | no   | —                   | Slice control total at submission                                                               |
| `total_lop_days`           | `numeric(12,2)`                  | no   | —                   |                                                                                                 |
| `assigned_at`              | `timestamptz`                    | no   | `now()`             |                                                                                                 |
| `due_at`                   | `timestamptz`                    | yes  | —                   | `assigned_at + org SLA`; drives escalation                                                      |
| `decided_at`               | `timestamptz`                    | yes  | —                   |                                                                                                 |
| `decided_by_user_id`       | `uuid`                           | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                        |
| `decision_note`            | `text`                           | yes  | —                   | Mandatory on `REJECTED`                                                                         |
| `escalated_at`             | `timestamptz`                    | yes  | —                   |                                                                                                 |
| `escalated_to_user_id`     | `uuid`                           | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL` — the HR user who acted under `attendance:approve:any` |
| `escalation_reason`        | `text`                           | yes  | —                   | Mandatory when escalated                                                                        |
| `approval_task_id`         | `uuid`                           | yes  | —                   | FK → `approval_task(id)` `ON DELETE SET NULL`                                                   |
| `row_version`              | `integer`                        | no   | `1`                 |                                                                                                 |

```sql
CONSTRAINT ux_attendance_approval__period_manager UNIQUE (attendance_period_id, manager_employee_id),
CONSTRAINT ck_attappr__decided CHECK (
  (status IN ('APPROVED','REJECTED','AUTO_ESCALATED')) = (decided_at IS NOT NULL AND decided_by_user_id IS NOT NULL)),
CONSTRAINT ck_attappr__reject_note CHECK (status <> 'REJECTED' OR decision_note IS NOT NULL),
CONSTRAINT ck_attappr__escalation CHECK (
  num_nulls(escalated_at, escalated_to_user_id, escalation_reason) IN (0, 3)),
CONSTRAINT ck_attappr__escalated_status CHECK (
  (status = 'AUTO_ESCALATED') = (escalated_at IS NOT NULL)),
CONSTRAINT ck_attappr__escalation_note CHECK (
  escalation_reason IS NULL OR length(btrim(escalation_reason)) >= 10),
CONSTRAINT ck_attappr__distinct_from_submitter CHECK (true)  -- see the trigger below
```

> **Corrected.** The previous `ck_attappr__escalated_status` read
> `((escalated_at IS NOT NULL) = (status = 'AUTO_ESCALATED') OR escalated_at IS NULL)`.
> When `escalated_at IS NULL` the second disjunct is true and the whole check passes
> regardless of status, so `status = 'AUTO_ESCALATED'` with no escalation timestamp,
> no escalating user and no reason was perfectly legal — an escalation that leaves no
> trace of who escalated or why. The biconditional above is what was meant.

**HR escalation must not be HR marking its own homework.** HR holds both
`attendance:submit` and `attendance:approve:any`. Nothing in the previous draft stopped
the same HR user who submitted the period from escalating every overdue slice and
approving the whole month's attendance alone — which collapses directive 6's "the
respective Manager reviews/approves" into a single actor. Trigger
`trg_attendance_approval_escalation_sod` (`BEFORE UPDATE`) therefore raises when
`status = 'AUTO_ESCALATED'` and
`escalated_to_user_id = (SELECT submitted_by_user_id FROM attendance_submission WHERE id = NEW.attendance_submission_id)`.
Guard `attendance.escalation_actor_not_submitter` states the same rule at the service
layer, and the guard `attendance.approval_overdue` is evaluated as
`due_at IS NOT NULL AND due_at < now()` — a NULL `due_at` fails closed, so a slice with no
SLA can never be escalated at all. Every escalation additionally notifies the bypassed
manager and every ACCOUNTS user, so an escalated month is visible to the people who rely
on it rather than only to the person who performed it.
Indexes:

- `ix_attendance_approval__manager_pending (manager_employee_id, status) WHERE status = 'PENDING'`
- `ix_attendance_approval__period_status (attendance_period_id, status)`
- `ix_attendance_approval__overdue (due_at) WHERE status = 'PENDING'`

### 9.5 Attendance state machines

`machine = 'attendance_period'`

| from                       | to                         | permission             | guard                                                                                                               | notification                                   |
| -------------------------- | -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `NULL`                     | `OPEN`                     | `payroll:cycle:create` | `attendance.cycle_exists`                                                                                           | —                                              |
| `OPEN`                     | `HR_SUBMITTED`             | `attendance:submit`    | `attendance.all_active_employees_have_records`, `attendance.day_identity_holds`, `attendance.payroll_inputs_locked` | —                                              |
| `HR_SUBMITTED`             | `MANAGER_APPROVAL_PENDING` | _(system)_             | `attendance.slices_created`                                                                                         | `ATTENDANCE_APPROVAL_PENDING` (→ each manager) |
| `MANAGER_APPROVAL_PENDING` | `APPROVED`                 | _(system)_             | `attendance.every_slice_approved`, `attendance.totals_unchanged_since_submission`                                   | `PAYROLL_CYCLE_STATE` (→ Accounts)             |
| `MANAGER_APPROVAL_PENDING` | `OPEN`                     | `attendance:reopen`    | `attendance.any_slice_rejected`                                                                                     | —                                              |
| `APPROVED`                 | `LOCKED`                   | _(system)_             | `attendance.cycle_left_attendance_approved`                                                                         | —                                              |
| `APPROVED`                 | `REOPENED`                 | `attendance:reopen`    | `attendance.cycle_not_calculated`, `approval.note_required`                                                         | `PAYROLL_CYCLE_STATE`                          |
| `LOCKED`                   | `REOPENED`                 | `attendance:reopen`    | `attendance.cycle_not_published`, `approval.note_required`                                                          | `PAYROLL_CYCLE_STATE`                          |
| `REOPENED`                 | `OPEN`                     | `attendance:reopen`    | —                                                                                                                   | —                                              |

`machine = 'attendance_record'`: `NULL→DRAFT` (`attendance:capture`) ·
`DRAFT→SUBMITTED` (`attendance:submit`) · `SUBMITTED→APPROVED` (`attendance:approve:team`,
guard `approval.actor_is_assigned_approver`) · `SUBMITTED→REJECTED`
(`attendance:approve:team`, guard `approval.note_required`) · `REJECTED→DRAFT`
(`attendance:capture`) · `APPROVED→LOCKED` (system) · `LOCKED→DRAFT`
(`attendance:reopen`, guard `attendance.cycle_not_published`).

`machine = 'attendance_approval'`: `NULL→PENDING` (system) ·
`PENDING→APPROVED` (`attendance:approve:team`, guard
`approval.actor_is_assigned_approver`) · `PENDING→REJECTED`
(`attendance:approve:team`, guards `approval.actor_is_assigned_approver`,
`approval.note_required`) · `PENDING→AUTO_ESCALATED` (`attendance:approve:any`, guards
`attendance.approval_overdue`, `attendance.escalation_actor_not_submitter`,
`approval.note_required` — HR may only escalate **after** `due_at` has passed, never
before, and the escalation is audited with a mandatory reason and notified to the bypassed
manager).

`AUTO_ESCALATED` is a **decided, approving** outcome; it is a separate value from
`APPROVED` only so that escalations are trivially reportable. The guard
`attendance.every_slice_approved` is therefore exactly:

```sql
NOT EXISTS (
  SELECT 1 FROM attendance_approval aa
  WHERE aa.attendance_period_id = :period
    AND (aa.status NOT IN ('APPROVED','AUTO_ESCALATED') OR aa.decided_at IS NULL))
```

A slice that HR escalates and then wishes to _reject_ is recorded as `REJECTED` with
`escalated_to_user_id` set and `escalated_at` left NULL.

`attendance.totals_unchanged_since_submission` re-runs the §9.3 serialiser over the
slice's records and compares against `attendance_approval.total_payable_days` /
`total_lop_days`; a mismatch means a record changed between submission and the last
approval, and the period cannot reach `APPROVED` — it returns to `OPEN` with an
`ATT_TOTALS_DRIFT` finding. This is what stops "the manager approved a different set of
numbers from the ones payroll used".

**Reopening is bounded by publication, always.** Every `REOPENED` path is guarded by
`attendance.cycle_not_published`. Once a `payroll_cycle` is `PUBLISHED` or `CLOSED` its
attendance is frozen permanently; a genuine error after publication is a
`payroll_correction` (§10.11), never an edit to an approved past month.

---

## 10. Payroll

> **The mandated order is enforced by `payroll_cycle.status` and nothing else.**
> Accounts uploads payroll data → HR submits attendance → the respective Manager
> approves attendance → the system validates required payroll inputs → payroll/payslips
> are generated automatically → the payslip becomes visible to the employee.
> A payslip row cannot exist before `CALCULATED`, and cannot be read by an employee
> before a live `payslip_publication` row exists (§10.8).

### 10.1 `payroll_cycle`

| Column                          | Type                       | Null | Default             | Notes                                                                                                                                                                                                               |
| ------------------------------- | -------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                            | `uuid`                     | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                  |
| `organization_id`               | `uuid`                     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                        |
| `period_code`                   | `text`                     | no   | —                   | `2026-08`. Unique per org **per `cycle_kind`**.                                                                                                                                                                     |
| `label`                         | `text`                     | no   | —                   | `August 2026` — the payslip's month label                                                                                                                                                                           |
| `cycle_kind`                    | `ess_payroll_cycle_kind`   | no   | `'REGULAR'`         | `REGULAR` \| `SUPPLEMENTARY` \| `OFF_CYCLE` \| `CORRECTION`. Required by WORKFLOWS.md A-2; without it the "off-cycle run producing a superseding payslip revision" that §10.2 already promises has nowhere to live. |
| `parent_payroll_cycle_id`       | `uuid`                     | yes  | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT`. Required for every kind except `REGULAR`.                                                                                                                            |
| `fiscal_year_id`                | `uuid`                     | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                                                                                                                                                                         |
| `attendance_period_id`          | `uuid`                     | no   | —                   | FK → `attendance_period(id)` `ON DELETE RESTRICT`. 1:1 **for `REGULAR` cycles only** (see the partial index below), so a supplementary run reuses the month's already-approved attendance without re-approving it.  |
| `no_inputs_attested_by_user_id` | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                            |
| `no_inputs_attested_at`         | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `no_inputs_attestation_note`    | `text`                     | yes  | —                   | ≥ 10 chars                                                                                                                                                                                                          |
| `employee_set_sha256`           | `bytea`                    | yes  | —                   | SHA-256 over the ordered `employee_id` list of `payroll_cycle_employee WHERE disposition='INCLUDED'`, frozen at `VALIDATED`                                                                                         |
| `period_start`                  | `date`                     | no   | —                   |                                                                                                                                                                                                                     |
| `period_end`                    | `date`                     | no   | —                   |                                                                                                                                                                                                                     |
| `scheduled_pay_date`            | `date`                     | no   | —                   | Derived from `organization.payroll_pay_day_rule` at creation; persisted                                                                                                                                             |
| `actual_pay_date`               | `date`                     | yes  | —                   | Set at publication; the payslip's "Credited 31 Aug 2026"                                                                                                                                                            |
| `status`                        | `ess_payroll_cycle_status` | no   | `'DRAFT'`           |                                                                                                                                                                                                                     |
| `inputs_locked_at`              | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `inputs_locked_by_user_id`      | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                            |
| `validated_at`                  | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `calculated_at`                 | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `calculated_by_user_id`         | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                            |
| `approved_at`                   | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `approved_by_user_id`           | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                            |
| `published_at`                  | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `published_by_user_id`          | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                            |
| `closed_at`                     | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `cancelled_at`                  | `timestamptz`              | yes  | —                   |                                                                                                                                                                                                                     |
| `cancel_reason`                 | `text`                     | yes  | —                   |                                                                                                                                                                                                                     |
| `employee_count`                | `integer`                  | no   | `0`                 | Employees in scope; set at `VALIDATED`                                                                                                                                                                              |
| `payslip_count`                 | `integer`                  | no   | `0`                 | Set at `CALCULATED`                                                                                                                                                                                                 |
| `control_gross_minor`           | `money_minor`              | yes  | —                   | Run control total, write-once at `CALCULATED`, re-verified at `PUBLISHED`. Not encrypted: an org-level aggregate, visible only to `payroll:cycle:read`.                                                             |
| `control_net_minor`             | `money_minor`              | yes  | —                   |                                                                                                                                                                                                                     |
| `control_deductions_minor`      | `money_minor`              | yes  | —                   |                                                                                                                                                                                                                     |
| `row_version`                   | `integer`                  | no   | `1`                 |                                                                                                                                                                                                                     |

```sql
CONSTRAINT ux_payroll_cycle__org_period_kind UNIQUE (organization_id, period_code, cycle_kind),
CONSTRAINT ck_payroll_cycle__range CHECK (period_end >= period_start),
CONSTRAINT ck_payroll_cycle__pay_date CHECK (scheduled_pay_date >= period_end),
CONSTRAINT ck_payroll_cycle__parent CHECK ((cycle_kind = 'REGULAR') = (parent_payroll_cycle_id IS NULL)),
CONSTRAINT ck_payroll_cycle__no_inputs_attestation CHECK (
  num_nulls(no_inputs_attested_by_user_id, no_inputs_attested_at, no_inputs_attestation_note) IN (0, 3)),
CONSTRAINT ck_payroll_cycle__employee_set_sha CHECK (
  employee_set_sha256 IS NULL OR octet_length(employee_set_sha256) = 32),
CONSTRAINT ck_payroll_cycle__distinct_approver CHECK (
  approved_by_user_id IS NULL OR calculated_by_user_id IS NULL
  OR approved_by_user_id <> calculated_by_user_id),
CONSTRAINT ck_payroll_cycle__distinct_publisher CHECK (
  published_by_user_id IS NULL OR calculated_by_user_id IS NULL
  OR published_by_user_id <> calculated_by_user_id),
CONSTRAINT ck_payroll_cycle__published CHECK (
  num_nulls(published_at, published_by_user_id, actual_pay_date) IN (0, 3)),
CONSTRAINT ck_payroll_cycle__cancel CHECK (num_nulls(cancelled_at, cancel_reason) IN (0, 2)),
CONSTRAINT ck_payroll_cycle__controls_nonneg CHECK (
  coalesce(control_gross_minor,0) >= 0 AND coalesce(control_net_minor,0) >= 0
  AND coalesce(control_deductions_minor,0) >= 0)
```

Indexes:

- `ux_payroll_cycle__org_period_kind (organization_id, period_code, cycle_kind)`
- `ix_payroll_cycle__org_status (organization_id, status, period_start DESC)`
- `ix_payroll_cycle__published (organization_id, published_at DESC) WHERE status IN ('PUBLISHED','CLOSED')`

```sql
CREATE UNIQUE INDEX ux_payroll_cycle__attendance_period
  ON ess.payroll_cycle (attendance_period_id) WHERE cycle_kind = 'REGULAR';   -- §1.2, WORKFLOWS R-1
```

`ck_payroll_cycle__distinct_approver` and `ck_payroll_cycle__distinct_publisher` together
are the **database-level dual-control guarantee**: the user who calculated payroll can be
neither the user who approved it nor the user who published it. The previous draft
constrained only the approver, which left the act that actually makes money visible to
employees — publication — performable by the same person who computed it.

**The no-inputs deadlock (this made a quiet month unpayable).** Transition #3
(`INPUTS_OPEN → INPUTS_LOCKED`) is guarded by
`payroll.at_least_one_committed_batch`. A month in which no employee has any variable pay,
arrear, incentive or reimbursement has **no** batch to commit, so the cycle could never
lock, attendance could never be submitted, and payroll could never run — the schema made
the ordinary case of a stable payroll month impossible. The corrected guard is
`payroll.inputs_settled`, which holds when _either_ at least one batch is `COMMITTED`
_or_ the three `no_inputs_attested_*` columns are set. Recording "there are no inputs this
month" is an explicit, permissioned (`payroll:input:commit`), reasoned, audited act by a
named Accounts user — not an absence the system infers. `payroll.at_least_one_committed_batch`
is retained as the first half of that disjunction.

### 10.2 Payroll cycle state machine (`machine = 'payroll_cycle'`)

| #   | from                                                      | to                     | permission                 | guards                                                                                                                                                                                                                                                            | notification                                    |
| --- | --------------------------------------------------------- | ---------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1   | `NULL`                                                    | `DRAFT`                | `payroll:cycle:create`     | `payroll.no_open_cycle_for_period`, `payroll.prior_cycle_closed`                                                                                                                                                                                                  | —                                               |
| 2   | `DRAFT`                                                   | `INPUTS_OPEN`          | `payroll:cycle:transition` | `payroll.attendance_period_open`                                                                                                                                                                                                                                  | `PAYROLL_CYCLE_STATE` → HR                      |
| 3   | `INPUTS_OPEN`                                             | `INPUTS_LOCKED`        | `payroll:input:commit`     | `payroll.inputs_settled`, `payroll.no_uncommitted_batches`, `payroll.all_batches_validated`, `payroll.dual_control_available`                                                                                                                                     | `PAYROLL_CYCLE_STATE` → HR                      |
| 4   | `INPUTS_LOCKED`                                           | `ATTENDANCE_SUBMITTED` | `attendance:submit`        | `attendance.period_is_hr_submitted`                                                                                                                                                                                                                               | `ATTENDANCE_APPROVAL_PENDING` → managers        |
| 5   | `ATTENDANCE_SUBMITTED`                                    | `ATTENDANCE_APPROVED`  | _(system)_                 | `attendance.every_slice_approved`                                                                                                                                                                                                                                 | `PAYROLL_CYCLE_STATE` → Accounts                |
| 6   | `ATTENDANCE_SUBMITTED`                                    | `INPUTS_LOCKED`        | `attendance:reopen`        | `attendance.any_slice_rejected`, `approval.note_required`                                                                                                                                                                                                         | `PAYROLL_CYCLE_STATE`                           |
| 7   | `ATTENDANCE_APPROVED`                                     | `VALIDATING`           | `payroll:validate`         | `payroll.attendance_locked`                                                                                                                                                                                                                                       | —                                               |
| 8   | `VALIDATING`                                              | `VALIDATED`            | _(system)_                 | `payroll.no_error_validations`                                                                                                                                                                                                                                    | `PAYROLL_CYCLE_STATE`                           |
| 9   | `VALIDATING`                                              | `VALIDATION_FAILED`    | _(system)_                 | `payroll.has_error_validations`                                                                                                                                                                                                                                   | `PAYROLL_CYCLE_STATE`                           |
| 10  | `VALIDATION_FAILED`                                       | `INPUTS_OPEN`          | `payroll:cycle:transition` | `approval.note_required`                                                                                                                                                                                                                                          | `PAYROLL_CYCLE_STATE`                           |
| 11  | `VALIDATION_FAILED`                                       | `VALIDATING`           | `payroll:validate`         | —                                                                                                                                                                                                                                                                 | —                                               |
| 12  | `VALIDATED`                                               | `CALCULATING`          | `payroll:calculate`        | `payroll.validated_recently` (validation no older than `org_setting.payroll_validation_max_age_hours`, and no input, attendance record or salary structure in scope changed since), `payroll.employee_set_unchanged`                                              | —                                               |
| 13  | `CALCULATING`                                             | `CALCULATED`           | _(system)_                 | `payroll.run_succeeded`, `payroll.payslip_count_matches_employee_count`, `payroll.controls_balance`                                                                                                                                                               | `PAYROLL_CYCLE_STATE` → Accounts                |
| 14  | `CALCULATING`                                             | `VALIDATION_FAILED`    | _(system)_                 | `payroll.run_failed`                                                                                                                                                                                                                                              | `PAYROLL_CYCLE_STATE`                           |
| 15  | `CALCULATED`                                              | `APPROVED`             | `payroll:approve`          | `payroll.distinct_approver`, `payroll.controls_balance`                                                                                                                                                                                                           | `PAYROLL_CYCLE_STATE`                           |
| 16  | `CALCULATED`                                              | `VALIDATED`            | `payroll:cycle:transition` | `approval.note_required`, `payroll.no_published_payslips` (discards the run; the live `payroll_run` → `SUPERSEDED`, every payslip of that run → `SUPERSEDED`, `payslip_count` and the control totals reset to `NULL`, `payroll_cycle_employee.payslip_id = NULL`) | `PAYROLL_CYCLE_STATE`                           |
| 17  | `APPROVED`                                                | `PUBLISHED`            | `payroll:publish`          | `payroll.distinct_approver`, `payroll.every_payslip_generated`, `payroll.pay_date_set`                                                                                                                                                                            | `PAYSLIP_PUBLISHED` → every employee in the run |
| 18  | `PUBLISHED`                                               | `CLOSED`               | `payroll:close`            | `payroll.pay_date_passed`, `payroll.reimbursements_settled`                                                                                                                                                                                                       | —                                               |
| 19  | `DRAFT`/`INPUTS_OPEN`/`INPUTS_LOCKED`/`VALIDATION_FAILED` | `CANCELLED`            | `payroll:cycle:transition` | `payroll.no_payslips_exist`, `approval.note_required`                                                                                                                                                                                                             | `PAYROLL_CYCLE_STATE`                           |
| 20  | `ATTENDANCE_APPROVED`                                     | `INPUTS_LOCKED`        | `attendance:reopen`        | `attendance.cycle_not_calculated`, `approval.note_required`                                                                                                                                                                                                       | `PAYROLL_CYCLE_STATE`                           |

**Transition 20** exists because the previous table had no way back from
`ATTENDANCE_APPROVED`: if a manager approved a slice in error, or an employee's approved
leave was cancelled after approval, the only recorded paths forward were `VALIDATING` and
nothing else — the cycle was stuck with attendance it knew to be wrong. The
`attendance_period` machine already allowed `APPROVED → REOPENED`; the cycle machine must
mirror it or the two fall out of lock-step, which is precisely the failure the 1:1
pairing exists to prevent.

Terminal: `CLOSED`, `CANCELLED`. There is **no** transition from `PUBLISHED` back to any
earlier state — a correction is a `payroll_correction` (§10.11) driving an `OFF_CYCLE` or
`CORRECTION` cycle that produces a superseding payslip revision (§10.7).

**The mandated order, and exactly where each link is enforced.** Directive 6 is satisfied
by the conjunction below; each row names the single artefact that makes the step
un-skippable, so an implementer can test each one in isolation:

| Mandated step                       | Enforced by                                                                                                                                                                                                                              | A route that tried to skip it would                      |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Accounts uploads payroll data       | transitions 2–3; `payroll:input:upload`/`:commit` held **only** by ACCOUNTS                                                                                                                                                              | fail `assertTransition` and `trg_guard_state_transition` |
| HR submits attendance               | guard `attendance.payroll_inputs_locked` on `attendance_period` `OPEN→HR_SUBMITTED` **and** on cycle transition 4                                                                                                                        | find the cycle not yet `INPUTS_LOCKED` and be refused    |
| The **respective** Manager approves | `attendance_record.manager_employee_id` snapshot → one `attendance_approval` slice per manager → guard `approval.actor_is_assigned_approver`; HR's `attendance:approve:any` is admissible only after `due_at` and never by the submitter | be refused as a non-assignee                             |
| System validates required inputs    | transitions 7–9; guard `payroll.no_error_validations` is a `NOT EXISTS` over unresolved `ERROR` rows                                                                                                                                     | find the cycle in `VALIDATION_FAILED`                    |
| Automatic payslip generation        | transitions 12–13; `trg_payslip_requires_calculating` refuses any `INSERT INTO payslip` while the cycle is not `CALCULATING`                                                                                                             | be refused by the database even with a direct `INSERT`   |
| Payslip becomes visible             | transition 17 creates `payslip_publication`; the employee query and the `payslip` RLS policy both require a live publication row                                                                                                         | return zero rows                                         |

The last two lines are why a payslip cannot "exist or be visible before the workflow
completes" in the strong sense the directive asks for: existence is blocked by a database
trigger keyed on the cycle state, and visibility is blocked by a row that only transition
17 can create.

### 10.3 `pay_component` — reference data, seeded

The earning and deduction lines the payslip renders (`Basic salary`, `House rent
allowance`, `Special allowance`, `Leave travel allowance`, `Conveyance allowance`,
`Provident fund (employee)`, `Income tax (TDS)`, `Professional tax`,
`Group insurance premium`, `Performance incentive`, …) are rows here — never string
literals in code.

| Column                           | Type                     | Null | Default             | Notes                                                                                                                              |
| -------------------------------- | ------------------------ | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `id`                             | `uuid`                   | no   | `gen_random_uuid()` | PK                                                                                                                                 |
| `organization_id`                | `uuid`                   | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                       |
| `code`                           | `citext`                 | no   | —                   | `BASIC`, `HRA`, `SPECIAL`, `LTA`, `CONVEYANCE`, `PF_EE`, `PF_ER`, `TDS`, `PT`, `GROUP_INS`, `INCENTIVE`, `ARREAR`, `LOP_DEDUCTION` |
| `name`                           | `text`                   | no   | —                   | The exact payslip line label                                                                                                       |
| `kind`                           | `ess_pay_component_kind` | no   | —                   |                                                                                                                                    |
| `calculation`                    | `ess_pay_component_calc` | no   | —                   |                                                                                                                                    |
| `calculation_basis_component_id` | `uuid`                   | yes  | —                   | FK → `pay_component(id)` `ON DELETE RESTRICT` — e.g. `PF_EE` is a percent of `BASIC`                                               |
| `rate`                           | `numeric(12,6)`          | yes  | —                   | `0.120000` for PF                                                                                                                  |
| `is_taxable`                     | `boolean`                | no   | `true`              |                                                                                                                                    |
| `is_prorated_by_payable_days`    | `boolean`                | no   | `false`             | `true` for `PRORATED_FIXED`                                                                                                        |
| `affects_gross`                  | `boolean`                | no   | _(generated)_       | `GENERATED ALWAYS AS (kind = 'EARNING') STORED`                                                                                    |
| `statutory_key`                  | `text`                   | yes  | —                   | `EPF`, `ESI`, `PT_KA`, `TDS_24Q` — links to the statutory engine                                                                   |
| `display_order`                  | `smallint`               | no   | `0`                 | **Fixes the payslip line order.** The UI never sorts.                                                                              |
| `display_group`                  | `text`                   | no   | —                   | `EARNINGS` \| `DEDUCTIONS` \| `EMPLOYER` \| `INFO`                                                                                 |
| `is_active`                      | `boolean`                | no   | `true`              |                                                                                                                                    |

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

| `salary_structure`                     | Type               | Null | Default             | Notes                                                                                             |
| -------------------------------------- | ------------------ | ---- | ------------------- | ------------------------------------------------------------------------------------------------- |
| `id`                                   | `uuid`             | no   | `gen_random_uuid()` | PK                                                                                                |
| `organization_id`                      | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                      |
| `employee_id`                          | `uuid`             | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                          |
| `effective_from`                       | `date`             | no   | —                   |                                                                                                   |
| `effective_to`                         | `date`             | yes  | —                   | `NULL` = current                                                                                  |
| `annual_ctc_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | no   | —                   | Encrypted; needed for `MULTIPLE_OF_CTC` benefits                                                  |
| `pay_frequency`                        | `text`             | no   | `'MONTHLY'`         |                                                                                                   |
| `revision_reason`                      | `text`             | no   | —                   | `NEW_HIRE`, `ANNUAL_REVISION`, `PROMOTION`, `CORRECTION`                                          |
| `source_document_id`                   | `uuid`             | yes  | —                   | FK → `employee_document(id)` `ON DELETE SET NULL` — the salary revision letter                    |
| `approved_by_user_id`                  | `uuid`             | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                          |
| `approved_at`                          | `timestamptz`      | no   | `now()`             |                                                                                                   |
| `structure_sha256`                     | `bytea`            | no   | —                   | SHA-256 over the canonical JSON of the component set; copied into every payslip generated from it |

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

| `salary_structure_component`       | Type               | Null | Default             | Notes                                                 |
| ---------------------------------- | ------------------ | ---- | ------------------- | ----------------------------------------------------- |
| `id`                               | `uuid`             | no   | `gen_random_uuid()` | PK                                                    |
| `organization_id`                  | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`          |
| `salary_structure_id`              | `uuid`             | no   | —                   | FK → `salary_structure(id)` `ON DELETE CASCADE`       |
| `pay_component_id`                 | `uuid`             | no   | —                   | FK → `pay_component(id)` `ON DELETE RESTRICT`         |
| `amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | yes  | —                   | Encrypted monthly amount for `FIXED`/`PRORATED_FIXED` |
| `rate_override`                    | `numeric(12,6)`    | yes  | —                   | Overrides `pay_component.rate`                        |
| `display_order`                    | `smallint`         | no   | `0`                 | Falls back to `pay_component.display_order`           |

```sql
CONSTRAINT ux_ssc__structure_component UNIQUE (salary_structure_id, pay_component_id),
CONSTRAINT ck_ssc__value_present CHECK (amount_minor_ct IS NOT NULL OR rate_override IS NOT NULL)
```

### 10.5 `payroll_input_batch` and `payroll_input_item` — the Accounts upload

| `payroll_input_batch`    | Type                             | Null | Default             | Notes                                                                                                                         |
| ------------------------ | -------------------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | `uuid`                           | no   | `gen_random_uuid()` | PK                                                                                                                            |
| `organization_id`        | `uuid`                           | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                  |
| `payroll_cycle_id`       | `uuid`                           | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT`                                                                                 |
| `batch_no`               | `integer`                        | no   | —                   | Sequential within the cycle                                                                                                   |
| `file_object_id`         | `uuid`                           | no   | —                   | FK → `file_object(id)` `ON DELETE RESTRICT` — the uploaded CSV/XLSX, retained as evidence                                     |
| `original_filename`      | `text`                           | no   | —                   |                                                                                                                               |
| `file_sha256`            | `bytea`                          | no   | —                   | 32 bytes; duplicate uploads are rejected                                                                                      |
| `status`                 | `ess_payroll_input_batch_status` | no   | `'UPLOADING'`       |                                                                                                                               |
| `row_count_total`        | `integer`                        | no   | `0`                 |                                                                                                                               |
| `row_count_valid`        | `integer`                        | no   | `0`                 |                                                                                                                               |
| `row_count_rejected`     | `integer`                        | no   | `0`                 |                                                                                                                               |
| `declared_total_minor`   | `money_minor`                    | yes  | —                   | Control total typed by the uploader; must equal the parsed sum or the batch fails `VALIDATED`                                 |
| `parsed_total_minor`     | `money_minor`                    | yes  | —                   | Computed at parse                                                                                                             |
| `uploaded_by_user_id`    | `uuid`                           | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                      |
| `uploaded_at`            | `timestamptz`                    | no   | `now()`             |                                                                                                                               |
| `committed_by_user_id`   | `uuid`                           | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                      |
| `committed_at`           | `timestamptz`                    | yes  | —                   |                                                                                                                               |
| `superseded_by_batch_id` | `uuid`                           | yes  | —                   | FK → `payroll_input_batch(id)` `ON DELETE SET NULL`                                                                           |
| `parse_error`            | `jsonb`                          | yes  | —                   | `{ "line": 42, "column": "amount", "message": "…" }[]` — rendered in the Accounts upload screen, never in an employee surface |
| `row_version`            | `integer`                        | no   | `1`                 |                                                                                                                               |

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

| `payroll_input_item`               | Type                     | Null | Default             | Notes                                                                                                   |
| ---------------------------------- | ------------------------ | ---- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `id`                               | `uuid`                   | no   | `gen_random_uuid()` | PK                                                                                                      |
| `organization_id`                  | `uuid`                   | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                            |
| `payroll_input_batch_id`           | `uuid`                   | no   | —                   | FK → `payroll_input_batch(id)` `ON DELETE CASCADE`                                                      |
| `payroll_cycle_id`                 | `uuid`                   | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — denormalised for the generator's single-scan read       |
| `employee_id`                      | `uuid`                   | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                |
| `source_row_no`                    | `integer`                | no   | —                   | Line in the uploaded file — traceability to the source artefact                                         |
| `kind`                             | `ess_payroll_input_kind` | no   | —                   |                                                                                                         |
| `pay_component_id`                 | `uuid`                   | yes  | —                   | FK → `pay_component(id)` `ON DELETE RESTRICT`. Required for every kind except `LOP_OVERRIDE`.           |
| `amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask)       | yes  | —                   | Encrypted. Required unless `kind = 'LOP_OVERRIDE'`.                                                     |
| `lop_days_override`                | `numeric(5,2)`           | yes  | —                   | Only for `kind = 'LOP_OVERRIDE'`                                                                        |
| `effective_period_code`            | `text`                   | yes  | —                   | For `ARREAR`: which past period the arrear relates to                                                   |
| `narration`                        | `text`                   | yes  | —                   | Rendered as the payslip line's sub-label when present                                                   |
| `expense_claim_id`                 | `uuid`                   | yes  | —                   | FK → `expense_claim(id)` `ON DELETE RESTRICT` — set for `REIMBURSEMENT_PAYOUT`, closing the loop to §13 |
| `is_rejected`                      | `boolean`                | no   | `false`             | Parse/validation rejected this row                                                                      |
| `rejection_reason`                 | `text`                   | yes  | —                   |                                                                                                         |

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

```sql
CREATE UNIQUE INDEX ux_pii__one_lop_override_per_employee_cycle
  ON ess.payroll_input_item (payroll_cycle_id, employee_id)
  WHERE kind = 'LOP_OVERRIDE' AND NOT is_rejected;
CREATE UNIQUE INDEX ux_pii__one_payout_per_claim
  ON ess.payroll_input_item (expense_claim_id)
  WHERE kind = 'REIMBURSEMENT_PAYOUT' AND NOT is_rejected;
```

`payroll_input_item` rows belonging to a `SUPERSEDED` or `DISCARDED` batch are excluded
from every generator read by joining `payroll_input_batch` and requiring
`status = 'COMMITTED'`; the partial indexes above additionally keep a superseded batch's
rows from blocking a corrected re-upload, because supersession sets `is_rejected = true`
on its items in the same transaction.

### 10.5.1 Input batch state machine (`machine = 'payroll_input_batch'`)

`NULL→UPLOADING` (`payroll:input:upload`, guard `payroll.cycle_inputs_open`) ·
`UPLOADING→PARSED` (_system_, guard `payroll.file_clean` — the `file_object` must be
`scan_status = 'CLEAN'` before a single byte is parsed) ·
`UPLOADING→PARSE_FAILED` (_system_) ·
`PARSED→VALIDATED` (_system_, guards `payroll.batch_totals_match`,
`payroll.batch_employees_resolve`) ·
`PARSED→DISCARDED` / `VALIDATED→DISCARDED` (`payroll:input:upload`, guard
`approval.note_required`) ·
`VALIDATED→COMMITTED` (`payroll:input:commit`, guards `payroll.cycle_inputs_open`,
`payroll.committer_not_uploader`) ·
`COMMITTED→SUPERSEDED` (`payroll:input:commit`, guard `payroll.cycle_inputs_open`;
sets `superseded_by_batch_id` and `is_rejected = true` on every item).
Terminal: `SUPERSEDED`, `DISCARDED`, `PARSE_FAILED`.

`payroll.committer_not_uploader` is a **maker-checker control on the money going in**:
the Accounts user who uploaded a batch of variable pay cannot be the one who commits it.
It is waived only when `org_setting` records fewer than two eligible Accounts users, and
that waiver is itself an audited `CONFIG_CHANGE`. Without it, dual control at the
_approval_ end is decorative — one person could still author every amount.

### 10.6 `payroll_validation_result` and `payroll_run`

| `payroll_validation_result` | Type                              | Null | Default             | Notes                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `uuid`                            | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                         |
| `organization_id`           | `uuid`                            | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                               |
| `payroll_cycle_id`          | `uuid`                            | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                               |
| `validation_pass_no`        | `integer`                         | no   | —                   | Increments each time `VALIDATING` is entered                                                                                                                                                                                                                               |
| `rule_code`                 | `text`                            | no   | —                   | `PAY_NO_SALARY_STRUCTURE`, `PAY_BANK_UNVERIFIED`, `PAY_ATTENDANCE_MISSING`, `PAY_LOP_EXCEEDS_ELIGIBLE`, `PAY_NEGATIVE_NET`, `PAY_INPUT_ORPHAN_EMPLOYEE`, `PAY_DUPLICATE_INPUT`, `PAY_TDS_MISSING_PAN`, `PAY_CTC_MISSING`, `ATT_TOTALS_DRIFT`, `PAY_CONTROL_TOTAL_MISMATCH` |
| `severity`                  | `ess_payroll_validation_severity` | no   | —                   |                                                                                                                                                                                                                                                                            |
| `employee_id`               | `uuid`                            | yes  | —                   | FK → `employee(id)` `ON DELETE CASCADE`. NULL = cycle-level finding.                                                                                                                                                                                                       |
| `entity_type`               | `text`                            | yes  | —                   | `payroll_input_item`, `attendance_record`, `salary_structure`                                                                                                                                                                                                              |
| `entity_id`                 | `uuid`                            | yes  | —                   | Not an FK (polymorphic)                                                                                                                                                                                                                                                    |
| `message`                   | `text`                            | no   | —                   | Human-readable, no amounts in plaintext                                                                                                                                                                                                                                    |
| `detail`                    | `jsonb`                           | yes  | —                   | Redacted structured context                                                                                                                                                                                                                                                |
| `resolved_at`               | `timestamptz`                     | yes  | —                   |                                                                                                                                                                                                                                                                            |
| `resolved_by_user_id`       | `uuid`                            | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                   |
| `resolution_note`           | `text`                            | yes  | —                   |                                                                                                                                                                                                                                                                            |
| `created_at`                | `timestamptz`                     | no   | `now()`             |                                                                                                                                                                                                                                                                            |

```sql
CONSTRAINT ck_pvr__resolution CHECK (num_nulls(resolved_at, resolved_by_user_id, resolution_note) IN (0, 3)),
CONSTRAINT ux_pvr__pass_rule_entity UNIQUE (payroll_cycle_id, validation_pass_no, rule_code, coalesce(employee_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(entity_id, '00000000-0000-0000-0000-000000000000'::uuid))
```

Indexes: `ix_pvr__cycle_severity (payroll_cycle_id, validation_pass_no, severity)`,
`ix_pvr__unresolved_errors (payroll_cycle_id) WHERE severity = 'ERROR' AND resolved_at IS NULL`.

Guard `payroll.no_error_validations` is exactly
`NOT EXISTS (SELECT 1 FROM payroll_validation_result WHERE payroll_cycle_id = $1 AND validation_pass_no = $2 AND severity = 'ERROR' AND resolved_at IS NULL)`.

| `payroll_run`           | Type                     | Null | Default             | Notes                                                                                                                             |
| ----------------------- | ------------------------ | ---- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | `uuid`                   | no   | `gen_random_uuid()` | PK                                                                                                                                |
| `organization_id`       | `uuid`                   | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                      |
| `payroll_cycle_id`      | `uuid`                   | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT`                                                                                     |
| `run_no`                | `integer`                | no   | —                   | Sequential per cycle; a re-run supersedes the previous                                                                            |
| `status`                | `ess_payroll_run_status` | no   | `'QUEUED'`          |                                                                                                                                   |
| `engine_version`        | `text`                   | no   | —                   | Semver of the calculation engine — reproducibility anchor                                                                         |
| `ruleset_sha256`        | `bytea`                  | no   | —                   | SHA-256 over the active `pay_component` set + statutory tables used                                                               |
| `started_at`            | `timestamptz`            | yes  | —                   |                                                                                                                                   |
| `finished_at`           | `timestamptz`            | yes  | —                   |                                                                                                                                   |
| `triggered_by_user_id`  | `uuid`                   | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                          |
| `employee_count`        | `integer`                | no   | `0`                 |                                                                                                                                   |
| `payslip_count`         | `integer`                | no   | `0`                 |                                                                                                                                   |
| `error_message`         | `text`                   | yes  | —                   |                                                                                                                                   |
| `error_detail`          | `jsonb`                  | yes  | —                   |                                                                                                                                   |
| `input_manifest_sha256` | `bytea`                  | no   | —                   | SHA-256 over the ordered list of every `payroll_input_item.id`, `attendance_record.id` and `salary_structure.id` the run consumed |
| `superseded_by_run_id`  | `uuid`                   | yes  | —                   | FK → `payroll_run(id)` `ON DELETE SET NULL`                                                                                       |

```sql
CONSTRAINT ux_payroll_run__cycle_run_no UNIQUE (payroll_cycle_id, run_no),
CONSTRAINT ck_payroll_run__sha CHECK (octet_length(ruleset_sha256) = 32 AND octet_length(input_manifest_sha256) = 32),
CONSTRAINT ck_payroll_run__times CHECK (finished_at IS NULL OR started_at IS NOT NULL),
CONSTRAINT ck_payroll_run__failure CHECK (status <> 'FAILED' OR error_message IS NOT NULL),
CONSTRAINT ck_payroll_run__kind CHECK ((run_kind = 'CORRECTION') = (payroll_correction_id IS NOT NULL))
```

```sql
CREATE UNIQUE INDEX ux_payroll_run__one_live ON ess.payroll_run (payroll_cycle_id)
  WHERE status = 'SUCCEEDED' AND superseded_by_run_id IS NULL;                 -- §1.2
CREATE UNIQUE INDEX ux_payroll_run__one_active ON ess.payroll_run (payroll_cycle_id)
  WHERE status IN ('QUEUED','RUNNING');   -- a cycle can have at most one run in flight
```

Two further columns, required by WORKFLOWS.md A-3:
`run_kind ess_payroll_run_kind NOT NULL DEFAULT 'REGULAR'` and
`payroll_correction_id uuid NULL` FK → `payroll_correction(id)` `ON DELETE RESTRICT`.

`input_manifest_sha256` covers the ordered ids of every `payroll_input_item`,
`attendance_record`, `salary_structure` **and `payroll_cycle_employee` row** the run
consumed, plus `payroll_cycle.employee_set_sha256` and the id of the
`statutory_rate_set`/`statutory_pt_slab` rows in force. The previous definition omitted
the employee population and the statutory rates, so two runs over a changed population or
a corrected PF ceiling would hash identically and the reproducibility claim would be
false.

### 10.6.1 Run state machine (`machine = 'payroll_run'`)

`NULL→QUEUED` (`payroll:calculate`, guard `payroll.cycle_calculating`) ·
`QUEUED→RUNNING` (_system_, lease-held by `ess_ops.background_job`) ·
`RUNNING→SUCCEEDED` / `RUNNING→FAILED` (_system_) ·
`SUCCEEDED→SUPERSEDED` (_system_, on transition 16 or a correction run).
A run that holds a lease which expires without a terminal status is swept to `FAILED`
with `error_message = 'LEASE_EXPIRED'` by the `payroll-run-reaper` job; it never sits in
`RUNNING` forever, because a cycle stuck in `CALCULATING` blocks the month.

### 10.7 `payslip` — immutable, versioned, hash-traceable

| Column                                     | Type                 | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------ | -------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                       | `uuid`               | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `organization_id`                          | `uuid`               | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `payroll_cycle_id`                         | `uuid`               | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `payroll_run_id`                           | `uuid`               | no   | —                   | FK → `payroll_run(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `employee_id`                              | `uuid`               | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fiscal_year_id`                           | `uuid`               | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `reference_no`                             | `citext`             | no   | —                   | `WDT-PS-2608-1847`. **Exact derivation** (the previous "employee numeric suffix" was ambiguous and collision-prone): `organization.code ‖ '-PS-' ‖ to_char(period_end,'YYMM') ‖ '-' ‖ ltrim(regexp_replace(employee.employee_number,'[^0-9]','','g'),'0')`, i.e. every digit of the employee number with leading zeros stripped — `WDT-01847` → `1847`, `WDT-011847` → `11847`. Truncating to a fixed 4 digits, as "suffix" invited, would collide `WDT-01847` with `WDT-11847` and hand one employee another's payslip reference. A `revision > 1` appends `'-R' ‖ revision`. Uniqueness is enforced by `ux_payslip__org_reference`; a collision is a hard error, never a silent retry.                                                                                                                                                                                                                                                                                                                               |
| `revision`                                 | `smallint`           | no   | `1`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `supersedes_payslip_id`                    | `uuid`               | yes  | —                   | FK → `payslip(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `status`                                   | `ess_payslip_status` | no   | `'GENERATED'`       |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `period_label`                             | `text`               | no   | —                   | `August 2026` — copied from the cycle, frozen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `period_start`                             | `date`               | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `period_end`                               | `date`               | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `pay_date`                                 | `date`               | no   | —                   | Rendered as "Credited 31 Aug 2026"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `payment_mode`                             | `text`               | no   | `'NEFT'`            | Rendered in the payslip meta line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `bank_account_last4`                       | `char(4)`            | no   | —                   | Snapshot; the header renders `HDFC Bank ••4412` from `bank_name_snapshot` + this                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bank_name_snapshot`                       | `text`               | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `payable_days`                             | `numeric(5,2)`       | no   | —                   | Snapshot of `attendance_record.payable_days`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `total_days`                               | `numeric(5,2)`       | no   | —                   | Snapshot of `attendance_record.calendar_days`. Together they render `31 / 31`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `lop_days`                                 | `numeric(5,2)`       | no   | `0`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `gross_earnings_minor_ct/_iv/_tag/_dek_id` | envelope             | no   | —                   | Encrypted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `total_deductions_minor_ct/…`              | envelope             | no   | —                   | Encrypted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `net_pay_minor_ct/…`                       | envelope             | no   | —                   | Encrypted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `employer_pf_minor_ct/…`                   | envelope             | yes  | —                   | Encrypted; "Employer PF" meta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `tds_minor_ct/…`                           | envelope             | no   | —                   | Encrypted; "TDS this month" meta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `attendance_record_id`                     | `uuid`               | no   | —                   | FK → `attendance_record(id)` `ON DELETE RESTRICT` — source traceability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `salary_structure_id`                      | `uuid`               | no   | —                   | FK → `salary_structure(id)` `ON DELETE RESTRICT` — source traceability                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `salary_structure_sha256`                  | `bytea`              | no   | —                   | Copy of `salary_structure.structure_sha256` at generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `input_snapshot`                           | `jsonb`              | no   | —                   | **Canonical and money-free** record of every input that produced this payslip: the attendance day counts (`eligible/present/paid_leave/holiday/week_off/absent/unpaid_leave/lop/payable`, which are day counts, not money), `lop_source`, the ordered list of `payroll_input_item` ids with their `kind` and `pay_component_id`, the ordered `salary_structure_component` ids, `salary_structure_sha256`, `employee_tax_projection.id`, `statutory_rate_set.id`, `statutory_pt_slab` ids, `engine_version`, `ruleset_sha256`, `payroll_run.id`. **It contains no amount, in any form.** The previous definition stored "money values … as minor-unit strings", which would have written the full earnings and deduction breakdown into an unencrypted `jsonb` column sitting in the same row as the encrypted totals — defeating §1.6 entirely for exactly the records it most needs to protect. Amounts are reconstructed for an audit by decrypting `payslip_line`, which is the point of keeping the line ids here. |
| `input_sha256`                             | `bytea`              | no   | —                   | SHA-256 over `jsonb_canonical(input_snapshot)` (§17.1). Recomputing it is the audit test "this payslip still references the same inputs".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `amount_sha256`                            | `bytea`              | no   | —                   | SHA-256 over the canonical serialisation of the **decrypted** amounts (`gross‖deductions‖net‖tds‖employer_pf` and every `payslip_line` amount in `display_order`, each as a minor-unit decimal string), computed in the API at generation. It is the audit test "this payslip's _figures_ are unaltered" — the half that `input_sha256` deliberately cannot cover now that the snapshot holds no money. A verifier with a KMS grant recomputes it; a verifier without one can still prove the input lineage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `pdf_file_object_id`                       | `uuid`               | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL` — generated at publication                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `generated_at`                             | `timestamptz`        | no   | `now()`             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `revoked_at`                               | `timestamptz`        | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `revoked_reason`                           | `text`               | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

```sql
CONSTRAINT ux_payslip__org_reference UNIQUE (organization_id, reference_no),
CONSTRAINT ux_payslip__cycle_employee_revision UNIQUE (payroll_cycle_id, employee_id, revision),
CONSTRAINT ck_payslip__revision CHECK (revision >= 1),
CONSTRAINT ck_payslip__supersede CHECK ((revision > 1) = (supersedes_payslip_id IS NOT NULL)),
CONSTRAINT ck_payslip__days CHECK (payable_days >= 0 AND payable_days <= total_days AND lop_days >= 0),
CONSTRAINT ck_payslip__period CHECK (period_end >= period_start AND pay_date >= period_end),
CONSTRAINT ck_payslip__sha CHECK (octet_length(input_sha256) = 32 AND octet_length(amount_sha256) = 32 AND octet_length(salary_structure_sha256) = 32),
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

```sql
CREATE UNIQUE INDEX ux_payslip__one_live_per_cycle_employee
  ON ess.payslip (payroll_cycle_id, employee_id) WHERE status IN ('GENERATED','PUBLISHED');
```

**Immutability.** Trigger `trg_payslip_immutable` (BEFORE UPDATE) rejects any change to
any column **except** `status`, `pdf_file_object_id`, `supersedes_payslip_id` (on the
superseded row), `revoked_at`, `revoked_reason`, `updated_at`, `updated_by_user_id`.
`DELETE` is rejected outright. Corrections create `revision = n+1` and set the old row's
`status = 'SUPERSEDED'`.

**Existence gate.** Trigger `trg_payslip_requires_calculating` (`BEFORE INSERT`, WORKFLOWS
R-4) raises unless
`(SELECT status FROM payroll_cycle WHERE id = NEW.payroll_cycle_id FOR SHARE) = 'CALCULATING'`,
**or** the insert belongs to a `payroll_run` with `run_kind = 'CORRECTION'` whose
`payroll_correction.status = 'CALCULATING'`. This is the database half of directive 6: a
payslip row cannot come into existence outside the calculation window, even from a direct
`INSERT` by a compromised application, because the trigger consults the cycle state rather
than trusting the caller.

### 10.7.1 Payslip state machine (`machine = 'payslip'`)

The previous draft left `payslip.status` unguarded: §2.1 declares that
`trg_guard_state_transition` re-checks `status` updates against `state_transition`, and
there was no `payslip` machine for it to check against — so `UPDATE payslip SET status =
'PUBLISHED'` was structurally permitted. The machine:

| from        | to           | permission        | guard                                                                                    |
| ----------- | ------------ | ----------------- | ---------------------------------------------------------------------------------------- |
| `NULL`      | `GENERATED`  | _(system)_        | `payroll.cycle_calculating` (and the `BEFORE INSERT` trigger above)                      |
| `GENERATED` | `PUBLISHED`  | `payroll:publish` | `payroll.cycle_approved`, `payroll.distinct_approver`, `payslip.publication_row_created` |
| `GENERATED` | `SUPERSEDED` | _(system)_        | `payroll.run_discarded_or_corrected`                                                     |
| `PUBLISHED` | `SUPERSEDED` | _(system)_        | `payslip.superseding_revision_published`                                                 |
| `PUBLISHED` | `REVOKED`    | `payroll:publish` | `approval.note_required`, `payslip.publication_revoked`                                  |

Terminal: `SUPERSEDED`, `REVOKED`. There is **no** transition back to `GENERATED`.
`GENERATED → PUBLISHED` and the `payslip_publication` insert are one transaction; the
guard `payslip.publication_row_created` asserts the row exists before the status flips, so
the two can never disagree about whether an employee can see the slip.

**Visibility gate (the hard rule).** The employee-facing query is _always_:

```sql
SELECT p.* FROM payslip p
JOIN payslip_publication pub ON pub.payslip_id = p.id
WHERE p.employee_id = :me
  AND p.status = 'PUBLISHED'
  AND pub.published_at <= now()
  AND pub.revoked_at IS NULL
ORDER BY p.period_end DESC;
```

No other path exists in the employee API. `payslip_line`, `payslip_fy_rollup` and the
payslip PDF endpoint each re-apply the same join; none of them accepts a `payslip_id` and
trusts it.

Before publication the Payslips screen shows its designed empty state. **The employee is
never shown `payroll_cycle.status`** — an employee holds no `payroll:cycle:read` and has
no business knowing that this month's payroll is in `VALIDATION_FAILED`. The endpoint
returns a coarse, whitelisted `payslipOutlook` derived from the employee's earliest
in-scope cycle, and nothing else:

| Derived value  | Condition                                                           | `ui_copy` key                 |
| -------------- | ------------------------------------------------------------------- | ----------------------------- |
| `NO_CYCLE_YET` | no `payroll_cycle_employee` row for this employee in any cycle      | `empty.payslips.no_cycle`     |
| `IN_PROGRESS`  | a cycle exists with `status` before `PUBLISHED` and not `CANCELLED` | `empty.payslips.in_progress`  |
| `NOT_IN_SCOPE` | the latest cycle has `disposition <> 'INCLUDED'` for this employee  | `empty.payslips.not_in_scope` |
| `NONE`         | no cycle at all covers the employee's tenure                        | `empty.payslips.none`         |

The copy for each is a persisted `ui_copy` row (§4.7) parameterised only by the cycle's
`label` — "August 2026 payroll is being processed", never "August 2026 payroll failed
validation". It never renders a draft, a provisional total, or a synthetic figure.

### 10.8 `payslip_line` and `payslip_publication`

| `payslip_line`                     | Type                    | Null | Default             | Notes                                                                                                                               |
| ---------------------------------- | ----------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `id`                               | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                                                                  |
| `organization_id`                  | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                        |
| `payslip_id`                       | `uuid`                  | no   | —                   | FK → `payslip(id)` `ON DELETE RESTRICT`                                                                                             |
| `pay_component_id`                 | `uuid`                  | no   | —                   | FK → `pay_component(id)` `ON DELETE RESTRICT`                                                                                       |
| `kind`                             | `ess_payslip_line_kind` | no   | —                   | Drives which column the line renders in                                                                                             |
| `label_snapshot`                   | `text`                  | no   | —                   | `pay_component.name` frozen at generation, so renaming a component never rewrites history                                           |
| `narration`                        | `text`                  | yes  | —                   | From `payroll_input_item.narration`                                                                                                 |
| `amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask)      | no   | —                   | Encrypted, **signed** value                                                                                                         |
| `quantity`                         | `numeric(10,2)`         | yes  | —                   | e.g. overtime hours                                                                                                                 |
| `rate_applied`                     | `numeric(12,6)`         | yes  | —                   | e.g. `0.120000` for PF — makes the line reproducible                                                                                |
| `basis_amount_minor_ct/…`          | envelope                | yes  | —                   | The base the rate was applied to                                                                                                    |
| `source_input_item_id`             | `uuid`                  | yes  | —                   | FK → `payroll_input_item(id)` `ON DELETE RESTRICT` — a line that came from an Accounts upload points back at the exact uploaded row |
| `display_order`                    | `smallint`              | no   | —                   | Snapshot of `pay_component.display_order`                                                                                           |
| `is_taxable_snapshot`              | `boolean`               | no   | —                   |                                                                                                                                     |

```sql
CONSTRAINT ux_payslip_line__slip_component_order UNIQUE (payslip_id, pay_component_id, display_order),
CONSTRAINT ck_payslip_line__order CHECK (display_order >= 0)
```

Indexes: `ix_payslip_line__slip_order (payslip_id, kind, display_order)` — the exact read
order of the Earnings and Deductions columns; `ix_payslip_line__source (source_input_item_id)`.
Same immutability trigger as `payslip`: no `UPDATE`, no `DELETE`.

| `payslip_publication`  | Type          | Null | Default             | Notes                                                                                                     |
| ---------------------- | ------------- | ---- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                                        |
| `organization_id`      | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                              |
| `payslip_id`           | `uuid`        | no   | —                   | FK → `payslip(id)` `ON DELETE RESTRICT`                                                                   |
| `payroll_cycle_id`     | `uuid`        | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT`                                                             |
| `employee_id`          | `uuid`        | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — denormalised so the visibility gate needs no join to `payslip` |
| `published_at`         | `timestamptz` | no   | `now()`             | May be future-dated for a scheduled release                                                               |
| `published_by_user_id` | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                  |
| `notification_id`      | `uuid`        | yes  | —                   | FK → `notification(id)` `ON DELETE SET NULL` — the "Your payslip for August 2026 is ready" notification   |
| `email_outbox_id`      | `uuid`        | yes  | —                   | FK → `email_outbox(id)` `ON DELETE SET NULL`                                                              |
| `first_viewed_at`      | `timestamptz` | yes  | —                   | Set once, on the employee's first successful read                                                         |
| `first_downloaded_at`  | `timestamptz` | yes  | —                   |                                                                                                           |
| `download_count`       | `integer`     | no   | `0`                 | Incremented on each PDF fetch; every fetch also writes an `audit_event` (`DOWNLOAD`)                      |
| `revoked_at`           | `timestamptz` | yes  | —                   |                                                                                                           |
| `revoked_by_user_id`   | `uuid`        | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                  |
| `revoked_reason`       | `text`        | yes  | —                   |                                                                                                           |

```sql
CONSTRAINT ck_pp__revocation CHECK (num_nulls(revoked_at, revoked_by_user_id, revoked_reason) IN (0, 3)),
CONSTRAINT ck_pp__downloads CHECK (download_count >= 0),
CONSTRAINT ck_pp__revocation_note CHECK (revoked_reason IS NULL OR length(btrim(revoked_reason)) >= 10),
CONSTRAINT ck_pp__viewed_after_published CHECK (first_viewed_at IS NULL OR first_viewed_at >= published_at)
```

```sql
-- one LIVE publication per payslip; a revoked one may be superseded by a new row
CREATE UNIQUE INDEX ux_payslip_publication__live
  ON ess.payslip_publication (payslip_id) WHERE revoked_at IS NULL;
```

> **Corrected.** `UNIQUE (payslip_id)` allowed exactly one publication row for all time,
> so a payslip revoked in error (a wrong pay date, a premature release) could never be
> republished — the only recovery was a new `revision`, which rewrites history for an
> unchanged payslip. The partial index permits revoke-then-republish while still
> guaranteeing at most one _live_ publication, which is what the visibility gate needs.
> Revocation is permissioned (`payroll:publish`), reasoned, audited, notified to the
> employee, and it does **not** delete the row: `revoked_at` preserves the fact that the
> slip was visible for a period, which matters if the employee downloaded it.

### 10.8.1 Publication state machine (`machine = 'payslip_publication'`)

`NULL→LIVE` (`payroll:publish`, guards `payroll.cycle_approved`,
`payroll.distinct_approver`, `payroll.pay_date_set`; emits `PAYSLIP_PUBLISHED`
notification + `PAYSLIP_PUBLISHED` email) ·
`LIVE→REVOKED` (`payroll:publish`, guard `approval.note_required`; emits a
`PAYSLIP_PUBLISHED` notification whose copy states the slip was withdrawn).
`status` is expressed by `revoked_at`, so the machine's `from_state`/`to_state` values are
`LIVE` and `REVOKED` and the guard trigger keys on that derived value.

**Scheduled release.** `published_at` may be future-dated. The gate compares
`published_at <= now()`, so a cycle can be published on Friday for a Monday release
without a job; the `PAYSLIP_PUBLISHED` notification is enqueued with
`notification.occurred_at = published_at` and suppressed until then by the same
comparison, so the employee is never told about a payslip they cannot yet open.
Indexes:

- `ix_pp__employee_live (employee_id, published_at DESC) WHERE revoked_at IS NULL` — the visibility gate's driving index
- `ix_pp__cycle (payroll_cycle_id)`

### 10.9 `payslip_fy_rollup` — queryable YTD totals without decrypting

Written in the same transaction as each `payslip_publication` insert (and reversed on
revocation) by `fn_refresh_payslip_fy_rollup(employee, fiscal_year)`. It exists solely so
the Payslips YTD tiles are a single indexed read, and it holds only figures the employee
is already entitled to see.

| Column                                   | Type               | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------ | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | `uuid`             | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `organization_id`                        | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `employee_id`                            | `uuid`             | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fiscal_year_id`                         | `uuid`             | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `payslip_count`                          | `integer`          | no   | `0`                 | → tile sub-label "5 payslips"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `first_period_start`                     | `date`             | yes  | —                   | `2026-04-01`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `last_period_end`                        | `date`             | yes  | —                   | `2026-08-31`. **Dates, not labels.** The tile sub-label "Apr – Aug 2026" is `to_char(first_period_start,'Mon') ‖ ' – ' ‖ to_char(last_period_end,'Mon YYYY')`, rendered from these two persisted dates. The previous `first_period_label`/`last_period_label` columns held `April 2026`/`August 2026` and the spec said they were "abbreviated to `Apr – Aug 2026`" — an abbreviation is string surgery on a label whose format is not guaranteed, and it is exactly the kind of client-side derivation directive 2 forbids. |
| `gross_earned_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | yes  | —                   | → "Gross earned". **Class M1** (§1.6): encrypted, one row per employee per FY, decrypted once per screen.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `net_credited_minor_ct/…`                | envelope           | yes  | —                   | → "Net credited"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `total_deductions_minor_ct/…`            | envelope           | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `tds_minor_ct/…`                         | envelope           | yes  | —                   | → "TDS deducted"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `employee_pf_minor_ct/…`                 | envelope           | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `employer_pf_minor_ct/…`                 | envelope           | yes  | —                   | `employee_pf + employer_pf` → "PF contributed", summed in the API after decryption                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `recomputed_at`                          | `timestamptz`      | no   | `now()`             |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `source_payslip_ids`                     | `uuid[]`           | no   | `'{}'`              | The exact rows folded — makes the tile auditable                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

```sql
CONSTRAINT ux_psfy__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_psfy__count CHECK (payslip_count >= 0),
CONSTRAINT ck_psfy__sources CHECK (payslip_count = cardinality(source_payslip_ids)),
CONSTRAINT ck_psfy__range CHECK (
  num_nulls(first_period_start, last_period_end) IN (0, 2)
  AND (last_period_end IS NULL OR last_period_end >= first_period_start))
```

Non-negativity of the amounts is asserted in the API at fold time (they are ciphertext at
rest and cannot be `CHECK`-ed), and re-asserted by the nightly `payslip-rollup-verify`
job, which refolds from `source_payslip_ids` and raises a P1 on any difference.
Index: `ux_psfy__employee_fy (employee_id, fiscal_year_id)`.

> **Security note.** This rollup is per-employee, envelope-encrypted (class M1) and
> protected by the same RLS self/scope policy as `payslip`, with **no team branch**.
> A row exists **only** after at least one publication, so a zero row is never rendered —
> with no row, the tiles show `—` and the sub-label "No published payslips in FY 2026–27
> yet" (`ui_copy` key `empty.payslips.ytd`).
>
> **Revocation reverses it.** `fn_refresh_payslip_fy_rollup` is called on every
> `payslip_publication` insert **and** on every revocation, and always refolds from
> scratch over the live publications rather than applying a delta — a delta-maintained
> total drifts, and a drifting total on a tax tile is exactly the fabricated number
> directive 2 forbids. If the refold leaves `payslip_count = 0`, the row is **deleted**,
> so the screen returns to its empty state rather than showing `₹0`.

### 10.10 `payroll_cycle_employee` — the in-scope population, snapshotted

Required by WORKFLOWS.md A-1 and by two guards this document already relies on.
`payroll_cycle.employee_count` was defined as "employees in scope; set at `VALIDATED`",
and `payroll.payslip_count_matches_employee_count` compares it to `payslip_count` — but
**no rule said which employees are in scope**, and no row recorded the answer. That made
the count unverifiable after the fact, made "why was this person not paid?" unanswerable,
and left an implementer to invent the scoping predicate.

**Scope rule (deterministic).** At the `ATTENDANCE_APPROVED → VALIDATING` transition the
system writes one row per employee satisfying:

```sql
employee.organization_id = :org
AND employee.date_of_joining <= payroll_cycle.period_end
AND (employee.date_of_exit IS NULL OR employee.date_of_exit >= payroll_cycle.period_start)
AND employee.employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD','SUSPENDED','EXITED')
```

(`SUSPENDED` and `EXITED` are in scope: a suspended employee may still be owed pay, and an
employee who left mid-month is owed their final salary. `PRE_JOINING` is not.) Each row is
then given a `disposition`, and the row is the _only_ evidence of that decision.

| Column                  | Type                            | Null | Default             | Notes                                                                                       |
| ----------------------- | ------------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------- |
| `id`                    | `uuid`                          | no   | `gen_random_uuid()` | PK                                                                                          |
| `organization_id`       | `uuid`                          | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                |
| `payroll_cycle_id`      | `uuid`                          | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE CASCADE`                                                |
| `employee_id`           | `uuid`                          | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                    |
| `validation_pass_no`    | `integer`                       | no   | —                   | The pass that produced this snapshot                                                        |
| `disposition`           | `ess_payroll_scope_disposition` | no   | —                   | `INCLUDED` \| `EXCLUDED` \| `DEFERRED`                                                      |
| `exclusion_reason_code` | `text`                          | yes  | —                   | Mandatory when not `INCLUDED`; one of the §10.6 `rule_code` values or `MANUAL`              |
| `exclusion_note`        | `text`                          | yes  | —                   | Mandatory when not `INCLUDED`, ≥ 10 chars                                                   |
| `excluded_by_user_id`   | `uuid`                          | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                    |
| `excluded_at`           | `timestamptz`                   | yes  | —                   |                                                                                             |
| `carry_to_cycle_id`     | `uuid`                          | yes  | —                   | FK → `payroll_cycle(id)` `ON DELETE SET NULL` — where a `DEFERRED` employee is paid instead |
| `attendance_record_id`  | `uuid`                          | yes  | —                   | FK → `attendance_record(id)` `ON DELETE RESTRICT`                                           |
| `salary_structure_id`   | `uuid`                          | yes  | —                   | FK → `salary_structure(id)` `ON DELETE RESTRICT`                                            |
| `payslip_id`            | `uuid`                          | yes  | —                   | FK → `payslip(id)` `ON DELETE SET NULL` — backfilled at `CALCULATED`                        |

```sql
CONSTRAINT ux_pce__cycle_employee UNIQUE (payroll_cycle_id, employee_id),
CONSTRAINT ck_pce__exclusion CHECK (
  (disposition = 'INCLUDED')
  = (num_nulls(exclusion_reason_code, exclusion_note, excluded_by_user_id, excluded_at) = 4)),
CONSTRAINT ck_pce__included_sources CHECK (
  disposition <> 'INCLUDED' OR (attendance_record_id IS NOT NULL AND salary_structure_id IS NOT NULL)),
CONSTRAINT ck_pce__deferred_target CHECK ((disposition = 'DEFERRED') = (carry_to_cycle_id IS NOT NULL)),
CONSTRAINT ck_pce__payslip_only_included CHECK (payslip_id IS NULL OR disposition = 'INCLUDED')
```

Indexes: `ix_pce__cycle_disposition (payroll_cycle_id, disposition)`,
`ix_pce__employee (employee_id, payroll_cycle_id)`.

`employee_count` at transition 8 is
`count(*) FILTER (WHERE disposition = 'INCLUDED')` over this table, and
`payroll_cycle.employee_set_sha256` is the SHA-256 of those `employee_id`s in ascending
order. Guard `payroll.employee_set_unchanged` re-derives the scope at `CALCULATING` and
compares the hash: an employee hired, exited or excluded between validation and
calculation invalidates the run rather than silently changing who gets paid. A re-run
(`validation_pass_no + 1`) replaces the previous pass's rows.

`ck_pce__payslip_only_included` is the structural reason an excluded employee cannot
acquire a payslip, and `ix_pce__employee` is what answers "you were not paid this month
because …" on the employee's own Payslips empty state, using only the whitelisted
`NOT_IN_SCOPE` outlook of §10.7 — never the raw `exclusion_note`, which is internal.

### 10.11 `payroll_correction` — the only way to change a published month

`PUBLISHED` is terminal-forward (§10.2). A real payroll still needs to fix a real error,
and without a modelled path someone will `UPDATE payslip`. This is that path.

| Column                                | Type                            | Null | Default             | Notes                                                                                    |
| ------------------------------------- | ------------------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------- |
| `id`                                  | `uuid`                          | no   | `gen_random_uuid()` | PK                                                                                       |
| `organization_id`                     | `uuid`                          | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                             |
| `payroll_cycle_id`                    | `uuid`                          | no   | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — the **published** cycle being corrected  |
| `correction_no`                       | `citext`                        | no   | —                   | `WDT-PC-2026-0007`, unique per org                                                       |
| `status`                              | `ess_payroll_correction_status` | no   | `'RAISED'`          |                                                                                          |
| `reason_code`                         | `text`                          | no   | —                   | `INPUT_ERROR`, `ATTENDANCE_ERROR`, `STRUCTURE_ERROR`, `STATUTORY_ERROR`, `COURT_ORDER`   |
| `reason_note`                         | `text`                          | no   | —                   | ≥ 20 chars                                                                               |
| `raised_by_user_id` / `raised_at`     | `uuid` / `timestamptz`          | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                 |
| `approved_by_user_id` / `approved_at` | `uuid` / `timestamptz`          | yes  | —                   |                                                                                          |
| `payroll_run_id`                      | `uuid`                          | yes  | —                   | FK → `payroll_run(id)` `ON DELETE RESTRICT` — the correction run                         |
| `settlement_cycle_id`                 | `uuid`                          | yes  | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — where the net delta is paid or recovered |
| `affected_employee_count`             | `integer`                       | no   | `0`                 |                                                                                          |
| `row_version`                         | `integer`                       | no   | `1`                 |                                                                                          |

```sql
CONSTRAINT ux_pc_corr__org_no UNIQUE (organization_id, correction_no),
CONSTRAINT ck_pc_corr__dual_control CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> raised_by_user_id),
CONSTRAINT ck_pc_corr__reason CHECK (length(btrim(reason_note)) >= 20),
CONSTRAINT ck_pc_corr__approved CHECK (num_nulls(approved_by_user_id, approved_at) IN (0, 2)),
CONSTRAINT ck_pc_corr__reason_code CHECK (reason_code IN ('INPUT_ERROR','ATTENDANCE_ERROR','STRUCTURE_ERROR','STATUTORY_ERROR','COURT_ORDER'))
```

**State machine** `machine = 'payroll_correction'`:
`NULL→RAISED` (`payroll:correction:raise`, guard `payroll.cycle_published`) ·
`RAISED→APPROVED` (`payroll:correction:approve`, guards `payroll.correction_distinct_approver`,
`approval.note_required`) · `RAISED→REJECTED` (`payroll:correction:approve`, guard
`approval.note_required`) · `APPROVED→CALCULATING` (`payroll:calculate`) ·
`CALCULATING→CALCULATED` / `CALCULATING→FAILED` (_system_) ·
`CALCULATED→PUBLISHED` (`payroll:publish`, guards `payroll.distinct_approver`,
`payroll.correction_settlement_cycle_open`). Terminal: `PUBLISHED`, `REJECTED`, `FAILED`.

Publishing a correction creates `payslip` rows at `revision = n+1` with
`supersedes_payslip_id` set, sets the superseded rows to `SUPERSEDED`, creates a fresh
`payslip_publication` for the new revision, revokes the old one with the correction's
`correction_no` as the reason, notifies each affected employee, and posts the net delta
into `settlement_cycle_id` as `ARREAR` or `ONE_OFF_DEDUCTION` input items. The original
payslip is never edited and never disappears: an employee who downloaded revision 1 can
still be shown exactly what they were shown.

### 10.12 Statutory reference data — PF, ESI and professional tax

`pay_component.calculation = 'STATUTORY_ENGINE'` and `statutory_key ∈ (EPF, ESI, PT_KA,
TDS_24Q)` referred to an engine whose rates existed nowhere in this schema. A PF rate of
12%, the ₹15,000 PF wage ceiling, the ESI threshold and Karnataka's PT slabs are **law that
changes**; as code literals they are unauditable and a past payslip stops being
reproducible the day they change. Required by WORKFLOWS.md A-4.

`statutory_rate_set` — one row per (organisation, country, effective range):
`id`, `organization_id`, `country_code char(2) NOT NULL DEFAULT 'IN'`,
`effective_from date NOT NULL`, `effective_to date NULL`,
`pf_employee_rate numeric(12,6) NOT NULL`, `pf_employer_rate numeric(12,6) NOT NULL`,
`pf_eps_rate numeric(12,6) NOT NULL`, `pf_wage_ceiling_minor money_minor NOT NULL`,
`pf_admin_charge_rate numeric(12,6) NOT NULL`,
`esi_employee_rate numeric(12,6) NOT NULL`, `esi_employer_rate numeric(12,6) NOT NULL`,
`esi_wage_threshold_minor money_minor NOT NULL`,
`esi_contribution_period_start_months smallint[] NOT NULL DEFAULT '{4,10}'`,
`gratuity_rate numeric(12,6) NOT NULL`, `ruleset_sha256 bytea NOT NULL`,
`source_reference text NOT NULL` (the gazette/notification citation).

```sql
CONSTRAINT ex_srs__no_overlap EXCLUDE USING gist (
  organization_id WITH =, country_code WITH =,
  daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&),
CONSTRAINT ck_srs__rates CHECK (
  pf_employee_rate BETWEEN 0 AND 1 AND pf_employer_rate BETWEEN 0 AND 1
  AND pf_eps_rate BETWEEN 0 AND 1 AND esi_employee_rate BETWEEN 0 AND 1
  AND esi_employer_rate BETWEEN 0 AND 1 AND gratuity_rate BETWEEN 0 AND 1)
```

`statutory_pt_slab` — professional tax by state:
`id`, `organization_id`, `state_code text NOT NULL`, `effective_from date NOT NULL`,
`effective_to date NULL`, `slab_no smallint NOT NULL`,
`from_monthly_wage_minor money_minor NOT NULL`,
`to_monthly_wage_minor money_minor NULL` (NULL = open top),
`monthly_amount_minor money_minor NOT NULL`,
`applies_in_months smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7,8,9,10,11,12}'`,
`annual_cap_minor money_minor NULL`, `source_reference text NOT NULL`.

```sql
CONSTRAINT ux_pts__org_state_from_slab UNIQUE (organization_id, state_code, effective_from, slab_no),
CONSTRAINT ck_pts__range CHECK (to_monthly_wage_minor IS NULL OR to_monthly_wage_minor > from_monthly_wage_minor),
CONSTRAINT ck_pts__amount CHECK (monthly_amount_minor >= 0)
```

`employee_statutory_election` — per employee, effective-dated:
`id`, `organization_id`, `employee_id`, `effective_from date NOT NULL`,
`effective_to date NULL`,
`pf_wage_basis text NOT NULL CHECK (pf_wage_basis IN ('CEILING','ACTUAL'))`,
`pf_applicable boolean NOT NULL DEFAULT true`,
`esi_applicable_override boolean NULL` (NULL ⇒ derive from the threshold),
`pt_state_code text NULL` (NULL ⇒ derive from the work location's `location.state`),
`vpf_rate numeric(12,6) NOT NULL DEFAULT 0 CHECK (vpf_rate BETWEEN 0 AND 1)`.

```sql
CONSTRAINT ex_ese__no_overlap EXCLUDE USING gist (
  employee_id WITH =, daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&)
```

All three are class M4 (plaintext configuration), seeded (§18.1), editable only under
`payroll:statutory:manage`, and every edit writes a `CONFIG_CHANGE` audit event. The run
resolves them by `payroll_cycle.period_end`, records the resolved row ids in
`payslip.input_snapshot`, and folds them into `payroll_run.ruleset_sha256` — so a payslip
computed under the old PF ceiling stays reproducible after the ceiling moves.

---

## 11. Reimbursement batches — the payroll ↔ expense bridge

| `reimbursement_batch` | Type                             | Null | Default             | Notes                                                                                                |
| --------------------- | -------------------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                  | `uuid`                           | no   | `gen_random_uuid()` | PK                                                                                                   |
| `organization_id`     | `uuid`                           | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                         |
| `payroll_cycle_id`    | `uuid`                           | yes  | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — **the cycle that paid it**. NULL only while `DRAFT`. |
| `batch_no`            | `citext`                         | no   | —                   | `RB-2026-09`. Unique per org.                                                                        |
| `cutoff_date`         | `date`                           | no   | —                   | `organization.expense_cutoff_day_of_month` resolved for the month                                    |
| `status`              | `ess_reimbursement_batch_status` | no   | `'DRAFT'`           |                                                                                                      |
| `claim_count`         | `integer`                        | no   | `0`                 |                                                                                                      |
| `total_amount_minor`  | `money_minor`                    | no   | `0`                 | Org-level control total (not per-employee), `payroll:reimburse` scope only                           |
| `locked_at`           | `timestamptz`                    | yes  | —                   |                                                                                                      |
| `locked_by_user_id`   | `uuid`                           | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                             |
| `paid_at`             | `timestamptz`                    | yes  | —                   | Set when the payroll cycle publishes                                                                 |
| `row_version`         | `integer`                        | no   | `1`                 |                                                                                                      |

```sql
CONSTRAINT ux_reimbursement_batch__org_no UNIQUE (organization_id, batch_no),
CONSTRAINT ck_rb__cycle_required CHECK (status = 'DRAFT' OR payroll_cycle_id IS NOT NULL),
CONSTRAINT ck_rb__totals CHECK (claim_count >= 0 AND total_amount_minor >= 0),
CONSTRAINT ck_rb__paid CHECK ((status = 'PAID') = (paid_at IS NOT NULL)),
CONSTRAINT ck_rb__locked CHECK (num_nulls(locked_at, locked_by_user_id) IN (0, 2)),
CONSTRAINT ck_rb__locked_status CHECK (status IN ('DRAFT','CANCELLED') OR locked_at IS NOT NULL)
```

`total_amount_minor` is class M2 (§1.6): an org-level control total, readable only under
`expense:reimburse`, never returned on an employee surface. The employee's own figure is
`reimbursement_batch_item.amount_minor` for their own claims.

| `reimbursement_batch_item` | Type          | Null | Default             | Notes                                                                                                     |
| -------------------------- | ------------- | ---- | ------------------- | --------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                                        |
| `organization_id`          | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                              |
| `reimbursement_batch_id`   | `uuid`        | no   | —                   | FK → `reimbursement_batch(id)` `ON DELETE CASCADE`                                                        |
| `expense_claim_id`         | `uuid`        | no   | —                   | FK → `expense_claim(id)` `ON DELETE RESTRICT`                                                             |
| `employee_id`              | `uuid`        | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                  |
| `amount_minor`             | `money_minor` | no   | —                   | Approved amount; `CHECK (amount_minor > 0)`                                                               |
| `payroll_input_item_id`    | `uuid`        | yes  | —                   | FK → `payroll_input_item(id)` `ON DELETE SET NULL` — the `REIMBURSEMENT_PAYOUT` row created for the cycle |

```sql
CONSTRAINT ux_rbi__claim UNIQUE (expense_claim_id),
CONSTRAINT ux_rbi__batch_claim UNIQUE (reimbursement_batch_id, expense_claim_id)
```

Index: `ix_rbi__employee (employee_id, reimbursement_batch_id)`.

State machine `machine = 'reimbursement_batch'`: `NULL→DRAFT` (`expense:reimburse`) ·
`DRAFT→LOCKED` (`expense:reimburse`, guard `reimb.all_claims_finance_approved`) ·
`LOCKED→SENT_TO_PAYROLL` (`expense:reimburse`, guards `reimb.cycle_inputs_open`,
`reimb.cycle_is_regular`,
creates one `payroll_input_item` of kind `REIMBURSEMENT_PAYOUT` per item) ·
`SENT_TO_PAYROLL→PAID` (system, guard `reimb.cycle_published`; moves every linked claim
to `REIMBURSED` and emits `EXPENSE_REIMBURSED` notifications) · `DRAFT|LOCKED→CANCELLED`
(`expense:reimburse`, guard `approval.note_required`).

---

## 12. Tax and benefits

### 12.1 `tax_regime` — reference data, seeded

| Column                          | Type                  | Null | Default             | Notes                                                                                                |
| ------------------------------- | --------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                            | `uuid`                | no   | `gen_random_uuid()` | PK                                                                                                   |
| `organization_id`               | `uuid`                | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                         |
| `fiscal_year_id`                | `uuid`                | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                                                          |
| `code`                          | `ess_tax_regime_code` | no   | —                   | `NEW` / `OLD`                                                                                        |
| `name`                          | `text`                | no   | —                   | `New regime` — the Tax screen chip renders `New regime · FY 2026–27` from this + `fiscal_year.label` |
| `standard_deduction_minor`      | `money_minor`         | no   | —                   | Regime-specific                                                                                      |
| `slabs`                         | `jsonb`               | no   | —                   | `[{"from_minor":"0","to_minor":"400000_00","rate":"0.00"}, …]` — minor units as strings              |
| `surcharge_rules`               | `jsonb`               | no   | `'[]'`              |                                                                                                      |
| `cess_rate`                     | `numeric(12,6)`       | no   | `0.040000`          |                                                                                                      |
| `rebate_87a_limit_minor`        | `money_minor`         | yes  | —                   |                                                                                                      |
| `allows_chapter_via_deductions` | `boolean`             | no   | —                   | `false` for `NEW`                                                                                    |
| `is_default`                    | `boolean`             | no   | `false`             | Applied when an employee makes no election                                                           |

```sql
CONSTRAINT ux_tax_regime__fy_code UNIQUE (fiscal_year_id, code),
CONSTRAINT ck_tax_regime__cess CHECK (cess_rate BETWEEN 0 AND 1),
CONSTRAINT ck_tax_regime__slabs CHECK (jsonb_typeof(slabs) = 'array' AND jsonb_array_length(slabs) >= 1)
```

```sql
CREATE UNIQUE INDEX ux_tax_regime__fy_default ON ess.tax_regime (fiscal_year_id) WHERE is_default;
```

`tax_regime.standard_deduction_minor` and `.cess_rate` are the **only** sources for those
two figures (§4.6). `slabs` is validated at seed time against a JSON Schema: an ordered,
gap-free, non-overlapping array of `{from_minor, to_minor|null, rate}` whose first
`from_minor` is `"0"`, whose amounts are minor-unit strings and whose rates are decimal
strings in `[0,1]`. A malformed slab table is a payroll-wide miscalculation, so it is
rejected at load, not at the first payslip.

### 12.2 `employee_tax_regime_election`

| Column               | Type          | Null | Default             | Notes                                             |
| -------------------- | ------------- | ---- | ------------------- | ------------------------------------------------- |
| `id`                 | `uuid`        | no   | `gen_random_uuid()` | PK                                                |
| `organization_id`    | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`      |
| `employee_id`        | `uuid`        | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`           |
| `fiscal_year_id`     | `uuid`        | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`       |
| `tax_regime_id`      | `uuid`        | no   | —                   | FK → `tax_regime(id)` `ON DELETE RESTRICT`        |
| `elected_at`         | `timestamptz` | no   | `now()`             |                                                   |
| `elected_by_user_id` | `uuid`        | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`          |
| `is_locked`          | `boolean`     | no   | `false`             | Locked once the first payslip of the FY publishes |
| `locked_at`          | `timestamptz` | yes  | —                   |                                                   |

```sql
CONSTRAINT ux_etre__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_etre__locked CHECK (is_locked = (locked_at IS NOT NULL))
```

### 12.3 `employee_tax_declaration` and `employee_tax_declaration_item`

| `employee_tax_declaration`                 | Type                         | Null | Default             | Notes                                                       |
| ------------------------------------------ | ---------------------------- | ---- | ------------------- | ----------------------------------------------------------- |
| `id`                                       | `uuid`                       | no   | `gen_random_uuid()` | PK                                                          |
| `organization_id`                          | `uuid`                       | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                |
| `employee_id`                              | `uuid`                       | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                     |
| `fiscal_year_id`                           | `uuid`                       | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                 |
| `tax_regime_id`                            | `uuid`                       | no   | —                   | FK → `tax_regime(id)` `ON DELETE RESTRICT`                  |
| `status`                                   | `ess_tax_declaration_status` | no   | `'DRAFT'`           |                                                             |
| `form_reference`                           | `text`                       | no   | `'12BB'`            | The Tax screen's "Investment declaration · Form 12BB"       |
| `submitted_at`                             | `timestamptz`                | yes  | —                   | Renders "Declared on 18 Apr 2026"                           |
| `proof_submitted_at`                       | `timestamptz`                | yes  | —                   |                                                             |
| `verified_at`                              | `timestamptz`                | yes  | —                   |                                                             |
| `verified_by_user_id`                      | `uuid`                       | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                    |
| `rejection_reason`                         | `text`                       | yes  | —                   |                                                             |
| `declared_total_minor_ct/_iv/_tag/_dek_id` | envelope (no mask)           | yes  | —                   | Encrypted; sum of items, recomputed server-side             |
| `verified_total_minor_ct/…`                | envelope                     | yes  | —                   | Encrypted; amount actually allowed after proof verification |
| `row_version`                              | `integer`                    | no   | `1`                 |                                                             |

```sql
CONSTRAINT ux_etd__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_etd__submitted CHECK (status = 'DRAFT' OR submitted_at IS NOT NULL),
CONSTRAINT ck_etd__verified CHECK (num_nulls(verified_at, verified_by_user_id) IN (0, 2)),
CONSTRAINT ck_etd__rejected CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL)
```

| `employee_tax_declaration_item`             | Type               | Null | Default             | Notes                                                      |
| ------------------------------------------- | ------------------ | ---- | ------------------- | ---------------------------------------------------------- |
| `id`                                        | `uuid`             | no   | `gen_random_uuid()` | PK                                                         |
| `organization_id`                           | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`               |
| `employee_tax_declaration_id`               | `uuid`             | no   | —                   | FK → `employee_tax_declaration(id)` `ON DELETE CASCADE`    |
| `section_code`                              | `text`             | no   | —                   | `80C`, `80D`, `80CCD1B`, `24B`, `HRA`, `LTA`               |
| `sub_category`                              | `text`             | yes  | —                   | `ELSS`, `PPF`, `Life insurance premium`                    |
| `declared_amount_minor_ct/_iv/_tag/_dek_id` | envelope (no mask) | no   | —                   | Encrypted                                                  |
| `verified_amount_minor_ct/…`                | envelope           | yes  | —                   | Encrypted                                                  |
| `proof_file_object_id`                      | `uuid`             | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                |
| `proof_status`                              | `text`             | no   | `'NOT_SUBMITTED'`   | `NOT_SUBMITTED` \| `SUBMITTED` \| `ACCEPTED` \| `REJECTED` |
| `reviewer_note`                             | `text`             | yes  | —                   |                                                            |
| `display_order`                             | `smallint`         | no   | `0`                 |                                                            |

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

| Column                              | Type            | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------- | --------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                | `uuid`          | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                              |
| `organization_id`                   | `uuid`          | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                    |
| `employee_id`                       | `uuid`          | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                         |
| `fiscal_year_id`                    | `uuid`          | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                     |
| `payroll_run_id`                    | `uuid`          | no   | —                   | FK → `payroll_run(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                     |
| `tax_regime_id`                     | `uuid`          | no   | —                   | FK → `tax_regime(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                      |
| `as_of_period_code`                 | `text`          | no   | —                   | `2026-08`                                                                                                                                                                                                                                                                                                                       |
| `projected_gross_minor`             | `money_minor`   | no   | —                   | → "Projected gross"                                                                                                                                                                                                                                                                                                             |
| `standard_deduction_minor`          | `money_minor`   | no   | —                   | → "Standard deduction"                                                                                                                                                                                                                                                                                                          |
| `declared_deductions_minor`         | `money_minor`   | no   | `0`                 | Chapter VI-A allowed under the regime                                                                                                                                                                                                                                                                                           |
| `taxable_income_minor`              | `money_minor`   | no   | —                   |                                                                                                                                                                                                                                                                                                                                 |
| `tax_before_cess_minor`             | `money_minor`   | no   | —                   |                                                                                                                                                                                                                                                                                                                                 |
| `surcharge_minor`                   | `money_minor`   | no   | `0`                 |                                                                                                                                                                                                                                                                                                                                 |
| `cess_minor`                        | `money_minor`   | no   | —                   |                                                                                                                                                                                                                                                                                                                                 |
| `projected_annual_tax_minor`        | `money_minor`   | no   | —                   | → the headline "₹2,74,320 · Projected annual tax including 4% cess"                                                                                                                                                                                                                                                             |
| `tds_deducted_to_date_minor`        | `money_minor`   | no   | —                   | Σ of published payslips' TDS in this FY at run time → "Deducted Apr – Aug"                                                                                                                                                                                                                                                      |
| `tds_remaining_minor`               | `money_minor`   | no   | _(generated)_       | `GENERATED ALWAYS AS (greatest(projected_annual_tax_minor - tds_deducted_to_date_minor, 0)) STORED` → "₹1,58,090 remaining"                                                                                                                                                                                                     |
| `remaining_months`                  | `smallint`      | no   | —                   | Payroll cycles left in the FY → "over 7 months"                                                                                                                                                                                                                                                                                 |
| `monthly_tds_minor`                 | `money_minor`   | no   | —                   | This period's TDS → "Monthly TDS"                                                                                                                                                                                                                                                                                               |
| `next_month_tds_estimate_minor`     | `money_minor`   | no   | —                   | `CASE WHEN remaining_months = 0 THEN tds_remaining_minor ELSE ceil(tds_remaining_minor::numeric / remaining_months) END`. **Corrected:** `remaining_months` is `CHECK (… BETWEEN 0 AND 12)`, and it is legitimately `0` for the March cycle — the previous formula divided by zero on the last payroll of every financial year. |
| `resolved_standard_deduction_minor` | `money_minor`   | no   | —                   | The `tax_regime.standard_deduction_minor` actually applied                                                                                                                                                                                                                                                                      |
| `resolved_cess_rate`                | `numeric(12,6)` | no   | —                   | The `tax_regime.cess_rate` actually applied — so the Tax screen's "including 4% cess" is read from the projection, and a later correction to the regime table does not retroactively change what a past projection says it did                                                                                                  |
| `comparison_tax_regime_id`          | `uuid`          | yes  | —                   | FK → `tax_regime(id)` `ON DELETE RESTRICT` — the _other_ regime for this FY                                                                                                                                                                                                                                                     |
| `comparison_annual_tax_minor`       | `money_minor`   | yes  | —                   | The same projection recomputed under `comparison_tax_regime_id`. This is what makes the prototype's "Compare regime" action ("Old regime would cost ₹18,240 more this year") a **persisted, reproducible figure** rather than a number invented at click time. `NULL` ⇒ the button is not rendered.                             |
| `comparison_delta_minor`            | `money_minor`   | yes  | —                   | `comparison_annual_tax_minor - projected_annual_tax_minor`, **signed**; the only signed money column in this table                                                                                                                                                                                                              |
| `is_current`                        | `boolean`       | no   | `false`             | Exactly one current row per employee/FY                                                                                                                                                                                                                                                                                         |
| `computed_at`                       | `timestamptz`   | no   | `now()`             |                                                                                                                                                                                                                                                                                                                                 |

```sql
CONSTRAINT ux_etp__employee_fy_run UNIQUE (employee_id, fiscal_year_id, payroll_run_id),
CONSTRAINT ck_etp__nonneg CHECK (
  projected_gross_minor >= 0 AND standard_deduction_minor >= 0 AND declared_deductions_minor >= 0
  AND taxable_income_minor >= 0 AND tax_before_cess_minor >= 0 AND surcharge_minor >= 0
  AND cess_minor >= 0 AND projected_annual_tax_minor >= 0 AND tds_deducted_to_date_minor >= 0
  AND monthly_tds_minor >= 0 AND next_month_tds_estimate_minor >= 0),
CONSTRAINT ck_etp__months CHECK (remaining_months BETWEEN 0 AND 12),
CONSTRAINT ck_etp__comparison CHECK (
  num_nulls(comparison_tax_regime_id, comparison_annual_tax_minor, comparison_delta_minor) IN (0, 3)),
CONSTRAINT ck_etp__comparison_regime CHECK (
  comparison_tax_regime_id IS NULL OR comparison_tax_regime_id <> tax_regime_id),
CONSTRAINT ck_etp__resolved CHECK (resolved_cess_rate BETWEEN 0 AND 1)
```

```sql
CREATE UNIQUE INDEX ux_etp__one_current ON ess.employee_tax_projection (employee_id, fiscal_year_id)
  WHERE is_current;   -- §1.2
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

One row per employee per FY quarter. **Corrected:** the previous text said these rows are
"created when the FY is seeded", which is impossible and contradicts §18.2 — `tds_quarter`
is listed there as a table that must start empty, and at FY-seed time there are no
employees to create rows for. Rows are created by the `tds-quarter-refresh` job when an
employee first becomes in-scope for a cycle in that FY, and by the same job after every
publication.

The Tax screen therefore renders all four quarters by **left-joining `fiscal_quarter`**,
not by requiring four `tds_quarter` rows:

```sql
SELECT fq.quarter_no, fq.label, tq.status, tq.tds_deducted_minor
  FROM fiscal_quarter fq
  LEFT JOIN tds_quarter tq
    ON tq.fiscal_quarter_id = fq.id AND tq.employee_id = :me
 WHERE fq.fiscal_year_id = :fy
 ORDER BY fq.quarter_no;
```

A missing row and an `UPCOMING` row both render `—` with the gray `Upcoming` chip —
exactly the prototype's Q3/Q4 behaviour, and in both cases a persisted absence rather than
a fabricated zero.

| Column               | Type                     | Null | Default             | Notes                                                                                                                         |
| -------------------- | ------------------------ | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | `uuid`                   | no   | `gen_random_uuid()` | PK                                                                                                                            |
| `organization_id`    | `uuid`                   | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                  |
| `employee_id`        | `uuid`                   | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                       |
| `fiscal_quarter_id`  | `uuid`                   | no   | —                   | FK → `fiscal_quarter(id)` `ON DELETE RESTRICT`                                                                                |
| `status`             | `ess_tds_quarter_status` | no   | `'UPCOMING'`        |                                                                                                                               |
| `tds_deducted_minor` | `money_minor`            | yes  | —                   | `NULL` while `UPCOMING`. Recomputed as Σ `payslip.tds_minor` over published payslips whose `period_end` falls in the quarter. |
| `payslip_count`      | `integer`                | no   | `0`                 |                                                                                                                               |
| `source_payslip_ids` | `uuid[]`                 | no   | `'{}'`              | Traceability                                                                                                                  |
| `form_24q_ack_no`    | `text`                   | yes  | —                   | Set when filed                                                                                                                |
| `filed_at`           | `timestamptz`            | yes  | —                   |                                                                                                                               |
| `filed_by_user_id`   | `uuid`                   | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                      |
| `revised_at`         | `timestamptz`            | yes  | —                   |                                                                                                                               |
| `recomputed_at`      | `timestamptz`            | no   | `now()`             |                                                                                                                               |

```sql
CONSTRAINT ux_tds_quarter__employee_quarter UNIQUE (employee_id, fiscal_quarter_id),
CONSTRAINT ck_tdsq__amount CHECK (tds_deducted_minor IS NULL OR tds_deducted_minor >= 0),
CONSTRAINT ck_tdsq__upcoming_null CHECK (status <> 'UPCOMING' OR tds_deducted_minor IS NULL),
CONSTRAINT ck_tdsq__filed CHECK ((status IN ('FILED','REVISED')) = (filed_at IS NOT NULL)),
CONSTRAINT ck_tdsq__filed_ack CHECK (status <> 'FILED' OR form_24q_ack_no IS NOT NULL)
```

Index: `ix_tdsq__employee_fq (employee_id, fiscal_quarter_id)`.

**Status derivation (deterministic, total, run nightly and after every publication).**
Evaluated top-down; the first matching rule wins, so the function is total and two
implementers cannot disagree:

| #   | Condition                                                                      | Status        |
| --- | ------------------------------------------------------------------------------ | ------------- |
| 1   | `filed_at IS NOT NULL AND revised_at IS NOT NULL`                              | `REVISED`     |
| 2   | `filed_at IS NOT NULL`                                                         | `FILED`       |
| 3   | `fiscal_quarter.start_date > CURRENT_DATE`                                     | `UPCOMING`    |
| 4   | otherwise (the quarter has started, whether or not a payslip exists in it yet) | `IN_PROGRESS` |

Rules 1–2 are set by Accounts under `tax:quarter:manage`; 3–4 are derived. The previous
wording made rules 3 and 4 overlap — a quarter that had started _and_ contained no payslip
satisfied neither branch cleanly — and left a past quarter with no payslips undefined.
`tds_deducted_minor` is `NULL` while `UPCOMING` (`ck_tdsq__upcoming_null`) and is otherwise
the API-folded sum of the decrypted `payslip.tds_minor` over published payslips whose
`period_end` falls in the quarter, re-encrypted into this row (class M1, §1.6);
`source_payslip_ids` records exactly which slips were folded and
`payslip_count = cardinality(source_payslip_ids)`.
Chip tones follow Design System §1: `FILED`→green, `IN_PROGRESS`→amber,
`UPCOMING`→gray, `REVISED`→blue.

### 12.6 `form16_document`

| Column                | Type                | Null | Default             | Notes                                                              |
| --------------------- | ------------------- | ---- | ------------------- | ------------------------------------------------------------------ |
| `id`                  | `uuid`              | no   | `gen_random_uuid()` | PK                                                                 |
| `organization_id`     | `uuid`              | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                       |
| `employee_id`         | `uuid`              | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                            |
| `fiscal_year_id`      | `uuid`              | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                        |
| `status`              | `ess_form16_status` | no   | `'PENDING'`         |                                                                    |
| `revision`            | `smallint`          | no   | `1`                 |                                                                    |
| `file_object_id`      | `uuid`              | yes  | —                   | FK → `file_object(id)` `ON DELETE RESTRICT`. NULL while `PENDING`. |
| `file_name`           | `text`              | yes  | —                   | `Form16_FY2025-26.pdf` — the exact string the row renders          |
| `includes_part_a`     | `boolean`           | no   | `true`              |                                                                    |
| `includes_part_b`     | `boolean`           | no   | `true`              |                                                                    |
| `is_digitally_signed` | `boolean`           | no   | `false`             | Drives the card sub-label "Part A and Part B · digitally signed"   |
| `traces_ack_no`       | `text`              | yes  | —                   |                                                                    |
| `issued_at`           | `timestamptz`       | yes  | —                   | Renders "Issued 12 Jun 2026"                                       |
| `issued_by_user_id`   | `uuid`              | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                           |
| `withdrawn_at`        | `timestamptz`       | yes  | —                   |                                                                    |
| `withdrawn_reason`    | `text`              | yes  | —                   |                                                                    |

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

| `benefit_plan`         | Type                   | Null | Default             | Notes                                                     |
| ---------------------- | ---------------------- | ---- | ------------------- | --------------------------------------------------------- |
| `id`                   | `uuid`                 | no   | `gen_random_uuid()` | PK                                                        |
| `organization_id`      | `uuid`                 | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`              |
| `code`                 | `citext`               | no   | —                   | `GMC`, `GTL`, `NPS`                                       |
| `name`                 | `text`                 | no   | —                   | `Group health insurance`                                  |
| `category`             | `ess_benefit_category` | no   | —                   | Renders the card eyebrow (`Health`, `Life`, `Retirement`) |
| `provider_name`        | `text`                 | yes  | —                   | `ICICI Lombard`                                           |
| `policy_reference`     | `text`                 | yes  | —                   | `WDT-GMC-2026`                                            |
| `description`          | `text`                 | yes  | —                   |                                                           |
| `primary_action`       | `ess_benefit_action`   | no   | `'NONE'`            | Drives the card button. `NONE` ⇒ no button is rendered.   |
| `primary_action_label` | `text`                 | yes  | —                   | `Download e-card` — persisted, not hardcoded              |
| `supports_dependents`  | `boolean`              | no   | `false`             |                                                           |
| `max_dependents`       | `smallint`             | yes  | —                   |                                                           |
| `display_order`        | `smallint`             | no   | `0`                 |                                                           |
| `is_active`            | `boolean`              | no   | `true`              |                                                           |

```sql
CONSTRAINT ux_benefit_plan__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_benefit_plan__action_label CHECK ((primary_action = 'NONE') = (primary_action_label IS NULL))
```

| `benefit_plan_year`                      | Type                        | Null | Default             | Notes                                                                                                                                                |
| ---------------------------------------- | --------------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                     | `uuid`                      | no   | `gen_random_uuid()` | PK                                                                                                                                                   |
| `organization_id`                        | `uuid`                      | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                         |
| `benefit_plan_id`                        | `uuid`                      | no   | —                   | FK → `benefit_plan(id)` `ON DELETE CASCADE`                                                                                                          |
| `fiscal_year_id`                         | `uuid`                      | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                                                                                                          |
| `label`                                  | `text`                      | no   | —                   | `Plan year Apr 2026 – Mar 2027` — the Benefits sub-header, persisted                                                                                 |
| `coverage_kind`                          | `ess_benefit_coverage_kind` | no   | —                   |                                                                                                                                                      |
| `coverage_amount_minor`                  | `money_minor`               | yes  | —                   | `500000_00` → `₹5,00,000`                                                                                                                            |
| `coverage_multiple`                      | `numeric(6,2)`              | yes  | —                   | `3.00` → `3× annual CTC`                                                                                                                             |
| `coverage_rate`                          | `numeric(12,6)`             | yes  | —                   | `0.100000` → NPS "10% of basic"                                                                                                                      |
| `employer_contribution_pay_component_id` | `uuid`                      | yes  | —                   | FK → `pay_component(id)` `ON DELETE RESTRICT` — makes the NPS card's `₹8,600 / mo` a **read of the employee's own payslip line**, not a stored guess |
| `enrolment_window_opens_on`              | `date`                      | yes  | —                   | `2026-04-01` — the "Add dependent" window                                                                                                            |
| `enrolment_window_closes_on`             | `date`                      | yes  | —                   | `2026-04-15`                                                                                                                                         |
| `plan_document_file_object_id`           | `uuid`                      | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                                                                                                          |
| `is_active`                              | `boolean`                   | no   | `true`              |                                                                                                                                                      |

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

### 12.7.1 Benefit plan year — state and empty behaviour

`benefit_plan_year` rows are configuration and may legitimately not exist for the current
FY (a plan not yet renewed). When no `benefit_plan_year` exists for the current
`fiscal_year`, the Benefits screen renders its empty state with the plan-year sub-header
omitted entirely — it does **not** fall back to last year's coverage figures, which would
show an employee a sum insured that is not in force.

When `coverage_kind = 'MONTHLY_AMOUNT'` and `employer_contribution_pay_component_id` is
set (the NPS card's `₹8,600 / mo`), the value is the **decrypted amount of that component
on the employee's latest published payslip**. With no published payslip the card renders
`—` with the sub-label from `ui_copy` key `empty.benefits.no_payslip_yet`
("Your contribution appears after your first payslip"). It never falls back to
`coverage_amount_minor`, because that is a plan-level figure and rendering it as the
employee's own contribution would be a fabricated personal number.

### 12.8 `benefit_enrolment`, `benefit_enrolment_dependent`

| `benefit_enrolment`           | Type                           | Null | Default             | Notes                                                                                                                                                                                            |
| ----------------------------- | ------------------------------ | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                          | `uuid`                         | no   | `gen_random_uuid()` | PK                                                                                                                                                                                               |
| `organization_id`             | `uuid`                         | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                     |
| `employee_id`                 | `uuid`                         | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                                                          |
| `benefit_plan_year_id`        | `uuid`                         | no   | —                   | FK → `benefit_plan_year(id)` `ON DELETE RESTRICT`                                                                                                                                                |
| `status`                      | `ess_benefit_enrolment_status` | no   | `'ELIGIBLE'`        | Only `ENROLLED` rows render a Benefits card                                                                                                                                                      |
| `member_reference`            | `text`                         | yes  | —                   | `••••4471` style masked member/PRAN id supplied by the provider; stored already masked (the full id lives in `employee_statutory_id`)                                                            |
| `sum_insured_minor`           | `money_minor`                  | yes  | —                   | Per-employee override of the plan-year coverage; `NULL` ⇒ use the plan year's                                                                                                                    |
| `employee_contribution_minor` | `money_minor`                  | yes  | —                   |                                                                                                                                                                                                  |
| `enrolled_at`                 | `timestamptz`                  | yes  | —                   |                                                                                                                                                                                                  |
| `effective_from`              | `date`                         | no   | —                   |                                                                                                                                                                                                  |
| `effective_to`                | `date`                         | yes  | —                   |                                                                                                                                                                                                  |
| `ecard_file_object_id`        | `uuid`                         | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`. NULL ⇒ the "Download e-card" button renders disabled with the reason "E-cards are issued from 1 Oct" (from `benefit_plan_year`), never a dead link. |
| `waiver_reason`               | `text`                         | yes  | —                   |                                                                                                                                                                                                  |
| `row_version`                 | `integer`                      | no   | `1`                 |                                                                                                                                                                                                  |

```sql
CONSTRAINT ux_be__employee_plan_year UNIQUE (employee_id, benefit_plan_year_id),
CONSTRAINT ck_be__enrolled CHECK ((status = 'ENROLLED') = (enrolled_at IS NOT NULL)),
CONSTRAINT ck_be__waived CHECK (status <> 'WAIVED' OR waiver_reason IS NOT NULL),
CONSTRAINT ck_be__range CHECK (effective_to IS NULL OR effective_to >= effective_from),
CONSTRAINT ck_be__amounts CHECK (
  coalesce(sum_insured_minor,0) >= 0 AND coalesce(employee_contribution_minor,0) >= 0)
```

Index: `ix_be__employee_active (employee_id, status) WHERE status = 'ENROLLED'`.

**State machine** `machine = 'benefit_enrolment'`:
`NULL→ELIGIBLE` (_system_, on plan-year publication for each matching employee) ·
`ELIGIBLE→ENROLLED` (`benefit:enrol:self` or `benefit:manage`, guard
`benefit.enrolment_window_open`) · `ELIGIBLE→WAIVED` (`benefit:enrol:self`, guard
`benefit.waiver_reason_present`) · `ENROLLED→PENDING_DOCUMENTS` (`benefit:manage`) ·
`PENDING_DOCUMENTS→ENROLLED` (`benefit:manage`, guard `benefit.documents_clean`) ·
`ENROLLED→TERMINATED` (`benefit:manage`, guard `approval.note_required`) ·
`ENROLLED|PENDING_DOCUMENTS→LAPSED` (_system_, at `effective_to`).
Terminal: `TERMINATED`, `LAPSED`.

**`primary_action = 'CHANGE_CONTRIBUTION'` and `'ADD_DEPENDENT'` are requests, not writes.**
The prototype's "Change contribution" button toasts "Contribution changes apply from the
next payroll", and "Add dependent" is window-bounded. Neither may write directly: a
contribution change alters a payroll input, and a dependent addition alters an insurer's
covered-lives list. Both create a `helpdesk_ticket` in the `BENEFITS` category with
`related_entity_type = 'benefit_enrolment'` and `related_entity_id` set, and the toast
shows the **persisted** `ticket_no`. The button is rendered disabled, with the persisted
window dates from `benefit_plan_year.enrolment_window_*` as its reason, outside the
window. There is no code path that changes `employee_contribution_minor` without a ticket
and a `benefit:manage` action against it.

| `benefit_enrolment_dependent` | Type   | Null | Default | Notes                                            |
| ----------------------------- | ------ | ---- | ------- | ------------------------------------------------ |
| `benefit_enrolment_id`        | `uuid` | no   | —       | FK → `benefit_enrolment(id)` `ON DELETE CASCADE` |
| `dependent_id`                | `uuid` | no   | —       | FK → `dependent(id)` `ON DELETE RESTRICT`        |
| `covered_from`                | `date` | no   | —       |                                                  |
| `covered_to`                  | `date` | yes  | —       |                                                  |
| `added_by_user_id`            | `uuid` | yes  | —       | FK → `app_user(id)` `ON DELETE SET NULL`         |

```sql
PRIMARY KEY (benefit_enrolment_id, dependent_id),
CONSTRAINT ck_bed__range CHECK (covered_to IS NULL OR covered_to >= covered_from)
```

### 12.9 `dependent` and `nominee`

| `dependent`                               | Type                         | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ---------------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                      | `uuid`                       | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                |
| `organization_id`                         | `uuid`                       | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                      |
| `employee_id`                             | `uuid`                       | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                                                                                                           |
| `full_name_ct/_iv/_tag/_dek_id/_mask`     | envelope                     | no   | —                   | **Mask = initials only.** A mask is one stored string; the previous note ("full name to the owning employee, initials-only to anyone else") described two different values in one column, which is unimplementable. The owning employee's view of the full name comes from **decrypting** `full_name_ct` — a per-reader authorization decision, which is where it belongs — and every other reader gets the mask. |
| `initials`                                | `text`                       | no   | —                   | `KR` — stored plaintext so the avatar renders without decrypting                                                                                                                                                                                                                                                                                                                                                  |
| `relationship`                            | `ess_dependent_relationship` | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `date_of_birth_ct/_iv/_tag/_dek_id/_mask` | envelope                     | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `age_years`                               | `smallint`                   | no   | _(maintained)_      | Recomputed nightly by `dependent-age-refresh` from the encrypted DOB, so the card can render `33 years` without a decrypt on every read                                                                                                                                                                                                                                                                           |
| `gender`                                  | `ess_gender`                 | no   | `'UNDISCLOSED'`     |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `is_verified`                             | `boolean`                    | no   | `false`             |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `verified_at`                             | `timestamptz`                | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `verified_by_user_id`                     | `uuid`                       | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                                                                                          |
| `proof_file_object_id`                    | `uuid`                       | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                                                                                       |
| `is_active`                               | `boolean`                    | no   | `true`              |                                                                                                                                                                                                                                                                                                                                                                                                                   |

```sql
CONSTRAINT ck_dependent__age CHECK (age_years BETWEEN 0 AND 130),
CONSTRAINT ck_dependent__initials CHECK (initials ~ '^[A-Z]{1,3}$'),
CONSTRAINT ck_dependent__verified CHECK (num_nulls(verified_at, verified_by_user_id) IN (0, 2))
```

Index: `ix_dependent__employee_active (employee_id) WHERE is_active`.

| `nominee`                             | Type           | Null | Default             | Notes                                                                                   |
| ------------------------------------- | -------------- | ---- | ------------------- | --------------------------------------------------------------------------------------- |
| `id`                                  | `uuid`         | no   | `gen_random_uuid()` | PK                                                                                      |
| `organization_id`                     | `uuid`         | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                            |
| `employee_id`                         | `uuid`         | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                 |
| `benefit_plan_id`                     | `uuid`         | yes  | —                   | FK → `benefit_plan(id)` `ON DELETE CASCADE`. NULL = a general (PF/gratuity) nomination. |
| `dependent_id`                        | `uuid`         | yes  | —                   | FK → `dependent(id)` `ON DELETE RESTRICT` — when the nominee is an existing dependent   |
| `full_name_ct/_iv/_tag/_dek_id/_mask` | envelope       | yes  | —                   | Required when `dependent_id IS NULL`                                                    |
| `relationship_ct/…`                   | envelope       | yes  | —                   |                                                                                         |
| `share_percent`                       | `numeric(5,2)` | no   | —                   | `100.00` — renders `Nominee: Karthik Raghavan (100%)`                                   |
| `is_active`                           | `boolean`      | no   | `true`              |                                                                                         |

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

| `expense_category`             | Type          | Null | Default             | Notes                                                                                                           |
| ------------------------------ | ------------- | ---- | ------------------- | --------------------------------------------------------------------------------------------------------------- |
| `id`                           | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                                              |
| `organization_id`              | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                    |
| `code`                         | `citext`      | no   | —                   | `TRAVEL`, `MEALS`, `REMOTE_WORK`, `EQUIPMENT`, `LEARNING`, `OTHER`                                              |
| `name`                         | `text`        | no   | —                   | `Travel`, `Meals & entertainment`, `Remote work`, `Equipment`, `Learning`, `Other` — the exact dropdown options |
| `requires_receipt`             | `boolean`     | no   | `true`              |                                                                                                                 |
| `receipt_required_above_minor` | `money_minor` | yes  | —                   |                                                                                                                 |
| `requires_finance_approval`    | `boolean`     | no   | `true`              | `false` ⇒ manager approval settles the claim                                                                    |
| `default_pay_component_id`     | `uuid`        | yes  | —                   | FK → `pay_component(id)` `ON DELETE RESTRICT` — which payslip line the reimbursement lands on                   |
| `gl_code`                      | `text`        | yes  | —                   |                                                                                                                 |
| `display_order`                | `smallint`    | no   | `0`                 |                                                                                                                 |
| `is_active`                    | `boolean`     | no   | `true`              |                                                                                                                 |

```sql
CONSTRAINT ux_expense_category__org_code UNIQUE (organization_id, code)
```

| `expense_limit`            | Type                      | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`                    | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `organization_id`          | `uuid`                    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `expense_category_id`      | `uuid`                    | no   | —                   | FK → `expense_category(id)` `ON DELETE CASCADE`                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `basis`                    | `ess_expense_limit_basis` | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cap_amount_minor`         | `money_minor`             | no   | —                   | `1500_00` = the ₹1,500 monthly internet cap                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `applies_employment_types` | `ess_employment_type[]`   | no   | `'{}'`              | Empty = all                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `applies_job_level_min`    | `smallint`                | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `applies_job_level_max`    | `smallint`                | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `effective_from`           | `date`                    | no   | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `effective_to`             | `date`                    | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `source_policy_version_id` | `uuid`                    | yes  | —                   | FK → `policy_version(id)` `ON DELETE SET NULL` — the Travel & Expense Policy version that set the cap                                                                                                                                                                                                                                                                                                                                                               |
| `is_hard_limit`            | `boolean`                 | no   | `true`              | `true` ⇒ submission blocked; `false` ⇒ flagged for finance                                                                                                                                                                                                                                                                                                                                                                                                          |
| `escalation_amount_minor`  | `money_minor`             | yes  | —                   | **Added** — SECURITY.md §4.4 requires skip-level approval above a threshold and states the rule is "data-driven from `expense_policy_limit`, not hardcoded". A claim whose `total_amount_minor` exceeds this routes to the approver's **own** manager (`employee_reporting_closure` `depth = 2` above the claimant) instead of the direct manager. `NULL` ⇒ no skip-level rule for this category. Requires the approver to hold `expense:claim:approve:skip_level`. |

```sql
CONSTRAINT ck_expense_limit__cap CHECK (cap_amount_minor > 0),
CONSTRAINT ck_expense_limit__escalation CHECK (escalation_amount_minor IS NULL OR escalation_amount_minor > 0),
CONSTRAINT ck_expense_limit__levels CHECK (
  applies_job_level_min IS NULL OR applies_job_level_max IS NULL
  OR applies_job_level_max >= applies_job_level_min),
CONSTRAINT ex_expense_limit__no_overlap EXCLUDE USING gist (
  expense_category_id WITH =, basis WITH =,
  daterange(effective_from, coalesce(effective_to,'infinity'::date), '[]') WITH &&)
```

### 13.2 `expense_claim`, `expense_claim_line`, `expense_attachment`

| `expense_claim`              | Type                       | Null | Default             | Notes                                                                                                                |
| ---------------------------- | -------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `id`                         | `uuid`                     | no   | `gen_random_uuid()` | PK                                                                                                                   |
| `organization_id`            | `uuid`                     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                         |
| `claim_no`                   | `citext`                   | no   | —                   | `EXP-2291`. Unique per org, from `expense_claim_seq`.                                                                |
| `employee_id`                | `uuid`                     | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                             |
| `fiscal_year_id`             | `uuid`                     | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT` — derived from `spend_date`                                              |
| `title`                      | `text`                     | no   | —                   | The claim description, e.g. `Client visit — cab rides`                                                               |
| `expense_category_id`        | `uuid`                     | no   | —                   | FK → `expense_category(id)` `ON DELETE RESTRICT` — header category (single-category claims, as the prototype's form) |
| `spend_date`                 | `date`                     | no   | —                   | `24 Sep 2026`                                                                                                        |
| `total_amount_minor`         | `money_minor`              | no   | —                   | Maintained by trigger as Σ `expense_claim_line.amount_minor`                                                         |
| `approved_amount_minor`      | `money_minor`              | yes  | —                   | May be less than claimed after partial approval                                                                      |
| `currency_code`              | `char(3)`                  | no   | `'INR'`             |                                                                                                                      |
| `status`                     | `ess_expense_claim_status` | no   | `'DRAFT'`           |                                                                                                                      |
| `submitted_at`               | `timestamptz`              | yes  | —                   |                                                                                                                      |
| `manager_employee_id`        | `uuid`                     | yes  | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — snapshot of the approver at submit                                        |
| `manager_decided_at`         | `timestamptz`              | yes  | —                   |                                                                                                                      |
| `manager_decided_by_user_id` | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                             |
| `manager_note`               | `text`                     | yes  | —                   | Rejection reason, rendered as the claim's sub-note (`Use the L&D budget flow`)                                       |
| `finance_decided_at`         | `timestamptz`              | yes  | —                   |                                                                                                                      |
| `finance_decided_by_user_id` | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                             |
| `finance_note`               | `text`                     | yes  | —                   |                                                                                                                      |
| `reimbursement_batch_id`     | `uuid`                     | yes  | —                   | FK → `reimbursement_batch(id)` `ON DELETE SET NULL`                                                                  |
| `reimbursed_at`              | `timestamptz`              | yes  | —                   |                                                                                                                      |
| `paid_in_payroll_cycle_id`   | `uuid`                     | yes  | —                   | FK → `payroll_cycle(id)` `ON DELETE RESTRICT` — "paid with September salary" is a **join**, not a caption            |
| `policy_flag_codes`          | `text[]`                   | no   | `'{}'`              | `LIMIT_EXCEEDED`, `LATE_SUBMISSION`, `MISSING_RECEIPT`                                                               |
| `withdrawn_at`               | `timestamptz`              | yes  | —                   |                                                                                                                      |
| `row_version`                | `integer`                  | no   | `1`                 |                                                                                                                      |

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
CONSTRAINT ck_ec__flags CHECK (policy_flag_codes <@ ARRAY['LIMIT_EXCEEDED','LATE_SUBMISSION','MISSING_RECEIPT','SKIP_LEVEL_REQUIRED']::text[])
```

`spend_date <= CURRENT_DATE` is enforced by trigger `trg_expense_claim_spend_not_future`
(`BEFORE INSERT OR UPDATE`), **not** by a `CHECK`. `CURRENT_DATE` is `STABLE`, not
`IMMUTABLE`: as a `CHECK` it would pass at insert and then poison the row — every later
`UPDATE` of a claim, and every `pg_restore`, re-evaluates the constraint against a
_different_ today, and for a `spend_date` in the future relative to the restore point it
fails, making the row unrestorable (§1.2).

`SKIP_LEVEL_REQUIRED` is set at submit when `total_amount_minor >
expense_limit.escalation_amount_minor`; it is what makes the routing decision visible on
the claim rather than implicit in the approver id.
Indexes:

- `ix_ec__employee_status (employee_id, status, spend_date DESC)` — "My claims"
- `ix_ec__employee_fy (employee_id, fiscal_year_id)` — the FY stat tiles
- `ix_ec__manager_pending (manager_employee_id, submitted_at DESC) WHERE status = 'PENDING_MANAGER'` — the Approvals queue
- `ix_ec__finance_queue (organization_id, status) WHERE status = 'PENDING_FINANCE'`
- `ix_ec__batch (reimbursement_batch_id)`
- `ix_ec__cycle (paid_in_payroll_cycle_id)`

| `expense_claim_line`    | Type          | Null | Default             | Notes                                                                                |
| ----------------------- | ------------- | ---- | ------------------- | ------------------------------------------------------------------------------------ |
| `id`                    | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                   |
| `organization_id`       | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                         |
| `expense_claim_id`      | `uuid`        | no   | —                   | FK → `expense_claim(id)` `ON DELETE CASCADE`                                         |
| `line_no`               | `smallint`    | no   | —                   |                                                                                      |
| `expense_category_id`   | `uuid`        | no   | —                   | FK → `expense_category(id)` `ON DELETE RESTRICT`                                     |
| `description`           | `text`        | no   | —                   | `Uber — client visit to Manyata`                                                     |
| `merchant_name`         | `text`        | yes  | —                   |                                                                                      |
| `spend_date`            | `date`        | no   | —                   |                                                                                      |
| `amount_minor`          | `money_minor` | no   | —                   | `CHECK (amount_minor > 0)`                                                           |
| `tax_amount_minor`      | `money_minor` | no   | `0`                 | GST component                                                                        |
| `approved_amount_minor` | `money_minor` | yes  | —                   |                                                                                      |
| `is_within_limit`       | `boolean`     | no   | `true`              | Evaluated against `expense_limit` at submit; persisted so the decision is reviewable |
| `limit_applied_minor`   | `money_minor` | yes  | —                   | The cap that was applied — renders "Within ₹1,500 cap" on the Approvals card         |
| `rejection_reason`      | `text`        | yes  | —                   |                                                                                      |

```sql
CONSTRAINT ux_ecl__claim_line UNIQUE (expense_claim_id, line_no),
CONSTRAINT ck_ecl__tax CHECK (tax_amount_minor >= 0 AND tax_amount_minor <= amount_minor),
CONSTRAINT ck_ecl__approved CHECK (approved_amount_minor IS NULL OR (approved_amount_minor >= 0 AND approved_amount_minor <= amount_minor))
```

| `expense_attachment`    | Type   | Null | Default             | Notes                                                |
| ----------------------- | ------ | ---- | ------------------- | ---------------------------------------------------- |
| `id`                    | `uuid` | no   | `gen_random_uuid()` | PK                                                   |
| `organization_id`       | `uuid` | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`         |
| `expense_claim_id`      | `uuid` | no   | —                   | FK → `expense_claim(id)` `ON DELETE CASCADE`         |
| `expense_claim_line_id` | `uuid` | yes  | —                   | FK → `expense_claim_line(id)` `ON DELETE CASCADE`    |
| `file_object_id`        | `uuid` | no   | —                   | FK → `file_object(id)` `ON DELETE RESTRICT`          |
| `kind`                  | `text` | no   | `'RECEIPT'`         | `RECEIPT` \| `INVOICE` \| `BOARDING_PASS` \| `OTHER` |
| `uploaded_by_user_id`   | `uuid` | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`             |

```sql
CONSTRAINT ux_expense_attachment__claim_file UNIQUE (expense_claim_id, file_object_id)
```

### 13.3 Expense claim state machine (`machine = 'expense_claim'`)

| from                          | to                   | permission                      | guards                                                                                                                                          | notification                  | email              |
| ----------------------------- | -------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------ |
| `NULL`                        | `DRAFT`              | `expense:claim:create:self`     | `expense.self_only`                                                                                                                             | —                             | —                  |
| `DRAFT`                       | `SUBMITTED`          | `expense:claim:create:self`     | `expense.has_lines`, `expense.receipt_if_required`, `expense.within_hard_limits`, `expense.manager_exists`, `expense.spend_within_claim_window` | —                             | —                  |
| `SUBMITTED`                   | `PENDING_MANAGER`    | _(system)_                      | `expense.approval_task_created`                                                                                                                 | `EXPENSE_SUBMITTED` → manager | —                  |
| `PENDING_MANAGER`             | `MANAGER_APPROVED`   | `expense:claim:approve:team`    | `approval.actor_is_assigned_approver`                                                                                                           | `EXPENSE_DECIDED` → employee  | `EXPENSE_DECISION` |
| `PENDING_MANAGER`             | `MANAGER_REJECTED`   | `expense:claim:approve:team`    | `approval.actor_is_assigned_approver`, `approval.note_required`                                                                                 | `EXPENSE_DECIDED`             | `EXPENSE_DECISION` |
| `MANAGER_APPROVED`            | `PENDING_FINANCE`    | _(system)_                      | `expense.category_requires_finance`                                                                                                             | —                             | —                  |
| `MANAGER_APPROVED`            | `QUEUED_FOR_PAYMENT` | _(system)_                      | `expense.category_skips_finance`                                                                                                                | —                             | —                  |
| `PENDING_FINANCE`             | `FINANCE_APPROVED`   | `expense:claim:approve:finance` | —                                                                                                                                               | `EXPENSE_DECIDED`             | —                  |
| `PENDING_FINANCE`             | `FINANCE_REJECTED`   | `expense:claim:approve:finance` | `approval.note_required`                                                                                                                        | `EXPENSE_DECIDED`             | `EXPENSE_DECISION` |
| `FINANCE_APPROVED`            | `QUEUED_FOR_PAYMENT` | `expense:reimburse`             | `reimb.batch_open`                                                                                                                              | —                             | —                  |
| `QUEUED_FOR_PAYMENT`          | `REIMBURSED`         | _(system)_                      | `reimb.cycle_published`                                                                                                                         | `EXPENSE_REIMBURSED`          | —                  |
| `DRAFT`                       | `CANCELLED`          | `expense:claim:withdraw:self`   | `expense.self_only`                                                                                                                             | —                             | —                  |
| `SUBMITTED`/`PENDING_MANAGER` | `WITHDRAWN`          | `expense:claim:withdraw:self`   | `expense.self_only`, `expense.not_yet_decided`                                                                                                  | —                             | —                  |

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

| Column                         | Type          | Null | Default             | Notes                                                      |
| ------------------------------ | ------------- | ---- | ------------------- | ---------------------------------------------------------- |
| `id`                           | `uuid`        | no   | `gen_random_uuid()` | PK                                                         |
| `organization_id`              | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`               |
| `employee_id`                  | `uuid`        | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                    |
| `fiscal_year_id`               | `uuid`        | no   | —                   | FK → `fiscal_year(id)` `ON DELETE RESTRICT`                |
| `awaiting_count`               | `integer`     | no   | `0`                 | Claims in `SUBMITTED`/`PENDING_MANAGER`/`PENDING_FINANCE`  |
| `awaiting_amount_minor`        | `money_minor` | no   | `0`                 | → tile 1 value                                             |
| `approved_unpaid_count`        | `integer`     | no   | `0`                 | `MANAGER_APPROVED`/`FINANCE_APPROVED`/`QUEUED_FOR_PAYMENT` |
| `approved_unpaid_amount_minor` | `money_minor` | no   | `0`                 | → tile 2 value                                             |
| `reimbursed_count`             | `integer`     | no   | `0`                 | → tile 3 sub-label "4 claims since April"                  |
| `reimbursed_amount_minor`      | `money_minor` | no   | `0`                 | → tile 3 value                                             |
| `rejected_count`               | `integer`     | no   | `0`                 |                                                            |
| `recomputed_at`                | `timestamptz` | no   | `now()`             |                                                            |

```sql
CONSTRAINT ux_efy__employee_fy UNIQUE (employee_id, fiscal_year_id),
CONSTRAINT ck_efy__nonneg CHECK (
  awaiting_count >= 0 AND approved_unpaid_count >= 0 AND reimbursed_count >= 0 AND rejected_count >= 0
  AND awaiting_amount_minor >= 0 AND approved_unpaid_amount_minor >= 0 AND reimbursed_amount_minor >= 0)
```

---

## 14. Documents

### 14.1 `document_type` — reference data, seeded

| Column                   | Type                      | Null | Default             | Notes                                                                                                                                                                                |
| ------------------------ | ------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                     | `uuid`                    | no   | `gen_random_uuid()` | PK                                                                                                                                                                                   |
| `organization_id`        | `uuid`                    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                         |
| `code`                   | `citext`                  | no   | —                   | `OFFER_LETTER`, `APPOINTMENT_LETTER`, `PROMOTION_LETTER`, `APPRAISAL_LETTER`, `SALARY_REVISION_LETTER`, `RELIEVING_LETTER`, `EXPERIENCE_LETTER`, `ID_PROOF`, `EDUCATION_CERTIFICATE` |
| `name`                   | `text`                    | no   | —                   | `Salary revision letter`                                                                                                                                                             |
| `category_label`         | `text`                    | no   | —                   | `Compensation`, `Performance`, `Career`, `Onboarding` — the exact sub-label the document row renders                                                                                 |
| `default_visibility`     | `ess_document_visibility` | no   | `'EMPLOYEE_AND_HR'` |                                                                                                                                                                                      |
| `is_employee_uploadable` | `boolean`                 | no   | `false`             |                                                                                                                                                                                      |
| `retention_years`        | `smallint`                | no   | `8`                 | Feeds the retention job (§18)                                                                                                                                                        |
| `display_order`          | `smallint`                | no   | `0`                 |                                                                                                                                                                                      |
| `is_active`              | `boolean`                 | no   | `true`              |                                                                                                                                                                                      |

```sql
CONSTRAINT ux_document_type__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_document_type__retention CHECK (retention_years BETWEEN 1 AND 50)
```

### 14.2 `employee_document`

| Column                   | Type                      | Null | Default             | Notes                                                                                              |
| ------------------------ | ------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                     | `uuid`                    | no   | `gen_random_uuid()` | PK                                                                                                 |
| `organization_id`        | `uuid`                    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                       |
| `employee_id`            | `uuid`                    | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                           |
| `document_type_id`       | `uuid`                    | no   | —                   | FK → `document_type(id)` `ON DELETE RESTRICT`                                                      |
| `title`                  | `text`                    | no   | —                   | `Salary revision letter — FY 2026–27` — the exact row title                                        |
| `file_object_id`         | `uuid`                    | no   | —                   | FK → `file_object(id)` `ON DELETE RESTRICT`                                                        |
| `document_date`          | `date`                    | no   | —                   | `1 Apr 2026` — the document's own date, not the upload time                                        |
| `visibility`             | `ess_document_visibility` | no   | —                   | Defaults from `document_type`                                                                      |
| `issued_by_user_id`      | `uuid`                    | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                           |
| `document_request_id`    | `uuid`                    | yes  | —                   | FK → `document_request(id)` `ON DELETE SET NULL` — set when this document fulfils a letter request |
| `is_system_generated`    | `boolean`                 | no   | `false`             |                                                                                                    |
| `version`                | `smallint`                | no   | `1`                 |                                                                                                    |
| `supersedes_document_id` | `uuid`                    | yes  | —                   | FK → `employee_document(id)` `ON DELETE SET NULL`                                                  |
| `archived_at`            | `timestamptz`             | yes  | —                   | Hidden from the employee list; retained for audit                                                  |
| `download_count`         | `integer`                 | no   | `0`                 |                                                                                                    |
| `last_downloaded_at`     | `timestamptz`             | yes  | —                   |                                                                                                    |

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

| `letter_template`         | Type       | Null | Default             | Notes                                                                                                                                                             |
| ------------------------- | ---------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                      | `uuid`     | no   | `gen_random_uuid()` | PK                                                                                                                                                                |
| `organization_id`         | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                      |
| `code`                    | `citext`   | no   | —                   | `EMPLOYMENT_VERIFICATION`, `SALARY_CERTIFICATE`, `ADDRESS_PROOF`, `BONAFIDE_VISA`, `NOC`                                                                          |
| `name`                    | `text`     | no   | —                   | `Employment verification letter`, `Salary certificate`, `Address proof letter`, `Bonafide letter (visa)`, `No objection certificate` — the exact dropdown options |
| `body_template`           | `text`     | no   | —                   | Handlebars-style template; placeholders are resolved server-side from persisted data only                                                                         |
| `requires_addressee`      | `boolean`  | no   | `false`             |                                                                                                                                                                   |
| `includes_salary_details` | `boolean`  | no   | `false`             | `true` for the salary certificate ⇒ issuing it writes a `READ_SENSITIVE` audit event                                                                              |
| `sla_working_days`        | `smallint` | no   | `1`                 | Renders "issued within 1 working day" — persisted, not a hardcoded caption                                                                                        |
| `requires_hr_approval`    | `boolean`  | no   | `true`              |                                                                                                                                                                   |
| `display_order`           | `smallint` | no   | `0`                 |                                                                                                                                                                   |
| `is_active`               | `boolean`  | no   | `true`              |                                                                                                                                                                   |

```sql
CONSTRAINT ux_letter_template__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_letter_template__sla CHECK (sla_working_days BETWEEN 0 AND 30)
```

| `document_request`     | Type                          | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ----------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`                        | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `organization_id`      | `uuid`                        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                     |
| `request_no`           | `citext`                      | no   | —                   | `WDT-DOC-2026-00214`. Unique per org.                                                                                                                                                                                                                                                                                                                                                                                            |
| `employee_id`          | `uuid`                        | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                         |
| `letter_template_id`   | `uuid`                        | no   | —                   | FK → `letter_template(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                  |
| `addressee`            | `text`                        | yes  | —                   | `HDFC Bank, Koramangala branch` → renders "Addressed to …"; when NULL the row renders "General purpose"                                                                                                                                                                                                                                                                                                                          |
| `purpose_note`         | `text`                        | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `status`               | `ess_document_request_status` | no   | `'SUBMITTED'`       |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `requested_at`         | `timestamptz`                 | no   | `now()`             | Renders "Requested 18 Sep 2026"                                                                                                                                                                                                                                                                                                                                                                                                  |
| `due_at`               | `timestamptz`                 | no   | —                   | `ess.add_business_time(organization_id, requested_at, letter_template.sla_working_days * 8, holiday_calendar_for(employee_id, requested_at::date))` — the single business-hours clock of §4.6.1. The previous "resolved against the holiday calendar" named no calendar (the org's? the employee's location's?) and no working-hours definition, so two implementers would produce two different due dates for the same request. |
| `assigned_to_user_id`  | `uuid`                        | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                                                                                                         |
| `issued_at`            | `timestamptz`                 | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `issued_by_user_id`    | `uuid`                        | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                         |
| `employee_document_id` | `uuid`                        | yes  | —                   | FK → `employee_document(id)` `ON DELETE SET NULL` — the issued PDF; its presence is what enables the row's download button                                                                                                                                                                                                                                                                                                       |
| `rejection_reason`     | `text`                        | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `cancelled_at`         | `timestamptz`                 | yes  | —                   |                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `row_version`          | `integer`                     | no   | `1`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

| Column                | Type                | Null | Default             | Notes                                                                                              |
| --------------------- | ------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `id`                  | `uuid`              | no   | `gen_random_uuid()` | PK                                                                                                 |
| `organization_id`     | `uuid`              | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                       |
| `code`                | `citext`            | no   | —                   | `COC`, `ISP`, `LEAVE`, `WFH`, `TNE`, `POSH`, `ABC`, `DPP`                                          |
| `name`                | `text`              | no   | —                   | `Code of Conduct`                                                                                  |
| `owner_label`         | `text`              | no   | —                   | `People Ops`, `IT & Security`, `Finance`, `Legal`, `Internal Committee` — the detail-panel eyebrow |
| `owner_department_id` | `uuid`              | yes  | —                   | FK → `department(id)` `ON DELETE SET NULL`                                                         |
| `contact_email`       | `citext`            | no   | —                   | `ethics@widedrop.com` — the "Questions" field                                                      |
| `status`              | `ess_policy_status` | no   | `'DRAFT'`           |                                                                                                    |
| `display_order`       | `smallint`          | no   | `0`                 | Fixes the list order                                                                               |
| `archived_at`         | `timestamptz`       | yes  | —                   |                                                                                                    |

```sql
CONSTRAINT ux_policy__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_policy__archived CHECK ((status = 'ARCHIVED') = (archived_at IS NOT NULL))
```

### 15.2 `policy_version` — version-controlled, never mutated after publication

| Column                     | Type                        | Null | Default             | Notes                                                                                          |
| -------------------------- | --------------------------- | ---- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`                      | no   | `gen_random_uuid()` | PK                                                                                             |
| `organization_id`          | `uuid`                      | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                   |
| `policy_id`                | `uuid`                      | no   | —                   | FK → `policy(id)` `ON DELETE RESTRICT`                                                         |
| `version_major`            | `smallint`                  | no   | —                   | `3`                                                                                            |
| `version_minor`            | `smallint`                  | no   | —                   | `1`                                                                                            |
| `version_label`            | `text`                      | no   | _(generated)_       | `GENERATED ALWAYS AS ('v' \|\| version_major \|\| '.' \|\| version_minor) STORED` → `v3.1`     |
| `status`                   | `ess_policy_version_status` | no   | `'DRAFT'`           |                                                                                                |
| `summary`                  | `text`                      | no   | —                   | The detail-panel paragraph                                                                     |
| `body_markdown`            | `text`                      | no   | —                   | Full policy text                                                                               |
| `body_sha256`              | `bytea`                     | no   | —                   | SHA-256 over `body_markdown`; what the employee acknowledged is provably this text             |
| `pdf_file_object_id`       | `uuid`                      | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`. NULL ⇒ the "Download PDF" button is not rendered. |
| `applies_to_label`         | `text`                      | no   | —                   | `All employees & contractors` — the human summary of the rules in §15.3                        |
| `effective_from`           | `date`                      | no   | —                   | `1 Jan 2026`                                                                                   |
| `effective_to`             | `date`                      | yes  | —                   | Set when a later version supersedes it                                                         |
| `next_review_on`           | `date`                      | yes  | —                   | `Jan 2027`                                                                                     |
| `last_updated_label`       | `text`                      | no   | —                   | `Jan 2026` — the list row's "Updated …", persisted at publication                              |
| `requires_acknowledgement` | `boolean`                   | no   | `true`              |                                                                                                |
| `acknowledgement_due_days` | `smallint`                  | yes  | —                   | Days from assignment; produces the per-employee due date                                       |
| `acknowledgement_due_on`   | `date`                      | yes  | —                   | An absolute org-wide due date (`15 Oct 2026`). Exactly one of the two is set.                  |
| `published_at`             | `timestamptz`               | yes  | —                   |                                                                                                |
| `published_by_user_id`     | `uuid`                      | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                       |
| `supersedes_version_id`    | `uuid`                      | yes  | —                   | FK → `policy_version(id)` `ON DELETE RESTRICT`                                                 |
| `withdrawn_at`             | `timestamptz`               | yes  | —                   |                                                                                                |
| `withdrawn_reason`         | `text`                      | yes  | —                   |                                                                                                |

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

| `policy_version_point` | Type       | Null | Default             | Notes                                         |
| ---------------------- | ---------- | ---- | ------------------- | --------------------------------------------- |
| `id`                   | `uuid`     | no   | `gen_random_uuid()` | PK                                            |
| `organization_id`      | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`  |
| `policy_version_id`    | `uuid`     | no   | —                   | FK → `policy_version(id)` `ON DELETE CASCADE` |
| `point_no`             | `smallint` | no   | —                   |                                               |
| `text`                 | `text`     | no   | —                   | One bullet of "What this policy covers"       |

```sql
CONSTRAINT ux_pvp__version_point UNIQUE (policy_version_id, point_no),
CONSTRAINT ck_pvp__point_no CHECK (point_no >= 1)
```

Same immutability trigger as `policy_version` (no edits after the version leaves `DRAFT`).
When a version has no points, the detail panel omits the "What this policy covers" block
entirely rather than rendering an empty card.

| `policy_applicability_rule`       | Type                                 | Null | Default             | Notes                                         |
| --------------------------------- | ------------------------------------ | ---- | ------------------- | --------------------------------------------- |
| `id`                              | `uuid`                               | no   | `gen_random_uuid()` | PK                                            |
| `organization_id`                 | `uuid`                               | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`  |
| `policy_version_id`               | `uuid`                               | no   | —                   | FK → `policy_version(id)` `ON DELETE CASCADE` |
| `dimension`                       | `ess_policy_applicability_dimension` | no   | —                   |                                               |
| `is_include`                      | `boolean`                            | no   | `true`              | `false` = exclusion, evaluated after includes |
| `department_id`                   | `uuid`                               | yes  | —                   | FK → `department(id)` `ON DELETE CASCADE`     |
| `location_id`                     | `uuid`                               | yes  | —                   | FK → `location(id)` `ON DELETE CASCADE`       |
| `designation_id`                  | `uuid`                               | yes  | —                   | FK → `designation(id)` `ON DELETE CASCADE`    |
| `cost_centre_id`                  | `uuid`                               | yes  | —                   | FK → `cost_centre(id)` `ON DELETE CASCADE`    |
| `employee_id`                     | `uuid`                               | yes  | —                   | FK → `employee(id)` `ON DELETE CASCADE`       |
| `employment_type`                 | `ess_employment_type`                | yes  | —                   |                                               |
| `includes_department_descendants` | `boolean`                            | no   | `true`              |                                               |

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

| Column              | Type          | Null | Default             | Notes                                                                                                                                     |
| ------------------- | ------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                                                                        |
| `organization_id`   | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                              |
| `policy_version_id` | `uuid`        | no   | —                   | FK → `policy_version(id)` `ON DELETE RESTRICT`                                                                                            |
| `employee_id`       | `uuid`        | no   | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                                                                                   |
| `assigned_at`       | `timestamptz` | no   | `now()`             |                                                                                                                                           |
| `due_on`            | `date`        | yes  | —                   | Resolved from `acknowledgement_due_on` or `assigned_at + acknowledgement_due_days`. NULL ⇒ no due date, and the UI shows no "Due …" text. |
| `is_required`       | `boolean`     | no   | `true`              |                                                                                                                                           |
| `superseded_at`     | `timestamptz` | yes  | —                   | Set when a newer version is assigned; a superseded assignment never appears in the pending count                                          |
| `notification_id`   | `uuid`        | yes  | —                   | FK → `notification(id)` `ON DELETE SET NULL`                                                                                              |

```sql
CONSTRAINT ux_pa__version_employee UNIQUE (policy_version_id, employee_id)
```

Indexes:

- `ix_pa__employee_open (employee_id, due_on) WHERE superseded_at IS NULL` — the pending count
- `ix_pa__version (policy_version_id) WHERE superseded_at IS NULL` — HR compliance reporting

`policy_acknowledgement` — the record of the act. **Append-only** (trigger
`trg_append_only_policy_ack`): an acknowledgement is never edited or deleted; a
re-acknowledgement of a new version is a new row against that version.

| Column                     | Type                    | Null | Default             | Notes                                                                                                                   |
| -------------------------- | ----------------------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`                       | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                                                                      |
| `organization_id`          | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                            |
| `policy_assignment_id`     | `uuid`                  | no   | —                   | FK → `policy_assignment(id)` `ON DELETE RESTRICT`                                                                       |
| `policy_version_id`        | `uuid`                  | no   | —                   | FK → `policy_version(id)` `ON DELETE RESTRICT` — denormalised; the required (employee, policy version) pair             |
| `employee_id`              | `uuid`                  | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                                                                                |
| `status`                   | `ess_policy_ack_status` | no   | —                   | `ACKNOWLEDGED` or `WAIVED` (a `PENDING`/`OVERDUE` state is the **absence** of a row, computed from `policy_assignment`) |
| `acknowledged_at`          | `timestamptz`           | no   | —                   | The required timestamp; renders "Acknowledged on 12 Jan 2026"                                                           |
| `acknowledged_body_sha256` | `bytea`                 | no   | —                   | Copy of `policy_version.body_sha256` at the moment of the click — proof of _what_ was acknowledged                      |
| `acknowledgement_text`     | `text`                  | no   | —                   | The exact consent sentence shown, e.g. `I have read and acknowledge`                                                    |
| `ip_address`               | `inet`                  | yes  | —                   |                                                                                                                         |
| `user_agent`               | `text`                  | yes  | —                   |                                                                                                                         |
| `app_user_id`              | `uuid`                  | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT` — who clicked                                                                  |
| `waived_by_user_id`        | `uuid`                  | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                |
| `waiver_reason`            | `text`                  | yes  | —                   |                                                                                                                         |
| `audit_event_id`           | `uuid`                  | yes  | —                   | FK → `audit_event(id)` `ON DELETE SET NULL`                                                                             |
| `created_at`               | `timestamptz`           | no   | `now()`             |                                                                                                                         |

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

| Column                      | Type                      | Null | Default             | Notes                                                                                                                                |
| --------------------------- | ------------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `id`                        | `uuid`                    | no   | `gen_random_uuid()` | PK                                                                                                                                   |
| `organization_id`           | `uuid`                    | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                         |
| `title`                     | `text`                    | no   | —                   |                                                                                                                                      |
| `body_markdown`             | `text`                    | no   | —                   | Paragraphs are the markdown's blocks — the prototype's `body: [para, para]` is a rendering of this single field, not an array column |
| `category_label`            | `text`                    | no   | —                   | `People Ops`, `Finance`, `Leadership`, `Benefits`, `Workplace`, `IT & Security` — the chip the list row shows                        |
| `author_employee_id`        | `uuid`                    | yes  | —                   | FK → `employee(id)` `ON DELETE SET NULL`                                                                                             |
| `author_byline`             | `text`                    | no   | —                   | `Ananya Bose · People Ops` or `Facilities` — persisted so a non-employee author (a team) is representable                            |
| `status`                    | `ess_announcement_status` | no   | `'DRAFT'`           |                                                                                                                                      |
| `is_pinned`                 | `boolean`                 | no   | `false`             |                                                                                                                                      |
| `pinned_until`              | `date`                    | yes  | —                   |                                                                                                                                      |
| `publish_at`                | `timestamptz`             | yes  | —                   | Future-dated ⇒ `SCHEDULED`                                                                                                           |
| `published_at`              | `timestamptz`             | yes  | —                   | Renders the row date `26 Sep 2026`                                                                                                   |
| `published_by_user_id`      | `uuid`                    | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                                                                                             |
| `expires_at`                | `timestamptz`             | yes  | —                   | After this the item leaves the list without being deleted                                                                            |
| `archived_at`               | `timestamptz`             | yes  | —                   |                                                                                                                                      |
| `attachment_file_object_id` | `uuid`                    | yes  | —                   | FK → `file_object(id)` `ON DELETE SET NULL`                                                                                          |
| `row_version`               | `integer`                 | no   | `1`                 |                                                                                                                                      |

```sql
CONSTRAINT ck_ann__published CHECK (
  (status = 'PUBLISHED') = (published_at IS NOT NULL AND published_by_user_id IS NOT NULL)),
-- ck_ann__scheduled is NOT a CHECK: `now()` is not IMMUTABLE and a scheduled row would
-- become permanently unupdatable and unrestorable the moment publish_at passed (§1.2).
-- Enforced by trg_announcement_schedule_future (BEFORE INSERT OR UPDATE) instead.
CONSTRAINT ck_ann__schedule_set CHECK (status <> 'SCHEDULED' OR publish_at IS NOT NULL),
CONSTRAINT ck_ann__pin CHECK (NOT is_pinned OR status = 'PUBLISHED'),
CONSTRAINT ck_ann__expiry CHECK (expires_at IS NULL OR published_at IS NULL OR expires_at > published_at)
```

Indexes:

- `ix_ann__feed (organization_id, is_pinned DESC, published_at DESC) WHERE status = 'PUBLISHED' AND archived_at IS NULL` — the exact list order (pinned first, then newest)
- `ix_ann__schedule (publish_at) WHERE status = 'SCHEDULED'`

**State machine** `machine = 'announcement'` (§16.1.1):
`NULL→DRAFT` (`announcement:author`) · `DRAFT→SCHEDULED` (`announcement:publish`, guards
`announcement.has_audience`, `announcement.publish_at_future`) ·
`DRAFT→PUBLISHED` (`announcement:publish`, guard `announcement.has_audience`; emits
`ANNOUNCEMENT_PUBLISHED` to every employee the audience resolves to) ·
`SCHEDULED→PUBLISHED` (_system_, job `announcement-publish`) ·
`SCHEDULED→DRAFT` (`announcement:author`) ·
`PUBLISHED→ARCHIVED` (`announcement:publish`). Terminal: `ARCHIVED`.
`announcement.has_audience` is what makes the fail-closed rule below enforceable at the
transition rather than only at read time.

### 16.2 `announcement_audience`

| Column                            | Type                             | Null | Default             | Notes                                        |
| --------------------------------- | -------------------------------- | ---- | ------------------- | -------------------------------------------- |
| `id`                              | `uuid`                           | no   | `gen_random_uuid()` | PK                                           |
| `organization_id`                 | `uuid`                           | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT` |
| `announcement_id`                 | `uuid`                           | no   | —                   | FK → `announcement(id)` `ON DELETE CASCADE`  |
| `kind`                            | `ess_announcement_audience_kind` | no   | —                   |                                              |
| `department_id`                   | `uuid`                           | yes  | —                   | FK → `department(id)` `ON DELETE CASCADE`    |
| `location_id`                     | `uuid`                           | yes  | —                   | FK → `location(id)` `ON DELETE CASCADE`      |
| `employment_type`                 | `ess_employment_type`            | yes  | —                   |                                              |
| `employee_id`                     | `uuid`                           | yes  | —                   | FK → `employee(id)` `ON DELETE CASCADE`      |
| `includes_department_descendants` | `boolean`                        | no   | `true`              |                                              |

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

| Column            | Type          | Null | Default | Notes                                       |
| ----------------- | ------------- | ---- | ------- | ------------------------------------------- |
| `announcement_id` | `uuid`        | no   | —       | FK → `announcement(id)` `ON DELETE CASCADE` |
| `employee_id`     | `uuid`        | no   | —       | FK → `employee(id)` `ON DELETE CASCADE`     |
| `organization_id` | `uuid`        | no   | —       | FK → `organization(id)` `ON DELETE CASCADE` |
| `first_read_at`   | `timestamptz` | no   | `now()` |                                             |
| `read_count`      | `integer`     | no   | `1`     |                                             |
| `last_read_at`    | `timestamptz` | no   | `now()` |                                             |

```sql
PRIMARY KEY (announcement_id, employee_id),
CONSTRAINT ck_ar__count CHECK (read_count >= 1)
```

Index: `ix_annread__employee (employee_id, first_read_at DESC)`.
Drives the unread dot on the Announcements nav item and the notification bell state.

### 16.4 `ticket_category` and `helpdesk_ticket`

| `ticket_category` (reference data, seeded) | Type       | Null | Default             | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------- | ---- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                       | `uuid`     | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `organization_id`                          | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `code`                                     | `citext`   | no   | —                   | `PAYROLL_TAX`, `LEAVE`, `BENEFITS`, `IT_ACCESS`, `DOCUMENTS`, `TOWN_HALL`, `OTHER`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `name`                                     | `text`     | no   | —                   | `Payroll & tax`, `Leave`, `Benefits`, `IT & access`, `Documents`, `Town hall`, `Other` — the exact dropdown options                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `default_assignee_user_id`                 | `uuid`     | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `default_assignee_role_id`                 | `uuid`     | yes  | —                   | FK → `role(id)` `ON DELETE SET NULL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `routing_email`                            | `citext`   | yes  | —                   | An **additional** recipient for this category (a team alias). `NULL` ⇒ none. **Corrected:** this column previously said it "defaults to `organization.helpdesk_email`", which a column default cannot do (it is in another table) and which allowed a category override to _replace_ the mandated address. Directive 8 requires every ticket to reach `helpdesk@widedroptech.com`, so `organization.helpdesk_email` is always in `to_addresses` and `routing_email`, when set, is added to `cc_addresses`. A category can widen the audience; it can never redirect it. |
| `first_response_sla_hours`                 | `smallint` | no   | `8`                 | 1 working day ⇒ the persisted source of the copy "first response within 1 working day"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `resolution_sla_hours`                     | `smallint` | no   | `40`                |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `is_anonymous_allowed`                     | `boolean`  | no   | `false`             | `true` for `TOWN_HALL` (the prototype's anonymous questions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `display_order`                            | `smallint` | no   | `0`                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `is_active`                                | `boolean`  | no   | `true`              |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

```sql
CONSTRAINT ux_ticket_category__org_code UNIQUE (organization_id, code),
CONSTRAINT ck_tc__sla CHECK (first_response_sla_hours > 0 AND resolution_sla_hours >= first_response_sla_hours)
```

| `helpdesk_ticket`             | Type                  | Null | Default             | Notes                                                                                                                                                                                                         |
| ----------------------------- | --------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                          | `uuid`                | no   | `gen_random_uuid()` | PK                                                                                                                                                                                                            |
| `organization_id`             | `uuid`                | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                  |
| `ticket_no`                   | `citext`              | no   | —                   | `HD-4821`. Unique per org, from `helpdesk_ticket_seq`.                                                                                                                                                        |
| `ticket_category_id`          | `uuid`                | no   | —                   | FK → `ticket_category(id)` `ON DELETE RESTRICT`                                                                                                                                                               |
| `raised_by_employee_id`       | `uuid`                | yes  | —                   | FK → `employee(id)` `ON DELETE RESTRICT`. NULL only when `is_anonymous`.                                                                                                                                      |
| `raised_by_user_id`           | `uuid`                | yes  | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`. NULL only when `is_anonymous`.                                                                                                                                      |
| `is_anonymous`                | `boolean`             | no   | `false`             | Permitted only when the category allows it                                                                                                                                                                    |
| `subject`                     | `text`                | no   | —                   | ≤ 200 chars                                                                                                                                                                                                   |
| `description`                 | `text`                | yes  | —                   | ≤ 5000 chars                                                                                                                                                                                                  |
| `status`                      | `ess_ticket_status`   | no   | `'OPEN'`            |                                                                                                                                                                                                               |
| `priority`                    | `ess_ticket_priority` | no   | `'NORMAL'`          |                                                                                                                                                                                                               |
| `assigned_to_user_id`         | `uuid`                | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`. NULL renders the meta "unassigned" — a persisted fact.                                                                                                              |
| `assigned_at`                 | `timestamptz`         | yes  | —                   |                                                                                                                                                                                                               |
| `first_response_due_at`       | `timestamptz`         | no   | —                   | `ess.add_business_time(organization_id, created_at, ticket_category.first_response_sla_hours)` (§4.6.1)                                                                                                       |
| `sla_paused_at`               | `timestamptz`         | yes  | —                   | Set while `status = 'WAITING_ON_EMPLOYEE'` — the clock does not run against the agent while the employee owes a reply (WORKFLOWS R-3)                                                                         |
| `sla_paused_seconds`          | `integer`             | no   | `0`                 | Accumulated pause, `CHECK (sla_paused_seconds >= 0)`; `resolution_due_at` is recomputed by the SLA routine on resume and is mutable only by it                                                                |
| `email_delivery_status`       | `ess_email_status`    | yes  | —                   | Denormalised mirror of `email_outbox.status`, maintained by the dispatcher in the same transaction as the outbox update, so the ticket screen renders the real delivery state in one read instead of guessing |
| `first_responded_at`          | `timestamptz`         | yes  | —                   | Set by the first `PUBLIC` agent comment                                                                                                                                                                       |
| `resolution_due_at`           | `timestamptz`         | no   | —                   |                                                                                                                                                                                                               |
| `resolved_at`                 | `timestamptz`         | yes  | —                   | Renders "Resolved 12 Sep"                                                                                                                                                                                     |
| `resolved_by_user_id`         | `uuid`                | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`                                                                                                                                                                      |
| `resolution_summary`          | `text`                | yes  | —                   |                                                                                                                                                                                                               |
| `closed_at`                   | `timestamptz`         | yes  | —                   |                                                                                                                                                                                                               |
| `reopened_count`              | `smallint`            | no   | `0`                 |                                                                                                                                                                                                               |
| `sla_first_response_breached` | `boolean`             | no   | _(generated)_       | `GENERATED ALWAYS AS (first_responded_at IS NOT NULL AND first_responded_at > first_response_due_at) STORED`                                                                                                  |
| `sla_resolution_breached`     | `boolean`             | no   | _(generated)_       | `GENERATED ALWAYS AS (resolved_at IS NOT NULL AND resolved_at > resolution_due_at) STORED`                                                                                                                    |
| `satisfaction_rating`         | `smallint`            | yes  | —                   | 1–5                                                                                                                                                                                                           |
| `related_entity_type`         | `text`                | yes  | —                   | `payslip`, `employee_bank_account`, `form16_document` — set when the ticket was raised from a module ("Request a change" on the profile)                                                                      |
| `related_entity_id`           | `uuid`                | yes  | —                   | Not an FK (polymorphic)                                                                                                                                                                                       |
| `email_outbox_id`             | `uuid`                | yes  | —                   | FK → `email_outbox(id)` `ON DELETE SET NULL` — the dispatch to `helpdesk@widedroptech.com`                                                                                                                    |
| `row_version`                 | `integer`             | no   | `1`                 |                                                                                                                                                                                                               |

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

| `ticket_comment`     | Type                            | Null | Default             | Notes                                                                         |
| -------------------- | ------------------------------- | ---- | ------------------- | ----------------------------------------------------------------------------- |
| `id`                 | `uuid`                          | no   | `gen_random_uuid()` | PK                                                                            |
| `organization_id`    | `uuid`                          | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                  |
| `helpdesk_ticket_id` | `uuid`                          | no   | —                   | FK → `helpdesk_ticket(id)` `ON DELETE CASCADE`                                |
| `author_user_id`     | `uuid`                          | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for system notes.              |
| `author_kind`        | `text`                          | no   | —                   | `EMPLOYEE` \| `AGENT` \| `SYSTEM`                                             |
| `visibility`         | `ess_ticket_comment_visibility` | no   | `'PUBLIC'`          | `INTERNAL` is never returned to the raiser — enforced in the query and by RLS |
| `body`               | `text`                          | no   | —                   |                                                                               |
| `is_edited`          | `boolean`                       | no   | `false`             |                                                                               |
| `edited_at`          | `timestamptz`                   | yes  | —                   |                                                                               |

```sql
CONSTRAINT ck_tcm__author_kind CHECK (author_kind IN ('EMPLOYEE','AGENT','SYSTEM')),
CONSTRAINT ck_tcm__system_author CHECK ((author_kind = 'SYSTEM') = (author_user_id IS NULL)),
CONSTRAINT ck_tcm__edited CHECK (is_edited = (edited_at IS NOT NULL))
```

Index: `ix_tcm__ticket_time (helpdesk_ticket_id, created_at)`,
`ix_tcm__ticket_public (helpdesk_ticket_id, created_at) WHERE visibility = 'PUBLIC'`.

| `ticket_attachment`   | Type   | Null | Default             | Notes                                          |
| --------------------- | ------ | ---- | ------------------- | ---------------------------------------------- |
| `id`                  | `uuid` | no   | `gen_random_uuid()` | PK                                             |
| `organization_id`     | `uuid` | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`   |
| `helpdesk_ticket_id`  | `uuid` | no   | —                   | FK → `helpdesk_ticket(id)` `ON DELETE CASCADE` |
| `ticket_comment_id`   | `uuid` | yes  | —                   | FK → `ticket_comment(id)` `ON DELETE CASCADE`  |
| `file_object_id`      | `uuid` | no   | —                   | FK → `file_object(id)` `ON DELETE RESTRICT`    |
| `uploaded_by_user_id` | `uuid` | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`       |

```sql
CONSTRAINT ux_ticket_attachment__ticket_file UNIQUE (helpdesk_ticket_id, file_object_id)
```

### 16.6 `faq_article` — reference data, seeded

The Help desk "Common questions" accordion. Content is configuration, authored by HR, not
operational data — but it is still persisted, versioned by `updated_at`, and read from
the database.

| Column               | Type       | Null | Default             | Notes                                           |
| -------------------- | ---------- | ---- | ------------------- | ----------------------------------------------- |
| `id`                 | `uuid`     | no   | `gen_random_uuid()` | PK                                              |
| `organization_id`    | `uuid`     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`    |
| `ticket_category_id` | `uuid`     | yes  | —                   | FK → `ticket_category(id)` `ON DELETE SET NULL` |
| `question`           | `text`     | no   | —                   |                                                 |
| `answer_markdown`    | `text`     | no   | —                   |                                                 |
| `display_order`      | `smallint` | no   | `0`                 |                                                 |
| `is_published`       | `boolean`  | no   | `true`              |                                                 |
| `view_count`         | `integer`  | no   | `0`                 |                                                 |

```sql
CONSTRAINT ck_faq__view_count CHECK (view_count >= 0)
```

Index: `ix_faq__org_order (organization_id, display_order) WHERE is_published`.
With no published rows, the accordion card is not rendered at all.

### 16.7 `notification`

Every row must be traceable to a persisted event: either a `state_transition` that
declared `emits_notification_kind`, or a scheduled job whose rule is named in
`source_rule_code`. The API has **no** endpoint that creates an arbitrary notification.

| Column                  | Type                    | Null | Default             | Notes                                                                      |
| ----------------------- | ----------------------- | ---- | ------------------- | -------------------------------------------------------------------------- |
| `id`                    | `uuid`                  | no   | `gen_random_uuid()` | PK                                                                         |
| `organization_id`       | `uuid`                  | no   | —                   | FK → `organization(id)` `ON DELETE CASCADE`                                |
| `recipient_app_user_id` | `uuid`                  | no   | —                   | FK → `app_user(id)` `ON DELETE CASCADE`                                    |
| `recipient_employee_id` | `uuid`                  | yes  | —                   | FK → `employee(id)` `ON DELETE CASCADE`                                    |
| `kind`                  | `ess_notification_kind` | no   | —                   |                                                                            |
| `tone`                  | `ess_notification_tone` | no   | —                   | Maps to the popover's colour dot (Design System §1)                        |
| `title`                 | `text`                  | no   | —                   | The notification sentence                                                  |
| `context_label`         | `text`                  | no   | —                   | `Payroll`, `Approvals`, `IT & Security` — the meta's right half            |
| `occurred_at`           | `timestamptz`           | no   | `now()`             | The meta renders `31 Aug · Payroll` from this + `context_label`            |
| `entity_type`           | `text`                  | no   | —                   | `payslip`, `leave_request`, `policy_version`, `helpdesk_ticket`, …         |
| `entity_id`             | `uuid`                  | no   | —                   | Not an FK (polymorphic); the deep-link target                              |
| `deep_link_screen`      | `text`                  | no   | —                   | `payslips`, `approvals`, `policies`, … — the nav id the click navigates to |
| `deep_link_params`      | `jsonb`                 | no   | `'{}'`              | `{"payslipId":"…"}`                                                        |
| `source_audit_event_id` | `uuid`                  | yes  | —                   | FK → `audit_event(id)` `ON DELETE SET NULL` — the event that caused it     |
| `source_rule_code`      | `text`                  | yes  | —                   | For job-generated notices, e.g. `POLICY_DUE_IN_3_DAYS`                     |
| `read_at`               | `timestamptz`           | yes  | —                   |                                                                            |
| `dismissed_at`          | `timestamptz`           | yes  | —                   |                                                                            |
| `expires_at`            | `timestamptz`           | yes  | —                   |                                                                            |

```sql
CONSTRAINT ck_notification__source CHECK (num_nonnulls(source_audit_event_id, source_rule_code) >= 1),
CONSTRAINT ck_notification__dedupe_key CHECK (length(btrim(dedupe_key)) > 0)
```

plus a column `dedupe_key text NOT NULL`, and

```sql
CREATE UNIQUE INDEX ux_notification__dedupe
  ON ess.notification (recipient_app_user_id, dedupe_key);
```

> **Corrected.** The previous constraint was
> `UNIQUE (recipient_app_user_id, kind, entity_type, entity_id, coalesce(source_rule_code,''))`
> — an expression, so not expressible as a `UNIQUE` constraint at all (§1.2), and, more
> seriously, **wrong**: it permits exactly one notification per (user, kind, entity) for
> all time. A ticket that is updated three times can raise one `TICKET_UPDATED`; a policy
> reminder can be sent once and never again; a payslip revision cannot notify because the
> original publication already did. The second and third notifications would be silently
> swallowed by a unique violation, and the bell count — which §16.7 claims is "exact, not
> approximate" — would be wrong in the direction of under-reporting.
>
> `dedupe_key` is composed by the caller and expresses the _intended_ idempotency window,
> not an accidental one: `'<kind>:<entity_type>:<entity_id>:<discriminator>'`, where the
> discriminator is the state transition's id for a transition-sourced notice
> (`…:leave_request:<id>:APPROVED`), the `payslip.revision` for a publication
> (`…:payslip:<id>:r2`), the reminder's target date for a scheduled rule
> (`POLICY_DUE:policy_version:<id>:2026-10-12`), and `ticket_comment.id` for a ticket
> update. A retried job recomputes the same key and is idempotent; a genuinely new event
> computes a new one and is delivered.
> Indexes:

- `ix_notification__inbox (recipient_app_user_id, occurred_at DESC) WHERE dismissed_at IS NULL` — the popover's list
- `ix_notification__unread (recipient_app_user_id) WHERE read_at IS NULL AND dismissed_at IS NULL` — the bell's dot
- `ix_notification__entity (entity_type, entity_id)`

The unique dedupe constraint is what stops a retried job from producing two identical
notifications — the count on the bell is therefore exact, not approximate.

---

## 17. Cross-cutting: audit, files, keys, email, ops

### 17.1 `audit_event` — append-only, hash-chained

The tamper-evidence record for every sensitive HR, payroll, approval, policy and
administrative action. It is append-only at the database level and chained, so removing
or editing a row breaks verification.

| Column                  | Type               | Null | Default                                | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ------------------ | ---- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | `uuid`             | no   | `gen_random_uuid()`                    | Part of the PK                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `organization_id`       | `uuid`             | no   | —                                      | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `sequence_no`           | `bigint`           | no   | _(from `audit_chain_head`, see below)_ | Monotonic, gap-free per organization; the chain order                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `occurred_at`           | `timestamptz`      | no   | `now()`                                | Partition key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `event_code`            | `text`             | no   | —                                      | The fine-grained taxonomy the sibling specs use: `PAYROLL.CYCLE_CREATED`, `PAYROLL.VALIDATED`, `AUTH.REFRESH_REUSE_DETECTED`, `TICKET.EMAIL_SENT`, `AUTHZ.DENIED`, … Format `^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*$`. **Added:** `action` is a 14-value enum, far too coarse to answer "show me every payroll publication" or to drive the alerting rules WORKFLOWS.md and SECURITY.md reference by name. The complete catalogue is seeded in `audit_event_code` (reference data) and `ck_audit_event__code_known` is a FK to it, so a typo in an event code is a migration failure rather than an event that no alert will ever match. |
| `severity`              | `text`             | no   | `'INFO'`                               | `INFO` \| `NOTICE` \| `WARNING` \| `CRITICAL` — carried by `audit_event_code`, copied here so alerting does not need the join                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `actor_kind`            | `ess_actor_kind`   | no   | —                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `actor_user_id`         | `uuid`             | yes  | —                                      | FK → `app_user(id)` `ON DELETE RESTRICT`. NULL only for `SYSTEM`/`SCHEDULER`/`MIGRATION`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `actor_employee_id`     | `uuid`             | yes  | —                                      | FK → `employee(id)` `ON DELETE RESTRICT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `actor_email_snapshot`  | `citext`           | yes  | —                                      | Frozen: the actor's address at the time, so a later email change does not rewrite history                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `actor_role_persona`    | `ess_persona`      | yes  | —                                      | **The persona the action was performed under** — for a multi-persona user this is the persona whose permission authorised it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `actor_permission_code` | `text`             | yes  | —                                      | The exact permission that authorised the action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `on_behalf_of_user_id`  | `uuid`             | yes  | —                                      | FK → `app_user(id)` `ON DELETE RESTRICT` — impersonation support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `action`                | `ess_audit_action` | no   | —                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `entity_type`           | `text`             | no   | —                                      | Table name, e.g. `payslip`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `entity_id`             | `uuid`             | yes  | —                                      | NULL for bulk/collection actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `entity_label`          | `text`             | yes  | —                                      | Human anchor, e.g. `WDT-PS-2608-1847`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `state_machine`         | `text`             | yes  | —                                      | Set when `action = 'STATE_TRANSITION'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `from_state`            | `text`             | yes  | —                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `to_state`              | `text`             | yes  | —                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `before_data`           | `jsonb`            | yes  | —                                      | **Redacted.** An envelope-encrypted column appears as `"<redacted:aes>"`. **A money column of class M1 or M5 (§1.6) appears as `{"redacted":"money","sha256":"<hex>"}`**, where the digest is over the minor-unit decimal string — enough to prove a value did or did not change without writing the salary into an unencrypted table. Class M2/M3/M4 amounts appear as minor-unit strings. Never a ciphertext, IV, tag, DEK id, secret, token, token hash, password hash, TOTP secret, recovery code, blind-index fingerprint or pepper.                                                                                           |
| `after_data`            | `jsonb`            | yes  | —                                      | Same redaction rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `changed_fields`        | `text[]`           | yes  | —                                      | Column names that differ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `reason`                | `text`             | yes  | —                                      | The mandatory note on guarded transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ip_address`            | `inet`             | yes  | —                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `user_agent`            | `text`             | yes  | —                                      | Truncated to 512 chars                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `request_id`            | `uuid`             | no   | —                                      | Correlates the whole HTTP request, the access log and any `login_attempt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `session_family_id`     | `uuid`             | yes  | —                                      | `refresh_token.family_id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `api_route`             | `text`             | yes  | —                                      | `POST /api/v1/leave-requests/:id/approve`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `http_status`           | `smallint`         | yes  | —                                      |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `metadata`              | `jsonb`            | no   | `'{}'`                                 | Non-PII context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `prev_hash`             | `bytea`            | yes  | —                                      | 32 bytes. `NULL` **only** for the organisation's genesis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `row_hash`              | `bytea`            | no   | —                                      | 32 bytes, see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

**`audit_chain_head` — the per-organisation chain cursor.** One row per organisation,
holding `organization_id uuid PRIMARY KEY`, `last_sequence_no bigint NOT NULL DEFAULT 0`,
`last_row_hash bytea NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. It exists for
two reasons, both of which the previous design got wrong:

1. **`sequence_no` must be gap-free per organisation.** A shared `audit_event_seq` is a
   PostgreSQL sequence: it is non-transactional, so a rolled-back insert burns a number.
   A chain with gaps cannot be verified — a verifier cannot distinguish "number 4104 was
   burned by a rollback" from "number 4104 was deleted by an attacker". The head row's
   `last_sequence_no` is incremented **inside** the transaction under
   `SELECT … FOR UPDATE`, so it rolls back with everything else.
2. **`prev_hash` must be an O(1) lookup.** With monthly partitioning, the previous
   `ORDER BY sequence_no DESC LIMIT 1` over `audit_event` is a scan across every
   partition of that organisation on **every** audited write.

**Hash chain.** Computed by `BEFORE INSERT` trigger `trg_audit_chain`, which first takes
`SELECT … FROM audit_chain_head WHERE organization_id = NEW.organization_id FOR UPDATE`
(row-locking the head serialises the chain per organisation and cannot fork; the previous
`pg_advisory_xact_lock(hashtext(...))` also collides across organisations because
`hashtext` is only 32 bits):

```
NEW.sequence_no := head.last_sequence_no + 1
prev_hash       := head.last_row_hash                       -- NULL for genesis
row_hash  := sha256(
    coalesce(prev_hash, '\x00'::bytea)
 || convert_to(NEW.id::text, 'UTF8')
 || convert_to(NEW.sequence_no::text, 'UTF8')
 || convert_to(to_char(NEW.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.USOF'), 'UTF8')
 || convert_to(NEW.actor_kind::text, 'UTF8')
 || convert_to(coalesce(NEW.actor_user_id::text, ''), 'UTF8')
 || convert_to(coalesce(NEW.actor_role_persona::text, ''), 'UTF8')
 || convert_to(NEW.action::text, 'UTF8')
 || convert_to(NEW.entity_type, 'UTF8')
 || convert_to(coalesce(NEW.entity_id::text, ''), 'UTF8')
 || convert_to(coalesce(NEW.from_state, ''), 'UTF8')
 || convert_to(coalesce(NEW.to_state, ''), 'UTF8')
 || convert_to(coalesce(jsonb_canonical(NEW.before_data), ''), 'UTF8')
 || convert_to(coalesce(jsonb_canonical(NEW.after_data), ''), 'UTF8')
 || convert_to(NEW.request_id::text, 'UTF8'))
```

and, after the row is written, `UPDATE audit_chain_head SET last_sequence_no = NEW.sequence_no,
last_row_hash = NEW.row_hash, updated_at = now()`.

`jsonb_canonical()` was referenced but never defined, which left the one function the
entire tamper-evidence guarantee depends on up to the implementer. Its contract, binding:
**RFC 8785 (JCS) JSON Canonicalization** — object keys sorted by UTF-16 code unit, no
insignificant whitespace, no trailing commas, strings escaped with the shortest legal
form, and **all numbers emitted as JSON strings by the writer** so that no float
formatting ever enters the digest (this schema never puts a bare number into
`before_data`/`after_data`; counts and money are strings). It is implemented as an
`IMMUTABLE` C or PL/pgSQL function with `SET search_path = ess, pg_catalog`, unit-tested
against the JCS test vectors, and its own source digest is recorded in
`ess_ops.schema_guard` — a change to the canonicaliser invalidates every historical hash
and must be a deliberate, versioned event, never a silent refactor.

```sql
-- audit_event is PARTITIONED BY RANGE (occurred_at). PostgreSQL requires every UNIQUE
-- or PRIMARY KEY on a partitioned table to INCLUDE the partition key. The previous
-- `PRIMARY KEY (id)`, `UNIQUE (organization_id, sequence_no)` and `UNIQUE (row_hash)`
-- are therefore ALL rejected at CREATE TABLE time on a partitioned parent — the table
-- as written could not be created at all. Corrected:
PRIMARY KEY (occurred_at, id),
CONSTRAINT ux_audit_event__org_sequence UNIQUE (organization_id, occurred_at, sequence_no),
CONSTRAINT ux_audit_event__row_hash     UNIQUE (occurred_at, row_hash),
CONSTRAINT ck_audit_event__hash_len CHECK (octet_length(row_hash) = 32 AND (prev_hash IS NULL OR octet_length(prev_hash) = 32)),
CONSTRAINT ck_audit_event__actor CHECK (actor_kind <> 'USER' OR actor_user_id IS NOT NULL),
CONSTRAINT ck_audit_event__system_actor CHECK (actor_kind = 'USER' OR actor_user_id IS NULL),
CONSTRAINT ck_audit_event__sequence CHECK (sequence_no > 0),
CONSTRAINT ck_audit_event__code_shape CHECK (event_code ~ '^[A-Z][A-Z0-9_]*\.[A-Z][A-Z0-9_]*$'),
CONSTRAINT ck_audit_event__severity CHECK (severity IN ('INFO','NOTICE','WARNING','CRITICAL')),
CONSTRAINT ck_audit_event__transition CHECK (
  (action = 'STATE_TRANSITION') = (state_machine IS NOT NULL AND to_state IS NOT NULL))
```

Adding `occurred_at` to those keys weakens them on its own — `(organization_id,
sequence_no)` is no longer globally unique across partitions, and neither is `row_hash`.
Two compensating controls restore the guarantee, and both are cheap because
`audit_chain_head` already exists:

1. `audit_chain_head.last_sequence_no` is the **only** allocator, incremented under a row
   lock inside the transaction, so a duplicate `sequence_no` for an organisation cannot be
   produced in the first place.
2. `audit-chain-verify` asserts global per-organisation uniqueness and contiguity
   (`max(sequence_no) = count(*)` per organisation, no duplicates) across all partitions
   on every run, and the daily `audit-anchor-sign` job signs the head triple into
   Object-Locked storage. Either check failing is a P1.
   Indexes:

- `ux_audit_event__org_sequence (organization_id, sequence_no)` — the verification scan
- `ix_audit_event__entity (entity_type, entity_id, occurred_at DESC)`
- `ix_audit_event__actor (actor_user_id, occurred_at DESC)`
- `ix_audit_event__request (request_id)`
- `ix_audit_event__action_time (organization_id, action, occurred_at DESC)`
- `ix_audit_event__sensitive (organization_id, occurred_at DESC) WHERE action IN ('READ_SENSITIVE','EXPORT','DOWNLOAD','PERMISSION_GRANT','PERMISSION_REVOKE','IMPERSONATE')`

**Append-only enforcement.** `trg_audit_immutable` raises on `UPDATE` and `DELETE`
unconditionally. `REVOKE UPDATE, DELETE, TRUNCATE ON ess.audit_event FROM ess_app, ess_job;`
Only `ess_migrator` may `TRUNCATE`, and only in a non-production environment.
Partitioned monthly by `RANGE (occurred_at)`; each partition inherits the triggers.

**Verification job.** `audit-chain-verify` runs hourly, walks the last 24 hours of rows
per organisation, recomputes `row_hash`, and compares. A mismatch pages on-call and is
itself recorded as a `CONFIG_CHANGE` event on a separate chain. A daily job signs the
latest `(organization_id, sequence_no, row_hash)` triple and writes it to append-only
object storage with Object Lock, so even a full database compromise cannot silently
rewrite history.

**What must be audited** (the service layer has an `@Audited` decorator that makes this
automatic): every `state_transition`; every login, logout, MFA change, password change and
session revocation; every decryption of an envelope field (`READ_SENSITIVE`); every
payslip, Form 16, document and expense-bill download; every `role_permission`/`user_role`
change; every payroll cycle transition, input commit, validation override and publication;
every policy publication and acknowledgement; every HR edit to another employee's profile;
every `org_setting` and statutory-table change; every audit export; every bulk export;
every denied authorization (`AUTHZ.DENIED`).

**`READ_SENSITIVE` is one row per request, not one per field.** Rendering the Profile
screen decrypts up to a dozen envelopes; the Payslips list decrypts one row per month.
Writing an audit row per field would multiply the audit table by an order of magnitude
against the _read_ path, which is the highest-volume path in the system, and would put the
chain-head row lock on every list render — a self-inflicted throughput ceiling and a real
availability risk. The rule: **one `READ_SENSITIVE` event per request**, emitted at
response time, with `entity_type`/`entity_id` naming the subject, `changed_fields`
carrying the sorted list of envelope columns decrypted, and
`metadata.subject_employee_ids` the distinct subjects when more than one. A request that
decrypts nothing writes nothing. This keeps the evidentiary value (who read whose
sensitive data, when, under which permission) while bounding the volume by request count.

**Who may read the audit log, and what they see.** `audit:read` is held by HR and
ACCOUNTS. Neither sees the other's operational detail by default: the audit query applies
a projection that redacts `before_data`/`after_data` unless the reader also holds
`audit:export`, and `EXPORT` itself writes an `audit_event`. There is no route that
returns `row_hash` or `prev_hash` to a user — exposing the chain values would let an
attacker who later gains write access forge a consistent continuation.

### 17.2 `file_object`

Every uploaded or generated binary. Bytes live in S3-compatible object storage; this
table is the only index into it, and no URL is ever stored — links are minted as
short-lived (5 min) pre-signed URLs at read time, after the authorization check.

| Column                 | Type                   | Null | Default             | Notes                                                                                       |
| ---------------------- | ---------------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------- |
| `id`                   | `uuid`                 | no   | `gen_random_uuid()` | PK                                                                                          |
| `organization_id`      | `uuid`                 | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                |
| `storage_bucket`       | `text`                 | no   | —                   |                                                                                             |
| `storage_key`          | `text`                 | no   | —                   | `org/<org>/payslip/<fy>/<uuid>.pdf`. Opaque, non-guessable, never derived from user input.  |
| `storage_region`       | `text`                 | no   | —                   |                                                                                             |
| `purpose`              | `ess_file_purpose`     | no   | —                   | Drives the retention class and the authorization rule                                       |
| `original_filename`    | `text`                 | no   | —                   | Sanitised; the display name                                                                 |
| `mime_type`            | `text`                 | no   | —                   | **Server-detected** from the magic bytes, never trusted from the client                     |
| `size_bytes`           | `bigint`               | no   | —                   |                                                                                             |
| `sha256`               | `bytea`                | no   | —                   | 32 bytes; deduplication and integrity                                                       |
| `scan_status`          | `ess_file_scan_status` | no   | `'PENDING'`         |                                                                                             |
| `scan_engine`          | `text`                 | yes  | —                   |                                                                                             |
| `scanned_at`           | `timestamptz`          | yes  | —                   |                                                                                             |
| `scan_detail`          | `text`                 | yes  | —                   |                                                                                             |
| `is_encrypted_at_rest` | `boolean`              | no   | `true`              | SSE-KMS on the bucket                                                                       |
| `uploaded_by_user_id`  | `uuid`                 | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL`. NULL for system-generated files.                  |
| `owner_employee_id`    | `uuid`                 | yes  | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — the subject of the file, for the RLS self policy |
| `download_count`       | `integer`              | no   | `0`                 |                                                                                             |
| `retention_until`      | `date`                 | yes  | —                   | Computed from `purpose` at insert                                                           |
| `deleted_at`           | `timestamptz`          | yes  | —                   | Set when the object is purged; the row survives for audit                                   |

```sql
CONSTRAINT ux_file_object__bucket_key UNIQUE (storage_bucket, storage_key),
CONSTRAINT ck_file_object__sha CHECK (octet_length(sha256) = 32),
CONSTRAINT ck_file_object__size CHECK (size_bytes > 0 AND size_bytes <= 26214400),  -- 25 MiB
CONSTRAINT ck_file_object__mime CHECK (mime_type IN (
  'application/pdf','image/jpeg','image/png','image/webp','image/heic',
  'text/csv','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')),
CONSTRAINT ck_file_object__scanned CHECK (
  scan_status = 'PENDING' OR scanned_at IS NOT NULL)
```

Indexes:

- `ix_file_object__owner (owner_employee_id, purpose)`
- `ix_file_object__sha (organization_id, sha256)`
- `ix_file_object__scan_queue (scan_status) WHERE scan_status = 'PENDING'`
- `ix_file_object__retention (retention_until) WHERE deleted_at IS NULL`

**Rule:** a file with `scan_status <> 'CLEAN'` is never served, never attached to an
outbound email, and never linked from a payslip or document. Upload endpoints return
`202` and the UI shows a "Scanning…" state.

That rule is enforced in the database, not only in prose: trigger
`trg_file_reference_requires_clean` (`BEFORE INSERT OR UPDATE`) on every table with a
`*_file_object_id` column — `expense_attachment`, `ticket_attachment`,
`employee_document`, `policy_version`, `payslip`, `form16_document`,
`payroll_input_batch`, `leave_request`, `employee_statutory_id`,
`employee_bank_account`, `dependent`, `profile_change_request`, `benefit_enrolment`,
`benefit_plan_year`, `organization` — raises unless the referenced file has
`scan_status = 'CLEAN'` and `deleted_at IS NULL`. `email_outbox` carries the same check on
`attachment_file_object_ids`. A single missed check in one service is otherwise enough to
serve malware from a trusted domain.

Two further constraints the previous definition lacked:

```sql
CONSTRAINT ck_file_object__purpose_owner CHECK (
  purpose NOT IN ('PAYSLIP_PDF','FORM16_PDF','EMPLOYEE_DOCUMENT','LETTER_PDF','PROFILE_PROOF')
  OR owner_employee_id IS NOT NULL),
CONSTRAINT ck_file_object__deleted CHECK (deleted_at IS NULL OR retention_until IS NOT NULL)
```

The first is what makes the `ix_file_object__owner` RLS self-policy total for every
employee-owned file class: a payslip PDF with a NULL owner would be reachable by the
`file:download:any` branch only, or by nobody, depending on the policy — an ambiguity that
must not exist for the most sensitive file in the system. `storage_key` is generated as
`org/<org_id>/<purpose>/<yyyy>/<uuid>` from server-side values only; no component is ever
derived from `original_filename` or any other client input, so a path-traversal or
object-overwrite attempt has nothing to influence.

### 17.3 `data_encryption_key`

| Column            | Type          | Null | Default             | Notes                                                                                      |
| ----------------- | ------------- | ---- | ------------------- | ------------------------------------------------------------------------------------------ |
| `id`              | `uuid`        | no   | `gen_random_uuid()` | PK                                                                                         |
| `organization_id` | `uuid`        | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                               |
| `version`         | `integer`     | no   | —                   | Monotonic per organization                                                                 |
| `purpose`         | `text`        | no   | —                   | `FIELD_DEFAULT`, `PAYROLL`, `MFA` — separate key domains                                   |
| `wrapped_key`     | `bytea`       | no   | —                   | The DEK, encrypted by the KMS master key. The plaintext DEK exists only in process memory. |
| `kms_key_arn`     | `text`        | no   | —                   | The master key identifier                                                                  |
| `algorithm`       | `text`        | no   | `'AES-256-GCM'`     |                                                                                            |
| `status`          | `text`        | no   | `'ACTIVE'`          | `PENDING` \| `ACTIVE` \| `RETIRED` \| `COMPROMISED`                                        |
| `activated_at`    | `timestamptz` | yes  | —                   |                                                                                            |
| `retired_at`      | `timestamptz` | yes  | —                   | A retired key still decrypts; it no longer encrypts                                        |
| `rotation_due_on` | `date`        | no   | —                   | 365 days after activation                                                                  |

```sql
CONSTRAINT ux_dek__org_purpose_version UNIQUE (organization_id, purpose, version),
CONSTRAINT ck_dek__status CHECK (status IN ('PENDING','ACTIVE','RETIRED','COMPROMISED'))
```

No plaintext key material is ever stored, logged, or included in an audit event.

**`status = 'COMPROMISED'` has defined behaviour** (it previously had none, which made it
an enum value nobody could act on). Marking a DEK compromised, under a break-glass
procedure that requires two operators and writes a `CONFIG_CHANGE` audit event:

1. immediately creates a new `ACTIVE` DEK of the same `purpose` at `version = max + 1`;
2. the compromised key **still decrypts** — revoking it would destroy data — but is
   refused for encryption by `fn_active_dek(purpose)`;
3. `crypto-rewrap` is promoted to the highest-priority job and re-encrypts every row whose
   `<field>_dek_id` points at it, in batches, logging progress to
   `ess_ops.background_job`;
4. `rotation_due_on` is irrelevant; the key moves to `RETIRED` only when a verification
   query proves zero rows still reference it, and that query is part of the runbook.
   `purpose = 'PAYROLL'` keys the M1 money envelopes, `'MFA'` keys TOTP secrets, and
   `'FIELD_DEFAULT'` everything else; separating them means a compromise of one domain does
   not force a rewrap of the others.

```sql
CONSTRAINT ck_dek__purpose CHECK (purpose IN ('FIELD_DEFAULT','PAYROLL','MFA')),
CONSTRAINT ck_dek__activated CHECK ((status = 'ACTIVE') = (activated_at IS NOT NULL AND retired_at IS NULL)),
CONSTRAINT ck_dek__version CHECK (version >= 1)
```

```sql
CREATE UNIQUE INDEX ux_dek__one_active ON ess.data_encryption_key (organization_id, purpose)
  WHERE status = 'ACTIVE';    -- §1.2
```

### 17.4 `email_outbox`

Transactional outbox. A row is inserted **in the same transaction** as the state change
that causes the email, so an email is never sent for an action that rolled back, and an
action never completes without its email being durably queued.

| Column                       | Type               | Null | Default             | Notes                                                                                      |
| ---------------------------- | ------------------ | ---- | ------------------- | ------------------------------------------------------------------------------------------ |
| `id`                         | `uuid`             | no   | `gen_random_uuid()` | PK                                                                                         |
| `organization_id`            | `uuid`             | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                               |
| `kind`                       | `ess_email_kind`   | no   | —                   |                                                                                            |
| `status`                     | `ess_email_status` | no   | `'QUEUED'`          |                                                                                            |
| `to_addresses`               | `citext[]`         | no   | —                   | For the help desk: `{helpdesk@widedroptech.com}`                                           |
| `cc_addresses`               | `citext[]`         | no   | `'{}'`              |                                                                                            |
| `reply_to_address`           | `citext`           | yes  | —                   | The raiser's work email, so the help desk can reply in thread                              |
| `from_address`               | `citext`           | no   | —                   | `no-reply@widedroptech.com`                                                                |
| `subject`                    | `text`             | no   | —                   | `[HD-4821] Payroll & tax — Form 16 (FY 2025–26) shows an incorrect PAN`                    |
| `template_code`              | `text`             | no   | —                   |                                                                                            |
| `template_data`              | `jsonb`            | no   | `'{}'`              | **Redacted.** No salary figures, no bank details, no tokens — only identifiers and labels. |
| `body_text`                  | `text`             | yes  | —                   | Rendered at send time; nulled after `SENT`                                                 |
| `body_html`                  | `text`             | yes  | —                   | Nulled after `SENT`                                                                        |
| `attachment_file_object_ids` | `uuid[]`           | no   | `'{}'`              | Only `CLEAN` files                                                                         |
| `entity_type`                | `text`             | yes  | —                   | `helpdesk_ticket`                                                                          |
| `entity_id`                  | `uuid`             | yes  | —                   |                                                                                            |
| `idempotency_key`            | `text`             | no   | —                   | `<kind>:<entity_type>:<entity_id>:<discriminator>` — unique per organization               |
| `provider`                   | `text`             | yes  | —                   | `ses`, `postmark`                                                                          |
| `provider_message_id`        | `text`             | yes  | —                   | Returned on success                                                                        |
| `retry_count`                | `smallint`         | no   | `0`                 |                                                                                            |
| `max_retries`                | `smallint`         | no   | `5`                 |                                                                                            |
| `next_attempt_at`            | `timestamptz`      | no   | `now()`             | Exponential backoff: `2^retry_count` minutes, capped at 60                                 |
| `last_error`                 | `text`             | yes  | —                   |                                                                                            |
| `queued_at`                  | `timestamptz`      | no   | `now()`             |                                                                                            |
| `sent_at`                    | `timestamptz`      | yes  | —                   |                                                                                            |
| `failed_at`                  | `timestamptz`      | yes  | —                   |                                                                                            |

```sql
CONSTRAINT ux_email_outbox__org_idempotency UNIQUE (organization_id, idempotency_key),
CONSTRAINT ck_email_outbox__to CHECK (cardinality(to_addresses) BETWEEN 1 AND 20),
CONSTRAINT ck_email_outbox__retries CHECK (retry_count >= 0 AND retry_count <= max_retries),
CONSTRAINT ck_email_outbox__sent CHECK ((status = 'SENT') = (sent_at IS NOT NULL)),
CONSTRAINT ck_email_outbox__sent_provider CHECK (status <> 'SENT' OR provider_message_id IS NOT NULL),
CONSTRAINT ck_email_outbox__failed CHECK ((status = 'FAILED') = (failed_at IS NOT NULL)),
CONSTRAINT ck_email_outbox__failed_reason CHECK (status <> 'FAILED' OR last_error IS NOT NULL),
CONSTRAINT ck_email_outbox__entity CHECK (num_nulls(entity_type, entity_id) IN (0, 2))
```

Indexes:

- `ix_email_outbox__dispatch (next_attempt_at) WHERE status IN ('QUEUED','SENDING')` — the dispatcher's claim query (`FOR UPDATE SKIP LOCKED`)
- `ix_email_outbox__entity (entity_type, entity_id)`
- `ix_email_outbox__failed (organization_id, failed_at DESC) WHERE status = 'FAILED'`

**`email_suppression`** — the `SUPPRESSED` status had no backing table, so nothing could
ever set it and a hard-bounced address would be retried forever. One row per suppressed
address: `id`, `organization_id`, `address citext NOT NULL`, `reason text NOT NULL`
(`HARD_BOUNCE` | `COMPLAINT` | `MANUAL`), `suppressed_at`, `suppressed_by_user_id`,
`released_at`, `released_by_user_id`, `provider_detail jsonb`.
`CREATE UNIQUE INDEX ux_email_suppression__live ON ess.email_suppression (organization_id, address) WHERE released_at IS NULL;`
The dispatcher checks it before every send and marks the row `SUPPRESSED` instead of
`SENT`. **`organization.helpdesk_email` can never be suppressed**: a trigger refuses a
suppression row for it, because silently dropping ticket mail to the mandated address
would break directive 8 invisibly. A hard bounce from that address raises a P1 instead.

**Help-desk dispatch (the mandated behaviour).** Creating a `helpdesk_ticket` inserts, in
the same transaction, one `email_outbox` row with `kind = 'HELPDESK_TICKET_CREATED'`,
`to_addresses` containing **`organization.helpdesk_email` (`helpdesk@widedroptech.com`)
always**, plus `cc_addresses = {ticket_category.routing_email}` when the category sets one
(a category widens the audience, it never redirects it — §16.4),
`reply_to_address = employee.work_email` (omitted when `is_anonymous`),
`idempotency_key = 'HELPDESK_TICKET_CREATED:helpdesk_ticket:<id>:v1'`, and
`template_data` limited to `{ticketNo, categoryName, subject, raisedByName?, raisedAt, priority, portalUrl}`.
`helpdesk_ticket.email_outbox_id` is set to that row, and
`helpdesk_ticket.email_delivery_status` mirrors its status thereafter. If the ticket insert
rolls back, no email exists; if it commits, the dispatcher will deliver or exhaust retries
and mark `FAILED`, which surfaces in the HR queue as a banner on the ticket and writes a
`TICKET.EMAIL_FAILED` audit event. **The ticket itself is persisted regardless of email
outcome — delivery is never a precondition for the record**, and the employee's toast
shows the persisted `ticket_no` the moment the transaction commits, never a provisional
one. `PAYSLIP_COPY_REQUESTED` and every other kind carrying employee data attaches nothing
and templates no amount: `template_data` for that kind is
`{payslipReference, periodLabel, portalUrl}` and the mail says "your payslip is ready in
the portal", because email is not a channel this system puts salary figures into.

A `CONSTRAINT ck_email_outbox__helpdesk_target CHECK (kind <> 'HELPDESK_TICKET_CREATED' OR cardinality(to_addresses) >= 1)`
plus trigger `trg_email_outbox_helpdesk_address` (which asserts
`organization.helpdesk_email = ANY (to_addresses)` for that kind) makes the mandated
recipient structurally unavoidable rather than a convention.

### 17.5 Operational tables (`ess_ops` schema)

| Table                        | Purpose                                                                                                                                | Key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ess_ops.idempotency_key`    | De-duplicates unsafe HTTP requests                                                                                                     | `id uuid PK`, `organization_id uuid NOT NULL`, `app_user_id uuid NOT NULL`, `key text NOT NULL`, `route text NOT NULL`, `request_hash bytea NOT NULL`, `response_status smallint`, `response_body jsonb`, `locked_at timestamptz`, `completed_at timestamptz`, `expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'`. `UNIQUE (organization_id, app_user_id, key, route)`. A replay with a different `request_hash` → `422`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ess_ops.rate_limit_counter` | Durable fallback for the Redis token buckets                                                                                           | `id uuid PK`, `bucket_key text NOT NULL`, `window_start timestamptz NOT NULL`, `window_seconds integer NOT NULL`, `hit_count integer NOT NULL DEFAULT 0`, `UNIQUE (bucket_key, window_start)`. Buckets: `ip:<cidr>`, `user:<id>`, `route:<route>:<user>`, `login:<email_fpr>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ess_ops.background_job`     | Scheduled and queued work                                                                                                              | `id uuid PK`, `job_name text NOT NULL`, `scheduled_for timestamptz NOT NULL`, `started_at`, `finished_at`, `status text NOT NULL` (`PENDING`/`RUNNING`/`SUCCEEDED`/`FAILED`), `attempt smallint NOT NULL DEFAULT 0`, `payload jsonb NOT NULL DEFAULT '{}'`, `error text`, `lease_owner text`, `lease_expires_at timestamptz`. Index `(status, scheduled_for) WHERE status IN ('PENDING','RUNNING')`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ess_ops.rate_limit_policy`  | The **definitions** the counters are counted against — seeded reference data, so a limit is reviewable and changeable without a deploy | `id uuid PK`, `organization_id uuid NULL` (NULL = global default), `bucket_kind text NOT NULL` (`ip`/`user`/`route_user`/`login_fpr`/`session`), `route_pattern text NOT NULL`, `limit_count integer NOT NULL`, `window_seconds integer NOT NULL`, `burst_count integer NOT NULL`, `on_exceed text NOT NULL` (`REJECT_429`/`DELAY`/`LOCK`), `is_active boolean NOT NULL DEFAULT true`. `UNIQUE (coalesce(organization_id,'…'::uuid), bucket_kind, route_pattern)` as an expression index. Seeded with at least: `POST /auth/login` 10/5 min per `login_fpr` **and** 30/5 min per `ip/24`; `POST /auth/refresh` 60/5 min per `session`; `POST /auth/password-reset` 5/h per `login_fpr`; `POST /me/tickets` 20/h per `user`; every write route 120/min per `user`; every read route 600/min per `user`; file upload 30/h per `user`. Without this table the directive's "rate limiting" requirement has counters but no limits, and every threshold becomes a literal in code. |
| `ess_ops.schema_guard`       | Records the hash of the applied schema so CI can detect drift from this document                                                       | `id uuid PK`, `migration_name text`, `schema_sha256 bytea`, `applied_at timestamptz`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

Named jobs: `leave-accrual`, `leave-carry-forward`, `leave-lapse`,
`leave-balance-verify`, `policy-assignment`, `policy-due-reminder`,
`announcement-publish`, `ticket-sla-escalation`, `ticket-auto-close`,
`email-dispatch`, `file-virus-scan`, `file-retention-purge`, `session-sweep`,
`audit-chain-verify`, `audit-anchor-sign`, `reporting-closure-verify`,
`dependent-age-refresh`, `tds-quarter-refresh`, `crypto-rewrap`,
`attendance-approval-reminder`, `payroll-cycle-open`, `payslip-rollup-verify`,
`payroll-run-reaper`, `mfa-enforcement`, `announcement-publish`, `employee-pseudonymise`,
`rate-limit-sweep`, `idempotency-sweep`, `approval-task-sla`, `expense-rollup-verify`,
`policy-assignment-backfill`.

Every job row is claimed with `UPDATE … SET lease_owner = $1, lease_expires_at = now() +
interval '5 minutes' WHERE id IN (SELECT id FROM ess_ops.background_job WHERE status =
'PENDING' AND scheduled_for <= now() ORDER BY scheduled_for FOR UPDATE SKIP LOCKED LIMIT
$2) RETURNING *`, so two workers never run the same job, and a worker that dies has its
lease reclaimed rather than blocking the queue forever. Jobs that write balances, rollups
or notifications must be **idempotent by construction** (refold from source, or key on
`notification.dedupe_key`), because a reclaimed lease means at-least-once execution.

---

## 18. Reference data, retention and immutability

### 18.1 What may be seeded at boot in production

These tables hold **configuration**. A production deploy runs
`npm run db:seed:reference`, which is idempotent (upsert by natural key) and writes an
`audit_event` with `actor_kind = 'MIGRATION'` for every insert or change.

| Table                                                  | Seeded content                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `permission`                                           | The full permission-code list (§3.1)                                                |
| `role`                                                 | Exactly four rows: Employee, Manager, HR, Accounts                                  |
| `role_permission`                                      | The persona → permission mapping (§3.3)                                             |
| `state_transition`                                     | Every machine's allowed transitions (§2.1 and each module)                          |
| `organization`                                         | **One** row: the Widedrop tenant, from environment configuration                    |
| `department`, `location`, `cost_centre`, `designation` | The organisation's structure, from a reviewed CSV — HR may edit afterwards          |
| `fiscal_year`, `fiscal_quarter`                        | Generated for the configured year range                                             |
| `leave_period`                                         | Generated from `organization.leave_year_start_month`                                |
| `leave_type`                                           | EL, CL, SL, Comp-off, Restricted holiday, LOP, Maternity, Paternity, Bereavement    |
| `leave_scheme`, `leave_entitlement_rule`               | The published Leave Policy's numbers                                                |
| `holiday_calendar`, `holiday`                          | The gazetted calendar per location                                                  |
| `pay_component`                                        | The earning/deduction catalogue                                                     |
| `tax_regime`                                           | Old and New, with slabs for each seeded FY                                          |
| `benefit_plan`, `benefit_plan_year`                    | The plans the organisation offers                                                   |
| `expense_category`, `expense_limit`                    | Categories and caps from the T&E Policy                                             |
| `document_type`, `letter_template`                     | Document taxonomy and letter bodies                                                 |
| `ticket_category`                                      | The seven help-desk categories                                                      |
| `ui_copy`                                              | Every interface string listed in §4.7 and §20.16, including all empty-state copy    |
| `faq_article`                                          | The Common-questions content                                                        |
| `data_encryption_key`                                  | One `ACTIVE` DEK per purpose (`FIELD_DEFAULT`, `PAYROLL`, `MFA`), wrapped by KMS    |
| `org_setting`                                          | The keys of §4.6.1                                                                  |
| `statutory_rate_set`, `statutory_pt_slab`              | PF/ESI/PT rates in force, with `source_reference`                                   |
| `audit_event_code`                                     | The event-code catalogue of §17.1                                                   |
| `ess_ops.rate_limit_policy`                            | The limits of §17.5                                                                 |
| `jwks`                                                 | The first `CURRENT` key's **public** half (the private half is in the secret store) |

Reference tables carry no employee-specific data and no amounts owed to anyone.

**Seeding is not silent.** Every seeded row carries `created_by_user_id IS NULL` and
`actor_kind = 'MIGRATION'` in its audit event, and `npm run db:seed:reference` writes a
`ess_ops.schema_guard` row with the digest of the seed input. A production run that would
_change_ an existing reference row (rather than insert a new one) prints a diff and
requires `--confirm-change`, because editing a seeded statutory rate or a permission
mapping in place has the same blast radius as a migration.

### 18.2 What must start EMPTY in production

Every operational table starts with **zero rows**, and the UI renders its designed empty
state until real activity creates data. No fixtures, no demo employees, no sample
payslips, no seeded announcements, no synthetic balances — at any point, in any
environment that serves real users.

```
app_user (except the single bootstrap HR account, created interactively by the
          operator via `npm run bootstrap:admin`, which forces MFA enrolment and a
          password change on first login)
session, user_invitation, profile_change_request, profile_change_request_field
payroll_cycle_employee, payroll_correction, employee_statutory_election
email_suppression, audit_chain_head
employee, employee_employment, employee_manager, employee_reporting_closure,
employee_personal_detail, employee_statutory_id, employee_bank_account,
employee_emergency_contact, user_role (beyond the bootstrap grant)
refresh_token, mfa_credential, mfa_recovery_code, login_attempt, password_reset_token
employee_leave_scheme, leave_balance, leave_balance_ledger, leave_request, leave_request_day
attendance_period, attendance_record, attendance_submission, attendance_approval
payroll_cycle, payroll_input_batch, payroll_input_item, payroll_validation_result,
payroll_run, payslip, payslip_line, payslip_publication, payslip_fy_rollup,
salary_structure, salary_structure_component
employee_tax_regime_election, employee_tax_declaration, employee_tax_declaration_item,
employee_tax_projection, tds_quarter, form16_document
benefit_enrolment, benefit_enrolment_dependent, dependent, nominee
expense_claim, expense_claim_line, expense_attachment, expense_fy_rollup,
reimbursement_batch, reimbursement_batch_item
employee_document, document_request
policy, policy_version, policy_version_point, policy_applicability_rule,
policy_assignment, policy_acknowledgement
announcement, announcement_audience, announcement_read
helpdesk_ticket, ticket_comment, ticket_attachment
approval_task, approval_decision
notification, file_object, email_outbox, audit_event
```

`policy` and `policy_version` are deliberately in this list: policies are authored
through the HR surface and version-controlled from their first publication, so that
`policy_acknowledgement` always points at a version with a real author, timestamp and
`body_sha256`. A seeded policy would have none of those.

CI enforces this with `npm run test:seed-purity`, which boots a fresh database, runs the
production seed, and asserts every table above has `count(*) = 0`.

**And the converse, which matters just as much.** `npm run test:empty-state` boots that
same empty database, signs in as the bootstrap HR account, and renders **every** screen
and every back-office surface. It asserts that no screen throws, no screen renders `0` or
`₹0` or `—` where the designed empty state belongs, every metric tile shows `—` with a
non-empty sub-label resolved from `ui_copy`, every list shows its designed empty block,
every badge is _absent_ rather than showing `0`, and no network response contains a number
that is not traceable to a row. Directive 9 is otherwise unverifiable: "polished with zero
data" is a property of the running system, and the only way a schema document can make it
binding is to name the test that proves it and the copy rows it resolves against.

### 18.3 Immutability rules

| Rule                                                                           | Enforcement                                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `audit_event` is append-only                                                   | `trg_audit_immutable` rejects `UPDATE`/`DELETE`; `REVOKE UPDATE, DELETE` from the app role; hash chain makes silent edits detectable                                           |
| `payslip` and `payslip_line` are immutable once generated                      | `trg_payslip_immutable` allows only `status`, `pdf_file_object_id`, `supersedes_payslip_id`, `revoked_at/reason`; `DELETE` always rejected. Corrections create `revision + 1`. |
| `policy_version` and `policy_version_point` never mutate after leaving `DRAFT` | `trg_policy_version_immutable`; a change is a new version                                                                                                                      |
| `policy_acknowledgement` is append-only                                        | `trg_append_only_policy_ack`                                                                                                                                                   |
| `leave_balance_ledger` is append-only                                          | `trg_append_only_leave_ledger`; a mistake is corrected by a compensating `ADJUSTMENT` row                                                                                      |
| `login_attempt` is append-only                                                 | `trg_append_only_login_attempt`                                                                                                                                                |
| `attendance_submission` is immutable except `superseded_by_submission_id`      | `trg_immutable_attendance_submission`                                                                                                                                          |
| `salary_structure` is immutable once a payslip references it                   | `trg_immutable_referenced_structure`                                                                                                                                           |
| `payroll_input_batch` is immutable once `COMMITTED`                            | `trg_immutable_committed_batch` (only `superseded_by_batch_id` may change)                                                                                                     |
| No operational row is ever hard-deleted                                        | No `DELETE` grant on the app role for any table in §18.2; lifecycle is expressed by status columns                                                                             |
| `file_object` rows survive object purge                                        | `deleted_at` is set; the row and its `sha256` remain for audit                                                                                                                 |

### 18.4 Retention

| Class                                                               | Retention                                                                | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payslip`, `payslip_line`, `payslip_publication`                    | 8 years after the FY ends (Indian statutory)                             | Never deleted inside the window; after it, HR-initiated, audited archival export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `form16_document`, `tds_quarter`                                    | 8 years after the FY                                                     | as above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `audit_event`                                                       | 8 years, partitioned monthly                                             | Old partitions detached to cold storage with Object Lock, never dropped while in window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `attendance_record`, `attendance_submission`, `attendance_approval` | 8 years                                                                  | as payslips                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `leave_balance_ledger`, `leave_request`                             | 5 years after the leave period closes                                    |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `expense_claim` + lines + attachments                               | 8 years (tax evidence)                                                   | `file_object.retention_until` set at upload                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `policy_version`, `policy_acknowledgement`                          | Permanent while the organisation exists                                  | Never purged — they are the compliance record                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `employee`, `employee_employment` and satellites                    | 8 years after `date_of_exit`, then pseudonymised                         | `employee-pseudonymise` job nulls the personal envelopes, keeps `employee_number` and the audit trail. **This requires the envelopes to be nullable**: `employee_personal_detail`'s five envelopes already are; `employee_statutory_id.value_*` is made nullable in §5.7; `employee_bank_account.account_number_*` and `account_holder_name_*`, `employee_emergency_contact.contact_name_*`/`phone_*`, and `dependent.full_name_*`/`date_of_birth_*` are likewise **nullable**, and each gains `pseudonymised_at timestamptz NULL`. Without this the job cannot run — the rows cannot be nulled and cannot be deleted (no `DELETE` grant, §18.3), so the retention policy would be undeliverable and the DPDP erasure obligation unmet. The job additionally replaces `employee.first_name`/`last_name` with `'Former'`/`'Employee ' ‖ employee_number`, clears `work_email` to `employee_number ‖ '@deleted.invalid'`, sets `is_directory_listed = false`, and leaves every payroll, tax and audit row untouched — those are statutory records about a person, not contact data. |
| `login_attempt`                                                     | 1 year                                                                   | `session-sweep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `refresh_token`                                                     | 90 days after `expires_at`                                               | `session-sweep`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `email_outbox` body columns                                         | Nulled immediately after `SENT`; the row kept 2 years                    | `email-dispatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `notification`                                                      | 1 year after `occurred_at`                                               | swept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ess_ops.idempotency_key`                                           | 24 hours                                                                 | swept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Uploaded files                                                      | `document_type.retention_years`, or the class above for payroll evidence | `file-retention-purge` deletes the object, sets `deleted_at`, writes an audit event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

Retention deletion is itself audited, batched, and requires the job to run as
`ess_job` — never as a request-scoped role. A retention job **never** deletes a row that a
legal hold marks: `organization`-level `legal_hold_until date NULL` and a
`retention_hold (id, organization_id, entity_type, entity_id, reason, placed_by_user_id,
placed_at, released_at)` table suspend purging for named records, because a live dispute
or an ongoing investigation must outrank the schedule. The purge query joins it and skips
held rows, logging each skip.

---

## 19. Approvals: `approval_task`, `approval_decision`, and the guard catalogue

### 19.1 `approval_task` — the unified Manager queue

The Approvals screen mixes leave and expense items and shows a single pending count on
the sidebar badge. That count must be one indexed read, not a union of scans, and the
"who must act" answer must survive a re-org. Hence one task row per pending decision.

| Column                      | Type                       | Null | Default             | Notes                                                                                                                                                          |
| --------------------------- | -------------------------- | ---- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | `uuid`                     | no   | `gen_random_uuid()` | PK                                                                                                                                                             |
| `organization_id`           | `uuid`                     | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`                                                                                                                   |
| `kind`                      | `ess_approval_task_kind`   | no   | —                   | Renders the card's kind chip (`Leave` blue, `Expense` amber)                                                                                                   |
| `status`                    | `ess_approval_task_status` | no   | `'PENDING'`         |                                                                                                                                                                |
| `subject_employee_id`       | `uuid`                     | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — whose request it is (name + initials on the card)                                                                   |
| `assignee_employee_id`      | `uuid`                     | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT` — who must decide                                                                                                     |
| `assignee_app_user_id`      | `uuid`                     | yes  | —                   | FK → `app_user(id)` `ON DELETE SET NULL` — denormalised for the badge query                                                                                    |
| `entity_type`               | `text`                     | no   | —                   | `leave_request`, `expense_claim`, `attendance_approval`, `document_request`                                                                                    |
| `entity_id`                 | `uuid`                     | no   | —                   | Polymorphic; uniqueness enforced per (kind, entity_id)                                                                                                         |
| `leave_request_id`          | `uuid`                     | yes  | —                   | FK → `leave_request(id)` `ON DELETE CASCADE` — a real FK for the kinds we support, so the card can be built with one join                                      |
| `expense_claim_id`          | `uuid`                     | yes  | —                   | FK → `expense_claim(id)` `ON DELETE CASCADE`                                                                                                                   |
| `attendance_approval_id`    | `uuid`                     | yes  | —                   | FK → `attendance_approval(id)` `ON DELETE CASCADE`                                                                                                             |
| `document_request_id`       | `uuid`                     | yes  | —                   | FK → `document_request(id)` `ON DELETE CASCADE`                                                                                                                |
| `profile_change_request_id` | `uuid`                     | yes  | —                   | FK → `profile_change_request(id)` `ON DELETE CASCADE` — **added**; the `PROFILE_CHANGE` branch of `ck_at__entity_fk` previously pointed at no table            |
| `assignment_reason`         | `text`                     | no   | `'PRIMARY_MANAGER'` | `PRIMARY_MANAGER` \| `SKIP_LEVEL` \| `HR_BUSINESS_PARTNER` \| `REASSIGNED` \| `HR_FALLBACK` — **why** this person must decide, so a queue entry is explainable |
| `reassigned_from_task_id`   | `uuid`                     | yes  | —                   | FK → `approval_task(id)` `ON DELETE SET NULL`                                                                                                                  |
| `title`                     | `text`                     | no   | —                   | `Earned leave · 5 – 9 Oct 2026 (5 days)` — composed server-side from persisted fields at creation                                                              |
| `subtitle`                  | `text`                     | yes  | —                   | `Family wedding in Kolkata · Balance after: 9.5 days`                                                                                                          |
| `amount_minor`              | `money_minor`              | yes  | —                   | For expense tasks — the employee's own claim amount, visible to their manager by definition                                                                    |
| `requested_at`              | `timestamptz`              | no   | —                   | Renders "Requested 27 Sep"                                                                                                                                     |
| `due_at`                    | `timestamptz`              | yes  | —                   | SLA for escalation                                                                                                                                             |
| `decided_at`                | `timestamptz`              | yes  | —                   |                                                                                                                                                                |
| `priority_order`            | `smallint`                 | no   | `0`                 | Queue ordering: overdue first, then oldest                                                                                                                     |
| `row_version`               | `integer`                  | no   | `1`                 |                                                                                                                                                                |

```sql
CONSTRAINT ck_at__entity_fk CHECK (
  (kind = 'LEAVE_REQUEST'      AND leave_request_id IS NOT NULL AND entity_id = leave_request_id)
OR (kind = 'EXPENSE_CLAIM'     AND expense_claim_id IS NOT NULL AND entity_id = expense_claim_id)
OR (kind = 'ATTENDANCE_PERIOD' AND attendance_approval_id IS NOT NULL AND entity_id = attendance_approval_id)
OR (kind = 'DOCUMENT_REQUEST'  AND document_request_id IS NOT NULL AND entity_id = document_request_id)
OR (kind = 'PROFILE_CHANGE'    AND profile_change_request_id IS NOT NULL AND entity_id = profile_change_request_id)),
CONSTRAINT ck_at__decided CHECK ((status <> 'PENDING') = (decided_at IS NOT NULL)),
CONSTRAINT ck_at__not_self CHECK (subject_employee_id <> assignee_employee_id),
CONSTRAINT ck_at__amount CHECK (amount_minor IS NULL OR amount_minor > 0),
CONSTRAINT ck_at__amount_kind CHECK (amount_minor IS NULL OR kind = 'EXPENSE_CLAIM'),
CONSTRAINT ck_at__assignment_reason CHECK (assignment_reason IN
  ('PRIMARY_MANAGER','SKIP_LEVEL','HR_BUSINESS_PARTNER','REASSIGNED','HR_FALLBACK')),
CONSTRAINT ck_at__reassigned CHECK ((assignment_reason = 'REASSIGNED') = (reassigned_from_task_id IS NOT NULL))
```

```sql
CREATE UNIQUE INDEX ux_approval_task__live_entity
  ON ess.approval_task (kind, entity_id) WHERE status = 'PENDING';
```

> **Corrected.** `UNIQUE (kind, entity_id)` permitted exactly one task per entity for all
> time, while the `approval_task` machine's `PENDING→REASSIGNED` transition is documented
> as "creates a replacement task". The replacement would have violated the constraint, so
> reassignment — the mechanism the whole document relies on for re-orgs, leavers and
> overdue queues — could never actually run. The partial index enforces what was meant:
> **at most one _pending_ task per entity**, with the decided history retained.
> The `PROFILE_CHANGE` branch previously matched any row with no FK at all, so a
> `PROFILE_CHANGE` task could be created pointing at nothing.
> Indexes:

- `ix_at__assignee_pending (assignee_employee_id, priority_order, requested_at) WHERE status = 'PENDING'` — the queue **and** the sidebar badge count
- `ix_at__assignee_history (assignee_employee_id, decided_at DESC) WHERE status <> 'PENDING'` — the History tab
- `ix_at__subject (subject_employee_id, requested_at DESC)`
- `ix_at__overdue (due_at) WHERE status = 'PENDING'`

`ck_at__not_self` is a structural anti-self-approval control: a manager can never be
assigned a task about their own request.

**Assignee resolution (total, deterministic, and it must terminate).** Evaluated in order;
the first candidate that is not the subject, is `ACTIVE`, and has an `app_user` wins, and
`assignment_reason` records which rule fired:

1. `SKIP_LEVEL` — expense claims only, when `total_amount_minor >
expense_limit.escalation_amount_minor`: the ancestor at `depth = 2` above the subject.
2. `PRIMARY_MANAGER` — the ancestor at `depth = 1`.
3. `SKIP_LEVEL` — the ancestor at `depth = 2` (used when rule 2's candidate _is_ the
   subject, i.e. a manager raising their own request).
4. `HR_BUSINESS_PARTNER` — `employee_employment.hr_business_partner_employee_id`.
5. `HR_FALLBACK` — `org_setting.approval_fallback_employee_id`.

If every rule fails the candidate tests, the submitting transition is **refused** with
`422 {"code":"NO_APPROVER"}` and the request is not created. A task is never created
unassigned, never assigned to the subject, and never assigned to an employee with no way
to sign in — each of which would silently strand a request in `PENDING` forever and put a
number on a badge that nobody can ever clear. The org-level invariant
`approval_fallback_employee_id` must differ from every employee it could be asked to
adjudicate for is not expressible in SQL; it is asserted at seed time and by the
`approval-task-sla` job, which raises a P1 on any task pending past twice its `due_at`.

### 19.2 `approval_decision` — append-only decision log

| Column                      | Type                            | Null | Default             | Notes                                                    |
| --------------------------- | ------------------------------- | ---- | ------------------- | -------------------------------------------------------- |
| `id`                        | `uuid`                          | no   | `gen_random_uuid()` | PK                                                       |
| `organization_id`           | `uuid`                          | no   | —                   | FK → `organization(id)` `ON DELETE RESTRICT`             |
| `approval_task_id`          | `uuid`                          | no   | —                   | FK → `approval_task(id)` `ON DELETE RESTRICT`            |
| `outcome`                   | `ess_approval_decision_outcome` | no   | —                   |                                                          |
| `decided_by_user_id`        | `uuid`                          | no   | —                   | FK → `app_user(id)` `ON DELETE RESTRICT`                 |
| `decided_by_employee_id`    | `uuid`                          | no   | —                   | FK → `employee(id)` `ON DELETE RESTRICT`                 |
| `acting_persona`            | `ess_persona`                   | no   | —                   | Which persona authorised it                              |
| `note`                      | `text`                          | yes  | —                   | Mandatory for `REJECTED`, `REASSIGNED`, `AUTO_ESCALATED` |
| `approved_amount_minor`     | `money_minor`                   | yes  | —                   | Partial approval of an expense                           |
| `reassigned_to_employee_id` | `uuid`                          | yes  | —                   | FK → `employee(id)` `ON DELETE SET NULL`                 |
| `ip_address`                | `inet`                          | yes  | —                   |                                                          |
| `audit_event_id`            | `uuid`                          | yes  | —                   | FK → `audit_event(id)` `ON DELETE SET NULL`              |
| `decided_at`                | `timestamptz`                   | no   | `now()`             |                                                          |

```sql
CONSTRAINT ck_ad__note CHECK (outcome NOT IN ('REJECTED','REASSIGNED','AUTO_ESCALATED') OR note IS NOT NULL),
CONSTRAINT ck_ad__reassign CHECK ((outcome = 'REASSIGNED') = (reassigned_to_employee_id IS NOT NULL))
```

Append-only (`trg_append_only_approval_decision`).
Index: `ix_ad__task (approval_task_id, decided_at DESC)`.

### 19.2.1 State machine `machine = 'approval_task'`

`NULL→PENDING` (system) ·
`PENDING→APPROVED` / `PENDING→REJECTED` (`approval:task:act`, guard
`approval.actor_is_assigned_approver`; `REJECTED` additionally `approval.note_required`) ·
`PENDING→WITHDRAWN` (system, when the underlying request is withdrawn) ·
`PENDING→EXPIRED` (system, on SLA exhaustion) ·
`PENDING→REASSIGNED` (`approval:task:act` or `role:assign`, guard
`approval.note_required`, creates a replacement task with
`assignment_reason = 'REASSIGNED'` and `reassigned_from_task_id` set).

> **`EXPIRED` does not decide anything.** An SLA-expired task is moved out of the queue and
> a replacement is created one level up (`SKIP_LEVEL`), with a notification to both
> parties. It is **never** auto-approved: `ess_approval_decision_outcome.AUTO_APPROVED`
> exists in the enum for future use and is not reachable from any transition in this
> document, because silently approving an employee's leave or expense because a manager
> was slow is a fabricated decision attributed to a person who never made it.
> `db:verify-schema` asserts no seeded `state_transition` row produces `AUTO_APPROVED`.

**Deciding is one transaction.** `approval_task → APPROVED|REJECTED`, the
`approval_decision` insert, the underlying entity's own transition, the ledger/rollup
effects, the `notification`, the `email_outbox` row and the `audit_event` all commit
together or not at all. The task row is taken `FOR UPDATE` first and `row_version` is
checked against the request's `If-Match`, so two managers clicking Approve on the same
card produce one decision and one `409`.

### 19.3 Guard catalogue

Every `state_transition.guard_key` referenced anywhere in this document, with its exact
predicate. Guards are pure functions of persisted state; they never consult the clock
beyond `now()`.

**Three properties are binding on every guard, and `db:verify-schema` rule 9 checks the
first two:**

1. **Registered.** Every `guard_key` in a seeded `state_transition` row resolves to an
   implementation in the API's guard registry, and every registered guard is referenced by
   at least one row. An unregistered guard key must fail the boot, not be skipped.
2. **Fail-closed.** A guard that cannot evaluate — a missing row, a NULL comparand, a
   settings key absent — returns **false**, never true and never an exception that a
   caller might catch and ignore. `attendance.approval_overdue` with a NULL `due_at` is
   the worked example: `due_at IS NOT NULL AND due_at < now()`.
3. **Re-evaluated inside the transaction.** A guard checked at request-admission time and
   not re-checked before the write is a TOCTOU hole. Every guard runs again inside the
   transaction that performs the transition, after the relevant rows are locked.

| Guard key                                                                                                    | Predicate                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval.actor_is_assigned_approver`                                                                        | The acting employee is the task's `assignee_employee_id`, **or** holds the specific `…:approve:any` code for that entity kind **and** supplies an escalation reason of ≥ 10 characters **and** is not the subject. The `:any` branch is never satisfied by a `:team` or `:finance` code, and `has_scope()` (§1.8.2) compares whole codes.                                                                                     |
| `approval.note_required`                                                                                     | The request supplies a non-empty `note`/`reason` of ≥ 10 characters                                                                                                                                                                                                                                                                                                                                                           |
| `leave.self_only`                                                                                            | `leave_request.employee_id = actor_employee_id`                                                                                                                                                                                                                                                                                                                                                                               |
| `leave.sufficient_balance`                                                                                   | `leave_balance.available_days - leave_balance.pending_days >= leave_request.balance_days`, evaluated on a row taken `FOR UPDATE` (§8.4), unless `leave_type.allows_negative_balance`. Uses `balance_days`, not `total_days`: an unpaid day consumes no entitlement. A missing `leave_balance` row fails the guard (fail-closed) rather than being read as zero.                                                               |
| `leave.no_overlap`                                                                                           | No `PENDING_APPROVAL`/`APPROVED` request of the same employee overlaps the dates (backed by `ex_leave_request__no_self_overlap`)                                                                                                                                                                                                                                                                                              |
| `leave.min_notice`                                                                                           | `start_date - CURRENT_DATE >= leave_type.min_notice_days`. Waived only when the actor holds `leave:request:approve:any` (HR) **and** supplies a reason; the waiver is recorded in `audit_event.reason`, so "HR waived it" is evidence, not a silent bypass. Never waived for the employee themself.                                                                                                                           |
| `leave.attachment_if_required`                                                                               | `total_days <= leave_type.requires_attachment_after_days` or `attachment_file_object_id IS NOT NULL` with `scan_status = 'CLEAN'`                                                                                                                                                                                                                                                                                             |
| `leave.manager_exists`                                                                                       | A current `PRIMARY` `employee_manager` row exists, or an HRBP fallback resolves                                                                                                                                                                                                                                                                                                                                               |
| `leave.period_open`                                                                                          | `leave_period.closed_at IS NULL`                                                                                                                                                                                                                                                                                                                                                                                              |
| `leave.starts_in_future`                                                                                     | `start_date > CURRENT_DATE`                                                                                                                                                                                                                                                                                                                                                                                                   |
| `leave.not_yet_locked_by_attendance`                                                                         | `leave_request.attendance_record_id IS NULL`                                                                                                                                                                                                                                                                                                                                                                                  |
| `attendance.cycle_exists`                                                                                    | A `payroll_cycle` exists for the same period                                                                                                                                                                                                                                                                                                                                                                                  |
| `attendance.all_active_employees_have_records`                                                               | `count(attendance_record) = count(active employees on end_date)`                                                                                                                                                                                                                                                                                                                                                              |
| `attendance.day_identity_holds`                                                                              | No record violates `ck_ar__day_identity` (re-checked in bulk)                                                                                                                                                                                                                                                                                                                                                                 |
| `attendance.payroll_inputs_locked`                                                                           | The linked `payroll_cycle.status = 'INPUTS_LOCKED'` — **this is the enforcement of "Accounts uploads before HR submits"**                                                                                                                                                                                                                                                                                                     |
| `attendance.slices_created`                                                                                  | One `attendance_approval` per distinct `manager_employee_id` in the period                                                                                                                                                                                                                                                                                                                                                    |
| `attendance.every_slice_approved`                                                                            | No `attendance_approval` for the period has `status <> 'APPROVED'`                                                                                                                                                                                                                                                                                                                                                            |
| `attendance.any_slice_rejected`                                                                              | At least one slice is `REJECTED`                                                                                                                                                                                                                                                                                                                                                                                              |
| `attendance.approval_overdue`                                                                                | `attendance_approval.due_at < now()`                                                                                                                                                                                                                                                                                                                                                                                          |
| `attendance.period_is_hr_submitted`                                                                          | `attendance_period.status = 'HR_SUBMITTED'`                                                                                                                                                                                                                                                                                                                                                                                   |
| `attendance.cycle_not_calculated`                                                                            | `payroll_cycle.status` is before `CALCULATING`                                                                                                                                                                                                                                                                                                                                                                                |
| `attendance.cycle_not_published`                                                                             | `payroll_cycle.status NOT IN ('PUBLISHED','CLOSED')`                                                                                                                                                                                                                                                                                                                                                                          |
| `attendance.cycle_left_attendance_approved`                                                                  | `payroll_cycle.status` is at or after `VALIDATING`                                                                                                                                                                                                                                                                                                                                                                            |
| `payroll.no_open_cycle_for_period`                                                                           | No non-terminal cycle exists for `period_code`                                                                                                                                                                                                                                                                                                                                                                                |
| `payroll.prior_cycle_closed`                                                                                 | The previous period's cycle is `CLOSED` or `CANCELLED`                                                                                                                                                                                                                                                                                                                                                                        |
| `payroll.attendance_period_open`                                                                             | The linked `attendance_period.status = 'OPEN'`                                                                                                                                                                                                                                                                                                                                                                                |
| `payroll.inputs_settled`                                                                                     | ≥ 1 `payroll_input_batch` with `status = 'COMMITTED'` **or** `payroll_cycle.no_inputs_attested_at IS NOT NULL` (§10.1)                                                                                                                                                                                                                                                                                                        |
| `payroll.at_least_one_committed_batch`                                                                       | ≥ 1 `payroll_input_batch` with `status = 'COMMITTED'` (the first half of `payroll.inputs_settled`)                                                                                                                                                                                                                                                                                                                            |
| `payroll.dual_control_available`                                                                             | ≥ 2 distinct `ACTIVE`, MFA-enrolled `app_user` rows hold the ACCOUNTS persona (§3.3)                                                                                                                                                                                                                                                                                                                                          |
| `payroll.committer_not_uploader`                                                                             | `payroll_input_batch.committed_by_user_id <> uploaded_by_user_id`, waivable only by the audited `org_setting` exception                                                                                                                                                                                                                                                                                                       |
| `payroll.employee_set_unchanged`                                                                             | The scope predicate of §10.10 re-derived now hashes to `payroll_cycle.employee_set_sha256`                                                                                                                                                                                                                                                                                                                                    |
| `payroll.no_published_payslips`                                                                              | No `payslip` of this cycle has `status = 'PUBLISHED'` or a live `payslip_publication`                                                                                                                                                                                                                                                                                                                                         |
| `payroll.no_lop_override_after_lock`                                                                         | No committed `LOP_OVERRIDE` input item has `created_at > payroll_cycle.inputs_locked_at`                                                                                                                                                                                                                                                                                                                                      |
| `payroll.cycle_calculating` / `payroll.cycle_approved` / `payroll.cycle_published`                           | `payroll_cycle.status = 'CALCULATING'` / `'APPROVED'` / `'PUBLISHED'`                                                                                                                                                                                                                                                                                                                                                         |
| `payroll.correction_distinct_approver`                                                                       | `payroll_correction.approved_by_user_id <> raised_by_user_id` (also a DB `CHECK`)                                                                                                                                                                                                                                                                                                                                             |
| `payroll.correction_settlement_cycle_open`                                                                   | `settlement_cycle_id` names a cycle in `INPUTS_OPEN`                                                                                                                                                                                                                                                                                                                                                                          |
| `payroll.file_clean`                                                                                         | The batch's `file_object.scan_status = 'CLEAN'`                                                                                                                                                                                                                                                                                                                                                                               |
| `payroll.batch_totals_match`                                                                                 | `declared_total_minor IS NULL OR declared_total_minor = parsed_total_minor`                                                                                                                                                                                                                                                                                                                                                   |
| `payroll.batch_employees_resolve`                                                                            | Every non-rejected item's `employee_id` is in the organisation and not `PRE_JOINING`                                                                                                                                                                                                                                                                                                                                          |
| `attendance.created_with_cycle`                                                                              | The enclosing command is cycle creation (§9.1) — replaces `attendance.cycle_exists`, which was circular                                                                                                                                                                                                                                                                                                                       |
| `attendance.escalation_actor_not_submitter`                                                                  | The escalating user is not `attendance_submission.submitted_by_user_id`                                                                                                                                                                                                                                                                                                                                                       |
| `attendance.totals_unchanged_since_submission`                                                               | §9.5                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `profile.self_only`                                                                                          | `profile_change_request.employee_id = actor_employee_id`                                                                                                                                                                                                                                                                                                                                                                      |
| `profile.has_fields`                                                                                         | ≥ 1 `profile_change_request_field`                                                                                                                                                                                                                                                                                                                                                                                            |
| `profile.proof_if_required`                                                                                  | `NOT requires_proof OR (proof_file_object_id IS NOT NULL AND its file is CLEAN)`                                                                                                                                                                                                                                                                                                                                              |
| `profile.target_row_unchanged_since_submit`                                                                  | Every target row's `row_version` equals the value captured at submit                                                                                                                                                                                                                                                                                                                                                          |
| `benefit.enrolment_window_open`                                                                              | `CURRENT_DATE BETWEEN benefit_plan_year.enrolment_window_opens_on AND …closes_on`; a NULL window fails closed                                                                                                                                                                                                                                                                                                                 |
| `benefit.waiver_reason_present` / `benefit.documents_clean`                                                  | Self-describing                                                                                                                                                                                                                                                                                                                                                                                                               |
| `announcement.has_audience`                                                                                  | ≥ 1 `announcement_audience` row                                                                                                                                                                                                                                                                                                                                                                                               |
| `announcement.publish_at_future`                                                                             | `publish_at > now()` at the moment of the transition                                                                                                                                                                                                                                                                                                                                                                          |
| `auth.credentials_valid` / `auth.mfa_satisfied_or_not_required` / `auth.user_status_permits_login`           | §6.6                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `user.privileged_role_granted_without_mfa`                                                                   | The user holds MANAGER/HR/ACCOUNTS and has no confirmed, enabled `mfa_credential`                                                                                                                                                                                                                                                                                                                                             |
| `reimb.cycle_is_regular`                                                                                     | The target cycle's `cycle_kind = 'REGULAR'`                                                                                                                                                                                                                                                                                                                                                                                   |
| `payslip.publication_row_created` / `payslip.publication_revoked` / `payslip.superseding_revision_published` | Self-describing; each asserts the companion row exists before the status flips                                                                                                                                                                                                                                                                                                                                                |
| `payroll.no_uncommitted_batches`                                                                             | No batch in `UPLOADING`/`PARSED`/`PARSE_FAILED`                                                                                                                                                                                                                                                                                                                                                                               |
| `payroll.all_batches_validated`                                                                              | Every non-discarded batch is `COMMITTED` and its declared total matched                                                                                                                                                                                                                                                                                                                                                       |
| `payroll.attendance_locked`                                                                                  | `attendance_period.status IN ('APPROVED','LOCKED')`                                                                                                                                                                                                                                                                                                                                                                           |
| `payroll.no_error_validations`                                                                               | §10.6 predicate                                                                                                                                                                                                                                                                                                                                                                                                               |
| `payroll.has_error_validations`                                                                              | Its negation                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `payroll.validated_recently`                                                                                 | `validated_at > now() - make_interval(hours => org_setting.payroll_validation_max_age_hours)` **and** no `payroll_input_item`, `attendance_record` or `salary_structure` in scope has `updated_at > validated_at`                                                                                                                                                                                                             |
| `payroll.run_succeeded`                                                                                      | The live `payroll_run.status = 'SUCCEEDED'`                                                                                                                                                                                                                                                                                                                                                                                   |
| `payroll.run_failed`                                                                                         | `= 'FAILED'`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `payroll.payslip_count_matches_employee_count`                                                               | `payroll_cycle.payslip_count = payroll_cycle.employee_count`                                                                                                                                                                                                                                                                                                                                                                  |
| `payroll.controls_balance`                                                                                   | Σ payslip gross = `control_gross_minor`, Σ net = `control_net_minor`, and `gross - deductions = net` for every payslip (computed in the API over decrypted values, inside the transaction)                                                                                                                                                                                                                                    |
| `payroll.distinct_approver`                                                                                  | `approved_by_user_id <> calculated_by_user_id` (also a DB `CHECK`)                                                                                                                                                                                                                                                                                                                                                            |
| `payroll.every_payslip_generated`                                                                            | Every payslip in the run has `status = 'GENERATED'`                                                                                                                                                                                                                                                                                                                                                                           |
| `payroll.pay_date_set`                                                                                       | `actual_pay_date IS NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                 |
| `payroll.pay_date_passed`                                                                                    | `actual_pay_date <= CURRENT_DATE`                                                                                                                                                                                                                                                                                                                                                                                             |
| `payroll.reimbursements_settled`                                                                             | Every linked `reimbursement_batch` is `PAID` or `CANCELLED`                                                                                                                                                                                                                                                                                                                                                                   |
| `payroll.no_payslips_exist`                                                                                  | No `payslip` rows reference the cycle                                                                                                                                                                                                                                                                                                                                                                                         |
| `payroll.bank_verified`                                                                                      | Every in-scope employee has a verified primary bank account (raised as a validation, not a hard stop, so HR can fix it)                                                                                                                                                                                                                                                                                                       |
| `expense.self_only`                                                                                          | `expense_claim.employee_id = actor_employee_id`                                                                                                                                                                                                                                                                                                                                                                               |
| `expense.has_lines`                                                                                          | ≥ 1 `expense_claim_line`                                                                                                                                                                                                                                                                                                                                                                                                      |
| `expense.receipt_if_required`                                                                                | Category requires a receipt ⇒ a `CLEAN` attachment exists for each line above the threshold                                                                                                                                                                                                                                                                                                                                   |
| `expense.within_hard_limits`                                                                                 | Every line with `is_hard_limit` caps is within them                                                                                                                                                                                                                                                                                                                                                                           |
| `expense.spend_within_claim_window`                                                                          | `CURRENT_DATE - spend_date <= org_setting.expense_claim_window_days` (seeded `30`). **Corrected:** the previous entry hardcoded `30` while claiming to read it from configuration, and named `expense_limit`, which has no window column. One number, one row, one reader. Exceeding it sets `policy_flag_codes += 'LATE_SUBMISSION'` and is a soft flag for Finance, not a hard block — a late bill is still a real expense. |
| `expense.manager_exists`                                                                                     | As `leave.manager_exists`                                                                                                                                                                                                                                                                                                                                                                                                     |
| `expense.not_yet_decided`                                                                                    | `manager_decided_at IS NULL`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `expense.category_requires_finance`                                                                          | `expense_category.requires_finance_approval`                                                                                                                                                                                                                                                                                                                                                                                  |
| `expense.category_skips_finance`                                                                             | Its negation                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `reimb.all_claims_finance_approved`                                                                          | Every item's claim is `FINANCE_APPROVED`                                                                                                                                                                                                                                                                                                                                                                                      |
| `reimb.batch_open`                                                                                           | A `DRAFT` batch exists for the current cutoff                                                                                                                                                                                                                                                                                                                                                                                 |
| `reimb.cycle_inputs_open`                                                                                    | The target `payroll_cycle.status IN ('INPUTS_OPEN')`                                                                                                                                                                                                                                                                                                                                                                          |
| `reimb.cycle_published`                                                                                      | `payroll_cycle.status IN ('PUBLISHED','CLOSED')`                                                                                                                                                                                                                                                                                                                                                                              |
| `policy.has_body`                                                                                            | `body_markdown` non-empty and `body_sha256` matches it                                                                                                                                                                                                                                                                                                                                                                        |
| `policy.effective_date_set`                                                                                  | `effective_from IS NOT NULL`                                                                                                                                                                                                                                                                                                                                                                                                  |
| `policy.applicability_defined`                                                                               | ≥ 1 `policy_applicability_rule` with `is_include`                                                                                                                                                                                                                                                                                                                                                                             |
| `policy.assignment_open`                                                                                     | A `policy_assignment` exists for (employee, version) with `superseded_at IS NULL` and no acknowledgement yet                                                                                                                                                                                                                                                                                                                  |
| `tax.declaration_window_open`                                                                                | `CURRENT_DATE BETWEEN fiscal_year.declaration_window_opens_on AND …closes_on`                                                                                                                                                                                                                                                                                                                                                 |
| `tax.proof_window_open`                                                                                      | `CURRENT_DATE BETWEEN fiscal_year.proof_window_opens_on AND …closes_on`                                                                                                                                                                                                                                                                                                                                                       |
| `tax.all_items_have_proof`                                                                                   | Every item has a `CLEAN` `proof_file_object_id`                                                                                                                                                                                                                                                                                                                                                                               |
| `docreq.self_only`                                                                                           | `document_request.employee_id = actor_employee_id`                                                                                                                                                                                                                                                                                                                                                                            |
| `docreq.document_attached`                                                                                   | `employee_document_id IS NOT NULL` and its file is `CLEAN`                                                                                                                                                                                                                                                                                                                                                                    |
| `ticket.self_only`                                                                                           | `raised_by_employee_id = actor_employee_id`                                                                                                                                                                                                                                                                                                                                                                                   |
| `ticket.resolution_summary_present`                                                                          | `resolution_summary` non-empty                                                                                                                                                                                                                                                                                                                                                                                                |
| `ticket.within_reopen_window`                                                                                | `resolved_at > now() - interval '14 days'`                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 20. Query-pattern appendix — every displayed value, sourced

Notation: `:me` = `ess.actor_employee_id`, `:u` = `ess.actor_user_id`,
`:org` = `ess.organization_id`, `:today` = `CURRENT_DATE` in `organization.timezone`,
`:fy` = the current `fiscal_year.id`, `:lp` = the current `leave_period.id`.
Every query below additionally runs under the RLS policies of §1.8.

**Rendering rules that apply everywhere:**

- A money value is `'₹' + Math.round(minor / 100).toLocaleString('en-IN')`.
- A date is `toLocaleDateString('en-IN', {day:'numeric', month:'short', year:'numeric'})`.
- **When a query returns no row, the tile renders `—` in `--text-muted` with the stated
  sub-label, and a list renders the designed empty state. No zero is ever substituted
  for a missing measurement, and no value is ever computed in the browser from anything
  other than what the endpoint returned.**

### 20.1 Shell — sidebar, header, search, notifications

| UI element                     | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Widedrop` / `Employee portal` | `organization.display_name`, `organization.portal_name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Logo                           | `organization.logo_file_object_id` → pre-signed URL                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Nav groups and items           | Static nav manifest in `packages/shared`, **filtered by the token's `scopes`**: `approvals` requires `approval:task:read:team` (§3.3 — _not_ `read:any`, which is HR-only); HR and Accounts groups require their persona permissions. The manifest is a list of nav ids and required codes — it carries no counts, amounts or user data — and the server re-checks the code on every route, so hiding an item is cosmetic and never the control.                                                                                                                                                                                                                                                                                                    |
| Approvals badge count          | `SELECT count(*) FROM approval_task WHERE assignee_employee_id = :me AND status = 'PENDING'` (index `ix_at__assignee_pending`). `0` ⇒ no badge element is rendered at all — not a `0` chip, not a dot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Sidebar user card name         | `employee.full_name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Sidebar user card sub          | `employee.employee_number \|\| ' · ' \|\| location.city` via `employment_as_of(:me, :today)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Avatar initials                | `employee.initials`; tint = `department.accent_colour_hex`, else `#1B365D`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Header date                    | `now()` rendered in `organization.timezone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Header name / title            | `employee.full_name`, `designation.title` from `employment_as_of(:me, :today)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Notification bell dot          | `EXISTS (SELECT 1 FROM notification WHERE recipient_app_user_id = :u AND read_at IS NULL AND dismissed_at IS NULL)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Notification list              | `SELECT title, context_label, occurred_at, tone, deep_link_screen, deep_link_params FROM notification WHERE recipient_app_user_id = :u AND dismissed_at IS NULL ORDER BY occurred_at DESC LIMIT 20`. Dot colour from `tone` (Design System §1). Empty ⇒ "You're all caught up".                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Global search — `Module`       | The RBAC-filtered nav manifest, `ILIKE '%q%'` on the label                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Global search — `Person`       | `SELECT e.full_name, d.title, similarity(e.full_name \|\| ' ' \|\| e.work_email::text, :q) AS sim FROM employee e … WHERE e.organization_id = :org AND e.is_directory_listed AND e.employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD') AND (e.full_name \|\| ' ' \|\| e.work_email::text) % :q ORDER BY sim DESC, e.full_name LIMIT 4`. The `similarity` expression must be **selected** to be orderable, `work_email` must be cast to `text` (it is `citext`, and `gin_trgm_ops` is a `text` operator class), and the trigram index is therefore `GIN ((full_name \|\| ' ' \|\| work_email::text) gin_trgm_ops)` — the §5.2 definition is corrected to include the cast. The tie-break on `full_name` makes the result order deterministic. |
| Global search — `Policy`       | `SELECT p.name, pv.version_label FROM policy_version pv JOIN policy p … WHERE pv.status = 'PUBLISHED' AND p.name ILIKE '%'\|\|:q\|\|'%' AND EXISTS (assignment for :me) LIMIT 3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Global search — `Payslip`      | `SELECT period_label, net_pay FROM payslip … <the §10.7 visibility gate> AND period_label ILIKE '%'\|\|:q\|\|'%' LIMIT 3` — net formatted after decryption in the API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| "No matches for …"             | Zero rows across all four kinds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 20.2 Home

| UI element                          | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Greeting word                       | `hour(now() in organization.timezone)` against the boundaries in `ui_copy` keys `home.greeting.morning_until` (`12`) / `home.greeting.afternoon_until` (`17`), with the three strings from `home.greeting.morning                                                                                                                                                                                                                                                                                                                                                                          | afternoon | evening`. The thresholds are copy-adjacent configuration, not literals in the bundle. |
| Greeting name                       | `employee.preferred_name ?? employee.first_name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Sub-header line                     | `now()` weekday + full date in org tz, `location.city`, `location.site_label` from `employment_as_of(:me, :today)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Latest payslip — month**          | `SELECT period_label … <visibility gate> ORDER BY period_end DESC LIMIT 1`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Latest payslip — net**            | `net_pay_minor` of that row, decrypted in the API                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Latest payslip — "credited"**     | `payslip.pay_date`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| _Empty_                             | No published payslip ⇒ value `—`, sub-label from the whitelisted `payslipOutlook` of §10.7 (`NO_CYCLE_YET` / `IN_PROGRESS` / `NOT_IN_SCOPE` / `NONE`) resolved through `ui_copy`. The raw `payroll_cycle.status` is **never** sent to an employee: they hold no `payroll:cycle:read`, and "August payroll failed validation" is not theirs to see.                                                                                                                                                                                                                                         |
| **Leave balance — top 3**           | `SELECT lt.name, lb.available_days, lb.entitlement_days FROM leave_balance lb JOIN leave_type lt ON lt.id = lb.leave_type_id WHERE lb.employee_id = :me AND lb.leave_period_id = :lp AND lt.is_active ORDER BY lt.display_order LIMIT 3`                                                                                                                                                                                                                                                                                                                                                   |
| Progress bar width                  | `round(available_days / nullif(entitlement_days, 0) * 100)`; `entitlement_days = 0` ⇒ bar hidden, value shown as a plain count                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| _Empty_                             | No rows ⇒ empty state "Balances start after your first accrual"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Approvals count**                 | The sidebar badge query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Approvals preview (2)               | `SELECT subject_employee.initials, subject_employee.full_name, title FROM approval_task WHERE assignee_employee_id = :me AND status = 'PENDING' ORDER BY priority_order, requested_at LIMIT 2`                                                                                                                                                                                                                                                                                                                                                                                             |
| "request(s) awaiting your action"   | Singular/plural on the count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| _Empty_                             | Count `0` ⇒ the whole Approvals card renders its empty state ("Nothing waiting on you")                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Announcements (3)**               | `SELECT a.title, a.category_label, a.published_at FROM announcement a WHERE a.status='PUBLISHED' AND a.archived_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now()) AND <audience matches :me> ORDER BY a.is_pinned DESC, a.published_at DESC LIMIT 3`                                                                                                                                                                                                                                                                                                                           |
| **Upcoming holidays (4)**           | `SELECT h.name, h.holiday_date FROM holiday h WHERE h.holiday_calendar_id = holiday_calendar_for(:me, :today) AND h.kind='PUBLIC' AND h.holiday_date >= :today ORDER BY h.holiday_date LIMIT 4`; `day`/`mon`/`dow` are formatted from `holiday_date`                                                                                                                                                                                                                                                                                                                                       |
| Card sub-label "Bengaluru calendar" | `holiday_calendar.name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Team today**                      | `SELECT e.initials, e.full_name, d.title, l.city, <status> FROM employee_reporting_closure c JOIN employee e … WHERE c.ancestor_employee_id = :me AND c.depth = 1 AND e.employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD') ORDER BY e.full_name`. `<status>` = `EXISTS (SELECT 1 FROM leave_request_day d JOIN leave_request r ON r.id = d.leave_request_id WHERE d.employee_id = e.id AND d.leave_date = :today AND d.day_fraction > 0 AND r.status='APPROVED')` → `On leave` (amber) else `Available` (green). A `PUBLIC` holiday on the employee's calendar → `Holiday` (gray). |
| _Empty_                             | No direct reports ⇒ the card is not rendered (the whole Manager column collapses)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Needs your attention**            | Union of: (a) `SELECT p.name, pv.version_label, pa.due_on, p.owner_label FROM policy_assignment pa JOIN policy_version pv … WHERE pa.employee_id = :me AND pa.superseded_at IS NULL AND NOT EXISTS (acknowledgement) ORDER BY pa.due_on NULLS LAST`; (b) the pending approval-task count as one item when > 0; (c) `document_request` rows in `IN_REVIEW` awaiting employee input. `todoCount` = the union's cardinality.                                                                                                                                                                  |
| _Empty_                             | Zero items ⇒ the whole block is omitted (`hasTodos = false`), as in the prototype                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 20.3 Payslips

| UI element                              | Source                                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header sub-line "HDFC Bank ••4412"      | `employee_bank_account` current primary: `bank_name \|\| ' ••' \|\| account_number_last4`. No primary account ⇒ the phrase is omitted.                                                   |
| FY chip                                 | `fiscal_year.label` where `is_current`                                                                                                                                                   |
| **YTD tile 1 — Gross earned**           | `payslip_fy_rollup.gross_earned_minor` for (`:me`, `:fy`)                                                                                                                                |
| tile 1 sub                              | `to_char(first_period_start,'Mon') ‖ ' – ' ‖ to_char(last_period_end,'Mon YYYY')` from the two persisted dates (§10.9) — no string surgery on a label                                    |
| **tile 2 — Net credited**               | `net_credited_minor`; sub = `payslip_count \|\| ' payslips'`                                                                                                                             |
| **tile 3 — TDS deducted**               | `tds_minor` (decrypted); sub = `ui_copy` key `payslips.ytd.tds.sub` ("Reflected in Form 26AS") — persisted copy, not a literal in the bundle                                             |
| **tile 4 — PF contributed**             | `employee_pf_minor + employer_pf_minor`, summed in the API **after** decryption (both are class M1); sub = `ui_copy` key `payslips.ytd.pf.sub`                                           |
| _Empty_                                 | No rollup row ⇒ all four tiles `—`, sub "No published payslips in FY 2026–27 yet"                                                                                                        |
| **Payslip list**                        | `SELECT id, period_label, pay_date, net_pay_minor FROM payslip p JOIN payslip_publication pub … <visibility gate> ORDER BY p.period_end DESC` (index `ix_payslip__employee_period`)      |
| **Detail — net, month, credited, mode** | The selected row: `net_pay_minor`, `period_label`, `pay_date`, `payment_mode`                                                                                                            |
| **Detail — "Days paid 31 / 31"**        | `payslip.payable_days \|\| ' / ' \|\| payslip.total_days`                                                                                                                                |
| **Earnings lines**                      | `SELECT label_snapshot, amount_minor, narration FROM payslip_line WHERE payslip_id = :id AND kind = 'EARNING' ORDER BY display_order`                                                    |
| **Gross earnings**                      | `payslip.gross_earnings_minor` (the API asserts it equals Σ of the earning lines before responding; a mismatch is a 500 and a P1 alert, never a silently-corrected number)               |
| **Deduction lines**                     | Same with `kind = 'DEDUCTION'`                                                                                                                                                           |
| **Total deductions**                    | `payslip.total_deductions_minor`, asserted equal to Σ                                                                                                                                    |
| **Employer PF**                         | `payslip.employer_pf_minor` (NULL ⇒ the chip is omitted)                                                                                                                                 |
| **TDS this month**                      | `payslip.tds_minor`                                                                                                                                                                      |
| **Reference**                           | `payslip.reference_no`                                                                                                                                                                   |
| Download PDF                            | `payslip.pdf_file_object_id` → pre-signed URL; writes `audit_event(DOWNLOAD)` and increments `payslip_publication.download_count`. NULL ⇒ button disabled with "PDF is being generated". |
| Email me                                | Enqueues `email_outbox` kind `PAYSLIP_COPY_REQUESTED` to `employee.work_email`                                                                                                           |
| _Empty_                                 | No visible payslips ⇒ list and detail both render the empty state; the cause is read from the current `payroll_cycle.status`                                                             |

### 20.4 Tax slips

| UI element                                             | Source                                                                                                                                                                            |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header "PAN AXYPR••••K"                                | `employee_statutory_id.value_mask WHERE kind='PAN'`. Absent ⇒ "PAN not on record — add it under My profile".                                                                      |
| Regime chip                                            | `tax_regime.name \|\| ' · ' \|\| fiscal_year.label` via `employee_tax_regime_election`; no election ⇒ the `is_default` regime, labelled "Default regime"                          |
| **Projected annual tax**                               | `employee_tax_projection.projected_annual_tax_minor WHERE is_current`                                                                                                             |
| Sub-label "including 4% cess"                          | `'including ' \|\| (tax_regime.cess_rate * 100) \|\| '% cess'`                                                                                                                    |
| **"Deducted Apr – Aug"**                               | `tds_deducted_to_date_minor`; the range from `fiscal_year.start_date` to the projection's `as_of_period_code`                                                                     |
| **Percentage**                                         | `round(tds_deducted_to_date_minor * 100.0 / nullif(projected_annual_tax_minor, 0))`                                                                                               |
| Progress bar                                           | The same percentage                                                                                                                                                               |
| **"₹1,58,090 remaining"**                              | `tds_remaining_minor` (generated column)                                                                                                                                          |
| **"about ₹22,584 per month over 7 months"**            | `next_month_tds_estimate_minor`, `remaining_months`                                                                                                                               |
| **Projected gross / Standard deduction / Monthly TDS** | `projected_gross_minor`, `standard_deduction_minor`, `monthly_tds_minor`                                                                                                          |
| _Empty_                                                | No `is_current` projection ⇒ every figure `—`, sub "Your first payroll of FY 2026–27 has not run yet"                                                                             |
| **Declaration card status**                            | `employee_tax_declaration.status` → chip (`SUBMITTED`/`VERIFIED` green, `DRAFT` gray, `PROOF_PENDING` amber, `REJECTED` red)                                                      |
| Declaration paragraph                                  | `'Declared on ' \|\| submitted_at \|\| ' under the ' \|\| tax_regime.name`, then the window dates from `fiscal_year.proof_window_opens_on` / `…closes_on`                         |
| "Update declaration"                                   | Enabled only when `tax.declaration_window_open`; otherwise disabled with the persisted window date in the tooltip                                                                 |
| **Quarterly TDS rows**                                 | `SELECT fq.label, tq.tds_deducted_minor, tq.status FROM tds_quarter tq JOIN fiscal_quarter fq … WHERE tq.employee_id = :me AND fq.fiscal_year_id = :fy ORDER BY fq.quarter_no`    |
| Quarter amount `—`                                     | `tds_deducted_minor IS NULL` (an `UPCOMING` quarter) — a persisted absence, not a placeholder                                                                                     |
| **Form 16 list**                                       | `SELECT fy.label, f.issued_at, f.file_name FROM form16_document f JOIN fiscal_year fy … WHERE f.employee_id = :me AND f.status IN ('ISSUED','REVISED') ORDER BY f.issued_at DESC` |
| Card sub "Part A and Part B · digitally signed"        | Composed from `includes_part_a`, `includes_part_b`, `is_digitally_signed`                                                                                                         |
| _Empty_                                                | No issued Form 16 ⇒ empty state "Form 16 for FY 2025–26 is issued by 15 June" (date from `fiscal_year`)                                                                           |

### 20.5 My profile

| Tab                    | Field → source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header                 | `employee.initials`, `full_name`, `designation.title · department.name`, chips: `employee_number`, `location.city`, `employment_type` (humanised), `'Joined ' \|\| date_of_joining`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Personal**           | Full name → `employee.full_name` · Date of birth → `employee_personal_detail.date_of_birth` (decrypted; requires `profile:read_sensitive:self`, writes `READ_SENSITIVE`) · Gender, Blood group, Marital status, Nationality → `employee_personal_detail` · Personal email / Mobile / Current address / Permanent address → decrypted envelopes                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Employment**         | Employee ID → `employee.employee_number` · Designation → `designation.title` · Department → `department.name` · Business unit → `department.business_unit` · Reporting manager → `employee_manager` current `PRIMARY` → `employee.full_name` · HR business partner → `employee_employment.hr_business_partner_employee_id` → `full_name` · Work location → `location.city \|\| ' · ' \|\| location.site_label` · Employment type → `employment_type` · Date of joining → `employee.date_of_joining` · **Tenure** → `age(:today, date_of_joining)` formatted `4 years 2 months` (computed, never stored) · Work email → `employee.work_email` · Cost centre → `cost_centre.code \|\| ' · ' \|\| cost_centre.name` · Notice period → `notice_period_days \|\| ' days'` |
| **Bank & statutory**   | Bank → `employee_bank_account.bank_name` · Account number → `account_number_mask` · IFSC → `ifsc_code` (plaintext) · PAN / Aadhaar / UAN / PF account / ESI → `employee_statutory_id.value_mask` by `kind`; a row with `is_applicable = false` renders `Not applicable` · Tax regime → `tax_regime.name \|\| ' · ' \|\| fiscal_year.label`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Emergency contacts** | `employee_emergency_contact` ordered by `priority`; `contact_name_mask`/`phone_mask` unless the reader is the employee, their current manager, or holds `profile:read_sensitive:any`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Tab notes              | `ui_copy` keys `profile.tab_note.personal` / `.employment` / `.bank` / `.emergency` (§4.7), not hardcoded strings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Sensitive-field audit  | Opening the Personal or Bank tab decrypts envelopes and therefore writes **one** `READ_SENSITIVE` audit event for the request (§17.1), listing the decrypted columns in `changed_fields`. Viewing the Employment tab decrypts nothing and writes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| "Request a change"     | Creates a `profile_change_request` (§5.11) — **not** a bare ticket — and returns the persisted `request_no`; the toast shows that number, never a guessed one. A Help-desk ticket is created alongside it and cross-linked (`profile_change_request.helpdesk_ticket_id`) only when the category routing calls for it. The prototype's toast `'HD-' + (4830 + tickets.length)` is a client-side counter and is exactly the fabricated identifier directive 2 forbids: the number must come back from the insert.                                                                                                                                                                                                                                                      |
| _Empty_                | A missing satellite row ⇒ that field is omitted from the payload and the row is not rendered; a tab with no fields renders "Nothing recorded yet — raise a ticket to add these details"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 20.6 Policies

| UI element                                            | Source                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pending count chip**                                | `SELECT count(*) FROM policy_assignment pa WHERE pa.employee_id = :me AND pa.superseded_at IS NULL AND NOT EXISTS (SELECT 1 FROM policy_acknowledgement a WHERE a.policy_assignment_id = pa.id)`; `0` ⇒ chip omitted                                                              |
| **List rows**                                         | `SELECT p.name, pv.version_label, pv.last_updated_label, <status> FROM policy_assignment pa JOIN policy_version pv ON pv.id = pa.policy_version_id JOIN policy p ON p.id = pv.policy_id WHERE pa.employee_id = :me AND pa.superseded_at IS NULL ORDER BY p.display_order, p.name` |
| Row chip                                              | The derived status of §15.4                                                                                                                                                                                                                                                       |
| **Detail eyebrow**                                    | `policy.owner_label \|\| ' · ' \|\| pv.version_label \|\| ' · Updated ' \|\| pv.last_updated_label`                                                                                                                                                                               |
| Title / Summary                                       | `policy.name`, `policy_version.summary`                                                                                                                                                                                                                                           |
| Applies to / Effective from / Next review / Questions | `pv.applies_to_label`, `pv.effective_from`, `pv.next_review_on`, `policy.contact_email`                                                                                                                                                                                           |
| **"What this policy covers"**                         | `SELECT text FROM policy_version_point WHERE policy_version_id = :v ORDER BY point_no`; zero rows ⇒ block omitted                                                                                                                                                                 |
| Acknowledge button                                    | Rendered only when a live `policy_assignment` exists with no acknowledgement; POST writes `policy_acknowledgement` with `acknowledged_at = now()`, `acknowledged_body_sha256`, IP, UA, plus an `audit_event`                                                                      |
| "Due 15 Oct 2026"                                     | `policy_assignment.due_on`; NULL ⇒ no due text                                                                                                                                                                                                                                    |
| "Acknowledged on 12 Jan 2026"                         | `policy_acknowledgement.acknowledged_at`                                                                                                                                                                                                                                          |
| Download PDF                                          | `policy_version.pdf_file_object_id`; NULL ⇒ button omitted                                                                                                                                                                                                                        |
| _Empty_                                               | No assignments ⇒ "No policies are assigned to you yet"                                                                                                                                                                                                                            |

### 20.7 Leave

| UI element                             | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-header "Leave year Jan – Dec 2026" | `leave_period.label` where `is_current`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Balance tiles (all types)**          | `SELECT lt.name, lb.available_days, lb.entitlement_days FROM leave_balance lb JOIN leave_type lt … WHERE lb.employee_id = :me AND lb.leave_period_id = :lp ORDER BY lt.display_order`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tile value `14.5 / 18 days`            | `available_days` / `entitlement_days`. **When `entitlement_days = 0`** — which is the correct, persisted state for an _earned_ type such as Comp-off, whose `leave_entitlement_rule.annual_entitlement_days` is `0.00` because the balance comes entirely from `ADJUSTMENT`/`ACCRUAL` grants — the tile renders the bare count (`1 day`) with no denominator and no progress bar, and the sub-label `ui_copy` key `leave.tile.earned_only` ("Earned as granted"). It never renders `1 / 1` by silently substituting the balance for the entitlement, which is how the prototype's `['Comp-off',1,1]` literal would otherwise be reproduced as a fabricated denominator. |
| Progress bar                           | `available_days / nullif(entitlement_days,0)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Leave type dropdown**                | `SELECT name FROM leave_type WHERE organization_id = :org AND is_active AND <employee is eligible via leave_entitlement_rule> ORDER BY display_order`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Submit                                 | Server recomputes `total_days` with `working_days()`; client-side count is advisory only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| "Weekends are not counted"             | Derived from `organization.week_off_days` / `employee_employment.weekly_off_days`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **My requests list**                   | `SELECT lt.name, r.start_date, r.end_date, r.total_days, r.reason, r.status, r.decision_note FROM leave_request r JOIN leave_type lt … WHERE r.employee_id = :me AND r.leave_period_id = :lp ORDER BY r.start_date DESC`                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Row range text                         | One date if `start_date = end_date`, else `start – end`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Row sub-note                           | `reason`, else `'Awaiting ' \|\| approver_employee.full_name` when `PENDING_APPROVAL`, else `decision_note`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Withdraw button                        | Shown when `status IN ('PENDING_APPROVAL','APPROVED')` and guard `leave.starts_in_future` holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Upcoming holidays**                  | As §20.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **"1 restricted holiday left"**        | `leave_balance.available_days` for the `RH` leave type; no RH balance ⇒ the sub-label is omitted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| _Empty_                                | No balances ⇒ tiles empty state; no requests ⇒ "No leave requests this year"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 20.8 Benefits

| UI element                                 | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-header "Plan year Apr 2026 – Mar 2027" | `benefit_plan_year.label` of the current FY                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Card eyebrow**                           | `benefit_plan.category` humanised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Card name**                              | `benefit_plan.name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Card value**                             | By `benefit_plan_year.coverage_kind`: `FIXED_SUM_INSURED` → `coalesce(benefit_enrolment.sum_insured_minor, coverage_amount_minor)` formatted; `MULTIPLE_OF_CTC` → `coverage_multiple \|\| '× annual CTC'`; `MONTHLY_AMOUNT` → `coverage_amount_minor`, or, when `employer_contribution_pay_component_id` is set, **the amount of that component on the employee's latest published payslip** (`payslip_line.amount_minor`), formatted `₹8,600 / mo`; `PERCENT_OF_BASIC` → `coverage_rate * 100 \|\| '% of basic'`; `NON_MONETARY` → no value line |
| **Card meta**                              | Composed from `provider_name`, `policy_reference`, and the covered dependents' names via `benefit_enrolment_dependent` → `dependent.full_name` (decrypted for the owner)                                                                                                                                                                                                                                                                                                                                                                          |
| Card button                                | `benefit_plan.primary_action_label`; `primary_action = 'NONE'` ⇒ no button. `DOWNLOAD_ECARD` with a NULL `ecard_file_object_id` ⇒ disabled with the reason from `benefit_plan_year`                                                                                                                                                                                                                                                                                                                                                               |
| **Dependents list**                        | `SELECT initials, full_name, relationship, age_years, <cover> FROM dependent WHERE employee_id = :me AND is_active ORDER BY created_at`; `<cover>` = the plan names from `benefit_enrolment_dependent`, plus `' · Nominee'` when a `nominee` row references the dependent                                                                                                                                                                                                                                                                         |
| "Add dependent"                            | Enabled only inside `benefit_plan_year.enrolment_window_*`; otherwise disabled showing those persisted dates                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| _Empty_                                    | No `ENROLLED` enrolments ⇒ "No benefits are active for you yet"; no dependents ⇒ the dependents card shows its empty state with the enrolment-window dates                                                                                                                                                                                                                                                                                                                                                                                        |

### 20.9 Expenses

| UI element                              | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-header "approved by the 25th"       | `organization.expense_cutoff_day_of_month`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Tile 1 — Awaiting approval**          | `expense_fy_rollup.awaiting_amount_minor`; sub = `awaiting_count ‖ ' claim(s) with ' ‖ <the distinct approver(s) of those claims>`, read from `expense_claim.manager_employee_id` (the **snapshot taken at submit**) — _not_ the employee's current primary manager. After a re-org the two differ, and naming the current manager would tell the employee their claim is with someone who has never seen it. More than one distinct approver ⇒ `'<n> approvers'`. Zero awaiting claims ⇒ the sub-label is omitted, not rendered with a name.                                                                                                                                                                                                                                                                                                                                               |
| **Tile 2 — Approved · paying `<date>`** | `approved_unpaid_amount_minor`. The date is shown **only for claims actually queued into a cycle**: `payroll_cycle.scheduled_pay_date` reached through `expense_claim.reimbursement_batch_id → reimbursement_batch.payroll_cycle_id`, for claims in `QUEUED_FOR_PAYMENT`. A claim that is merely `FINANCE_APPROVED` is not yet in a batch and has no pay date, so the tile renders the amount with the sub-label "Not yet queued for payment" rather than promising a date the system has not committed to. Mixed states ⇒ the earliest committed `scheduled_pay_date` plus `'and <n> not yet queued'`. Enum ordering (`status <= 'INPUTS_LOCKED'`) is **not** used as a filter anywhere: `ess_payroll_cycle_status` is ordered for readability, not semantics, and a future `ALTER TYPE … ADD VALUE` would silently change the meaning of such a comparison. Explicit `IN (…)` lists only. |
| **Tile 3 — Reimbursed FY**              | `reimbursed_amount_minor`; sub = `reimbursed_count ‖ ' claim(s) since ' ‖ to_char(fiscal_year.start_date,'Mon')`. Singular/plural from the count; `0` ⇒ the whole tile renders `—` with "No reimbursements in FY 2026–27".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| _Empty_                                 | No rollup row ⇒ all three tiles `—` with "No claims in FY 2026–27"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Category dropdown**                   | `SELECT name FROM expense_category WHERE organization_id = :org AND is_active ORDER BY display_order`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| "Goes to `<manager>`, then Finance"     | Current primary manager's `full_name`; the ", then Finance" clause only when `expense_category.requires_finance_approval`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Claims list**                         | `SELECT claim_no, title, ec.name, spend_date, total_amount_minor, status, manager_note, finance_note FROM expense_claim c JOIN expense_category ec … WHERE c.employee_id = :me AND c.fiscal_year_id = :fy ORDER BY c.spend_date DESC, c.created_at DESC`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Row note suffix                         | `manager_note` / `finance_note` when rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Row chip                                | The §13.3 status → chip mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| _Empty_                                 | No claims ⇒ "No claims yet — submit your first one" with the New-claim button                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### 20.10 Documents

| UI element                       | Source                                                                                                                                                                                          |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Letter type dropdown**         | `SELECT name FROM letter_template WHERE organization_id = :org AND is_active ORDER BY display_order`                                                                                            |
| Form note "within 1 working day" | `letter_template.sla_working_days` of the selected template                                                                                                                                     |
| **Letter requests list**         | `SELECT lt.name, dr.requested_at, dr.addressee, dr.status, dr.employee_document_id FROM document_request dr JOIN letter_template lt … WHERE dr.employee_id = :me ORDER BY dr.requested_at DESC` |
| Row sub                          | `'Requested ' \|\| requested_at`, then `'Addressed to ' \|\| addressee` or `'General purpose'`                                                                                                  |
| Download icon                    | Rendered only when `employee_document_id IS NOT NULL`; resolves to a pre-signed URL and writes `audit_event(DOWNLOAD)`                                                                          |
| **My documents list**            | `SELECT ed.title, dt.category_label, ed.document_date FROM employee_document ed JOIN document_type dt … WHERE ed.employee_id = :me AND ed.archived_at IS NULL ORDER BY ed.document_date DESC`   |
| _Empty_                          | No requests ⇒ "No letter requests yet"; no documents ⇒ "Your HR documents will appear here"                                                                                                     |

### 20.11 Directory

| UI element               | Source                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"12 people shown"**    | The **actual** result count of the people query after the search filter — recomputed on every keystroke, never a constant                                                                                                                                                                                                                                                                                                  |
| **People list**          | `SELECT e.initials, e.full_name, d.title, dep.name, l.city, dep.accent_colour_hex FROM employee e JOIN LATERAL employment_as_of(e.id, :today) ee … WHERE e.organization_id = :org AND e.is_directory_listed AND e.employment_status IN ('ACTIVE','ON_LEAVE','NOTICE_PERIOD') AND (:q = '' OR (e.full_name \|\| ' ' \|\| d.title \|\| ' ' \|\| dep.name \|\| ' ' \|\| l.city) ILIKE '%'\|\|:q\|\|'%') ORDER BY e.full_name` |
| **Person card**          | `full_name`, `designation.title · department.name · location.city`, `work_email`, `work_phone` (requires `directory:read_contact`; absent ⇒ the chip is omitted), `'Reports to ' \|\| <current primary manager full_name>` (no manager ⇒ omitted)                                                                                                                                                                          |
| **Reporting line strip** | `SELECT path_employee_ids FROM employee_reporting_closure WHERE descendant_employee_id = :me ORDER BY depth DESC LIMIT 1` gives the chain above; `WHERE ancestor_employee_id = :me AND depth = 1` gives the reports below. Labels: ancestors → "Your manager" / "Your manager's manager", self → "You", descendants → "Reports to you".                                                                                    |
| Avatar tint              | `department.accent_colour_hex`, else `#1B365D`                                                                                                                                                                                                                                                                                                                                                                             |
| _Empty_                  | Zero matches ⇒ the prototype's "No one matches …" block; no reporting relationships ⇒ the strip is omitted                                                                                                                                                                                                                                                                                                                 |

### 20.12 Announcements

| UI element    | Source                                                                             |
| ------------- | ---------------------------------------------------------------------------------- |
| **List**      | The §20.2 feed query without the `LIMIT`                                           |
| Row meta      | `Pinned` badge from `is_pinned`; `category_label · published_at`                   |
| **Detail**    | `title`, `body_markdown` rendered to paragraphs, `'Posted by ' \|\| author_byline` |
| Read tracking | Opening an item upserts `announcement_read`                                        |
| _Empty_       | No published announcements for this employee ⇒ "No announcements right now"        |

### 20.13 Help desk

| UI element                                       | Source                                                                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sub-header "first response within 1 working day" | `min(ticket_category.first_response_sla_hours)` humanised                                                                                                                                                               |
| **Category dropdown**                            | `SELECT name FROM ticket_category WHERE organization_id = :org AND is_active ORDER BY display_order`                                                                                                                    |
| Submit                                           | Inserts `helpdesk_ticket` + the `email_outbox` row to `helpdesk@widedroptech.com` (§17.4) in one transaction; the toast shows the **persisted** `ticket_no` and the SLA from `ticket_category.first_response_sla_hours` |
| **My tickets list**                              | `SELECT t.ticket_no, t.subject, tc.name, t.status, t.assigned_to_user_id, t.updated_at, t.resolved_at FROM helpdesk_ticket t JOIN ticket_category tc … WHERE t.raised_by_employee_id = :me ORDER BY t.created_at DESC`  |
| Row meta                                         | Assigned & open → `<assignee employee full_name> \|\| ' · updated ' \|\| <relative updated_at>` · Resolved → `'Resolved ' \|\| resolved_at` · Unassigned → `'Opened ' \|\| <relative created_at> \|\| ' · unassigned'`  |
| **FAQ accordion**                                | `SELECT question, answer_markdown FROM faq_article WHERE organization_id = :org AND is_published ORDER BY display_order`                                                                                                |
| _Empty_                                          | No tickets ⇒ "No tickets yet"; no FAQ rows ⇒ the card is not rendered                                                                                                                                                   |

### 20.14 Approvals (Manager)

| UI element               | Source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sub-header "· 3 reports" | `SELECT count(*) FROM employee_reporting_closure WHERE ancestor_employee_id = :me AND depth = 1` joined to active employees                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Tab "Pending · N"        | The sidebar badge query                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Pending cards**        | `SELECT t.id, s.initials, s.full_name, t.kind, t.title, t.subtitle, t.requested_at, t.amount_minor FROM approval_task t JOIN employee s ON s.id = t.subject_employee_id WHERE t.assignee_employee_id = :me AND t.status = 'PENDING' ORDER BY t.priority_order, t.requested_at`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Kind chip                | `LEAVE_REQUEST` → `Leave` blue · `EXPENSE_CLAIM` → `Expense` amber · `ATTENDANCE_PERIOD` → `Attendance` blue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Card title / subtitle    | `approval_task.title` / `.subtitle`, composed at creation from persisted fields (leave type, dates, day count, reason, `balance_after_days`; or claim no, amount, category, `limit_applied_minor`, attachment count)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Approve / Reject         | Writes `approval_decision` + the underlying entity's transition + `audit_event`, all in one transaction. Reject requires a note (`approval.note_required`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Empty**                | `noPending` ⇒ exactly the prototype's "All caught up" block                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **History**              | `SELECT … FROM approval_task t JOIN approval_decision d ON d.approval_task_id = t.id WHERE t.assignee_employee_id = :me AND t.status <> 'PENDING' ORDER BY t.decided_at DESC LIMIT 50`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Team today aside**     | The §20.2 Team-today query; header date = `now()` in org tz                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Aside note               | **Exactly two sentences, each omitted independently when its query returns nothing** (the previous "plus the count of … overlapping the next holiday" named no output format and no threshold, so no two implementers would build the same string). Sentence 1, from `SELECT e.first_name, lr.start_date, lr.end_date FROM leave_request lr JOIN employee e … WHERE lr.employee_id IN (direct reports of :me) AND lr.status = 'APPROVED' AND lr.start_date BETWEEN :today AND :today + 30 ORDER BY lr.start_date LIMIT 1` → `'<first_name> is away <start> – <end>.'` (one date when the range is a single day). Sentence 2, from `SELECT h.name, h.holiday_date, count(DISTINCT lrd.employee_id) FROM holiday h LEFT JOIN leave_request_day lrd ON lrd.leave_date BETWEEN h.holiday_date - 3 AND h.holiday_date + 3 AND lrd.employee_id IN (direct reports) AND lrd.day_fraction > 0 … WHERE h.holiday_calendar_id = holiday_calendar_for(:me, :today) AND h.kind = 'PUBLIC' AND h.holiday_date >= :today ORDER BY h.holiday_date LIMIT 1`, rendered **only when the count is ≥ 1** → `'<n> of your team have leave around <holiday name>.'` Both sentences empty ⇒ the note element is not rendered. |

### 20.15 HR and Accounts back-office surfaces

These appear as additional sidebar groups after `Manager` (Design System §6), using the
same visual treatment, and are server-side role-gated.

| Screen                             | Key reads / writes                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Payroll cycles** (Accounts)      | `SELECT period_code, label, status, scheduled_pay_date, employee_count, payslip_count FROM payroll_cycle WHERE organization_id = :org ORDER BY period_start DESC`. A step-tracker renders the seven mandated stages directly from `status`.                                                                                                                             |
| **Payroll inputs** (Accounts)      | `payroll_input_batch` list with `status`, `row_count_*`, `declared_total_minor` vs `parsed_total_minor`; `payroll_input_item` grid with `is_rejected` / `rejection_reason`. Upload writes a `file_object` (scanned before parse).                                                                                                                                       |
| **Validation results** (Accounts)  | `SELECT rule_code, severity, message, employee.full_name FROM payroll_validation_result … WHERE payroll_cycle_id = :c AND validation_pass_no = <latest> ORDER BY severity DESC`. `CALCULATE` is disabled while any unresolved `ERROR` exists.                                                                                                                           |
| **Attendance capture** (HR)        | `attendance_record` grid for the period with the day-count columns; the day-identity check is validated per row before Submit is enabled.                                                                                                                                                                                                                               |
| **Attendance submission** (HR)     | Writes `attendance_submission` with `payload_sha256` and the control totals; transitions the period and the cycle. Blocked unless `attendance.payroll_inputs_locked` holds — the UI states the reason ("Accounts has not locked payroll inputs for August 2026 yet").                                                                                                   |
| **Attendance approvals** (Manager) | `attendance_approval` slice with its records; Approve/Reject writes `approval_decision` and the record transitions.                                                                                                                                                                                                                                                     |
| **Payslip register** (Accounts)    | `SELECT employee.employee_number, employee.full_name, payable_days, gross/net (decrypted) FROM payslip WHERE payroll_cycle_id = :c ORDER BY employee_number`, with the cycle control totals shown above it.                                                                                                                                                             |
| **Publication** (Accounts)         | Creates one `payslip_publication` per payslip, one `notification` per employee, one `email_outbox` row per employee; sets `payroll_cycle.actual_pay_date`. Guarded by `payroll.distinct_approver`.                                                                                                                                                                      |
| **Policy authoring** (HR)          | `policy` / `policy_version` / `policy_version_point` / `policy_applicability_rule` CRUD while `DRAFT`; Publish runs the `policy-assignment` job synchronously and reports how many employees were assigned.                                                                                                                                                             |
| **Compliance report** (HR)         | `SELECT pv.version_label, count(*) FILTER (WHERE ack.id IS NOT NULL) AS acknowledged, count(*) AS assigned FROM policy_assignment pa LEFT JOIN policy_acknowledgement ack … GROUP BY pv.id`                                                                                                                                                                             |
| **Ticket queue** (HR)              | `ix_ht__queue`; assignment, internal comments, resolution.                                                                                                                                                                                                                                                                                                              |
| **Employee admin** (HR)            | `employee` + effective-dated `employee_employment` / `employee_manager` writes; every write audited with before/after.                                                                                                                                                                                                                                                  |
| **Audit log** (HR, Accounts)       | `SELECT occurred_at, actor_email_snapshot, actor_role_persona, action, entity_type, entity_label, from_state, to_state, reason FROM audit_event WHERE organization_id = :org AND occurred_at BETWEEN … ORDER BY sequence_no DESC`, with a "chain verified through sequence N" banner from the latest `audit-chain-verify` run. Reading it writes an `audit:read` event. |

---

### 20.16 Empty-state catalogue — every surface, with its key and its cause

Directive 9 requires every screen, card, table, dashboard, group box, chart and widget to
stay polished and correct with zero data. §20 stated that per screen in prose; this table
is the enumeration the `ui_copy` manifest and `test:empty-state` are checked against, so
"polished when empty" is a list of rows rather than an aspiration. Every entry renders the
§8-pattern empty block (Design System §8) or, for a metric tile, `—` in `--text-muted`
with the stated sub-label. **No entry renders `0`, `₹0`, `0 / 0`, `0%` or a placeholder
name.**

| Surface                                   | Cause of emptiness                         | `ui_copy` key root                                        | Action offered                |
| ----------------------------------------- | ------------------------------------------ | --------------------------------------------------------- | ----------------------------- |
| Sidebar approvals badge                   | `count = 0`                                | _(element absent)_                                        | —                             |
| Notification popover                      | no undismissed rows                        | `empty.notifications`                                     | —                             |
| Global search                             | zero rows across all four kinds            | `empty.search`                                            | —                             |
| Home · latest payslip tile                | no live publication                        | `empty.payslips.{no_cycle,in_progress,not_in_scope,none}` | —                             |
| Home · leave balance tiles                | no `leave_balance` row for `:lp`           | `empty.leave.balances`                                    | —                             |
| Home · approvals card                     | no pending task                            | `empty.approvals.none`                                    | —                             |
| Home · announcements                      | audience resolves to nothing               | `empty.announcements`                                     | —                             |
| Home · holidays                           | no future `PUBLIC` holiday on the calendar | `empty.holidays`                                          | —                             |
| Home · team today                         | `depth = 1` count is 0                     | _(card absent)_                                           | —                             |
| Home · needs your attention               | union cardinality 0                        | _(block absent)_                                          | —                             |
| Payslips · YTD tiles                      | no `payslip_fy_rollup` row                 | `empty.payslips.ytd`                                      | —                             |
| Payslips · list + detail                  | no live publication                        | `empty.payslips.*`                                        | —                             |
| Payslips · employer-PF chip               | `employer_pf_minor` NULL                   | _(chip absent)_                                           | —                             |
| Tax · TDS summary                         | no `is_current` projection                 | `empty.tax.projection`                                    | —                             |
| Tax · quarters                            | `LEFT JOIN` miss or `UPCOMING`             | _(row renders `—` + gray chip)_                           | —                             |
| Tax · declaration card                    | no `employee_tax_declaration` row          | `empty.tax.declaration`                                   | Start declaration (in-window) |
| Tax · Form 16                             | no `ISSUED`/`REVISED` row                  | `empty.tax.form16`                                        | —                             |
| Tax · compare regime                      | `comparison_annual_tax_minor` NULL         | _(button absent)_                                         | —                             |
| Profile · any tab                         | satellite row absent                       | `empty.profile.{personal,employment,bank,emergency}`      | Request a change              |
| Policies · list                           | no `policy_assignment`                     | `empty.policies`                                          | —                             |
| Policies · "what this covers"             | no `policy_version_point`                  | _(block absent)_                                          | —                             |
| Policies · download                       | `pdf_file_object_id` NULL                  | _(button absent)_                                         | —                             |
| Leave · tiles / requests                  | no balance / no request                    | `empty.leave.{balances,requests}`                         | Apply for leave               |
| Leave · RH sub-label                      | no `RH` balance                            | _(sub-label absent)_                                      | —                             |
| Benefits · cards                          | no `ENROLLED` enrolment                    | `empty.benefits`                                          | —                             |
| Benefits · plan-year header               | no `benefit_plan_year` for `:fy`           | _(sub-header absent)_                                     | —                             |
| Benefits · NPS value                      | no published payslip                       | `empty.benefits.no_payslip_yet`                           | —                             |
| Benefits · dependents                     | no active dependent                        | `empty.benefits.dependents`                               | Add dependent (in-window)     |
| Expenses · tiles                          | no `expense_fy_rollup` row                 | `empty.expenses.tiles`                                    | —                             |
| Expenses · list                           | no claim in `:fy`                          | `empty.expenses.claims`                                   | New claim                     |
| Documents · letters                       | no `document_request`                      | `empty.documents.letters`                                 | Request a letter              |
| Documents · my documents                  | no live `employee_document`                | `empty.documents.files`                                   | —                             |
| Directory · list                          | zero matches                               | `empty.directory.search`                                  | Clear search                  |
| Directory · reporting line                | no closure rows beyond self                | _(strip absent)_                                          | —                             |
| Announcements · list/detail               | audience resolves to nothing               | `empty.announcements`                                     | —                             |
| Help desk · tickets                       | no ticket raised by `:me`                  | `empty.help.tickets`                                      | Raise a ticket                |
| Help desk · FAQ                           | no published `faq_article`                 | _(card absent)_                                           | —                             |
| Approvals · pending                       | no pending task                            | `empty.approvals.none`                                    | —                             |
| Approvals · history                       | no decided task                            | `empty.approvals.history`                                 | —                             |
| Approvals · team aside                    | no reports                                 | _(aside absent)_                                          | —                             |
| HR · attendance grid                      | period not open                            | `empty.hr.attendance`                                     | —                             |
| HR · policy compliance                    | no assignments                             | `empty.hr.compliance`                                     | —                             |
| HR · ticket queue                         | queue clear                                | `empty.hr.tickets`                                        | —                             |
| Accounts · cycles                         | no `payroll_cycle`                         | `empty.accounts.cycles`                                   | Open a cycle                  |
| Accounts · inputs / validation / register | no batch / no finding / no payslip         | `empty.accounts.{inputs,validation,register}`             | Upload a batch                |
| Audit log                                 | no events in range                         | `empty.audit`                                             | Widen the range               |

Three rules govern the whole table:

1. **Absent, not zero.** A count of zero removes the element (badges, chips, sub-labels,
   cards) rather than rendering a `0`.
2. **The sub-label says _why_, from data.** `—` alone is not an empty state; every tile's
   sub-label names the persisted cause (no accrual yet, payroll not published, window
   closed on a stated date).
3. **The action is only offered when it would succeed.** "Add dependent" appears only
   inside a persisted enrolment window; "Start declaration" only inside the declaration
   window; "Open a cycle" only when `payroll.dual_control_available` holds. A disabled
   control always carries a `disabled.*` reason resolved from persisted dates.

---

## 21. Schema-verification checklist (CI)

`npm run db:verify-schema` fails the build unless all of the following hold:

1. Every table named in this document exists in schema `ess` or `ess_ops`, with exactly
   the stated columns, types, nullability and defaults.
2. Every `CHECK`, `UNIQUE`, `EXCLUDE` and foreign key in this document is present, with
   the stated `ON DELETE` behaviour.
3. Every index in this document exists (name, columns, order, partial predicate).
4. No column of type `real`, `double precision`, `float4`, `float8` or `money` exists
   anywhere in `ess`.
5. Every table in `ess` has `ROW LEVEL SECURITY` enabled and at least one policy.
6. `ess_app` holds no `DELETE` grant on any table listed in §18.2, and no grant at all on
   `audit_event` beyond `INSERT`/`SELECT`.
7. Every enum value referenced by a `state_transition` seed row exists in its enum.
8. Every `state_transition.required_permission_code` resolves to a `permission.code`.
9. Every guard key referenced in `state_transition.guard_key` has an implementation
   registered in the API's guard registry (§19.3).
10. `npm run test:seed-purity` leaves every table in §18.2 empty.
11. Every column with an `_ct` suffix has matching `_iv`, `_tag`, `_dek_id` columns and
    the envelope `CHECK` constraints; every `_fpr` column has a matching
    `_fpr_pepper_version`.
12. `audit-chain-verify` passes over the test fixture set, including a deliberate
    tamper fixture that must be detected.

### 21.2 Checks added by this revision

13. **Every `status` column has a machine.** For each table in `ess` with a column named
    `status`, a `state_transition` row exists with that table's machine name, and every
    distinct `machine` in `state_transition` corresponds to such a table (§2.1).
14. **No orphan permissions.** Every `permission.code` is referenced by at least one
    `role_permission` row, and every code referenced by a `state_transition` or by the
    API's route table exists in `permission` (§3.1).
15. **Settings do not shadow columns.** No `org_setting.key` names a column of
    `organization` (§4.6.1), and every key read by the API exists in the seed.
16. **`ui_copy` completeness.** The seeded key set equals `UI_COPY_KEYS` exactly, and
    every key in §20.16 is present (§4.7).
17. **Constraint legality.** No `CHECK` constraint and no partial-index predicate in
    `ess` or `ess_ops` references `now()`, `CURRENT_DATE`, `CURRENT_TIMESTAMP` or
    `localtimestamp` (§1.2) — asserted by parsing `pg_constraint.consrc`/`pg_get_expr`
    and `pg_index.indpred`.
18. **Partial and expression uniqueness exists.** Every `ux_…` named in §1.2 is present in
    `pg_indexes` as a unique index with the stated predicate; none of them appears in
    `information_schema.table_constraints`.
19. **Partition-key compliance.** Every `UNIQUE`/`PRIMARY KEY` on a partitioned table
    includes the partition key (§17.1), and `audit_chain_head` has exactly one row per
    organisation.
20. **RLS totality.** Every table in `ess` has `ENABLE` **and** `FORCE ROW LEVEL
SECURITY`; every policy that permits `INSERT` or `UPDATE` has a `WITH CHECK`; no
    policy body contains the string `LIKE` applied to `ess.scopes` (§1.8).
21. **Function hygiene.** Every function in `ess`/`ess_ops` has an explicit
    `SET search_path`, and no function is `SECURITY DEFINER` except those §1.8.1 names.
22. **Money typing.** Every column whose name ends `_minor` is `bigint`/`money_minor`;
    every column in class M1 (§1.6) exists only as an envelope (`_ct`/`_iv`/`_tag`/
    `_dek_id`) and has **no** plaintext sibling of the same root name.
23. **Separation of duties.** The six SoD invariants of §3.3 hold over the seeded
    `role_permission` rows.
24. **No auto-approval.** No seeded `state_transition` row produces
    `AUTO_APPROVED` (§19.2.1).
25. **Empty-state purity.** `npm run test:empty-state` passes against a database that has
    only reference data (§18.2).
26. **Cross-document agreement.** `npm run docs:verify-cross-refs` parses `API.md`,
    `SECURITY.md`, `WORKFLOWS.md` and `FRONTEND.md` for `table.column` references and
    fails on any that this document does not define, and on any table this document
    defines that none of them uses. This check exists because the gaps that motivated
    §22 — `session`, `org_setting`, `payroll_cycle_employee`, `profile_change_request`,
    `user_invitation`, `jwks`, the statutory tables — were each required by a sibling
    document and absent here, and nothing would have caught that.

---

## 22. Reconciliation with the sibling specifications

The other documents in `docs/` are normative for their own domains and refer to this one
by table and column name. Where names had drifted, **this document's name is canonical**
and the sibling's is an alias to be corrected there; where a _rule_ differed, the stricter
one wins and is adopted here. The full reconciliation:

| Sibling reference                                                                          | Canonical here                                                          | Resolution                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SECURITY.md` `session`                                                                    | `session`                                                               | **Added** (§6.0). Was missing entirely; `sid`, step-up MFA and immediate revocation all depend on it. |
| `SECURITY.md` `jwks`                                                                       | `jwks`                                                                  | **Added** (§6.5.2), public keys only.                                                                 |
| `SECURITY.md` `activation_token`                                                           | `user_invitation`                                                       | **Added** (§6.5.1). Same object; this name, per WORKFLOWS A-6.                                        |
| `SECURITY.md` `org_setting`                                                                | `org_setting`                                                           | **Added** (§4.6.1) with the no-shadow rule for `organization` columns.                                |
| `SECURITY.md` `notification_outbox`                                                        | `email_outbox`                                                          | One table; §17.4. `notification` is the in-app bell, `email_outbox` is mail.                          |
| `SECURITY.md` `statutory_identity.<kind>_ciphertext`                                       | `employee_statutory_id` (row per kind)                                  | Row-per-kind, not column-per-kind; the mask set in §1.6 now matches SECURITY's column-by-column.      |
| `SECURITY.md` `bank_account`, `emergency_contact`, `ticket_message`                        | `employee_bank_account`, `employee_emergency_contact`, `ticket_comment` | Naming only.                                                                                          |
| `SECURITY.md` `letter_request`                                                             | `document_request`                                                      | Naming only.                                                                                          |
| `SECURITY.md` `expense_policy_limit.escalation_amount`                                     | `expense_limit.escalation_amount_minor`                                 | **Added** (§13.1) with skip-level routing in §19.1.                                                   |
| `SECURITY.md` `user.token_version` / `ver`                                                 | `app_user.token_version` / `ver`                                        | **Renamed here** from `token_epoch`/`epc`.                                                            |
| `SECURITY.md` refresh 7 d idle / 14 d family                                               | same                                                                    | **Adopted here** (was 14/30 — the looser value was a security regression).                            |
| `SECURITY.md` UAN, gender, marital status, blood group, nationality, ticket body encrypted | same                                                                    | **Adopted here** (§1.6); this document had them plaintext.                                            |
| `SECURITY.md` DOB mask `••/••/1994`                                                        | same                                                                    | **Adopted** (§1.6); this document's mask reproduced the plaintext.                                    |
| `SECURITY.md` `PENDING_MFA`, `SUSPENDED`, `OFFBOARDED`                                     | `ess_user_status`                                                       | **Extended** (§2).                                                                                    |
| `WORKFLOWS.md` A-1 `payroll_cycle_employee`                                                | same                                                                    | **Added** (§10.10).                                                                                   |
| `WORKFLOWS.md` A-2 `cycle_kind`, R-1                                                       | same                                                                    | **Added** (§10.1).                                                                                    |
| `WORKFLOWS.md` A-3 `payroll_correction`, `run_kind`                                        | same                                                                    | **Added** (§10.11, §10.6).                                                                            |
| `WORKFLOWS.md` A-4 statutory tables                                                        | same                                                                    | **Added** (§10.12).                                                                                   |
| `WORKFLOWS.md` A-5 `profile_change_request(_field)`                                        | same                                                                    | **Added** (§5.11).                                                                                    |
| `WORKFLOWS.md` R-2 `every_slice_approved`                                                  | same                                                                    | **Adopted** (§9.5).                                                                                   |
| `WORKFLOWS.md` R-3 SLA pause fields                                                        | same                                                                    | **Added** (§16.4).                                                                                    |
| `WORKFLOWS.md` R-4 `trg_payslip_requires_calculating`                                      | same                                                                    | **Added** (§10.7).                                                                                    |
| `WORKFLOWS.md` `payroll.no_published_payslips`                                             | same                                                                    | **Added** to the guard catalogue (§19.3).                                                             |
| `WORKFLOWS.md` dotted event codes (`PAYROLL.VALIDATED`)                                    | `audit_event.event_code`                                                | **Added** (§17.1) with a seeded `audit_event_code` catalogue.                                         |
| `API.md` `POST /me/profile-change-requests`                                                | `profile_change_request`                                                | Now backed by a table.                                                                                |

**Deployment note (directive 10).** Nothing in this schema constrains the frontend's
hosting: the SPA is static and coexists with `widedrop.com` on Netlify as a separate site
or subdomain. What this document does require of the deployment is stated once, here, so
`DEPLOYMENT.md` and the migrations agree: PostgreSQL 16 with the four extensions of §1.1;
`sslmode=verify-full` on every connection; the five database roles of §1.8.1 created
before the first migration and `ess_app`'s password supplied from the platform secret
store; a KMS or Vault-transit master key reachable by the API process and by nothing else,
with the DEK-wrapping grant scoped to that principal; pgBouncer (or the platform pooler) in
**transaction** pooling mode, which is compatible with the `SET LOCAL` context of §1.8.2
and is not compatible with session-level `SET` — so the request context must never be set
outside a transaction; encrypted automated backups with PITR; and a separate
object-storage bucket with SSE-KMS and Object Lock for the audit anchors of §17.1. The
database is never exposed to the public internet, and the Netlify site talks only to the
API origin.
