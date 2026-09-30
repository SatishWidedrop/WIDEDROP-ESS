# Widedrop ESS — System Architecture & Canonical Index

> ### This is the design specification, not the built system
>
> Written before the implementation, and kept because the reasoning in it is
> worth having: it records why each decision went the way it did. But the
> build made its own decisions in places, and where the two disagree **the
> code is correct and this document is out of date.**
>
> What to read instead, for this document's subject: `docs/PLAN.md` for what was built and in what order, and `docs/RUNBOOK.md` for how it runs.
>
> The largest divergence is the permission vocabulary. These documents fold
> the scope into the permission name (`payslip:read:any`,
> `approval:task:read:team`); what was built separates them, so a permission
> names an action and each role holds it _at a scope_ (`payslip:read-any` at
> `ORG`). `docs/RBAC.md` is generated from the module the API enforces, and
> CI fails if it drifts.

**Status:** normative. This is the **index and the tie-breaker** for the six specification
documents in `docs/`. Where any two of them disagree on a **name** — an entity, a column, an
enum value, a permission string, a state, a guard key, an endpoint path, an environment
variable — **§4 of this document wins**, and the divergent spelling is a defect in the document
that carries it. Where they disagree on a **control**, the stricter option wins and §4 records
which that is. No document may introduce a name that §4 does not carry; `npm run docs:verify-cross-refs`
(`DATA-MODEL.md` §21 rule 26) fails the build on one.

This document owns no behaviour of its own. Every rule here is a pointer into the document
that owns it, plus the single answer that was chosen where two documents gave different ones.

---

## 1. System summary and the four personas

Widedrop ESS is a multi-tenant Employee Self-Service portal for Widedrop Technologies: a
static React SPA on `ess.widedrop.com` talking cross-origin-but-same-site to a Fastify 5 /
Node 22 API on `api-ess.widedrop.com`, over a PostgreSQL 16 system of record in which every
displayed value is a persisted column or a deterministic, re-derivable computation over
persisted columns. It covers thirteen employee-facing modules (Home, Payslips, Tax slips, My
profile, Leave, Benefits, Expenses, Documents, Policies, Directory, Announcements, Help desk,
Manager Approvals) and the HR and Accounts back-office surfaces that the mandated payroll
workflow requires. Authorization is server-side, deny-by-default and compiled into the query
rather than applied to the response; payroll amounts, statutory identifiers, bank accounts and
personal contact details are envelope-encrypted with keys that live outside the database; every
HR, payroll, approval, policy and administrative action lands in an append-only, HMAC-chained
audit trail in the same transaction as its effect. A payslip does not exist as a visible object
until Accounts has uploaded and committed inputs, HR has submitted attendance, the responsible
manager has approved every slice of it, the server-side validation pass has produced zero
unresolved `ERROR` results, and three distinct Accounts users have calculated, approved and
published the cycle.

**The four personas** (`ess_persona`; exactly four, D2 — a user may hold several, and their
effective permission set is the union, with each permission's reach resolved independently):

| Persona    | Holds                                                                                                                                            | Never holds                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `EMPLOYEE` | Their own pay, tax, leave, benefits, expenses, documents, policies, tickets and profile. Auto-granted on activation, unrevokable while `ACTIVE`. | Anything about another person beyond the directory DTO.                                                             |
| `MANAGER`  | Everything `EMPLOYEE` has, plus the unified approvals queue and team-scoped reads bounded by `employee_reporting_closure`.                       | **Any `:read:any` code at all**; any compensation figure, including a report's; `profile:read_sensitive:*`.         |
| `HR`       | Everything `EMPLOYEE` has, plus people records, attendance capture and submission, policies, announcements, letters, tickets, roles, audit.      | `payroll:{input:*,calculate,approve,publish}`, `payslip:read:any`, `payroll:salary_structure:*`, full bank numbers. |
| `ACCOUNTS` | Everything `EMPLOYEE` has, plus payroll cycles, inputs, calculation, approval, publication, payslip register, tax, reimbursements.               | `attendance:{capture,submit,approve:*}`, `employee:*`, `role:*`, `profile:update:any`, non-payroll PII.             |

The two exclusion columns are not stylistic. They are the separation-of-duties invariants
SoD-1…SoD-6 (`DATA-MODEL.md` §3.3), asserted in CI against the seeded `role_permission` rows:
the persona that manufactures attendance cannot run payroll on it, and the persona that runs
payroll cannot create the employee whose pay it runs.

---

## 2. Component diagram

```
                                  ┌───────────────────────────┐
                                  │  EMPLOYEE / MANAGER / HR  │
                                  │  ACCOUNTS  ·  browser     │
                                  └─────────────┬─────────────┘
                     TLS 1.3                    │                  TLS 1.3
            ┌──────────────────────────────────-┴──────────────────────────┐
            ▼                                                              ▼
 ┌────────────────────────────┐                        ┌──────────────────────────────────────┐
 │ NETLIFY  (site #2, own     │   fetch, same-site     │ RENDER · singapore                   │
 │ team)  ess.widedrop.com    │   credentials:include  │ api-ess.widedrop.com                 │
 │ ── static SPA only ──      │ ─────────────────────▶ │ ── THE authorization boundary ──     │
 │ · hashed immutable assets  │                        │ Fastify 5 / Node 22 / Prisma 5       │
 │ · index.html  no-store     │ ◀───────────────────── │ public listener  :$PORT              │
 │ · CSP / HSTS / COOP        │   JSON · 302 · 4xx     │ internal listener :$PRIVATE_PORT     │
 │ · SPA history fallback     │                        │   /api/v1/readyz · /metrics ·        │
 │ NO secrets · NO SSR ·      │                        │   /api/v1/version · /.well-known/    │
 │ NO functions · NO API      │                        │     jwks.json  (unprefixed, RFC 8615)│
 └────────────────────────────┘                        └──┬────────┬────────┬────────┬────────┘
            ▲                                             │        │        │        │
            │ artifact upload (netlify-cli, --no-build)   │        │        │        │
            │                                    private  ▼        ▼        ▼        ▼ private
 ┌──────────┴───────────────┐                    ┌──────────┐ ┌────────┐ ┌──────┐ ┌────────────┐
 │ GITHUB ACTIONS + GHCR    │  OIDC, no static   │PgBouncer │ │ClamAV  │ │ KMS  │ │  WORKER    │
 │ build · test · SAST ·    │  cloud keys        │txn pool  │ │ clamd  │ │ KEK  │ │ same image │
 │ migrate · deploy         │ ─────────────────▶ └────┬─────┘ └────────┘ └──────┘ │ SERVICE_   │
 └──────────────────────────┘                        │                            │ ROLE=worker│
                                                     ▼                            │ outbox +   │
                                    ┌────────────────────────────────┐            │ scheduled  │
                                    │ MANAGED POSTGRESQL 16          │◀───────────┘ jobs       │
                                    │ private · sslmode=verify-full  │  DIRECT_DATABASE_URL    │
                                    │ schemas: ess · ess_ops         │  (session advisory locks)│
                                    │ RLS ENABLE + FORCE everywhere  │
                                    │ roles: owner/app/job/migrator/ │
                                    │        readonly/backup         │
                                    └───────┬────────────────┬───────┘
                                S3 API      │                │  HTTPS provider API
                                            ▼                ▼
                          ┌─────────────────────────┐  ┌──────────────────────────┐
                          │ CLOUDFLARE R2 (apac)    │  │ AMAZON SES (ap-south-1)  │
                          │ private buckets · SSE   │  │ DKIM · SPF · DMARC on    │
                          │ payslip & Form-16 PDFs  │  │ widedroptech.com         │
                          │ bills · policies ·      │  │ → helpdesk@widedroptech  │
                          │ letters · input files   │  │ ← SNS bounce webhook     │
                          │ 120 s signed GET only   │  └──────────────────────────┘
                          └─────────────────────────┘

  OUT OF SCOPE, SEPARATE BLAST RADIUS — no shared team, token, cookie, quota or DNS zone:
  ┌──────────────────────────────────────────────────────────────────────────────────────┐
  │ NETLIFY (site #1, existing free team)   widedrop.com + www.widedrop.com   UNTOUCHED  │
  └──────────────────────────────────────────────────────────────────────────────────────┘
```

Three properties of this picture are load-bearing and are the reason it looks the way it does:

1. **The SPA never proxies the API.** A Netlify rewrite to `api-ess.widedrop.com` would make the
   API same-_origin_, defeating the CORS allowlist and putting an uncontrolled CDN in front of
   authenticated responses. Explicitly refused in `infra/netlify/netlify.toml`.
2. **The browser, the Netlify edge and everything in `apps/web` are untrusted.** Role gating in
   the SPA is cosmetic; every request is authorized server-side against persisted grants
   (`SECURITY.md` rule B2-1).
3. **The two Netlify properties share nothing.** Separate team ⇒ separate build-minute and
   bandwidth quota, separate deploy token, separate access control. An ESS incident cannot take
   down the marketing site and a leaked marketing token cannot reach the ESS.

---

## 3. How to read the six documents

| Document                                                   | Owns                                                                                                                                                   | Read it when                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`DATA-MODEL.md`](./DATA-MODEL.md)                         | Every table, column, type, constraint, index, trigger, enum, RLS policy and the query behind every displayed value (§20). **Canonical for all names.** | You are writing a migration, a Prisma model, or any query.                 |
| [`SECURITY.md`](./SECURITY.md)                             | Threat model, authentication, RBAC/ABAC reach, crypto and key management, audit chain, rate limiting, headers, DPDP. **Canonical for all controls.**   | You are writing a guard, a token, a cipher, a limiter or a header.         |
| [`API.md`](./API.md)                                       | The wire: paths, verbs, request/response schemas, status codes, error catalogue, idempotency, pagination, `emptyState`, screen→endpoint map.           | You are writing a route, a DTO or a client fetcher.                        |
| [`WORKFLOWS.md`](./WORKFLOWS.md)                           | Every state machine, its transitions, guards, notifications and emails; the payroll pipeline; the deterministic payslip calculation spec (§1.9).       | You are writing a transition, a guard predicate or the calculation engine. |
| [`FRONTEND.md`](./FRONTEND.md)                             | `apps/web`: folder layout, routing, auth boundary, query/mutation conventions, design-system implementation, per-screen build spec, empty-state copy.  | You are writing a screen, a component or a query hook.                     |
| [`DEPLOYMENT.md`](./DEPLOYMENT.md)                         | Where everything runs, how it is configured, how it ships, how it is backed up and recovered; Netlify, Render, Postgres, R2, SES, CI/CD, runbooks.     | You are configuring an environment, a secret, a pipeline or an incident.   |
| [`../design/DESIGN-SYSTEM.md`](../design/DESIGN-SYSTEM.md) | Palette, type scale, geometry, nav model, empty-state pattern, `en-IN` locale rules.                                                                   | You are choosing a colour, a spacing, a chip tone or a number format.      |
| [`../design/prototype/`](../design/prototype/)             | **The UI/UX source of truth.** Layout, order, copy tone, responsive behaviour.                                                                         | You are unsure what a screen should look like.                             |

---

## 4. Canonical glossary

This section is the single source of truth. A name not here does not exist.

### 4.1 Entities

Schema `ess` unless marked. Tables are `snake_case`, **singular**.

**Tenancy & reference** — `organization`, `department`, `location`, `cost_centre`,
`designation`, `fiscal_year`, `fiscal_quarter`, `org_setting`, `ui_copy`, `state_transition`,
`permission`, `role`, `role_permission`, `user_role`, `role_grant_request`.

**Identity** — `app_user`, `employee`, `employee_employment`, `employee_manager`,
`employee_reporting_closure`, `employee_personal_detail`, `employee_statutory_id`,
`employee_bank_account`, `employee_emergency_contact`, `profile_change_request`,
`profile_change_request_field`, `dependent`, `nominee`.

**Sessions & auth** — `session`, `refresh_token`, `mfa_credential`, `mfa_recovery_code`,
`login_attempt`, `password_reset_token`, `user_invitation`, `jwks`.

**Leave & attendance** — `holiday_calendar`, `holiday`, `leave_type`, `leave_period`,
`leave_scheme`, `leave_entitlement_rule`, `leave_balance_ledger`, `leave_balance`,
`leave_request`, `leave_request_day`, `attendance_period`, `attendance_record`,
`attendance_submission`, `attendance_approval`.

**Payroll** — `payroll_cycle`, `payroll_cycle_employee`, `pay_component`, `salary_structure`,
`salary_structure_component`, `payroll_input_batch`, `payroll_input_item`,
`payroll_validation_result`, `payroll_run`, `payslip`, `payslip_line`, `payslip_publication`,
`payslip_fy_rollup`, `payroll_correction`, `statutory_rate_set`, `statutory_pt_slab`,
`employee_statutory_election`, `reimbursement_batch`, `reimbursement_batch_item`.

**Tax & benefits** — `tax_regime`, `tax_regime_slab`, `tax_regime_surcharge`,
`employee_tax_regime_election`, `employee_tax_declaration`, `employee_tax_declaration_item`,
`employee_tax_projection`, `tds_quarter`, `form16_document`, `benefit_plan`,
`benefit_plan_year`, `benefit_enrolment`, `benefit_enrolment_dependent`.

**Expenses** — `expense_category`, `expense_limit`, `expense_claim`, `expense_claim_line`,
`expense_attachment`, `expense_fy_rollup`.

**Documents & policies** — `document_type`, `employee_document`, `letter_template`,
`document_request`, `policy`, `policy_version`, `policy_version_point`,
`policy_applicability_rule`, `policy_assignment`, `policy_acknowledgement`.

**Communications & support** — `announcement`, `announcement_audience`, `announcement_read`,
`notification`, `ticket_category`, `helpdesk_ticket`, `ticket_comment`, `ticket_attachment`,
`faq_article`.

**Approvals** — `approval_task`, `approval_decision`.

**Cross-cutting** — `audit_event`, `audit_chain_head`, `audit_checkpoint`, `file_object`,
`data_encryption_key`, `email_outbox`, `email_suppression`; and in schema `ess_ops`:
`background_job`, `idempotency_key`, `rate_limit_counter`, `schema_guard`.

**Names that appear in sibling drafts and are NOT entities.** Each is an alias to be corrected
wherever it is found:

| Wrong                                                  | Right                                                                             |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `user`                                                 | `app_user`                                                                        |
| `ticket`, `ticket_message`                             | `helpdesk_ticket`, `ticket_comment`                                               |
| `file`, `notification_outbox`                          | `file_object`, `email_outbox`                                                     |
| `data_key`                                             | `data_encryption_key`                                                             |
| `statutory_identity` (col per kind)                    | `employee_statutory_id` (row per kind, discriminated by `kind`)                   |
| `bank_account`, `emergency_contact`                    | `employee_bank_account`, `employee_emergency_contact`                             |
| `reporting_closure`                                    | `employee_reporting_closure(ancestor_employee_id, descendant_employee_id, depth)` |
| `org_unit`, `org_unit_closure`                         | `department` (self-referential via `parent_department_id`)                        |
| `employee.manager_id`                                  | `employee_manager` (history) + `employee_reporting_closure` (resolved)            |
| `leave_ledger`                                         | `leave_balance_ledger`                                                            |
| `expense_policy_limit.escalation_amount`               | `expense_limit.escalation_amount_minor`                                           |
| `payroll_validation_issue`                             | `payroll_validation_result`                                                       |
| `payroll_input_row`                                    | `payroll_input_batch` (the file) + `payroll_input_item` (the row)                 |
| `activation_token`                                     | `user_invitation`                                                                 |
| `letter_request`                                       | `document_request`                                                                |
| `document.class`                                       | `document_type.category`                                                          |
| `benefit_plan.window_start/end`                        | `benefit_plan_year.enrolment_window_opens_on` / `_closes_on`                      |
| `payslip.input_digest`                                 | `payslip.input_sha256` (inputs) **and** `payslip.amount_sha256` (amounts)         |
| `user_role.expires_at`                                 | `user_role.valid_to`                                                              |
| `user_role.scope_org_unit_id`                          | `user_role.scope_department_id`                                                   |
| `app_user.token_epoch`                                 | `app_user.token_version`                                                          |
| `session.step_up_at`, `refresh_token.mfa_satisfied_at` | `session.mfa_verified_at`                                                         |
| `mfa_credential.secret_ciphertext`                     | `mfa_credential.totp_secret_ct` + `_iv` / `_tag` / `_dek_id` / `_mask`            |
| `<field>_bidx`                                         | `<field>_fpr` + `<field>_fpr_pepper_version`                                      |
| `<field>_ciphertext`                                   | `<field>_ct` + `_iv` / `_tag` / `_dek_id` / `_mask`                               |
| `audit_event.ip_address` / `user_agent`                | `audit_event.ip_hash` / `user_agent_hash`                                         |
| `audit_event.on_behalf_of_user_id`                     | **must not exist** — there is no impersonation capability anywhere                |

### 4.2 Enums

Every one is a native Postgres enum in schema `ess`. Adding a value is a forward-only
migration; removing one is forbidden. **No query, guard or DTO ever compares an enum with
`<`/`>`** — ordering is for readability, and a later `ADD VALUE` would silently change the
meaning of such a comparison. "Has reached stage X" is always an explicit `IN (…)` list.

| Enum                                 | Values                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ess_persona`                        | `EMPLOYEE`, `MANAGER`, `HR`, `ACCOUNTS`                                                                                                                                                                                                                                                                                                                   |
| `ess_permission_scope`               | `self`, `team`, `skip_level`, `any`, `finance`, `global`                                                                                                                                                                                                                                                                                                  |
| `ess_user_status`                    | `INVITED`, `PENDING_MFA`, `ACTIVE`, `LOCKED` _(never written — a lock is `app_user.locked_until`)_, `SUSPENDED`, `EX_EMPLOYEE`, `DISABLED`, `OFFBOARDED`                                                                                                                                                                                                  |
| `ess_session_status`                 | `ACTIVE`, `EXPIRED`, `REVOKED`                                                                                                                                                                                                                                                                                                                            |
| `ess_jwks_status`                    | `NEXT`, `CURRENT`, `RETIRED`                                                                                                                                                                                                                                                                                                                              |
| `ess_mfa_method`                     | `TOTP`                                                                                                                                                                                                                                                                                                                                                    |
| `ess_login_outcome`                  | `SUCCESS`, `BAD_CREDENTIALS`, `UNKNOWN_USER`, `MFA_REQUIRED`, `MFA_FAILED`, `LOCKED`, `DISABLED`, `RATE_LIMITED`                                                                                                                                                                                                                                          |
| `ess_employment_status`              | `PRE_JOINING`, `ACTIVE`, `ON_LEAVE`, `NOTICE_PERIOD`, `SUSPENDED`, `EXITED`                                                                                                                                                                                                                                                                               |
| `ess_employment_type`                | `FULL_TIME_PERMANENT`, `FULL_TIME_PROBATION`, `FIXED_TERM`, `INTERN`, `CONTRACTOR`, `CONSULTANT`                                                                                                                                                                                                                                                          |
| `ess_gender`                         | `FEMALE`, `MALE`, `NON_BINARY`, `UNDISCLOSED`                                                                                                                                                                                                                                                                                                             |
| `ess_marital_status`                 | `SINGLE`, `MARRIED`, `DIVORCED`, `WIDOWED`, `UNDISCLOSED`                                                                                                                                                                                                                                                                                                 |
| `ess_blood_group`                    | `A_POS`, `A_NEG`, `B_POS`, `B_NEG`, `AB_POS`, `AB_NEG`, `O_POS`, `O_NEG`, `UNKNOWN`                                                                                                                                                                                                                                                                       |
| `ess_statutory_id_kind`              | `PAN`, `AADHAAR`, `UAN`, `PF_ACCOUNT`, `ESI`, `PRAN`, `PASSPORT`                                                                                                                                                                                                                                                                                          |
| `ess_dependent_relationship`         | `SPOUSE`, `SON`, `DAUGHTER`, `FATHER`, `MOTHER`, `FATHER_IN_LAW`, `MOTHER_IN_LAW`, `SIBLING`, `OTHER`                                                                                                                                                                                                                                                     |
| `ess_profile_change_status`          | `DRAFT`, `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `REJECTED`, `CANCELLED`, `APPLIED`                                                                                                                                                                                                                                                                         |
| `ess_profile_change_field`           | `PERSONAL_EMAIL`, `PERSONAL_MOBILE`, `CURRENT_ADDRESS`, `PERMANENT_ADDRESS`, `MARITAL_STATUS`, `EMERGENCY_CONTACT`, `BANK_ACCOUNT`, `STATUTORY_ID`, `NAME`, `DATE_OF_BIRTH`                                                                                                                                                                               |
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
| `ess_attendance_lop_source`          | `DERIVED`, `HR_OVERRIDE`, `PAYROLL_INPUT_OVERRIDE`                                                                                                                                                                                                                                                                                                        |
| `ess_payroll_cycle_status`           | `DRAFT`, `INPUTS_OPEN`, `INPUTS_LOCKED`, `ATTENDANCE_SUBMITTED`, `ATTENDANCE_APPROVED`, `VALIDATING`, `VALIDATION_FAILED`, `VALIDATED`, `CALCULATING`, `CALCULATED`, `APPROVED`, `PUBLISHED`, `CLOSED`, `CANCELLED`                                                                                                                                       |
| `ess_payroll_cycle_kind`             | `REGULAR`, `SUPPLEMENTARY`, `OFF_CYCLE`, `CORRECTION`                                                                                                                                                                                                                                                                                                     |
| `ess_payroll_scope_disposition`      | `INCLUDED`, `EXCLUDED`, `DEFERRED`                                                                                                                                                                                                                                                                                                                        |
| `ess_payroll_input_batch_status`     | `UPLOADING`, `PARSED`, `PARSE_FAILED`, `VALIDATED`, `COMMITTED`, `SUPERSEDED`, `DISCARDED`                                                                                                                                                                                                                                                                |
| `ess_payroll_input_kind`             | `VARIABLE_PAY`, `INCENTIVE`, `BONUS`, `ARREAR`, `ONE_OFF_DEDUCTION`, `LOP_OVERRIDE`, `REIMBURSEMENT_PAYOUT`, `ADVANCE_RECOVERY`, `TDS_OVERRIDE`                                                                                                                                                                                                           |
| `ess_payroll_validation_severity`    | `INFO`, `WARNING`, `ERROR`                                                                                                                                                                                                                                                                                                                                |
| `ess_payroll_run_status`             | `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `SUPERSEDED`                                                                                                                                                                                                                                                                                                  |
| `ess_payroll_run_kind`               | `REGULAR`, `CORRECTION`                                                                                                                                                                                                                                                                                                                                   |
| `ess_payroll_correction_status`      | `RAISED`, `APPROVED`, `CALCULATING`, `CALCULATED`, `PUBLISHED`, `REJECTED`, `FAILED` — **there is no `PENDING_APPROVAL`**                                                                                                                                                                                                                                 |
| `ess_payslip_status`                 | `GENERATED`, `PUBLISHED`, `SUPERSEDED`, `REVOKED` — **there is no `DRAFT`**                                                                                                                                                                                                                                                                               |
| `ess_payslip_line_kind`              | `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `INFORMATIONAL`                                                                                                                                                                                                                                                                                          |
| `ess_pay_component_kind`             | `EARNING`, `DEDUCTION`, `EMPLOYER_CONTRIBUTION`, `INFORMATIONAL`                                                                                                                                                                                                                                                                                          |
| `ess_pay_component_calc`             | `FIXED`, `PERCENT_OF_BASIC`, `PERCENT_OF_GROSS`, `SLAB`, `INPUT_DRIVEN`, `STATUTORY_ENGINE`, `PRORATED_FIXED`                                                                                                                                                                                                                                             |
| `ess_reimbursement_batch_status`     | `DRAFT`, `LOCKED`, `SENT_TO_PAYROLL`, `PAID`, `CANCELLED`                                                                                                                                                                                                                                                                                                 |
| `ess_tax_regime_code`                | `OLD`, `NEW`                                                                                                                                                                                                                                                                                                                                              |
| `ess_tax_declaration_status`         | `DRAFT`, `SUBMITTED`, `PROOF_PENDING`, `PROOF_SUBMITTED`, `VERIFIED`, `REJECTED`                                                                                                                                                                                                                                                                          |
| `ess_tds_quarter_status`             | `UPCOMING`, `IN_PROGRESS`, `FILED`, `REVISED`                                                                                                                                                                                                                                                                                                             |
| `ess_form16_status`                  | `PENDING`, `ISSUED`, `REVISED`, `WITHDRAWN`                                                                                                                                                                                                                                                                                                               |
| `ess_benefit_category`               | `HEALTH`, `LIFE`, `ACCIDENT`, `RETIREMENT`, `WELLNESS`, `ALLOWANCE`, `OTHER`                                                                                                                                                                                                                                                                              |
| `ess_benefit_coverage_kind`          | `FIXED_SUM_INSURED`, `MULTIPLE_OF_CTC`, `MONTHLY_AMOUNT`, `PERCENT_OF_BASIC`, `NON_MONETARY`                                                                                                                                                                                                                                                              |
| `ess_benefit_enrolment_status`       | `ELIGIBLE`, `ENROLLED`, `WAIVED`, `PENDING_DOCUMENTS`, `LAPSED`, `TERMINATED`                                                                                                                                                                                                                                                                             |
| `ess_benefit_action`                 | `NONE`, `DOWNLOAD_ECARD`, `VIEW_POLICY_DOCUMENT`, `CHANGE_CONTRIBUTION`, `ADD_DEPENDENT`, `RAISE_TICKET`                                                                                                                                                                                                                                                  |
| `ess_expense_claim_status`           | `DRAFT`, `SUBMITTED`, `PENDING_MANAGER`, `MANAGER_APPROVED`, `MANAGER_REJECTED`, `PENDING_FINANCE`, `FINANCE_APPROVED`, `FINANCE_REJECTED`, `QUEUED_FOR_PAYMENT`, `REIMBURSED`, `WITHDRAWN`, `CANCELLED`                                                                                                                                                  |
| `ess_expense_limit_basis`            | `PER_CLAIM`, `PER_LINE`, `PER_DAY`, `PER_MONTH`, `PER_FY`                                                                                                                                                                                                                                                                                                 |
| `ess_document_request_status`        | `SUBMITTED`, `IN_REVIEW`, `PROCESSING`, `ISSUED`, `REJECTED`, `CANCELLED`                                                                                                                                                                                                                                                                                 |
| `ess_document_visibility`            | `EMPLOYEE_AND_HR`, `HR_ONLY`, `EMPLOYEE_MANAGER_HR`                                                                                                                                                                                                                                                                                                       |
| `ess_policy_status`                  | `DRAFT`, `PUBLISHED`, `ARCHIVED`                                                                                                                                                                                                                                                                                                                          |
| `ess_policy_version_status`          | `DRAFT`, `IN_REVIEW`, `PUBLISHED`, `SUPERSEDED`, `WITHDRAWN`                                                                                                                                                                                                                                                                                              |
| `ess_policy_ack_status`              | `PENDING`, `ACKNOWLEDGED`, `WAIVED`, `OVERDUE` — a row is created `PENDING` **by publication**, never by the employee's click                                                                                                                                                                                                                             |
| `ess_policy_applicability_dimension` | `ALL`, `DEPARTMENT`, `LOCATION`, `EMPLOYMENT_TYPE`, `DESIGNATION`, `COST_CENTRE`, `EMPLOYEE`                                                                                                                                                                                                                                                              |
| `ess_announcement_status`            | `DRAFT`, `SCHEDULED`, `PUBLISHED`, `ARCHIVED`                                                                                                                                                                                                                                                                                                             |
| `ess_announcement_audience_kind`     | `ALL`, `DEPARTMENT`, `LOCATION`, `EMPLOYMENT_TYPE`, `EMPLOYEE`                                                                                                                                                                                                                                                                                            |
| `ess_ticket_status`                  | `OPEN`, `ASSIGNED`, `IN_PROGRESS`, `WAITING_ON_EMPLOYEE`, `RESOLVED`, `CLOSED`, `REOPENED`, `CANCELLED`                                                                                                                                                                                                                                                   |
| `ess_ticket_priority`                | `LOW`, `NORMAL`, `HIGH`, `URGENT`                                                                                                                                                                                                                                                                                                                         |
| `ess_ticket_comment_visibility`      | `PUBLIC`, `INTERNAL`                                                                                                                                                                                                                                                                                                                                      |
| `ess_approval_task_kind`             | `LEAVE_REQUEST`, `EXPENSE_CLAIM`, `ATTENDANCE_PERIOD`, `PROFILE_CHANGE`, `DOCUMENT_REQUEST`                                                                                                                                                                                                                                                               |
| `ess_approval_task_status`           | `PENDING`, `APPROVED`, `REJECTED`, `WITHDRAWN`, `EXPIRED`, `REASSIGNED`                                                                                                                                                                                                                                                                                   |
| `ess_approval_decision_outcome`      | `APPROVED`, `REJECTED`, `REASSIGNED`, `AUTO_APPROVED` _(no seeded transition produces it)_, `AUTO_ESCALATED`                                                                                                                                                                                                                                              |
| `ess_notification_kind`              | `PAYSLIP_PUBLISHED`, `LEAVE_SUBMITTED`, `LEAVE_DECIDED`, `EXPENSE_SUBMITTED`, `EXPENSE_DECIDED`, `EXPENSE_REIMBURSED`, `POLICY_ASSIGNED`, `POLICY_OVERDUE`, `ANNOUNCEMENT_PUBLISHED`, `TICKET_UPDATED`, `TICKET_RESOLVED`, `DOCUMENT_ISSUED`, `APPROVAL_PENDING`, `ATTENDANCE_APPROVAL_PENDING`, `PAYROLL_CYCLE_STATE`, `FORM16_ISSUED`, `SECURITY_ALERT` |
| `ess_notification_tone`              | `GREEN`, `AMBER`, `RED`, `BLUE`, `GRAY`                                                                                                                                                                                                                                                                                                                   |
| `ess_email_kind`                     | `HELPDESK_TICKET_CREATED`, `HELPDESK_TICKET_UPDATED`, `PAYSLIP_PUBLISHED`, `PAYSLIP_COPY_REQUESTED`, `LEAVE_DECISION`, `EXPENSE_DECISION`, `POLICY_REMINDER`, `DOCUMENT_ISSUED`, `USER_INVITE`, `PASSWORD_RESET`, `MFA_ENROLLED`, `SECURITY_ALERT`                                                                                                        |
| `ess_email_status`                   | `QUEUED`, `SENDING`, `SENT`, `FAILED`, `SUPPRESSED`, `CANCELLED`                                                                                                                                                                                                                                                                                          |
| `ess_file_purpose`                   | `EXPENSE_BILL`, `TICKET_ATTACHMENT`, `EMPLOYEE_DOCUMENT`, `POLICY_PDF`, `PAYSLIP_PDF`, `FORM16_PDF`, `PAYROLL_INPUT_UPLOAD`, `ATTENDANCE_UPLOAD`, `BENEFIT_DOCUMENT`, `LETTER_PDF`, `PROFILE_PROOF`, `ORG_ASSET`                                                                                                                                          |
| `ess_file_scan_status`               | `PENDING`, `CLEAN`, `INFECTED`, `SCAN_FAILED`, `SKIPPED`                                                                                                                                                                                                                                                                                                  |
| `ess_audit_action`                   | `CREATE`, `UPDATE`, `DELETE`, `READ_SENSITIVE`, `LOGIN`, `LOGOUT`, `STATE_TRANSITION`, `EXPORT`, `DOWNLOAD`, `PERMISSION_GRANT`, `PERMISSION_REVOKE`, `IMPERSONATE` _(never written — no impersonation exists)_, `CONFIG_CHANGE`, `CRYPTO_REWRAP`                                                                                                         |
| `ess_actor_kind`                     | `USER`, `SYSTEM`, `SCHEDULER`, `MIGRATION`                                                                                                                                                                                                                                                                                                                |

**`audit_event` carries two vocabularies and needs both.** `action` is the coarse
`ess_audit_action` enum above (what kind of thing happened, for indexing and retention);
`event_code` is the fine dotted code from the seeded `audit_event_code` catalogue
(`PAYROLL.VALIDATED`, `AUTH.REFRESH_REUSE_DETECTED`, `AUTHZ.DENIED`,
`ADMIN.USER_STATUS_CHANGED`, `SECURITY.BANK_ACCOUNT_COLLISION`, …) that `SECURITY.md` and
`WORKFLOWS.md` name throughout. Neither replaces the other, and an `event_code` outside the
seeded catalogue fails CI.

### 4.3 Permission strings

**Grammar.** `resource[:subresource]:action[:scope]`, two to four colon-separated lowercase
segments, `scope ∈ ess_permission_scope`. A two-segment org-wide code carries the implicit
scope `global` and prints no scope segment. The string is what is stored in `permission.code`,
in `state_transition.required_permission_code`, in the `ess.scopes` GUC (compared by
`has_scope()` as a **whole array element**, never by `LIKE`), in `config.permission`, in
`audit_event.actor_permission_code` and in `GET /me`'s `permissions[]`. **There is exactly one
spelling**; the `verb:resource[:qualifier]` form of `SECURITY.md` §4.4's legacy tables and the
bare `resource:action` form of earlier `packages/shared` drafts are both withdrawn, and
`packages/shared/src/rbac/roles.ts` is generated from the seed by `npm run gen:permissions`.

**Scope segment ⇄ ABAC reach.** The two are related but distinct: the segment is part of the
_name_, the ABAC scope is the _reach_ resolved per grant per request.

| Segment      | ABAC scope        | Predicate                                                                    |
| ------------ | ----------------- | ---------------------------------------------------------------------------- |
| `self`       | `SELF`            | subject `= actor.employeeId`, derived from the token, never from the request |
| `team`       | `REPORTING_CHAIN` | `employee_reporting_closure` `depth BETWEEN 1 AND 6` beneath the actor       |
| `skip_level` | `REPORTING_CHAIN` | same closure, `depth >= 2`                                                   |
| `any`        | `ORG`             | actor's organisation, subject to resource attribute predicates               |
| `finance`    | `ORG`             | organisation-wide, limited to the expense-settlement routes                  |
| `global`     | `ORG`             | no employee predicate at all (configuration and reference reads)             |

Two refinements: `emergency_contact:read:team` resolves to `DIRECT_REPORTS` (`depth = 1`
exactly, matching the persisted policy note "visible only to People Ops and your manager"); and
an `HR` grant narrowed by `user_role.scope_department_id` is a `DEPARTMENT` subtree predicate.
Multiple grants of one permission compose as the **union of the resolved row sets**, never as
"the widest scope wins" — with `scope_department_id` in play the ordering is not a total order,
and "widest wins" would make an HRBP-for-Design who also manages a Platform team lose access to
their own reports.

**The complete seeded catalogue.** This is `DATA-MODEL.md` §3.1; every code appears in at least
one persona grant (`E` Employee, `M` Manager, `H` HR, `A` Accounts), and an orphan fails CI.

```
auth:login                              EMHA
profile:read:self  profile:update:self  profile:read_sensitive:self             EMHA
profile:read:team                       M     profile:read:any                  H
profile:update:any                      H     profile:read_sensitive:any        H
profile:change_request:create:self  profile:change_request:read:self            EMHA
profile:change_request:read:any  profile:change_request:decide                  H
emergency_contact:read:self  emergency_contact:write:self                       EMHA
emergency_contact:read:team             M     emergency_contact:read:any        H
bank_account:read:self  bank_account:change_request:create:self                 EMHA
bank_account:read_sensitive:any  bank_account:change_request:verify             A
statutory_identity:read:self            EMHA  statutory_identity:read_sensitive:any   A
payslip:read:self  payslip:download:self  payslip:email:self                    EMHA
payslip:read:any  payslip:download:any                                          A
payroll:salary_structure:read:self      EMHA
payroll:salary_structure:read:any  payroll:salary_structure:write               A
tax:declaration:read:self  tax:declaration:write:self  tax:quarter:read:self    EMHA
tax:form16:read:self                    EMHA  tax:form16:read:any               HA
tax:declaration:read:any  tax:declaration:verify  tax:form16:issue              A
tax:quarter:read:any  tax:quarter:manage                                        A
leave:request:read:self  leave:request:create:self  leave:request:withdraw:self EMHA
leave:balance:read:self  holiday:read                                           EMHA
leave:request:read:team  leave:request:approve:team  leave:balance:read:team    M
leave:request:read:any  leave:request:approve:any  leave:balance:read:any       H
leave:balance:adjust  leave:config:manage  holiday:manage                       H
attendance:read:self                    EMHA
attendance:read:team  attendance:approve:team                                   M
attendance:read:any                     HA
attendance:capture  attendance:submit  attendance:approve:any  attendance:reopen H
payroll:cycle:read                      HA
payroll:validation_issue:read           HA
payroll:cycle:create  payroll:cycle:transition                                  A
payroll:input:upload  payroll:input:read  payroll:input:commit                  A
payroll:validate  payroll:calculate  payroll:approve  payroll:publish           A
payroll:close  payroll:component:manage  payroll:statutory:manage               A
payroll:correction:raise  payroll:correction:approve  payroll:correction:read   A
payroll:export                          A
benefit:read:self  benefit:enrol:self  dependent:read:self  dependent:write:self EMHA
benefit:read:any  benefit:manage  benefit:enrol:approve                         H
dependent:read:any  dependent:verify                                            H
benefit:deduction:read:any              A
expense:claim:read:self  expense:claim:create:self  expense:claim:withdraw:self EMHA
expense:policy_limit:read               EMHA
expense:claim:read:team  expense:claim:approve:team                             M
expense:claim:approve:skip_level        M
expense:claim:read:any  expense:claim:approve:finance  expense:reimburse        A
expense:config:manage                   A
document:read:self  document:request:create:self  document:request:read:self    EMHA
document:read:any  document:upload:any  document:request:read:any               H
document:request:fulfil  document:type:manage                                   H
policy:read  policy:acknowledge:self  policy:ack:read:self                      EMHA
policy:ack:read:any  policy:author  policy:publish  policy:archive              H
directory:read  directory:read_contact                                          EMHA
announcement:read                       EMHA
announcement:author  announcement:publish  announcement:pin                     H
ticket:create:self  ticket:read:self  ticket:comment:self  ticket:close:self    EMHA
faq:read                                EMHA
ticket:read:any  ticket:comment:any  ticket:assign  ticket:resolve              HA
ticket:config:manage  faq:manage                                                H
approval:task:read:self  notification:read:self  notification:mark_read:self    EMHA
file:download:self  org:read                                                    EMHA
approval:task:read:team  approval:task:act                                      M
approval:task:read:any                  H
employee:create  employee:read:any  employee:update:any  employee:deactivate    H
role:read  role:assign  role:manage                                             H
org:manage  org:setting:update                                                  H
org:setting:read                        HA
security:session:revoke  security:mfa:reset  security:account:unlock            H
audit:read                              HA    audit:export  audit:verify        H
file:download:any                       HA
report:leave:read  report:expense:read  H     report:payroll:read               A
```

`is_sensitive = true` (exercising it writes an `audit_event` with `action = 'READ_SENSITIVE'`
and the subject employee id) for: `profile:read_sensitive:*`, `bank_account:read_sensitive:any`,
`statutory_identity:read_sensitive:any`, `payslip:read:any`, `payslip:download:any`,
`payroll:salary_structure:read:any`, `tax:declaration:read:any`, `audit:read`, `audit:export`,
`payroll:export`, `file:download:any`, `employee:read:any`, `security:mfa:reset`,
`security:session:revoke`, `security:account:unlock`, `profile:change_request:read:any`,
`payroll:correction:approve`.

**Step-up MFA (`†`)** is required by: bank-account and statutory change submission and
verification, password change, MFA reset/regeneration, any `role:assign`/`role:manage`,
`payroll:approve`, `payroll:publish`, `payroll:correction:approve`, payslip publication
revocation, every `*:export`, admin user-status changes, and any unmasking of a statutory id or
bank account. A step-up is a fresh MFA assertion recorded in **`session.mfa_verified_at`**,
valid for **`org_setting.step_up_max_age_seconds` = 300** (hard maximum 900), mirrored by the
access token's `mfa_at` claim. MFA _enrolment_ and credential removal require a fresh
**`reauth_at`** (a password re-presentation) instead, because a first enrolment has no second
factor to assert.

**Maker-checker (`‡`)** — the actor of this step must differ from the actor of the named
preceding step, resolved from persisted `…_by_user_id` columns and never from the audit log:
policy publisher ≠ author; attendance approver ≠ the HR user who submitted the period; payroll
approver ≠ calculator (`payroll.distinct_approver`); payroll publisher ≠ calculator **and** ≠
approver (`payroll.distinct_publisher`); correction approver ≠ raiser; role-grant approver ≠
requester. Where only one qualifying user exists the action is **blocked** and the error names
the missing approver; there is no "allow single-approver mode" setting.

**Self-dealing (`§`)** — denied when the resource's subject employee is the actor. There is no
super-admin, no support role and **no impersonation capability anywhere in the system**.

### 4.4 States

Every table with a `status` column has a machine in `state_transition`; every machine
corresponds to such a table (`DATA-MODEL.md` §21 rule 13). The complete machine index:

`leave_request` · `attendance_period` · `attendance_record` · `attendance_approval` ·
`payroll_cycle` · `payroll_input_batch` · `payroll_run` · `payslip` · `payslip_publication` ·
`payroll_correction` · `reimbursement_batch` · `employee_tax_declaration` · `tds_quarter` ·
`form16_document` · `benefit_enrolment` · `expense_claim` · `document_request` ·
`policy_version` · `policy_acknowledgement` · `announcement` · `helpdesk_ticket` ·
`approval_task` · `profile_change_request` · `app_user` · `employee` · `role_grant_request` ·
`session`.

The state _values_ of each are the enums of §4.2. Four that were spelled differently across
documents, resolved:

| Machine                  | Canonical                                                                                               | Withdrawn spelling                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `attendance_period`      | `OPEN → HR_SUBMITTED → MANAGER_APPROVAL_PENDING → APPROVED → LOCKED`, with `REOPENED`                   | `ATTENDANCE_DRAFT → ATTENDANCE_SUBMITTED` |
| `payslip`                | created `GENERATED`, then `PUBLISHED` / `SUPERSEDED` / `REVOKED`                                        | created `DRAFT`                           |
| `payroll_correction`     | `NULL → RAISED → APPROVED → CALCULATING → CALCULATED → PUBLISHED`, with `REJECTED` / `FAILED`           | `NULL → PENDING_APPROVAL`                 |
| `policy_acknowledgement` | `PENDING → ACKNOWLEDGED` / `WAIVED` / `OVERDUE`; the `PENDING` row is created **by policy publication** | `NULL → ACKNOWLEDGED`                     |

**The seven employee-facing payroll stage keys.** Internal and failure states never reach an
employee: `VALIDATING`, `VALIDATION_FAILED`, `CALCULATING` and `CANCELLED` collapse to
`stageKey: "IN_PROGRESS"` before serialisation, so no employee is ever told that payroll
validation failed. The keys the SPA may `switch` on are `NOT_STARTED`, `INPUTS_PENDING`,
`ATTENDANCE_PENDING`, `ATTENDANCE_APPROVAL_PENDING`, `IN_PROGRESS`, `AWAITING_RELEASE`,
`PUBLISHED`, each travelling with its `ui_copy` `stageLabel`.

---

## 5. The payroll pipeline, end to end

This is the mandated workflow, and it is the reason `payslip` rows are not visible objects.
Each arrow is a `state_transition` row with a permission code and zero or more guard keys; each
is audited in the same transaction as its effect.

```
ACCOUNTS       HR            MANAGER        SYSTEM / WORKER      DATABASE                 EMPLOYEE
   │            │               │                  │                 │                       │
   │ POST /payroll/cycles       │                  │                 │                       │
   ├───────────────────────────────────────────────────────────────▶ payroll_cycle DRAFT     │
   │ open-inputs │              │                  │                 │                       │
   ├───────────────────────────────────────────────────────────────▶ INPUTS_OPEN             │
   │            │               │                  │                 │                       │
   │ POST /files + /inputs (CSV/XLSX)              │                 │                       │
   ├──────────────────────────────────────────────▶│ parse, magic-byte + ClamAV scan         │
   │            │               │                  ├───────────────▶ payroll_input_batch     │
   │            │               │                  │                 PARSED  (+ _item rows   │
   │            │               │                  │                  with file_object_id    │
   │            │               │                  │                  and row_number)        │
   │ POST …/inputs/:batch/commit  (payroll:input:commit — a DISTINCT step from upload)       │
   ├───────────────────────────────────────────────────────────────▶ batch COMMITTED         │
   │ lock-inputs │              │                  │                 │                       │
   ├───────────────────────────────────────────────────────────────▶ INPUTS_LOCKED           │
   │            │               │                  │                 guard: payroll.         │
   │            │               │                  │                 dual_control_available  │
   │            │               │                  │                 (>= 3 ACTIVE MFA-       │
   │            │               │                  │                  enrolled ACCOUNTS)     │
   │            │               │                  │                 │                       │
   │            │ capture / bulk-upload attendance │                 │                       │
   │            ├─────────────────────────────────────────────────▶ attendance_record DRAFT  │
   │            │ POST /hr/attendance/periods/:id/submit            │                       │
   │            ├─────────────────────────────────────────────────▶ period HR_SUBMITTED,     │
   │            │               │                  │                 one attendance_approval │
   │            │               │                  │                 per manager slice,      │
   │            │               │                  │                 payload_sha256 frozen   │
   │            │               │                  │                 cycle ATTENDANCE_       │
   │            │               │                  │                        SUBMITTED        │
   │            │               │  approve slice   │                 │                       │
   │            │               ├────────────────────────────────▶ attendance_approval       │
   │            │               │  (or /return)    │                 APPROVED / REJECTED     │
   │            │               │                  │                 guard ‡: approver ≠ the │
   │            │               │                  │                 HR submitter; a manager │
   │            │               │                  │                 never approves their own│
   │            │               │                  │                 record                  │
   │            │               │                  │   when guard attendance.every_slice_    │
   │            │               │                  │   approved holds ──────────────────────▶ cycle
   │            │               │                  │                 ATTENDANCE_APPROVED     │
   │ POST …/validate            │                  │                 │                       │
   ├──────────────────────────────────────────────▶│ VALIDATING      │                       │
   │            │               │                  │ per employee: approved attendance ·     │
   │            │               │                  │ effective salary_structure · verified   │
   │            │               │                  │ bank account · exactly one input item   │
   │            │               │                  │ per (employee, kind, component), matched│
   │            │               │                  │ on employee_code ^WDT-\d{5}$ only       │
   │            │               │                  ├───────────────▶ payroll_cycle_employee  │
   │            │               │                  │                 (INCLUDED/EXCLUDED/     │
   │            │               │                  │                  DEFERRED, upserted so  │
   │            │               │                  │                  deferrals survive)     │
   │            │               │                  ├───────────────▶ payroll_validation_     │
   │            │               │                  │                 result rows (INFO/      │
   │            │               │                  │                 WARNING/ERROR)          │
   │            │               │                  ├───────────────▶ cycle.input_manifest_   │
   │            │               │                  │                 sha256  ← FREEZES the   │
   │            │               │                  │                 inputs                  │
   │            │               │                  │   any unresolved ERROR ⇒ VALIDATION_    │
   │            │               │                  │   FAILED (a real blocking list, never   │
   │            │               │                  │   a generic error); else VALIDATED      │
   │ POST …/calculate           │                  │                 │                       │
   ├──────────────────────────────────────────────▶│ CALCULATING     │                       │
   │            │               │                  │ payroll_run QUEUED → RUNNING, records   │
   │            │               │                  │ engine_version + ruleset_sha256         │
   │            │               │                  │ §1.9 deterministic spec, integer paise  │
   │            │               │                  ├───────────────▶ payslip GENERATED       │
   │            │               │                  │                 + payslip_line rows     │
   │            │               │                  │                 + input_sha256 (inputs)  │
   │            │               │                  │                 + amount_sha256 (lines) │
   │            │               │                  │                 + payslip_fy_rollup     │
   │            │               │                  │   trg_payslip_requires_calculating      │
   │            │               │                  │   rejects any INSERT outside this state │
   │            │               │                  ├───────────────▶ cycle CALCULATED        │
   │ POST …/approve  †‡  (payroll.distinct_approver: approver ≠ calculator)                  │
   ├───────────────────────────────────────────────────────────────▶ APPROVED                │
   │ POST …/publish  †‡  (payroll.distinct_publisher: publisher ≠ calculator AND ≠ approver) │
   ├──────────────────────────────────────────────▶│                 │                       │
   │            │               │                  ├───────────────▶ payslip_publication row │
   │            │               │                  │                 ← ITS EXISTENCE IS      │
   │            │               │                  │                   VISIBILITY            │
   │            │               │                  ├───────────────▶ payslip PUBLISHED       │
   │            │               │                  ├───────────────▶ cycle PUBLISHED         │
   │            │               │                  ├───────────────▶ notification +          │
   │            │               │                  │                 email_outbox + PDF job  │
   │            │               │                  │                 (same transaction)      │
   │            │               │                  │                 │   GET /me/payslips    │
   │            │               │                  │                 ├──────────────────────▶│
   │            │               │                  │                 │   first row visible   │
   │ POST …/close  †            │                  │                 │                       │
   ├───────────────────────────────────────────────────────────────▶ CLOSED (terminal)       │
```

**The visibility rule, and the three places it is enforced.** A payslip is visible iff a
`payslip_publication` row exists for it with `published_at <= now()` and `revoked_at IS NULL`.
That predicate is (1) the single `publishedPayslipWhere` fragment every repository function
composes — including the Home "latest payslip" card, the YTD tiles, global search, badge counts
and notification fan-out, so an unpublished payslip cannot surface through a side channel;
(2) inside the RLS policy on `payslip`, `payslip_line` and `payslip_fy_rollup` itself, so the
gate cannot be forgotten by a caller; and (3) asserted by `apps/api/test/payroll-visibility.test.ts`
against every endpoint that can reach a money value. Before publication the Payslips screen
renders the `PAYSLIPS_CYCLE_IN_PROGRESS` empty state with the persisted `stageLabel` — never a
zero, never a placeholder row.

**Correcting a published month** is never an edit. `payroll_correction` (`RAISED → APPROVED →
CALCULATING → CALCULATED → PUBLISHED`) produces a new `payroll_run` with `run_kind =
'CORRECTION'` and new payslips that supersede the old ones; the superseded rows stay, and the
net delta settles in a named `settlement_cycle_id`.

---

## 6. Repository layout

```
WIDEDROP-ESS/
├── apps/
│   ├── api/                       Fastify 5 · Node 22 · TypeScript · the ONLY trusted compute
│   │   ├── prisma/
│   │   │   ├── schema.prisma      generated from docs/DATA-MODEL.md; diffed in CI
│   │   │   ├── migrations/        hand-written SQL for triggers, EXCLUDE, partial indexes,
│   │   │   │                      the audit chain, append-only rules and every RLS policy
│   │   │   └── seed/              reference data ONLY (§8) — permissions, roles, enums,
│   │   │                          ui_copy, statutory rates, holiday calendars, FAQ
│   │   ├── src/
│   │   │   ├── config/env.ts      Zod schema parsed BEFORE Fastify exists; fail-fast
│   │   │   ├── plugins/           authorize · audit · rateLimit · idempotency · csrf · errors
│   │   │   ├── authz/             matrix · scopes · where · predicates · separation
│   │   │   ├── auth/              password · totp · tokens · csrf · session
│   │   │   ├── crypto/            envelope · dek · fpr (blind index) · chain
│   │   │   ├── modules/<domain>/  routes.ts · service.ts · repo.ts · dto.ts · schemas.ts
│   │   │   ├── workflow/          stateMachine · guards registry · transition runner
│   │   │   ├── payroll/           engine (§1.9) · validation · publication
│   │   │   ├── worker/            outbox dispatcher + the named scheduled jobs
│   │   │   └── server.ts          public listener :$PORT + internal listener :$PRIVATE_PORT
│   │   ├── test/                  routes.guard · separation · empty-vs-denied · payroll-*
│   │   └── Dockerfile             3-stage, non-root, no npm/compilers/source in the runtime
│   └── web/                       React 18 · Vite · TypeScript · static, zero secrets
│       ├── src/                   app · routes · features · components · lib · hooks · styles
│       ├── scripts/gen-csp-headers.mjs   emits dist/_headers (generated, never committed)
│       └── test/                  msw handlers · renderWithProviders · contract tests
├── packages/
│   └── shared/                    the ONLY code both sides import
│       ├── src/rbac/              Persona · Scope · the GENERATED permission union
│       ├── src/contracts/         Zod schemas shared by API validation and SPA forms
│       ├── src/domain/            state machines, payroll helpers, notification kinds
│       ├── src/format/            formatInr · fmt · rel — the identical functions both sides use
│       └── src/design/            tokens · icon ids
├── infra/
│   ├── netlify/netlify.toml       redirects (order is semantic) + headers, minus CSP
│   ├── render/render.yaml         blueprint; every secret is `sync: false`
│   ├── fly/fly.toml               the stated alternative
│   └── dns-inventory.md           reviewed quarterly — dangling CNAMEs are a same-site risk
├── docs/                          ARCHITECTURE (this file) · DATA-MODEL · SECURITY · API ·
│                                  WORKFLOWS · FRONTEND · DEPLOYMENT · adr/ · secret-inventory.md
├── design/                        DESIGN-SYSTEM.md · prototype/ (the UI/UX source of truth)
└── .github/workflows/             ci.yml (on PR) · deploy.yml (on workflow_run success)
```

---

## 7. Technology decision record

| #   | Decision                                                                                                                                     | Alternatives considered                                                          | Why this one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | **PostgreSQL 16** as the single system of record                                                                                             | MySQL; MongoDB; a managed HR SaaS                                                | Payroll is relational, transactional and audited. Postgres gives native enums, `EXCLUDE` constraints over date ranges (effective-dated salary structures and fiscal years cannot overlap _by construction_), partial and expression indexes, `numeric` without float error, and **row-level security** — the second, independent authorization layer that makes a missing `WHERE` clause return zero rows instead of another employee's payslip. No document store reproduces that.                             |
| T2  | **Application-layer AES-256-GCM envelope encryption** on compensation, statutory ids, bank accounts and personal contact detail, keys in KMS | Provider disk encryption alone; `pgcrypto` in the database; full-database TDE    | Disk encryption protects against a stolen drive and nothing else: a leaked dump, a compromised read replica, a logical-replication tap or a platform operator all read plaintext. Keys outside the database mean none of those yields compensation data. The cost — money aggregates must be folded in the API, not `SUM()`-ed in SQL — is paid once by the persisted `payslip_fy_rollup` / `expense_fy_rollup` rows.                                                                                           |
| T3  | **Integer minor units (paise) everywhere**, `bigint`, `BigInt` in Prisma, JSON string on the wire                                            | `numeric(14,2)`; float; a money library                                          | Float is disqualified outright for payroll. `numeric` is correct in the database but loses precision the moment it crosses JSON as a JS `number`; integers of paise survive the whole round trip, and rounding happens exactly once, at render, in `formatInr`.                                                                                                                                                                                                                                                 |
| T4  | **Fastify 5** on Node 22                                                                                                                     | Express; NestJS; Go; Django                                                      | Schema-first routing makes "every route declares `config.permission` or `config.public`" a _boot-time assertion_ over the printed route table rather than a code-review habit — an unguarded route cannot ship. Fast JSON serialisation with an explicit response schema also gives field allowlisting for free, which is the DTO-layer half of keeping Accounts away from non-payroll PII.                                                                                                                     |
| T5  | **Prisma 5** with hand-written SQL migrations                                                                                                | Raw SQL + a query builder; TypeORM; Drizzle                                      | Prisma's generated types make the DTO layer type-safe and its `where` composition is what lets the scope predicate be _compiled into_ the query rather than checked after the fetch. Everything Prisma cannot express — triggers, `EXCLUDE`, partial indexes, the hash chain, RLS — is hand-written SQL, diffed against `DATA-MODEL.md` in CI.                                                                                                                                                                  |
| T6  | **React 18 + Vite SPA, static, no SSR**                                                                                                      | Next.js; Remix; server-rendered templates                                        | The prototype is a single-shell app whose chrome never remounts. SSR would put a rendering server inside the trust boundary, require secrets at the edge, and make the Netlify free tier the wrong shape. A static bundle keeps `ess.widedrop.com` a zero-secret host and the API the single authorization boundary.                                                                                                                                                                                            |
| T7  | **Ed25519 access JWT (10 min) + opaque rotating refresh cookie**                                                                             | Long-lived JWT; server sessions only; HMAC-signed JWT                            | A short JWT is offline-verifiable _and_ revocable, because `sid` is looked up in `session` on every request. Ed25519 keeps the private key out of every verifier. An opaque refresh token carries no claims, cannot be forged offline, and its rotation with family-reuse detection turns a stolen cookie into a loud, self-limiting event.                                                                                                                                                                     |
| T8  | **`__Host-` cookies, `SameSite=Strict`, signed session-bound CSRF token in the response body**                                               | Classic readable-cookie double-submit; `SameSite` alone; token in `localStorage` | `ess.widedrop.com` and `api-ess.widedrop.com` are same-**site**, so `SameSite` will happily attach the cookie for _any_ `*.widedrop.com` host — including the marketing site and any hijacked CNAME. `__Host-` host-locks the cookie so a sibling cannot set it; the HMAC over the victim's `session_id` is something a sibling cannot mint. The SPA cannot read a cookie on the API host, so the token arrives in the response body — the readable-cookie variant is not merely weaker here, it is impossible. |
| T9  | **Render (singapore) for the API + worker; Netlify for the SPA on a second team**                                                            | Netlify Functions; Vercel; a VM; one Netlify team                                | The brief fixes the marketing site on Netlify free. A second _team_ gives independent build minutes, bandwidth, deploy token and access control, so ESS traffic cannot consume the marketing allowance and a leaked token cannot reach both. Serverless functions are the wrong shape for a system of record: no persistent pool, no background worker, no advisory locks, and cold starts on a payroll publication.                                                                                            |
| T10 | **PgBouncer transaction pooling, plus a second `DIRECT_DATABASE_URL`**                                                                       | Session pooling; no pooler; Prisma Data Proxy                                    | Transaction pooling is exactly compatible with the `SET LOCAL` request context the RLS policies read, and incompatible with session-level `SET` — which is why the context must never be set outside a transaction. Session-scoped advisory locks and migrations need a direct connection, so both URLs exist and each names its role.                                                                                                                                                                          |
| T11 | **Redis token buckets primary, `ess_ops.rate_limit_counter` fallback**                                                                       | Postgres-only; in-memory                                                         | In-memory multiplies every limit by the instance count — a failure that looks fine in single-instance staging. Postgres-primary puts a write on the system of record on every rate-limited request, so a credential-stuffing burst becomes database load. Redis absorbs it; Postgres keeps the limiter working when Redis is down; both down fails **closed** on `/auth/*` and every sensitive route.                                                                                                           |
| T12 | **Transactional outbox (`email_outbox`) for every email, worker-dispatched**                                                                 | Send inline; a queue service                                                     | A help-desk ticket must persist even when the mail provider is down, and an email must never be sent for a transaction that rolled back. The outbox row is written in the same transaction as the ticket; the worker retries with backoff and dead-letters. This is what makes directive 8 (`helpdesk@widedroptech.com`) reliable rather than best-effort.                                                                                                                                                      |
| T13 | **Keyed HMAC audit chain computed in the application**                                                                                       | `sha256()` in a `BEFORE INSERT` trigger                                          | A bare SHA-256 chain is forgeable by exactly the privileged insider the chain exists to catch: anyone with write access can recompute it. The chain key never enters Postgres. The trigger is retained, but only to enforce append-only and reject a NULL `row_hash`.                                                                                                                                                                                                                                           |
| T14 | **`404`, not `403`, for out-of-scope objects**                                                                                               | `403` everywhere                                                                 | `403` confirms that an id exists — an enumeration oracle over employee and payslip ids. `403` is reserved for "you can see this object but may not perform this action on it". The empty and the denied response are byte-identical for exactly the same reason.                                                                                                                                                                                                                                                |
| T15 | **Cloudflare R2, private, 120-second signed GETs**                                                                                           | Public bucket with unguessable keys; files in Postgres; local disk               | A container filesystem is ephemeral — payslips would vanish on redeploy. Bytes in Postgres bloat every backup and restore. An unguessable public URL is a bearer token with no expiry and no audit; a 120-second signed URL minted per authorized request is auditable and cheap to revoke.                                                                                                                                                                                                                     |

Each row is also an ADR in `docs/adr/`; a deviation requires a new ADR, not an edit.

---

## 8. No fabricated data

**The rule.** Every value, count, amount, status, balance, metric, notification and number the
interface renders originates in a persisted row or in a deterministic computation over
persisted rows. There is no sample data, no seeded-for-demo operational row, no placeholder, no
`|| 0`, no `?? '—'` standing in for a value the server did not send. A screen with no data
renders its designed empty state, which is itself sourced from persisted copy.

**Absent, zero and denied are three different things**, and conflating them is both a design
bug and a security bug:

| Situation                                       | API                                                 | UI                                                  |
| ----------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- |
| No persisted row exists for this measure        | field is `null`; collection is `[]` with `total: 0` | `—` in `--text-muted` plus a sub-label saying _why_ |
| Rows exist and the computation over them is `0` | field is `0` (integer paise for money)              | `₹0` — a fact, not a placeholder                    |
| The actor has no scope over the underlying rows | **byte-identical to absent**                        | identical empty state                               |

The third row is the security property: if a denial rendered differently from an emptiness, the
empty state would become an existence oracle. `apps/api/test/empty-vs-denied.test.ts` diffs the
two responses for every collection endpoint. Conversely a denial is never rendered as a zero — a
`0` in this system always means "we counted, and the answer was none", which is the difference
between "you have no leave left" and "we could not tell you your leave".

**How each layer enforces it:**

| Layer             | Enforcement                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Database**      | `npm run test:seed-purity` asserts that every table in `DATA-MODEL.md` §18.2 is **empty** after a production seed: no employee, no payslip, no leave request, no ticket, no announcement. Only reference data is seeded. `npm run test:empty-state` then runs the whole app against that reference-only database.                                                              |
| **Schema**        | Balances are projections of an append-only ledger (`leave_balance_ledger`), never mutable numbers. Aggregates that must be queryable are persisted rollups written in the same transaction as their source row, never recomputed guesses.                                                                                                                                      |
| **API**           | `DATA-MODEL.md` §20 maps **every** value the prototype renders to a column or a stated aggregation; a response field that §20 does not source does not exist. `null` is sent for absent, `0` only for measured zero, and the field is **omitted** when the actor is not entitled to it. `emptyState.params` carries no money value at all.                                     |
| **Copy**          | Every user-facing string — labels, empty-state titles and messages, chip labels, stage labels, plural forms, composed sentences — comes from the seeded `ui_copy` table via `API.md` §12.18's formatters, in `organization.locale`/`.timezone`. CI invariant 12 fails on an `emptyState.code` with no seeded `ui_copy` pair.                                                   |
| **Frontend**      | The SPA owns **no** operational constant. A CI grep fails the build on a hex colour outside `tokens.css`, on a `/api/v1` string outside `features/*/api.ts`, on a `style` attribute in the shipped DOM, and on `Date.now()`/`new Date()` outside two named files — the clock for anything _displayed_ is `MeDto.serverTime`.                                                   |
| **Time**          | Containers run `TZ=UTC` and the database `timezone='UTC'`; **no business date is derived from the process clock's local calendar**. A civil date is `(instant AT TIME ZONE :org_tz)::date`, or an explicit `timeZone` in `Intl`. An ESLint rule bans the bare `Date` getters. This is the one failure mode that produces _wrong_ numbers without any of them being _invented_. |
| **Authorization** | Badge counts, search results, notifications and to-do items are produced by the **same** `authzWhere()` predicate as the screen they summarise, so an unscoped read cannot leak through an aggregate. `notification` rows store a `resource_ref` and a template key — never a rendered amount — and the amount is resolved at read time through the authorized query.          |

---

## 9. Implementation milestones

Each milestone ends with a demonstrable system and a set of exit criteria that CI can check. No
milestone is complete while a later one is needed to make it honest.

| #      | Milestone                                       | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Exit criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1** | **Foundations & schema**                        | Monorepo, TypeScript project references, ESLint/Prettier/Vitest, `packages/shared` with the generated permission union and the shared formatters. `schema.prisma` + hand-written migrations for the full `ess`/`ess_ops` schema: every table, enum, constraint, index, trigger, RLS policy. Reference-data seed (permissions, four roles with their grants, `state_transition`, `ui_copy`, statutory rates, holiday calendars, FAQ). `docker-compose` dev stack.                                                                | `npm run db:verify-schema` passes all 26 checks. `npm run test:seed-purity` leaves every §18.2 table empty. `separation.test.ts` proves SoD-1…SoD-6 over the seeded grants. `docs:verify-cross-refs` passes across all six documents. Six DB roles exist with the stated grants.                                                                                                                                                                                                                        |
| **M2** | **Identity, authentication, authorization**     | `app_user`, `employee`, `employee_employment`, `employee_manager` + closure rebuild. Argon2id+pepper, HIBP k-anonymity, TOTP enrolment and verification, recovery codes, invitation and activation, password reset, lockout ladder. Session + refresh rotation with family reuse detection, `__Host-` cookies, CSRF, CORS, security headers. The `authorize` plugin: boot-time route assertion, `authzWhere`, `separation.ts`, denial auditing. Audit chain with HMAC and checkpoints.                                          | `routes.guard.test.ts` proves no route lacks `permission` or `public`, and the public list matches §4.6 exactly. The matrix-driven table test issues a real request for every `(persona, permission)` pair marked `—` and gets `403`/`404`. Refresh reuse revokes the family and alerts. A deliberate tamper fixture fails `audit-chain-verify`. RLS integration suite passes with RLS both disabled and enabled.                                                                                       |
| **M3** | **Shell, design system, employee read-only**    | `apps/web` shell: sidebar, header, tab bar, More sheet, global search, notification popover, `useContainerBreakpoints`. The full token block and every primitive of `FRONTEND.md` §2.6. `GET /me`, `/me/bootstrap`, server-composed nav. Read-only Home, My profile, Directory, Announcements, Policies. Masking in the DTO layer; `emptyState` end to end.                                                                                                                                                                     | Every screen renders correctly against a reference-data-only database — this is the first demonstration of directive 9. Zero `[style]` attributes in the shipped DOM. Axe clean; contrast verified against the dark palette. `apiPaths.contract.test.ts` and `rbac.contract.test.ts` pass, so no route or permission exists on one side of the wire only.                                                                                                                                               |
| **M4** | **Leave, expenses, help desk, approvals**       | Leave requests with server-side working-day computation, balance reservation against the ledger, overlap rejection, accrual/carry-forward/lapse jobs. Expense claims with category caps, attachment rules, the cut-off rule and skip-level escalation. Help-desk tickets with the transactional outbox to `helpdesk@widedroptech.com`, SLA clocks and the delivery-status mirror. The unified `approval_task` queue and `POST /manager/approvals/:id/decide`. File upload: magic-byte sniffing, ClamAV, signed 120 s downloads. | An employee can complete each flow end to end and a manager can decide it, with every transition guarded by a seeded `state_transition` row and audited in the same transaction. A mail-provider outage does not fail ticket creation. A manager cannot approve their own item; the skip-level rule is data-driven from `expense_limit`.                                                                                                                                                                |
| **M5** | **Attendance and the payroll pipeline**         | HR attendance capture and bulk upload, period submission with per-manager slices and `payload_sha256`. Manager approval/return and HR escalation. Accounts payroll cycles, input upload → parse → commit, the validation pass with `payroll_cycle_employee` snapshot and `input_manifest_sha256`, the deterministic calculation engine of `WORKFLOWS.md` §1.9, payslip generation with both digests, approve, publish, close, and `payroll_correction`. Reimbursement batches.                                                  | **D3 is demonstrable and enforced**: no payslip row is reachable by any endpoint, count, search hit, notification or export before its `payslip_publication` row exists — asserted by `payroll-visibility.test.ts` against every money-bearing endpoint. Three distinct Accounts users are structurally required to publish. `…/verify` recomputes both digests from persisted rows. Golden-vector tests pin the calculation to the paise.                                                              |
| **M6** | **Tax, benefits, documents, policy versioning** | Tax regime election, declaration and proof windows, `employee_tax_projection`, `tds_quarter`, Form 16 issuance. Benefit plan years, enrolment, dependants and nominees. Employee documents, letter templates and the `document_request` queue. Version-controlled policies: applicability resolution, assignment fan-out, acknowledgement with `PENDING → ACKNOWLEDGED`, due dates, overdue escalation, and the compliance view.                                                                                                | A policy version publishes, assigns to exactly the matching population, and every acknowledgement persists `(employee, policy_version, status, acknowledged_at, ip_hash, user_agent_hash)`. No "acknowledge on behalf" path exists — the route has no `employeeId` input at all. Tax quarters with no persisted TDS render `—`, never `₹0`.                                                                                                                                                             |
| **M7** | **Hardening and compliance**                    | Rate limiting on every route in the index, with the Redis/Postgres pair and the fail-closed rule. Full CSP with Trusted Types and the `/api/v1/csp-report` collector. Key rotation runbooks exercised: JWT `kid`, KEK, DEK, pepper, blind-index pepper. Audit checkpoints and the object-locked anchor. DPDP: record of processing, retention schedule, data-subject access and correction. Dependency and secret scanning, pinned action SHAs, OIDC deploys. Accessibility and performance passes.                             | Every item in `SECURITY.md` Appendix A passes. One release ships `Content-Security-Policy-Report-Only` with a real report proving the collector and the `Reporting-Endpoints` header work, before the enforcing header. An external penetration test finds no High or Critical. A full key rotation completes with zero decryption failures.                                                                                                                                                            |
| **M8** | **Production cutover and operations**           | Both Netlify sites, Render services, managed Postgres with PITR, R2 buckets, SES with DKIM/SPF/DMARC and the SNS webhook. CI/CD with `deploy.yml` on `workflow_run` success. Boot-time env validation and the privilege and schema-guard assertions. Backups with the weekly off-provider encrypted dump under `ess_backup`, and a **rehearsed** restore. Runbooks, alerting, on-call, the DNS inventory. Real organisation data loaded through the product's own audited paths.                                                | A restore drill meets the stated RPO/RTO from a real backup, and the drill is signed off. A smoke test after deploy proves CORS rejects a foreign origin and that an authenticated read returns an **empty** collection. `widedrop.com` is demonstrably unchanged: no config edit, no build-minute consumed, no shared token, no DNS record touched in its zone. The first real payroll cycle publishes with three distinct Accounts users and every amount traceable to its input file and row number. |
