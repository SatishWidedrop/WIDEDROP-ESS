# Widedrop ESS — Security Architecture, RBAC/ABAC Model and Privacy Controls

**Status:** Normative specification. An implementer MUST NOT deviate without an ADR in `docs/adr/`.
**Scope:** `apps/api` (Fastify 5 / Node 22 / Prisma / PostgreSQL 16), `apps/web` (React 18 / Vite SPA),
`packages/shared`, `infra/`. Companion documents: **`docs/ARCHITECTURE.md` (the index and the
tie-breaker)**, `docs/DATA-MODEL.md`, `docs/API.md`, `docs/WORKFLOWS.md`, `docs/FRONTEND.md`,
`docs/DEPLOYMENT.md`, `design/DESIGN-SYSTEM.md`.

**Host layout assumed throughout (see `docs/DEPLOYMENT.md`):**

| Host                   | Serves                                       | Platform                       |
| ---------------------- | -------------------------------------------- | ------------------------------ |
| `widedrop.com`         | existing public marketing site               | Netlify free tier (untouched)  |
| `ess.widedrop.com`     | ESS SPA — static assets only, no server code | Netlify (separate site)        |
| `api-ess.widedrop.com` | ESS API — the only trusted compute           | container host (Render/Fly)    |
| `db` (private network) | PostgreSQL 16                                | managed, not publicly routable |
| `files.<provider>`     | S3-compatible object storage, private bucket | signed URLs only               |

`ess.widedrop.com` and `api-ess.widedrop.com` are **cross-origin but same-site** (registrable domain
`widedrop.com`). Every cookie and CSRF decision below is justified against that fact.

> ### Canonical reference
>
> **`docs/ARCHITECTURE.md` is the system index and the single source of truth for every
> entity name, enum value, permission string, state name and workflow-stage name.** Where
> this document and any sibling disagree on a _name_, `ARCHITECTURE.md` §4 (Canonical
> glossary) wins and the divergent spelling is a defect to be corrected here. Where they
> disagree on a _control_, the stricter of the two wins and `ARCHITECTURE.md` §4 records
> which that is. No document may introduce a name, enum value or permission code that
> `ARCHITECTURE.md` §4 does not carry.

---

## 0. Cross-document reconciliation (normative)

This document was written before `docs/DATA-MODEL.md`, `docs/API.md` and `docs/WORKFLOWS.md` were
finalised, and drifted from them. The following resolutions are **binding**; where any older sentence
in this file still uses a superseded name, the name in this table wins and the sentence is read with
the substitution applied. Nothing here weakens a control — every resolution keeps the stronger of the
two positions.

| #   | Conflict                                                                                                                                                                                                                                                                      | Resolution (binding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Permission grammar: this doc used `verb:resource[:qualifier]`; `API.md` and `WORKFLOWS.md` use `resource:action[:scope]`                                                                                                                                                      | **`resource:action[:scope]` wins** (§4.3 rewritten). §4.4 is re-keyed to the canonical strings. A permission that appears in only one document is still real; the union is the vocabulary, and `packages/shared/src/permissions.ts` is generated from §4.4 so the compiler is the arbiter                                                                                                                                                                                                                                                                                                                                                                                |
| R2  | Payroll entity: this doc said `payroll_run.status IN ('PUBLISHED','LOCKED')`; `DATA-MODEL.md` defines `ess_payroll_run_status = QUEUED/RUNNING/SUCCEEDED/FAILED/SUPERSEDED` and puts the lifecycle on **`payroll_cycle`**                                                     | **`payroll_cycle` carries the D3 lifecycle**; `payroll_run` is one calculation attempt. Every guard in this document that named `payroll_run.status` means `payroll_cycle.status`. The old predicate was an **impossible query** and is corrected in §4.4 and §4.12                                                                                                                                                                                                                                                                                                                                                                                                      |
| R3  | Payslip status: this doc said payslips are created in `DRAFT`; `DATA-MODEL.md` defines `ess_payslip_status = GENERATED/PUBLISHED/SUPERSEDED/REVOKED`                                                                                                                          | **`GENERATED`** is the pre-publication state. "Invisible until published" is unchanged; only the label changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| R4  | Audit chain: `DATA-MODEL.md` computes `row_hash` with **plain `sha256()` inside a `BEFORE INSERT` trigger**; this document requires a **keyed HMAC**                                                                                                                          | **Keyed HMAC in the application wins** (§8.3). A database trigger cannot do it, because the key must never be inside Postgres (A10) — a bare SHA-256 chain is forgeable by exactly the insider (T-HR/T-ACC/T-PLAT) the chain exists to catch. The DB trigger is retained **only** to enforce append-only and to reject a row whose `row_hash` is NULL                                                                                                                                                                                                                                                                                                                    |
| R5  | `audit_event.ip_address inet` / `user_agent text` in `DATA-MODEL.md` vs `ip_hash` / `user_agent_hash` here                                                                                                                                                                    | **Hashed columns win** (§14.3). The audit trail must not become a location-tracking database; the raw values are never persisted anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R6  | `audit_event.on_behalf_of_user_id` ("impersonation support") in `DATA-MODEL.md` vs §4.1 "no impersonation capability anywhere"                                                                                                                                                | **No impersonation.** The column MUST NOT exist; if it exists for migration reasons it carries `CHECK (on_behalf_of_user_id IS NULL)` and no code path may set it. An impersonation feature would silently defeat every `§`, `‡` and step-up rule in §4                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R7  | Compensation columns: §7.1 previously listed `payslip.*`, `payslip_line.*`, `salary_structure.*` as _deliberately not_ application-encrypted; `DATA-MODEL.md` class **M1** envelope-encrypts all of them                                                                      | **M1 wins — they ARE envelope-encrypted** (§7.1 corrected, ADR 0004 is superseded by `docs/adr/0009-payroll-columns-encrypted.md`). The aggregate-performance objection is answered by the persisted `payslip_fy_rollup` / `tds_quarter` rows (one row per employee per FY / quarter), which are themselves encrypted and decrypted in-app — one AES-GCM operation per tile, not a table scan                                                                                                                                                                                                                                                                            |
| R8  | Envelope column naming                                                                                                                                                                                                                                                        | `DATA-MODEL.md` wins: `<field>_ct`, `<field>_iv`, `<field>_tag`, `<field>_dek_id` (uuid FK → `data_encryption_key`), `<field>_mask`. Read `…_ciphertext` in this document as `…_ct` + its sibling columns. The key table is **`data_encryption_key`**, not `data_key`                                                                                                                                                                                                                                                                                                                                                                                                    |
| R9  | Blind indexes                                                                                                                                                                                                                                                                 | **Superseded — `DATA-MODEL.md` §1.6 now has them, and its naming is canonical.** The suffix is **`_fpr`** (not `_bidx`), the value is the **full 32-byte** `HMAC-SHA256(pepper_v<n>, normalise(plaintext))` (not truncated to 16), and every `_fpr` column carries a mandatory sibling `_fpr_pepper_version smallint` so a pepper rotation cannot silently void a uniqueness constraint. The columns are `employee_statutory_id.value_fpr` (row-per-kind, so one column covers PAN and Aadhaar), `employee_bank_account.account_number_fpr`, `employee_personal_detail.personal_email_fpr` and `…personal_mobile_fpr`. §7.2 below is read with that substitution applied |
| R10 | Table names                                                                                                                                                                                                                                                                   | `file_object` (not `file`), `email_outbox` (not `notification_outbox`), `helpdesk_ticket` (not `ticket`), `employee_reporting_closure` (not `reporting_closure`), `app_user` (not `user`), `session` as defined in `DATA-MODEL.md` §6.0                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R11 | Rate-limit store: §9.3 said Postgres-primary; `DATA-MODEL.md` says Redis token buckets with `ess_ops.rate_limit_counter` as durable fallback                                                                                                                                  | **Redis primary, Postgres fallback** (§9.3 corrected). The fail-closed-on-auth-routes rule is unchanged and now applies when _both_ stores are unavailable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R12 | Rate-limit bucket keys: `DATA-MODEL.md` shows raw `user:<id>` / `ip:<cidr>`                                                                                                                                                                                                   | **Hashed keys win** (§9.2): every bucket key is `sha256(scope ‖ ':' ‖ route ‖ ':' ‖ HMAC(LOG_HASH_KEY, value))`. A limiter table is not a place to accumulate raw identifiers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| R13 | `audit_event.sequence_no` is monotonic **per organization**                                                                                                                                                                                                                   | Accepted. The chain in §8.3 is **per-organisation**; `prev_hash` links the previous row _of the same `organization_id`_, and verification runs per organisation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R15 | `data_key` (§7.2, purposes `PII`/`STATUTORY`/`BANK`/`MFA`/`TICKET`) vs `DATA-MODEL.md` §17.3 `data_encryption_key` (`FIELD_DEFAULT`/`PAYROLL`/`MFA`) — `DEPLOYMENT.md` tracked this as R-18                                                                                   | **`data_encryption_key` wins**, with purposes `FIELD_DEFAULT`, `PAYROLL`, `MFA` and status `PENDING`/`ACTIVE`/`RETIRED`/`COMPROMISED` (`RETIRING` is withdrawn; `COMPROMISED` has the defined behaviour of `DATA-MODEL.md` §17.3). Read `data_encryption_key` in §7.2–§7.3 and in `DEPLOYMENT.md` §11.3 as `data_encryption_key`. Two purpose lists under two table names is exactly how a rotation misses a column                                                                                                                                                                                                                                                      |
| R16 | Step-up freshness and where it is recorded: this doc §2.7 said `session.mfa_verified_at` ≤ 5 min; `API.md` §4.3 said `refresh_token.mfa_satisfied_at`; `WORKFLOWS.md` §0.9 said `session.step_up_at` valid for `org_setting.step_up_max_age_minutes` = 15                     | **`session.mfa_verified_at`, 300 seconds**, read from `org_setting.step_up_max_age_seconds` (seeded `300`, hard maximum `900`). A refresh _family_ is a cookie lineage and cannot carry a step-up; 15 minutes is a 3× widening of the window in which a stolen live session can move an organisation's payroll, and the looser value loses                                                                                                                                                                                                                                                                                                                               |
| R17 | `user_role.expires_at` / `scope_org_unit_id` / `org_unit` / `reporting_closure` / `employee.manager_id` / `leave_ledger` / `expense_policy_limit` / `payroll_validation_issue` / `activation_token` / `payslip.input_digest` / `document.class` / `benefit_plan.window_start` | `DATA-MODEL.md` names win: `user_role.valid_to`, `user_role.scope_department_id`, `department`, `employee_reporting_closure(ancestor_employee_id, descendant_employee_id, depth)`, `employee_manager` (history) + the closure, `leave_balance_ledger`, `expense_limit.escalation_amount_minor`, `payroll_validation_result`, `user_invitation`, `payslip.input_sha256` (+ `payslip.amount_sha256`), `document_type.category`, `benefit_plan_year.enrolment_window_opens_on`/`_closes_on`                                                                                                                                                                                 |
| R18 | Attendance state names: §4.4 wrote `ATTENDANCE_DRAFT → ATTENDANCE_SUBMITTED`                                                                                                                                                                                                  | `ess_attendance_period_status` = `OPEN`, `HR_SUBMITTED`, `MANAGER_APPROVAL_PENDING`, `APPROVED`, `LOCKED`, `REOPENED`. HR's submit is `OPEN → HR_SUBMITTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R19 | Unprefixed operational paths (`/csp-report`, `/healthz`, `/readyz`, `/metrics`)                                                                                                                                                                                               | **All are served under `/api/v1`** (`DEPLOYMENT.md` R-14, `API.md` §1.1): `/api/v1/csp-report`, `/api/v1/healthz`, `/api/v1/readyz`, `/api/v1/metrics`. `GET /.well-known/jwks.json` is the single deliberate exception and stays unprefixed at the origin root, because RFC 8615 fixes it there                                                                                                                                                                                                                                                                                                                                                                         |
| R20 | `INTERNAL_PORT` (§10.2) vs `PRIVATE_PORT` (`DEPLOYMENT.md` §7.2)                                                                                                                                                                                                              | **`PRIVATE_PORT`.** `DEPLOYMENT.md` §7.2 is the canonical environment-variable table; §10.2 here is the canonical _validation rule_ for each variable. Where a variable appears in both, the name comes from `DEPLOYMENT.md` and the constraint from here                                                                                                                                                                                                                                                                                                                                                                                                                |
| R21 | `mfa_credential.secret_ciphertext`                                                                                                                                                                                                                                            | `DATA-MODEL.md` §1.6 five-column envelope: `totp_secret_ct`, `_iv`, `_tag`, `_dek_id`, `_mask` on `mfa_credential`, DEK `purpose = 'MFA'`, AAD per §1.6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R14 | `audit_event.actor_email_snapshot citext`                                                                                                                                                                                                                                     | Accepted and justified: it freezes _who acted_ against a later email change. It is a **work** address (ORG-visible by design, §4.4 `directory:read`) and is therefore not a §8.5 redaction violation. Personal addresses are never written to `audit_event`                                                                                                                                                                                                                                                                                                                                                                                                              |

Where this document and `docs/DATA-MODEL.md` disagree on a **control** (R4, R5, R6, R7, R9, R12),
this document is normative and `DATA-MODEL.md` is to be corrected. Where they disagree on a **name**
(R1, R2, R3, R8, R10, R13), `DATA-MODEL.md` is normative and this document has been corrected above.

---

**Prime directives inherited from the product brief (restated so they are testable here):**

- D1 — Every displayed value comes from persisted data or a deterministic computation over it. Security
  consequence: authorization is applied to the _query_, not to the rendered output, so an unscoped read
  cannot leak through an aggregate, a badge count, a search result or a notification.
- D2 — Exactly four personas: Employee, Manager, HR, Accounts. A user may hold several.
- D3 — Payslips do not exist or become visible until the payroll workflow completes.
- D4 — Complete auditability for HR, payroll, approval, policy and administrative actions.
- D5 — Empty states are first-class; a denied or out-of-scope read renders the designed empty state,
  never a fabricated value and never a stack trace.

---

## 1. Threat model

### 1.1 Assets, by sensitivity

| #   | Asset                                                                                                                     | Where it lives                                                       | Classification                                   | Impact if breached                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| A1  | Payroll amounts (`payslip`, `payslip_line`, `salary_structure`, `payroll_input_item`, `payslip_fy_rollup`, `tds_quarter`) | Postgres, **app-layer encrypted** (§7.1, R7)                         | **Restricted**                                   | Financial disclosure, industrial-relations damage, insider trading on comp data          |
| A2  | Statutory identifiers (PAN, Aadhaar, UAN, PF account, ESI)                                                                | Postgres, app-layer encrypted                                        | **Restricted / DPDP sensitive**                  | Identity theft, statutory fraud; Aadhaar misuse is a criminal exposure                   |
| A3  | Bank account number + IFSC (`employee_bank_account`)                                                                      | Postgres, app-layer encrypted                                        | **Restricted**                                   | Direct financial fraud — salary redirection is the single highest-value attack on an ESS |
| A4  | Personal PII (DOB, personal email/phone, home addresses, blood group, marital status, gender)                             | Postgres, app-layer encrypted for the named columns                  | **Confidential / DPDP personal data**            | Doxxing, social engineering, DPDP contravention                                          |
| A5  | Dependants & emergency contacts (minor's data)                                                                            | Postgres, encrypted                                                  | **Confidential / children's data under DPDP §9** | Statutory breach; children's data has stricter handling                                  |
| A6  | Health/benefit enrolment (GMC, dependants covered, NPS PRAN)                                                              | Postgres                                                             | **Confidential**                                 | Health inference, discrimination risk                                                    |
| A7  | Policy acknowledgements (`policy_acknowledgement`)                                                                        | Postgres                                                             | **Confidential, integrity-critical**             | POSH/ISP compliance evidence; forging or deleting one defeats a legal defence            |
| A8  | Audit trail (`audit_event`, `audit_checkpoint`)                                                                           | Postgres, append-only, hash-chained                                  | **Integrity-critical**                           | Loss of non-repudiation; an attacker who can edit it erases everything else              |
| A9  | Authentication material (Argon2id hashes, TOTP secrets, recovery-code hashes, refresh-token hashes)                       | Postgres, encrypted/ hashed                                          | **Restricted**                                   | Full account takeover                                                                    |
| A10 | Signing & encryption keys (JWT Ed25519 private keys, KEK, pepper, blind-index key, audit chain key)                       | Platform secret store / KMS — **never** Postgres, **never** the repo | **Critical**                                     | Total compromise: forge tokens, decrypt A2–A5, rewrite A8                                |
| A11 | Documents & letters (offer, appraisal, Form 16, salary certificates, expense bills)                                       | Private object storage                                               | **Confidential**                                 | Payroll + PII disclosure in one file                                                     |
| A12 | Help-desk ticket bodies (often contain PAN corrections, bank details, medical context)                                    | Postgres                                                             | **Confidential**                                 | Free-text PII channel — treat as A4                                                      |
| A13 | Availability of payroll publication on the pay date                                                                       | Whole system                                                         | **High**                                         | Statutory wage-payment deadlines                                                         |

### 1.2 Actors

**Authorized:** Employee, Manager, HR, Accounts (D2); the API service identity; the payroll generation
worker; platform operators (Render/Fly, Netlify, managed Postgres); CI/CD (GitHub Actions).

**Adversaries:**

| ID           | Adversary                                                                                                                             | Capability                                               | Primary goal                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| T-EXT        | Unauthenticated internet attacker                                                                                                     | Can reach `ess.widedrop.com`, `api-ess.widedrop.com`     | Credential stuffing, enumeration, RCE                                     |
| T-PHISH      | Phisher                                                                                                                               | Can send mail as a lookalike, can host a fake login page | Harvest credentials + OTP, then redirect salary (A3)                      |
| T-EMP        | Curious/malicious authenticated Employee                                                                                              | Valid session, browser devtools, can edit client JS      | Read peers' payslips, manager approvals, HR data                          |
| T-MGR        | Malicious Manager                                                                                                                     | Valid privileged session                                 | Read outside own reporting chain; approve own leave/expense/attendance    |
| T-HR / T-ACC | Malicious privileged insider                                                                                                          | Broad legitimate access                                  | Mass export, silent salary edit, grant self a role, erase the audit trail |
| T-SUB        | Attacker controlling **any other `*.widedrop.com` host** (incl. the Netlify marketing site, a stale DNS record, a subdomain takeover) | Same-site with the ESS                                   | Cookie injection, same-site CSRF, token theft                             |
| T-SUPPLY     | Compromised npm dependency / CI token                                                                                                 | Code execution in build or runtime                       | Exfiltrate A10, backdoor auth                                             |
| T-PLAT       | Platform / DB operator                                                                                                                | Raw disk, raw DB                                         | Read A1–A5 at rest                                                        |

T-SUB is elevated for this system specifically because the existing `widedrop.com` Netlify site is
outside the ESS security boundary yet shares the registrable domain.

### 1.3 Trust boundaries

```
 [B1] browser  ──HTTPS──▶  Netlify edge (ess.widedrop.com)   : static assets only, zero secrets
 [B2] browser  ──HTTPS──▶  api-ess.widedrop.com (Fastify)    : THE authorization boundary
 [B3] Fastify  ──TLS────▶  PostgreSQL 16 (private network)   : least-privilege DB roles
 [B4] Fastify  ──HTTPS──▶  S3-compatible object storage      : private bucket, signed URLs
 [B5] Fastify  ──HTTPS──▶  email provider (helpdesk@, notices)
 [B6] Fastify  ──HTTPS──▶  api.pwnedpasswords.com            : k-anonymity, no secret leaves
 [B7] GitHub Actions ────▶ Netlify + container host + DB migrations
 [B8] operator ──────────▶ platform consoles / psql
 [B9] in-process: HTTP handler ──▶ authz layer ──▶ Prisma     : the deny-by-default gate
```

**Rule B2-1 (the load-bearing rule of this document):** the browser, the Netlify edge and everything
in `apps/web` are **untrusted**. Role gating in the SPA (hiding the `Approvals` nav item, the
`isManager` flag the prototype uses) is **cosmetic**. Every request is authorized server-side against
the persisted role grants and the persisted resource, never against a client-supplied role, id list,
header or JWT claim that was not cryptographically issued by this API.

### 1.4 STRIDE per boundary, with the mitigating control

#### B1 — browser ↔ Netlify edge (static SPA)

| STRIDE | Threat                                                              | Control                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | Phishing clone at `ess-widedrop.com` (T-PHISH)                      | WebAuthn-ready TOTP-now MFA (§2.6); mail from `no-reply@widedrop.com` with DMARC `p=reject`; login page never framed (`frame-ancestors 'none'`); user education banner sourced from `announcement`              |
| T      | Malicious JS injected via a compromised build or third-party script | No third-party scripts at all; CSP `script-src 'self'` with **no** `unsafe-inline`/`unsafe-eval` (§6.3); Subresource Integrity is unnecessary because nothing is cross-origin; immutable hashed asset filenames |
| R      | —                                                                   | —                                                                                                                                                                                                               |
| I      | Tokens stolen from `localStorage` by XSS                            | Access token held **in a JS closure in memory only**; refresh token in an `HttpOnly` cookie the SPA cannot read (§3)                                                                                            |
| D      | Netlify outage                                                      | SPA is static and cached; API and data are on a different provider, so an ESS outage never takes down `widedrop.com` and vice versa                                                                             |
| E      | Subdomain takeover of a stale `*.widedrop.com` record (T-SUB)       | `__Host-` cookie prefix (blocks cookie injection from a sibling host), CSRF token bound to the session (§3.5), strict CORS allowlist, quarterly DNS record review recorded in `infra/dns-inventory.md`          |

#### B2 — browser ↔ API _(the authorization boundary)_

| STRIDE | Threat                                                                   | Control                                                                                                                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S      | Credential stuffing / password spraying (T-EXT)                          | Argon2id + pepper (§2.1), breach check (§2.3), per-account progressive lockout + per-IP + global spray detection (§2.5, §9)                                                                                                                                                                                           |
| S      | Token forgery                                                            | Ed25519-signed access JWT with `kid`; `alg` allowlist of exactly `["EdDSA"]`; `iss`/`aud` verified; no JWK embedded in the token                                                                                                                                                                                      |
| S      | Session fixation / replay after logout                                   | Server-side `session` row consulted on every request (`sid` claim), refresh rotation + family reuse detection (§3.2)                                                                                                                                                                                                  |
| T      | Parameter tampering: `POST /leave-requests {employeeId: <someone else>}` | `employeeId` is **never** accepted from the body for self-scoped writes; it is derived from the token's `sub` (§4.6)                                                                                                                                                                                                  |
| T      | CSRF on the cookie-authenticated refresh/logout routes                   | Signed double-submit token + `Origin`/`Sec-Fetch-Site` enforcement (§3.5)                                                                                                                                                                                                                                             |
| R      | "I never approved that expense / never acknowledged that policy"         | Hash-chained audit written in the same transaction as the state change (§8)                                                                                                                                                                                                                                           |
| I      | IDOR: `GET /payslips/9f3…` belonging to another employee (T-EMP)         | Scope compiled into the Prisma `WHERE`, never a post-fetch check; out-of-scope ⇒ **404** (§4.6)                                                                                                                                                                                                                       |
| I      | Enumeration of employees / emails via login, reset, search               | Uniform generic responses + constant-ish timing (§2.4), directory search returns only the ORG-safe DTO (§4.4)                                                                                                                                                                                                         |
| D      | Expensive queries, upload floods, export abuse                           | Per-route rate limits (§9), pagination caps, upload size caps, exports queued and serialised per actor                                                                                                                                                                                                                |
| E      | Client sets `X-Roles: HR` or edits the JWT payload                       | Signature verified; a `ver` mismatch is a hard `401 TOKEN_STALE` (§2.9) — it is never "repaired" mid-request; the `roles` claim is **never** consulted for an authorization decision, which is always resolved from `user_role` (§4.7); **no** header, query param or body field ever influences authorization (B2-1) |

#### B3 — API ↔ PostgreSQL

| STRIDE | Threat                                                              | Control                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T      | SQL injection                                                       | Prisma parameterised queries; `$queryRawUnsafe` banned by ESLint; raw SQL only via tagged `$queryRaw` with typed params (§5.4)                                                              |
| R      | Privileged insider edits a payslip row directly (T-HR/T-ACC/T-PLAT) | App DB role has no `UPDATE`/`DELETE` on `audit_event`; audit chain verification job detects gaps; payslips are immutable after publication (amendments are new rows)                        |
| I      | Disk/backup theft (T-PLAT)                                          | Provider-managed encryption at rest **plus** application-layer AES-256-GCM envelope encryption on A2–A5 columns, keys outside the DB (§7)                                                   |
| D      | Connection exhaustion                                               | Prisma pool caps, statement timeout `15s`, `idle_in_transaction_session_timeout 30s`                                                                                                        |
| E      | App role creating roles / altering schema at runtime                | Runtime role `ess_app` has only `SELECT/INSERT/UPDATE/DELETE` on the application schema and `SELECT/INSERT` on `audit_event`; migrations run as a separate `ess_migrator` role from CI only |

#### B4 — API ↔ object storage

| STRIDE | Threat                                                    | Control                                                                                                                          |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| S/E    | Guessable object keys                                     | Keys are server-generated UUIDv7 paths with no user input (§5.3)                                                                 |
| T      | Malicious upload (polyglot, PDF with JS, SVG with script) | Magic-byte sniffing, extension+MIME agreement, image re-encode, SVG rejected outright, PDF active-content rejection (§5.3)       |
| I      | Public bucket / leaked long-lived URL                     | Bucket private, no public ACL, block-public-access on; URLs signed for 120 s, single resource, `Content-Disposition: attachment` |
| D      | Storage fills                                             | Per-actor and per-entity upload caps and quotas (§9)                                                                             |

#### B5/B6 — API ↔ email & HIBP

| STRIDE | Threat                                                | Control                                                                                                                                                   |
| ------ | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I      | Password or hash leaving the process                  | HIBP receives only the **first 5 hex chars** of the SHA-1 (§2.3)                                                                                          |
| T      | SSRF pivot via an outbound call                       | `safeFetch()` host allowlist + private-IP rejection + no redirects (§5.5); no user-supplied URL is ever fetched                                           |
| S      | Email header/content injection into the helpdesk mail | Provider API (JSON) not raw SMTP concatenation; CR/LF stripped from every header-bound field; body fields are text-only, length-capped                    |
| D      | Mail provider outage blocks ticket creation           | Ticket is persisted first, mail is an outbox row (`email_outbox`) delivered by a worker with retries — a mail failure never fails the user's write (§8.6) |

#### B7/B8 — CI/CD and operators

| STRIDE | Threat                                      | Control                                                                                                                                                                         |
| ------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T/E    | Malicious dependency or workflow (T-SUPPLY) | Lockfile + `npm ci`, `--ignore-scripts` in CI, pinned action SHAs, OIDC deploy (no long-lived cloud keys), branch protection with required review, SAST + secret scanning (§12) |
| R      | Unattributed production change              | All deploys from `main` via CI; console access requires SSO+MFA; break-glass DB access is a documented, time-boxed, logged procedure (§8.7)                                     |
| I      | Secrets in logs/artifacts                   | Redaction allowlist (§11), secret scanning with push protection (§12)                                                                                                           |

---

## 2. Authentication

### 2.1 Password hashing — Argon2id with a server-side pepper

Implementation: `apps/api/src/auth/password.ts` using `argon2` (node bindings to libargon2).

```
Algorithm : argon2id
memoryCost: 65536        // 64 MiB
timeCost  : 3            // iterations
parallelism: 1
hashLength: 32 bytes
salt      : 16 bytes, CSPRNG per password (library-generated, stored in the encoded hash)
encoding  : PHC string, stored in user.password_hash (text)
```

Target ≈ 90–130 ms on the production container. `apps/api/src/auth/password.bench.ts` asserts the
measured cost is within `[60ms, 400ms]` at boot in production and logs a warning otherwise, so a
host downgrade cannot silently weaken hashing.

**Pepper.** A 32-byte secret (`PASSWORD_PEPPER_V1`) held only in the platform secret store. The
password is pre-hashed before Argon2id so that a database-only compromise (A9) is not crackable:

```
prehash = base64url( HMAC-SHA512( key = PEPPER[v], msg = NFKC(password) ) )
hash    = argon2id( prehash )
```

`user.pepper_version smallint not null` records which pepper produced the hash. Pepper rotation adds
`PASSWORD_PEPPER_V2`; verification tries the version recorded on the row, and on a successful login
with an old version the hash is transparently recomputed with the current pepper inside the login
transaction. Pre-hashing also neutralises Argon2 input-length concerns and the libargon2 password
length limit.

**Rehash-on-login.** If `argon2.needsRehash(hash, currentParams)` or `pepper_version < current`, the
password is rehashed and stored inside the same transaction as the successful-login audit write.

### 2.2 Password policy (no composition rules)

Enforced in `packages/shared/src/password-policy.ts` (shared so the SPA can give live feedback) **and**
re-enforced server-side — the client check is advisory only.

| Rule              | Value                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Minimum length    | 12 characters for `EMPLOYEE`-only users; **14** if the user holds `MANAGER`, `HR` or `ACCOUNTS`                                                                                                        |
| Maximum length    | 256 characters (DoS cap; enforced before hashing)                                                                                                                                                      |
| Composition rules | **None.** No upper/lower/digit/symbol requirement, no forced rotation                                                                                                                                  |
| Normalisation     | Unicode NFKC before any check or hash; all codepoints allowed including spaces and emoji                                                                                                               |
| Breach check      | Rejected if found in HIBP (§2.3)                                                                                                                                                                       |
| Local blocklist   | Rejected if in `packages/shared/data/common-passwords-10k.txt` (case-folded)                                                                                                                           |
| Context check     | Rejected if it contains, case-insensitively and after stripping non-alphanumerics, any of: work email local-part, personal email local-part, first name, last name, `employee_code`, `widedrop`, `ess` |
| Strength          | `zxcvbn-ts` score ≥ 3 with the above as user inputs                                                                                                                                                    |
| Reuse             | Rejected if it matches any of the last 5 hashes in `password_history` (verified with Argon2id against each stored hash, capped at 5 verifications)                                                     |
| Expiry            | None. Rotation is event-driven only (breach signal, compromise, offboarding)                                                                                                                           |

`password_history(user_id, password_hash, pepper_version, created_at)` — rows older than the 5 most
recent per user are deleted in the same transaction.

### 2.3 Breach check — HIBP k-anonymity with graceful offline fallback

`apps/api/src/auth/hibp.ts`

1. `sha1 = SHA1(NFKC(password)).toUpperCase()`; `prefix = sha1[0..5]`; `suffix = sha1[5..]`.
2. `GET https://api.pwnedpasswords.com/range/{prefix}` with `Add-Padding: true`,
   `User-Agent: widedrop-ess/1.0`, timeout **2000 ms**, one retry with 250 ms jitter, via `safeFetch()`
   (§5.5) pinned to that exact host. **The password, its full hash and the user identity never leave
   the process.**
3. Response parsed to a `Set` of suffixes; positive match ⇒ reject with
   `{"code":"PASSWORD_BREACHED"}` (422) and the UI copy "This password has appeared in a public data
   breach. Choose a different one."
4. Results cached in-process (LRU, 4096 prefixes, TTL 10 min) keyed by prefix only.
5. **Circuit breaker:** 5 consecutive failures opens the breaker for 60 s.

**Offline fallback (breaker open, timeout, non-200, or `HIBP_ENABLED=false`):**

- Fall back to the bundled 10k local blocklist plus the zxcvbn score gate — never fail open silently
  and never block the user.
- Emit `audit_event(action='AUTH.BREACH_CHECK_DEGRADED', severity='WARN')` at most once per minute
  (deduplicated) and increment the `hibp_degraded_total` metric, which alerts after 15 minutes (§11.4).
- Set `app_user.breach_check_pending = true` on any credential **written** while degraded.
  There is **no** nightly re-check job, and there must not be one: the HIBP protocol needs the
  password's SHA-1 prefix, which is by construction unrecoverable from an Argon2id hash, and storing
  anything from which it _could_ be recovered would be a deliberate weakening of A9. The flag is
  instead consumed **at the next successful password verification**, which is the only moment the
  plaintext legitimately exists in memory:

  1. Password verified, MFA not yet challenged.
  2. If `breach_check_pending` and the breaker is closed, run the §2.3 check on that plaintext.
  3. Not breached ⇒ clear the flag inside the login transaction, continue normally.
  4. Breached ⇒ clear the flag, complete MFA, then issue a **change-password-only session**: an
     access token with `amr` unchanged and a single-purpose claim `pwd_reset_required: true`. The
     authorize plugin denies every route except `POST /auth/password/change`, `POST /auth/logout` and
     `GET /me/minimal`, regardless of the permission matrix. Audited as
     `AUTH.PASSWORD_CHANGE_FORCED` with `reason='BREACHED_AT_LOGIN'`.
  5. If the breaker is still open at step 2, the flag is left set and login proceeds normally — the
     user is never blocked by an unavailable third party.

  `app_user.breach_check_pending boolean NOT NULL DEFAULT false` is required in `DATA-MODEL.md`.

### 2.4 Generic responses and enumeration resistance

| Endpoint                            | Always returns                                                                                                     | Notes                                                                                                                                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/login`                  | `401 {"code":"INVALID_CREDENTIALS"}` for unknown user, wrong password, unverified, suspended or offboarded account | Locked accounts are the single exception: `423 {"code":"ACCOUNT_LOCKED","retryAfterSeconds":n}` only **after** the password was verified correct, so lock state is never an oracle for an attacker who does not already know the password |
| `POST /auth/password-reset/request` | `202 {"status":"accepted"}` always                                                                                 | Mail sent only if an active account exists                                                                                                                                                                                                |
| `POST /auth/password-reset/confirm` | `400 {"code":"INVALID_OR_EXPIRED_TOKEN"}` for wrong, used, expired or unknown token                                |                                                                                                                                                                                                                                           |
| `POST /auth/mfa/verify`             | `401 {"code":"INVALID_MFA_CODE"}`                                                                                  | Never distinguishes "no MFA enrolled"                                                                                                                                                                                                     |
| `POST /auth/activate`               | `400 {"code":"INVALID_OR_EXPIRED_TOKEN"}`                                                                          |                                                                                                                                                                                                                                           |

**Timing.** The login handler always performs one Argon2id verification: when the user does not exist
it verifies against a fixed dummy PHC hash generated at boot from a random password
(`DUMMY_ARGON2_HASH`). Three details make that actually constant-time rather than approximately so:
the dummy hash is generated with the **current** Argon2id parameters (so a parameter change cannot
make the not-found branch cheaper than the found branch); the supplied password goes through the same
NFKC normalisation and the same HMAC-SHA512 pepper pre-hash before the dummy verification (so the
pre-hash cost is present on both branches); and the dummy is regenerated whenever the parameters or
the active pepper version change. Every negative path then sleeps until a floor of 250 ms total
handler time (`await untilFloor(startedAt, 250)`), so response time does not distinguish the branches.

No endpoint anywhere returns "user not found", an email address that was not supplied by the caller,
or a count that reveals whether an identifier exists.

**The MFA challenge token (previously undefined — an implementer could not have built the login
flow).** `POST /auth/login` never returns a session. On a correct password for an account that can
authenticate it returns `200 {"mfa":"required","challenge":"<token>","expiresIn":300}`. The challenge
is the _only_ credential accepted by `POST /auth/mfa/verify`.

| Property   | Value                                                                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format     | Opaque, 32 CSPRNG bytes, base64url. **Not** a JWT — it must not be parseable or forgeable offline, and it must be revocable                                                                                                                               |
| Storage    | `mfa_challenge(id uuid pk, user_id, token_hash bytea UNIQUE, purpose, amr text[], created_at, expires_at, consumed_at, attempt_count int NOT NULL DEFAULT 0, ip_hash, user_agent_hash)`; `token_hash = SHA-256(token)`; plaintext never stored or logged  |
| TTL        | **5 minutes**, single-use (`consumed_at` set inside the verification transaction)                                                                                                                                                                         |
| Transport  | Response body → SPA memory. **Never** a cookie: it is not needed on a later navigation, and a cookie would make the half-authenticated state survive a tab close                                                                                          |
| Authority  | Proves "this password was verified at `created_at`" and **nothing else**. It grants access to exactly `POST /auth/mfa/verify`, `POST /auth/mfa/recovery/use` and `POST /auth/mfa/enrol*` (the `PENDING_MFA` path). Presenting it anywhere else is a `401` |
| Attempts   | `attempt_count` is incremented in its own committed transaction _before_ the TOTP comparison, so a crash cannot lose the count; at 5 the challenge is consumed and the user must re-enter the password. This is in addition to the §9.1 per-user limit    |
| Binding    | `ip_hash` and `user_agent_hash` are recorded at issue and **compared on verify**; a mismatch consumes the challenge and emits `AUTH.MFA_CHALLENGE_BINDING_MISMATCH` (severity `WARN`)                                                                     |
| Revocation | Consumed, expired and superseded challenges are deleted nightly; a new login for the same user consumes any live challenge (one live challenge per user)                                                                                                  |
| Audit      | `AUTH.MFA_CHALLENGED` at issue; `AUTH.MFA_SUCCEEDED` / `AUTH.MFA_FAILED` at verify                                                                                                                                                                        |

Only when `POST /auth/mfa/verify` succeeds are the `session` row, the access token and the refresh
cookie created — in one transaction, together with `AUTH.LOGIN_SUCCEEDED`. A correct password with no
MFA step **never** produces a session for any role.

**The same 250 ms floor** (above) applies to every terminal response of `/auth/login` and
`/auth/mfa/verify` that is a `401` or `423`, so the branch taken is not observable. `429` responses
are deliberately exempt: they are produced before any credential work and adding a delay there would
convert the limiter into an amplification lever.

### 2.5 Account lifecycle

`app_user.status` (`ess_user_status`, per `DATA-MODEL.md` §2 as extended):
`INVITED → PENDING_MFA → ACTIVE → {SUSPENDED | EX_EMPLOYEE} → OFFBOARDED`, plus the administrative
terminal `DISABLED`. `LOCKED` exists in the enum for compatibility but this system does **not** use it
as a status: a lock is a transient overlay held in `app_user.locked_until`, because a lock must not
destroy the state the account was in (an `INVITED` account that is being brute-forced must still be
`INVITED` when the lock expires).

| State         | Meaning                                                                                             | Can authenticate?                                             | Entered by                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `INVITED`     | HR created the user; invite token issued; no password yet                                           | No                                                            | `POST /admin/users` (`invite:user`)                                                                                       |
| `PENDING_MFA` | Password set, MFA enrolment not yet completed                                                       | Only to `/auth/mfa/enrol*`                                    | activation                                                                                                                |
| `ACTIVE`      | Normal                                                                                              | Yes                                                           | MFA enrolled (or employee grace period, §2.6)                                                                             |
| `SUSPENDED`   | Temporarily disabled (investigation, long leave)                                                    | No                                                            | `suspend:user`                                                                                                            |
| `EX_EMPLOYEE` | The post-exit retrieval window. Entered automatically at 23:59 IST on `employment.last_working_day` | **Yes**, password + TOTP, no grace, no "remember this device" | system job at LWD, or `employee:deactivate` early                                                                         |
| `OFFBOARDED`  | Terminal. Sessions revoked, login permanently refused                                               | No                                                            | automatically at `last_working_day + org_setting.ex_employee_window_days`, or `employee:deactivate` with `immediate=true` |
| `DISABLED`    | Administrative terminal for a non-employment reason (duplicate record, test account)                | No                                                            | `employee:deactivate`                                                                                                     |

**Invite / activation.** Invite token: 32 random bytes, base64url, stored **only** as
`SHA-256` in `user_invitation.token_hash`, `expires_at = now() + 7 days`, single-use, bound to
`user_id`. Delivered to the **work email on record**. Activation sets the password (§2.2), forces MFA
enrolment, then transitions to `ACTIVE`. Expired invites are re-issued by HR only, which invalidates
the previous token.

**Transitions are audited** (`ADMIN.USER_STATUS_CHANGED`) with old and new status, actor and reason,
and `SUSPENDED`/`OFFBOARDED` immediately revoke all sessions and refresh-token families and bump
`user.token_version`.

**Offboarding, precisely.** The previous text said `OFFBOARDED` refuses login _and_ that an
offboarded employee may retrieve Form 16 for 90 days. Those cannot both be true, and "an attribute on
`user_role`" was not a buildable construct. The corrected design uses the `EX_EMPLOYEE` **status**
above — still exactly four personas (D2), because it is a status, not a role:

1. At 23:59 IST on `employment.last_working_day` a job moves the user to `EX_EMPLOYEE`, revokes every
   `user_role` grant **except** the `EMPLOYEE` one, sets that grant's
   `user_role.valid_to = last_working_day + org_setting.ex_employee_window_days` (seeded to **90**),
   bumps `token_version`, and deletes every `session` and `refresh_token` row.
2. While `EX_EMPLOYEE`, the authorize plugin intersects the resolved permission set with a fixed,
   code-level **read-only allowlist** — no other permission is reachable even if a grant survives:

   ```
   EX_EMPLOYEE_ALLOWLIST = {
     'payslip:read:self', 'payslip:download:self',
     'tax:quarter:read:self', 'document:read:self', 'file:download:self',
     'profile:read:self',
     'policy:read', 'policy:ack:read:self',
     'ticket:create:self', 'ticket:read:self', 'ticket:comment:self',
     'notification:read:self', 'notification:mark_read:self',
   }
   ```

   Every write outside that set is `403 {"code":"ACCOUNT_READ_ONLY"}` and audited as `AUTHZ.DENIED`.
   `payslip:email:self` is deliberately absent: after exit the work mailbox is usually closed, and the
   destination is not client-supplied (§4.4), so the mail would go nowhere and could bounce a payslip
   notification into an unmonitored inbox.

3. At the end of the window the user moves to `OFFBOARDED`: the `EMPLOYEE` grant expires, login is
   refused, and the retention clocks in §14.5 start.
4. An immediate offboarding (misconduct, security event) skips step 1's window by setting
   `ex_employee_window_days = 0` for that user, which is an audited
   `ADMIN.USER_STATUS_CHANGED` with a mandatory reason.

The window length is read from `org_setting.ex_employee_window_days`, never hardcoded, so the number
shown on the Documents screen ("available until …") is persisted data (D1).

### 2.6 Login rate limiting and progressive lockout — exact thresholds

State in `login_attempt(id, user_id nullable, email_hash bytea, ip_hash bytea, outcome, occurred_at)`
(90-day retention) and counters in `rate_limit_counter` (§9.3). `email_hash`/`ip_hash` are
`HMAC-SHA256` under `LOG_HASH_KEY` so the table itself is not a PII store.

Per **account** (keyed on `user_id`, all IPs), counting consecutive failures since the last success:

| Consecutive failures | Action                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| 1 – 4                | Normal `401`                                                                                     |
| 5                    | `401` + `AUTH.LOGIN_THROTTLE_ENGAGED` audit                                                      |
| 6 – 8                | 30 s cooldown; attempts during it ⇒ `429` + `Retry-After`                                        |
| 9 – 10               | 5 min cooldown                                                                                   |
| 11 – 14              | 15 min lock (`user.locked_until`), email to the user's work address, `AUTH.ACCOUNT_LOCKED` audit |
| 15+                  | 60 min lock (hard ceiling), security alert (§11.4), MFA re-verification required on next success |

A successful password + MFA verification resets the counter to 0. Locks are **not** cleared by a
password reset alone — the reset clears the counter only after the new password is set, so lockout
cannot be used to bypass throttling.

Per **IP** (`ip_hash`): 20 failed logins / 15 min ⇒ `429` for 15 min; 60 / 60 min ⇒ 60 min block and a
`SECURITY.IP_BLOCKED` audit event.

**Spray detection (cross-account):** ≥ 25 distinct `user_id` values failing from one `ip_hash` within
10 min, or ≥ 100 failures org-wide in 5 min ⇒ alert, and every subsequent login from that IP requires
MFA even when the password is correct and the device is remembered.

`Retry-After` is always sent on `429` and `423` (§9.4).

**Email normalisation.** Every lookup and every rate-limit key uses
`normalizeEmail(x) = NFKC(trim(x)).toLowerCase()`. `app_user.work_email` is `citext` with a unique
index, so `Priya.R@widedrop.com` and `priya.r@widedrop.com` are one account and one bucket. Without
this, case variation would silently multiply an attacker's per-account budget.

**Unlocking (previously missing — locks could be created but never administratively cleared).**
A lock clears by itself when `locked_until` passes. `security:account:unlock` (HR, ORG, step-up `†`,
self-dealing `§`) clears `locked_until` and the consecutive-failure counter early; it writes
`ADMIN.USER_UNLOCKED` with a mandatory reason and emails the account holder. It does **not** clear the
`login_attempt` history, and it does **not** reset the per-IP or spray counters — those protect other
accounts and an HR user must not be able to switch them off for an attacker's source address.

### 2.7 TOTP MFA

`apps/api/src/auth/totp.ts` — RFC 6238.

| Parameter               | Value                                                                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Algorithm               | `SHA-1` (authenticator-app interoperability; the secret's 160-bit entropy carries the security, not the PRF)                                                                                        |
| Digits                  | 6                                                                                                                                                                                                   |
| Period                  | 30 s                                                                                                                                                                                                |
| Accepted window         | ±1 step (previous, current, next) ⇒ ≤ 90 s                                                                                                                                                          |
| Secret                  | 20 bytes CSPRNG, base32 (RFC 4648, no padding) for display                                                                                                                                          |
| Storage                 | `mfa_credential.totp_secret_ct` / `_iv` / `_tag` / `_dek_id` / `_mask` — the five-column AES-256-GCM envelope of `DATA-MODEL.md` §1.6, DEK `purpose='MFA'`, AAD `<org>                              | mfa_credential | totp_secret | <row id>`. Never returned by any API after enrolment (R21) |
| Provisioning URI        | `otpauth://totp/Widedrop%20ESS:{work_email}?secret=…&issuer=Widedrop%20ESS&algorithm=SHA1&digits=6&period=30` — rendered as a QR **client-side** from the one-time enrolment response; never logged |
| Replay                  | `mfa_credential.last_accepted_step bigint`; a code is rejected if its step ≤ `last_accepted_step`. Updated in the same transaction as the successful verification                                   |
| Clock drift             | No per-user drift tracking; hosts run NTP. Verification failures at ±2 steps emit `AUTH.MFA_CLOCK_DRIFT_SUSPECTED` for operability                                                                  |
| Verification rate limit | 5 attempts per 5 min per `user_id`, then 15 min cooldown; 10 failures ⇒ account lock per §2.6                                                                                                       |

**Enrolment** requires a fresh password re-authentication (≤ 5 min — either a step-up assertion on an
existing session, or a live `mfa_challenge` on the `PENDING_MFA` path) and is confirmed by submitting
a valid code; only then is the secret marked `ACTIVE` and recovery codes issued.

Enrolment hygiene, because an abandoned enrolment leaves a usable secret lying about:

- A `PENDING` `mfa_credential` is **unusable for authentication** — the verifier selects
  `WHERE status='ACTIVE'` only, so a half-enrolled secret can never satisfy a login.
- `PENDING` rows expire after **15 minutes** and are deleted by the nightly job; starting a new
  enrolment deletes any existing `PENDING` row for that user first (`ux_mfa_credential__user_method`
  in `DATA-MODEL.md` already makes this a single row per user per method).
- Confirming enrolment while an `ACTIVE` credential already exists is a **replacement**, requires
  step-up against the _existing_ credential, revokes all sessions, invalidates all recovery codes, and
  emits `AUTH.MFA_ENROLLED` plus an email to the work address. This closes the obvious takeover path
  of silently adding a second authenticator.

**Recovery codes.** 10 codes × 128 bits, rendered as `xxxxx-xxxxx-xxxxx` (Crockford base32).
Stored as `HMAC-SHA256(RECOVERY_CODE_KEY, code)` in `mfa_recovery_code.code_hmac` — a fast keyed hash
is correct here because the codes are full-entropy random, unlike passwords. Single-use
(`used_at`), shown exactly once, regenerable (which invalidates all previous codes). Using a recovery
code emits `AUTH.MFA_RECOVERY_USED`, emails the user, and forces TOTP re-enrolment before the next
login. When 2 or fewer remain, a to-do item appears on Home (sourced from `mfa_recovery_code` counts —
a real persisted count, per D1).

**Who MUST have MFA.**

| Role held                   | MFA requirement                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HR`, `ACCOUNTS`, `MANAGER` | **Mandatory before the account can reach `ACTIVE`.** No grace period. A role grant to a user without active MFA transitions them to `PENDING_MFA` and forces enrolment at next login                          |
| `EMPLOYEE` only             | Mandatory, with a **14-day grace** from activation. During grace a non-dismissible to-do item ("Set up two-step verification") appears on Home; after 14 days login completes only through the enrolment flow |

This is not an arbitrary choice: it implements the persisted Information Security Policy v4.2 clause
"Multi-factor authentication is mandatory on all company SaaS tools" (the policy record the prototype
shows on the Policies screen). The grace length is read from `org_setting.mfa_grace_days`, not
hardcoded, so the compliance date is auditable.

**Step-up re-verification.** A valid, unexpired MFA assertion within the last **5 minutes**
(`session.mfa_verified_at`) is required for, and re-prompted on: bank-account change submission and
verification, password change, MFA reset/regeneration, any role grant or revoke, payroll publication,
payslip regeneration, any bulk export, and admin user-status changes. Routes declare
`config: { stepUp: true }`; the guard returns `403 {"code":"MFA_STEP_UP_REQUIRED"}` and the SPA opens
the step-up dialog.

### 2.8 Password reset

1. `POST /auth/password-reset/request {email}` — rate-limited (§9.1), always `202`.
2. Token: 32 random bytes base64url. Stored as **SHA-256 only** in
   `password_reset_token(id, organization_id, app_user_id, token_hash, purpose, expires_at, used_at, requested_ip_hash)`.
   `expires_at = now() + 15 minutes`. `purpose = 'PASSWORD_RESET'` (tokens are never
   interchangeable between purposes).
3. Issuing a new token marks all of the user's unused tokens `used_at = now()` — one live token.
4. Link goes to the **work email on record** only, never to an address supplied in the request.
5. `POST /auth/password-reset/confirm {token, newPassword}` — constant-time hash comparison, expiry
   and `used_at` checked, new password validated (§2.2), then **in one transaction**: write the new
   hash, append to `password_history`, mark the token used, `user.token_version += 1`, delete all
   `session` and `refresh_token` rows for the user, clear `locked_until` and failure counters, write
   `AUTH.PASSWORD_RESET_COMPLETED`.
6. MFA is **not** bypassed: the next login still requires TOTP. Resetting a password never resets MFA.
7. The user is emailed "your password was changed" with the timestamp and coarse location
   (city from IP, best-effort) and a "this wasn't me" link that opens a pre-filled Help-desk ticket.

### 2.9 Session revocation triggers

`app_user.token_version int` is embedded in every access token as `ver`. A mismatch ⇒ `401`
`{"code":"TOKEN_STALE"}`, which the SPA handles by attempting one refresh and then logging out.

**This is the single, authoritative behaviour.** Earlier drafts of §1.4 and §4.6 said the server
"reloads roles from `user_role` on mismatch" and continues. That is wrong and is withdrawn: a `ver`
bump means _something security-relevant changed about this principal_ (role revoked, password reset,
account suspended, refresh reuse detected), and the only safe response is to stop the request and make
the client re-establish. Repairing the request in flight would let a revoked role survive for the
remainder of a long-running call. Role resolution from `user_role` (§4.7) happens on **every**
request regardless of `ver`; it is not a repair step.

`token_version` is incremented, and **all** sessions + refresh families revoked, on: password change
or reset; any role grant or revoke; MFA enrolment, reset or recovery-code use; `SUSPENDED` or
`OFFBOARDED`; refresh-token reuse detection (§3.2); user-initiated "sign out everywhere"; and an HR
`revoke:session` action. Because access tokens live only 10 minutes, revocation is fully effective
within 10 minutes worst-case; for the highest-impact case (offboarding) the session row is deleted
too, and `sid` is checked against `session` on **every** request, so revocation there is immediate.

---

## 3. Tokens and sessions

### 3.1 Access token

| Property       | Value                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Type           | JWT, compact serialisation                                                                                          |
| Algorithm      | **EdDSA (Ed25519)**. Verifier accepts exactly `["EdDSA"]`; `alg:none` and any HMAC alg are rejected before parsing  |
| TTL            | **10 minutes** (`ACCESS_TOKEN_TTL_SECONDS`, max permitted value 900)                                                |
| Transport      | `Authorization: Bearer …` header only. **Never** in a cookie, URL, query string or `localStorage`                   |
| Client storage | In-memory closure inside `apps/web/src/lib/auth-store.ts`; lost on reload and re-obtained via the refresh cookie    |
| Key location   | Private key `JWT_SIGNING_KEY_<kid>` (PKCS#8 PEM) in the platform secret store; never in Postgres, never in the repo |

Claims (`apps/api/src/auth/tokens.ts`):

| Claim                | Type               | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iss`                | string             | `https://api-ess.widedrop.com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `aud`                | string             | `https://ess.widedrop.com`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `sub`                | uuid               | `user.id`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sid`                | uuid               | `session.id` — looked up on every request; revocation point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `jti`                | uuid               | unique per token; used for replay forensics in audit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `iat`,`nbf`,`exp`    | number             | `nbf = iat`, `exp = iat + 600`; 30 s clock skew tolerated                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `ver`                | int                | `user.token_version` (§2.9)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `roles`              | string[]           | e.g. `["EMPLOYEE","MANAGER"]` — **SPA cosmetics only**. The server MUST NOT read this claim in any code path, not even to short-circuit a denial: a stale claim that short-circuits a `403` is an availability bug, and any future refactor that lets it short-circuit an _allow_ is a privilege-escalation bug. `apps/api/src/auth/tokens.ts` deletes the claim from the verified payload before the object reaches the authorize plugin, and a Semgrep rule forbids `.roles` on a decoded-token type. Authoritative resolution is always `user_role` (§4.7) |
| `pwd_reset_required` | boolean (optional) | Present and `true` only on the restricted change-password session of §2.3. When set, the authorize plugin denies every route outside that section's three-route allowlist                                                                                                                                                                                                                                                                                                                                                                                     |
| `emp`                | uuid \| null       | `employee.id` — convenience only; server re-derives it for writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `amr`                | string[]           | `["pwd"]` or `["pwd","otp"]`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `auth_time`          | number             | epoch seconds of the original password authentication; drives step-up (§2.7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `mfa_at`             | number \| null     | epoch seconds of the last MFA assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

No PII (no name, no email, no employee code) is placed in the token: it is readable by anyone who can
see the browser's memory or a proxy log that wrongly captures headers.

### 3.2 Key rotation and `kid`

`jwks` table: `(kid text pk, public_key_pem text, alg text, status enum('NEXT','CURRENT','RETIRED'), not_before timestamptz, not_after timestamptz)`. Private keys live in the secret store under
`JWT_SIGNING_KEY_<kid>`; the DB holds only public keys and metadata.

- `kid` format: `wd-ess-<yyyymm>-<4 hex>`.
- Rotation every **90 days**, plus immediately on suspected compromise.
- Procedure: publish the new key as `NEXT` (verify-only) → after one deploy cycle promote to
  `CURRENT` (sign with it) → previous key becomes `RETIRED` but still verifies for
  `ACCESS_TOKEN_TTL + 60 s` → key material deleted from the secret store 24 h later.
- `GET /.well-known/jwks.json` is served **only on the internal listener**, which is a concrete thing,
  not an aspiration: `apps/api/src/server.ts` starts **two** Fastify instances — the public one bound
  to `0.0.0.0:$PORT` and an internal one bound to `127.0.0.1:$PRIVATE_PORT`, reachable only from
  inside the container's network namespace and from the platform's private network. `/metrics`
  (§11.3) and `GET /.well-known/jwks.json` are registered **only** on the internal instance; a
  boot-time assertion fails the process if either path resolves on the public instance. Public keys
  are not secret, but publishing a signing-key inventory tells an attacker exactly which `kid` values
  to target during a rotation window, and `/metrics` is a live map of authentication failures.
  Internal routes are exempt from §4.6's permission assertion via `config: { internal: true }`, which
  is itself only legal on the internal instance.
- Verification caches the JWKS in-process for 5 min with a forced refresh on unknown `kid`
  (rate-limited to 1 refresh / 30 s to prevent a `kid`-flood DoS).

### 3.3 Refresh token

| Property            | Value                                                                                                                                                                                                                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Format              | **Opaque**, 32 bytes (256 bits) from `crypto.randomBytes`, base64url. Not a JWT — it carries no claims and cannot be parsed or forged offline                                                                                                                                          |
| Storage (server)    | `refresh_token(id uuid, user_id, session_id, family_id uuid, parent_id uuid null, token_hash bytea, issued_at, expires_at, used_at, revoked_at, revoked_reason, ip_hash, user_agent_hash)`; `token_hash = SHA-256(token)` with a unique index. The plaintext is never stored or logged |
| Storage (client)    | `__Host-wd_rt` cookie only (§3.4)                                                                                                                                                                                                                                                      |
| Idle TTL            | 7 days (`expires_at`)                                                                                                                                                                                                                                                                  |
| Absolute family TTL | 14 days from `family.created_at`; after that re-authentication is required regardless of activity                                                                                                                                                                                      |
| Rotation            | **Every** use. `POST /auth/refresh` validates, marks the presented token `used_at`, issues a new token in the same `family_id` with `parent_id` set, and returns a new access token. All in one transaction                                                                            |

**Reuse detection.** If a presented token's `used_at` is non-null (it has already been rotated) or
`revoked_at` is set, the request is a replay — either the cookie was stolen, or a legitimate client
raced. The response is the same either way:

1. Revoke **the entire family**: `UPDATE refresh_token SET revoked_at = now(), revoked_reason='REUSE_DETECTED' WHERE family_id = $1 AND revoked_at IS NULL`.
2. Delete the associated `session` rows; `user.token_version += 1`.
3. Write `AUTH.REFRESH_REUSE_DETECTED` (severity `CRITICAL`) with `family_id`, both `ip_hash` values
   and both `user_agent_hash` values — never the token.
4. Email the user: "You have been signed out of all devices because a sign-in token was replayed."
5. Raise a security alert (§11.4).
6. Return `401 {"code":"SESSION_REVOKED"}` and clear the cookie.

A 10-second grace is granted for the _immediate_ predecessor of the current token from the _same_
`ip_hash` **and** `user_agent_hash`, to absorb double-fired refreshes from React StrictMode or a
racing tab; outside that narrow window the full revocation above applies.

**How the grace actually works.** An earlier draft said the grace "re-returns the already-issued
successor". That is not implementable: only `SHA-256(token)` is stored, so the successor's plaintext
does not exist on the server and cannot be re-sent — and storing it so that it could be would put a
live bearer credential in the database, which is precisely what hashing it avoids. The grace
therefore **mints a new successor**:

1. The presented token `T` has `used_at` set, `used_at > now() - 10s`, `revoked_at IS NULL`,
   `grace_used_at IS NULL`, and both hashes match the row.
2. The server revokes `T`'s existing child (`revoked_reason='SUPERSEDED_BY_GRACE'`), issues a fresh
   token in the same `family_id` with `parent_id = T.id`, and sets `T.grace_used_at = now()`.
3. Because `grace_used_at` is set, a **second** replay of `T` is not graced — it takes the full
   family revocation of the list above. One race is a framework artefact; two is a stolen cookie.
4. The grace is counted (`refresh_grace_total`) and a rate above 1 % of refreshes is a `P3` alert: it
   means the SPA is double-firing and the signal that distinguishes theft from a race is being eroded.

`refresh_token.grace_used_at timestamptz NULL` is required in `DATA-MODEL.md`.

### 3.4 Cookie attributes, justified

```
Set-Cookie: __Host-wd_rt=<opaque>;   Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800
Set-Cookie: __Host-wd_csrf=<opaque>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800
```

> **Correction — `__Host-wd_csrf` is `HttpOnly` and the SPA never reads it.** Earlier drafts marked it
> readable so the SPA could "echo the cookie" in a classic double-submit. That is impossible in this
> host layout: the cookie is set by `api-ess.widedrop.com`, `document.cookie` is scoped to the
> _document's_ host, and the SPA's document is `ess.widedrop.com`. JavaScript on `ess.widedrop.com`
> cannot read, and must never be able to read, a cookie belonging to the API host — that is the
> `__Host-` guarantee working as intended. The CSRF value therefore reaches the SPA **in the response
> body** of `/auth/login` and `/auth/refresh` and is held in memory beside the access token; the
> cookie copy exists only so the _server_ can compare the two. §3.5 specifies this precisely.

| Attribute                 | Choice              | Justification for this host layout                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__Host-` prefix          | required            | Forbids a `Domain` attribute, so the cookie is **host-locked to `api-ess.widedrop.com`**. This is the specific defence against T-SUB: a compromised or taken-over sibling host (including the Netlify marketing site at `widedrop.com`) cannot set or overwrite a `Domain=.widedrop.com` cookie that the API would then accept. It also forces `Secure` and `Path=/` |
| `HttpOnly` (on `wd_rt`)   | yes                 | XSS in the SPA cannot read the refresh token. Combined with the access token being memory-only, an XSS gets at most a 10-minute window and cannot persist                                                                                                                                                                                                            |
| `HttpOnly` (on `wd_csrf`) | yes                 | The SPA receives this value in a response **body**, not by reading the cookie (it cannot — see the correction above). Keeping the cookie `HttpOnly` means an XSS on the API origin cannot read it either, and there is no benefit to exposing it                                                                                                                     |
| `Secure`                  | yes                 | TLS only; implied by `__Host-` but stated                                                                                                                                                                                                                                                                                                                            |
| `SameSite=Strict`         | yes                 | `ess.widedrop.com → api-ess.widedrop.com` is **same-site**, so `Strict` does not break the SPA's own XHR. It does block every genuinely cross-site request, including top-level navigations from a phishing page to `/auth/refresh`. `Lax` would be unnecessarily weaker; `None` would be wrong                                                                      |
| `Path=/`                  | forced by `__Host-` | We accept the slightly wider path in exchange for the host-locking guarantee, which matters more here. Route-level enforcement (only `/auth/refresh` and `/auth/logout` read the cookie) provides the narrowing that `Path` would have given                                                                                                                         |
| `Domain`                  | **absent**          | See `__Host-`                                                                                                                                                                                                                                                                                                                                                        |
| `Max-Age`                 | 604800 (7 d)        | Matches the refresh idle TTL; the server is authoritative regardless                                                                                                                                                                                                                                                                                                 |
| `Partitioned` (CHIPS)     | not set             | Not a third-party cookie context                                                                                                                                                                                                                                                                                                                                     |

Logout sends `Set-Cookie: __Host-wd_rt=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` and
the same for `__Host-wd_csrf`, **and** revokes server-side — clearing the cookie alone is never
treated as logout. The API also sends `Clear-Site-Data: "cache", "storage"` on the logout response so
a shared machine does not retain cached responses or IndexedDB residue; it deliberately omits
`"cookies"` from that list because the explicit `Max-Age=0` pair above is the precise, auditable
clearance and `Clear-Site-Data: "cookies"` is inconsistently scoped across browsers.

**Session lifetimes, stated once so no implementer invents a timer.** There is no separate idle
timeout: the refresh token's 7-day idle TTL _is_ the idle timeout, the 14-day family TTL _is_ the
absolute session lifetime, the 10-minute access-token TTL bounds revocation lag, and the 5-minute
step-up freshness (§2.7) bounds how long a high-impact action may ride on an old MFA assertion.
`session.last_seen_at` is updated at most once per minute per session (a bounded write, not a
per-request one) and is what the "signed in on 3 devices" list on Profile reads — a persisted value,
per D1.

### 3.5 CSRF defence, and why it is still required

Most API calls carry a `Bearer` token from JS memory and are therefore structurally CSRF-immune (a
cross-site attacker cannot read or set that header without CORS permission). The cookie-authenticated
surface is small and explicit: `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/logout-all`. Those routes get the full defence.

**Why `SameSite=Strict` is not sufficient on its own:**

1. **Same-site siblings are not cross-site.** Any `*.widedrop.com` host — the Netlify marketing site,
   a future landing page, a stale CNAME taken over by an attacker (T-SUB) — can issue requests that
   the browser considers same-site, and `SameSite` will happily attach the cookie. Given the brief
   explicitly keeps the public site on a separate Netlify free-tier account, this is a _live_ risk,
   not a theoretical one.
2. Browsers and embedded webviews have shipped `SameSite` bugs and downgrade behaviours; some
   enterprise/legacy clients ignore the attribute.
3. `SameSite` is a defence the _browser_ chooses to apply. CSRF tokens are a defence the _server_
   enforces. Defence in depth requires at least one server-enforced check.

**The mechanism (`apps/api/src/auth/csrf.ts`), on every unsafe method (`POST/PUT/PATCH/DELETE`):**

1. **Session-bound signed token, delivered in the body.** The server mints
   `csrf = <nonce>.<hmac>` where `nonce = 16 CSPRNG bytes (base64url)` and
   `hmac = base64url(HMAC-SHA256(CSRF_KEY, nonce ‖ ":" ‖ session_id))`. It is returned **in the JSON
   response body** of `POST /auth/login` (on the final MFA step), `POST /auth/mfa/verify` and
   `POST /auth/refresh`, and simultaneously set as the `HttpOnly` `__Host-wd_csrf` cookie. The SPA
   keeps the body copy in the same in-memory closure as the access token and sends it in `X-WD-CSRF`.
   The server requires: (a) the header is present and well-formed; (b) the HMAC recomputes correctly
   against the `session_id` **derived from the server's own session lookup**, compared with
   `timingSafeEqual`; (c) when a `__Host-wd_csrf` cookie is present, it `timingSafeEqual`s the header.
   Check (b) is the load-bearing one and is sufficient on its own; (c) is defence in depth.

   This is stronger than classic double-submit here, not weaker. A sibling host (T-SUB) cannot set a
   `__Host-` cookie on the API host at all, and even if cookie injection were possible by some other
   route, it could not mint a valid HMAC over the **victim's** `session_id`, which it cannot read.
   The attacker would have to both set the cookie and guess a 256-bit MAC.

2. **The bootstrap problem, solved explicitly.** On a cold page load the SPA has no CSRF token — it
   has just been loaded and its first call is `POST /auth/refresh`. That one route therefore cannot
   require `X-WD-CSRF`, and pretending otherwise is how this design usually breaks in practice.
   `POST /auth/refresh` is instead protected by the full stack below it, and is the **only** unsafe
   route exempt from check 1:

   | Control on `/auth/refresh`                                                                                                                                                  | Why it is sufficient                                                                                                                                                |
   | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `Origin` must be present and exactly an allowlisted origin                                                                                                                  | A cross-site form post cannot set `Origin` to another site's value                                                                                                  |
   | `Sec-Fetch-Site: same-site` **and** `Sec-Fetch-Mode: cors` **and** `Sec-Fetch-Dest: empty`, all three **mandatory** (a request missing them is rejected, not waved through) | Blocks top-level navigation and form-post CSRF outright                                                                                                             |
   | `__Host-` prefix on `wd_rt`                                                                                                                                                 | A sibling or taken-over host cannot set or overwrite it                                                                                                             |
   | `SameSite=Strict`                                                                                                                                                           | Blocks genuinely cross-site delivery                                                                                                                                |
   | Rotation + family reuse detection (§3.3)                                                                                                                                    | A CSRF-triggered refresh rotates the token, so the victim's next real refresh is a detected replay and the family is revoked — the attack is loud and self-limiting |
   | Response body is the only place the new tokens appear, and the attacker cannot read it (CORS)                                                                               | A forced refresh yields the attacker nothing                                                                                                                        |

   `POST /auth/logout` and `POST /auth/logout-all` are **not** exempt: by the time they are called the
   SPA holds a CSRF token. (A forced logout is low-impact, but it is also trivially preventable.)

3. **`Origin` enforcement.** `Origin` must be present and an exact string match against
   `ALLOWED_ORIGINS` (§6.5). Absent or mismatched ⇒ `403 {"code":"CSRF_ORIGIN_REJECTED"}`.
   **There is no `Referer` fallback.** The earlier draft allowed one "when `Origin` is absent on
   same-origin requests" — but the SPA is _never_ same-origin with the API in this layout, so the
   clause could only ever have been exercised by a non-browser client, i.e. exactly the caller it
   would have helped. `Referer` is ignored entirely.

4. **Fetch-metadata enforcement.** `Sec-Fetch-Site` must be `same-site` or `same-origin`;
   `Sec-Fetch-Mode` must be `cors` (never `navigate`); `Sec-Fetch-Dest` must be `empty`. Unlike the
   earlier draft, these headers are **required, not "enforced when present"** — every browser that
   this SPA supports sends them, and treating their absence as a pass hands any attacker a one-header
   bypass. A non-browser client (CI smoke test, the ClamAV-less local dev harness) sets them
   explicitly; `NODE_ENV=development` is the only environment where their absence is tolerated, and
   that tolerance is asserted to be off in production by a boot check.

5. All checks run — they are not alternatives. A failure at any step emits `SECURITY.CSRF_REJECTED`
   with the request id, route and the reason code, and returns `403` with a generic body.

6. `GET`/`HEAD`/`OPTIONS` are exempt but must be side-effect free; a lint rule and a route-table
   assertion at boot fail the build if a `GET` route declares a write permission (§4.8).

7. **`POST /api/v1/csp-report` is exempt from this entire section** and from CORS. A browser sends CSP
   reports as a cross-origin `POST` with `Content-Type: application/csp-report`, no `Origin` the
   endpoint can rely on, and `Sec-Fetch-Mode: no-cors` — so every rule above would reject 100 % of
   reports, and the enforcement CSP rollout would appear silently clean. The exemption is safe because
   the route is unauthenticated, reads no cookie, performs no state change, and is capped and
   rate-limited (§6.3). It is declared `config: { public: true, csrfExempt: true, reason: 'browser CSP reporting endpoint' }`
   and the boot assertion requires `csrfExempt` to co-occur with `public`.

The CSRF token is rotated on login, on every refresh, and on every `token_version` bump, and both the
cookie and the server-side expectation are cleared on logout. `CSRF_KEY` rotation (§10.4) invalidates
live tokens; the SPA treats a single `CSRF_ORIGIN_REJECTED`/`CSRF_TOKEN_INVALID` by silently
refreshing once to obtain a new token, and only then surfaces an error.

---

## 4. Authorization — RBAC + ABAC

### 4.1 Roles

Exactly four persona roles (D2), stored in `role(code, name)` and granted through
`user_role` as defined in `DATA-MODEL.md` §3.4 — `(id, organization_id, app_user_id, role_id,
granted_by_user_id, granted_at, valid_from, valid_to, revoked_at, revoked_by_user_id, reason)`,
plus the HRBP narrowing column `scope_department_id uuid NULL` FK → `department(id)`. There is no
`expires_at` and no `scope_org_unit_id`; read those spellings here as `valid_to` and
`scope_department_id` (R17).

| Code       | Persona                          | Who holds it                                                                                                                                                                                                           | Scope default                                                                                            |
| ---------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `EMPLOYEE` | Employee                         | **Every** user with an `employee` record, always, in addition to any other role                                                                                                                                        | `SELF` + `ORG` for the public directory/policy/announcement surfaces                                     |
| `MANAGER`  | Manager                          | Derived-but-explicit: granted by HR to any user who has ≥ 1 active direct report. A nightly reconciliation job flags mismatches; it never auto-grants or auto-revokes (a silent privilege change would be unauditable) | `DIRECT_REPORTS`, widened to `REPORTING_CHAIN` only for the specific escalation permissions marked below |
| `HR`       | People Ops / HR Business Partner | Granted by HR with maker-checker (§4.9)                                                                                                                                                                                | `ORG`, optionally narrowed to an org-unit subtree via `user_role.scope_org_unit_id` (the HRBP model)     |
| `ACCOUNTS` | Finance / Payroll                | Granted by HR with maker-checker                                                                                                                                                                                       | `ORG`, but structurally excluded from non-payroll PII (§4.5)                                             |

There is **no** super-admin, no `SUPPORT` role and **no impersonation capability anywhere in the
system**. Investigating a user's view of the portal is done by reading the audit trail and the same
API as that user would call under an explicit, audited `read:` permission — never by assuming their
identity. `packages/shared/src/permissions.ts` contains the permission string union; a compile error
is the first line of defence against inventing a permission at a call site.

### 4.2 Scopes (ABAC)

| Scope             | Resolves to                                                                                                                                                   | Computed from                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `SELF`            | `{ employee_id = actor.employee_id }`                                                                                                                         | the access token's `sub` → `employee.user_id`; **never** from the request                         |
| `DIRECT_REPORTS`  | `{ employee_id IN (SELECT descendant_employee_id FROM employee_reporting_closure WHERE ancestor_employee_id = actor.employee_id AND depth = 1) }`             | `employee_manager` (history) → `employee_reporting_closure`                                       |
| `REPORTING_CHAIN` | `{ employee_id IN (SELECT descendant_employee_id FROM employee_reporting_closure WHERE ancestor_employee_id = actor.employee_id AND depth BETWEEN 1 AND 6) }` | `employee_reporting_closure`                                                                      |
| `DEPARTMENT`      | `{ department_id IN (subtree of the grant's `scope_department_id`) }`                                                                                         | `department.parent_department_id` adjacency, walked by `trg_department_no_cycle`'s same traversal |
| `ORG`             | no employee predicate; still subject to resource-level attribute predicates                                                                                   | —                                                                                                 |

`employee_reporting_closure(ancestor_employee_id, descendant_employee_id, depth, PRIMARY KEY(ancestor_employee_id, descendant_employee_id))` (`DATA-MODEL.md` §5.5) is a
**materialised transitive closure**, rewritten inside the same transaction as any `employee.manager_id`
change (and any employee create/terminate) by
`apps/api/src/authz/reporting-closure.ts#rebuildSubtree()` on any `employee_manager` change. Reasons: (a) a scope check becomes one
indexed lookup instead of a recursive CTE per request, (b) the closure is a persisted fact that the
audit trail can reference, (c) `depth ≤ 6` bounds the blast radius of a cyclic or corrupted
`manager_id` — and a `CHECK` plus an insertion-time cycle test rejects cycles outright.

Self-reference `(x, x, 0)` is stored so `REPORTING_CHAIN` including self is expressible, but every
permission in §4.4 that uses `REPORTING_CHAIN` requires `depth ≥ 1`, i.e. **a manager is never inside
their own approval scope**.

### 4.3 Permission string grammar — canonical form

Two grammars were in circulation. `docs/API.md` and `docs/WORKFLOWS.md` name permissions
`resource:action[:scope]` (`payslip:read:self`, `payroll:input:upload`, `attendance:approve:team`);
earlier drafts of this section used `verb:resource[:qualifier]` (`read:payslip:self`). They are not
interchangeable, and a route guard cannot compile against both. Per **R1**, the canonical grammar is:

```
resource[:subresource]:action[:scope]
resource    ::= snake_case noun, singular — the aggregate the permission is about
subresource ::= optional snake_case noun, for a resource that owns a distinct sub-aggregate
                (payroll:input:*, payroll:cycle:*, leave:request:*, leave:balance:*,
                 expense:claim:*, policy:ack:*, ticket:comment:*, security:mfa:*,
                 security:session:*, security:account:*, tax:quarter:*, tax:declaration:*,
                 document:request:*, document:type:*, approval:task:*)
action      ::= read | read_sensitive | read_contact | create | update | write | delete
              | submit | approve | reject | withdraw | reopen | acknowledge | publish
              | author | calculate | validate | generate | issue | verify | assign
              | resolve | comment | close | export | upload | download | commit | capture
              | transition | lock | close | reimburse | adjust | reset | revoke | archive
              | pin | manage | enrol | escalate | unlock | email | mark_read | act | fulfil
scope       ::= self | team | skip_level | any | finance | global
```

`scope` is the closed six-value `ess_permission_scope` enum of `DATA-MODEL.md` §3.1. An earlier
draft of this line also listed `chain`, `queue`, `full` and `masked`; all four are **withdrawn**:
`chain` is spelled `skip_level`, `queue` is an attribute predicate (help-desk queue membership)
and never a scope, and `full`/`masked` are two _different permissions_ over the same column
(`…:read:self` returns the mask, `…:read_sensitive:any` returns the plaintext) rather than two
scopes of one. A two-segment org-wide code such as `payroll:validate` carries the implicit scope
`global` and prints no scope segment (`ck_permission__code_matches_parts`).

Three rules that were previously implicit and are now normative:

1. **The action list above is closed and complete.** The earlier list omitted `manage`, `comment`,
   `close`, `pin`, `reimburse`, `adjust`, `reset`, `archive`, `email`, `enrol`, `author`, `commit`,
   `capture`, `transition`, `escalate`, `unlock`, `mark_read`, `act` and `fulfil` — yet §4.4 used
   every one of them. A permission whose action is outside this list is a **compile error**, because
   `packages/shared/src/permissions.ts` is a template-literal union over these members.
2. **`scope` in the string is a _semantic_ narrowing and is not the ABAC scope.** `payslip:read:self`
   and `payslip:read:any` are two different permissions that expose different DTOs; the _reach_ of
   each is the ABAC scope stored per (role, permission) in the §4.4 matrix and per grant in
   `user_role.scope_org_unit_id`. Keeping them separate is what makes "same permission, different
   reach" expressible for a multi-role user (§4.7). `team` in a permission string is a synonym for
   the `DIRECT_REPORTS` ABAC scope and `chain` for `REPORTING_CHAIN`, used only where API.md already
   spells it that way (`attendance:approve:team`).
3. **`permissions.ts` is generated from §4.4**, not hand-maintained, by
   `npm run gen:permissions` parsing this file's matrix; CI fails if the generated file differs from
   the committed one. The matrix in this document is therefore the single source of truth, and a
   permission cannot exist in code without appearing here.

#### 4.3.1 Canonical name for every permission in §4.4 (normative mapping)

§4.4's tables are retained verbatim below because their _content_ — the scopes, the `†`/`‡`/`§`
markers and the guard notes — is correct and load-bearing. Read each cell's permission string through
this table; the right-hand column is what appears in `permissions.ts`, in `config.permission` and in
`audit_event.actor_permission_code`.

| As written in §4.4                                         | Canonical                                                   |     | As written in §4.4                                    | Canonical                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------- | --- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `read:profile:self`                                        | `profile:read:self`                                         |     | `read:profile:full`                                   | `profile:read_sensitive:any`                                           |
| `update:profile:self`                                      | `profile:update:self`                                       |     | `create:profile_change_request:self`                  | `profile:change_request:create:self`                                   |
| `approve:profile_change_request`                           | `profile:change_request:decide`                             |     | `read:directory`                                      | `directory:read`                                                       |
| `read:reporting_line`                                      | `directory:read` (the widget is part of the directory read) |     | `read:emergency_contact:self`                         | `emergency_contact:read:self`                                          |
| `update:emergency_contact:self`                            | `emergency_contact:write:self`                              |     | `read:emergency_contact`                              | `emergency_contact:read:any`                                           |
| `read:bank_account:masked:self`                            | `bank_account:read:self`                                    |     | `read:bank_account:full`                              | `bank_account:read_sensitive:any`                                      |
| `create:bank_change_request:self`                          | `bank_account:change_request:create:self`                   |     | `verify:bank_change_request`                          | `bank_account:change_request:verify`                                   |
| `read:statutory_id:masked:self`                            | `statutory_identity:read:self`                              |     | `read:statutory_id:full`                              | `statutory_identity:read_sensitive:any`                                |
| `read:salary_structure:self`                               | `payroll:salary_structure:read:self`                        |     | `read:salary_structure`                               | `payroll:salary_structure:read:any`                                    |
| `update:salary_structure`                                  | `payroll:salary_structure:write`                            |     | `create:payroll_run`                                  | `payroll:cycle:create`                                                 |
| `upload:payroll_input`                                     | `payroll:input:upload`                                      |     | `read:payroll_input`                                  | `payroll:input:read`                                                   |
| _(new, see below)_                                         | `payroll:input:commit`                                      |     | _(new)_                                               | `payroll:cycle:read`                                                   |
| `submit:attendance_period`                                 | `attendance:submit`                                         |     | `read:attendance:self`                                | `attendance:read:self`                                                 |
| `read:attendance` (Manager)                                | `attendance:read:team`                                      |     | `read:attendance` (HR/Accounts)                       | `attendance:read:any`                                                  |
| `approve:attendance`                                       | `attendance:approve:team`                                   |     | `reject:attendance`                                   | `attendance:approve:team` (the reject decision of the same permission) |
| `approve:attendance:escalated`                             | `attendance:approve:any`                                    |     | _(new)_                                               | `attendance:reopen`                                                    |
| `validate:payroll_run`                                     | `payroll:validate`                                          |     | `generate:payroll`                                    | `payroll:calculate`                                                    |
| _(new, the `‡` second approver)_                           | `payroll:approve`                                           |     | `publish:payroll`                                     | `payroll:publish`                                                      |
| `lock:payroll_run`                                         | `payroll:close`                                             |     | `read:payslip:self`                                   | `payslip:read:self`                                                    |
| `download:payslip:self`                                    | `payslip:download:self`                                     |     | `email:payslip:self`                                  | `payslip:email:self`                                                   |
| `read:payslip:any`                                         | `payslip:read:any`                                          |     | `read:payslip_source`                                 | `payroll:cycle:read` + `payroll:input:read`                            |
| `read:tax_quarter:self`                                    | `tax:quarter:read:self`                                     |     | `read:form16:self` / `download:form16:self`           | `document:read:self` / `file:download:self`                            |
| `issue:form16`                                             | `tax:quarter:manage`                                        |     | `create:leave_request:self`                           | `leave:request:create:self`                                            |
| `read:leave_request:self`                                  | `leave:request:read:self`                                   |     | `withdraw:leave_request:self`                         | `leave:request:withdraw:self`                                          |
| `read:leave_request` (Manager)                             | `leave:request:read:team`                                   |     | `read:leave_request` (HR)                             | `leave:request:read:any`                                               |
| `approve:leave_request` / `reject:leave_request` (Manager) | `leave:request:approve:team`                                |     | same (HR override)                                    | `leave:request:approve:any`                                            |
| `read:leave_balance:self`                                  | `leave:balance:read:self`                                   |     | `read:leave_balance`                                  | `leave:balance:read:team` / `:any`                                     |
| `adjust:leave_balance`                                     | `leave:balance:adjust`                                      |     | `read:holiday_calendar`                               | `holiday:read`                                                         |
| `manage:holiday_calendar`                                  | `holiday:manage`                                            |     | `create:expense_claim:self`                           | `expense:claim:create:self`                                            |
| `read:expense_claim:self`                                  | `expense:claim:read:self`                                   |     | `withdraw:expense_claim:self`                         | `expense:claim:withdraw:self`                                          |
| `read:expense_claim` (Manager)                             | `expense:claim:read:team`                                   |     | `read:expense_claim` (Accounts)                       | `expense:claim:read:any`                                               |
| `approve:expense_claim` / `reject:expense_claim`           | `expense:claim:approve:team`                                |     | _(skip-level escalation)_                             | `expense:claim:approve:skip_level`                                     |
| `reimburse:expense_claim`                                  | `expense:reimburse`                                         |     | `read:expense_attachment`                             | `file:download:self` / `file:download:any`                             |
| _(new)_                                                    | `expense:policy_limit:read`                                 |     | `read:benefit_enrolment:self` / `read:dependent:self` | `benefit:read:self` / `dependent:read:self`                            |
| `create:dependent_change_request:self`                     | `dependent:write:self`                                      |     | `read:benefit_enrolment` / `read:dependent`           | `benefit:read:any` / `dependent:read:any`                              |
| `approve:dependent_change_request`                         | `benefit:enrol:approve`                                     |     | `read:benefit_deduction`                              | `benefit:deduction:read:any`                                           |
| `manage:benefit_plan`                                      | `benefit:manage`                                            |     | `read:document:self` / `download:document:self`       | `document:read:self` / `file:download:self`                            |
| `read:document`                                            | `document:read:any`                                         |     | `issue:document`                                      | `document:upload:any`                                                  |
| `create:letter_request:self`                               | `document:request:create:self`                              |     | `issue:letter`                                        | `document:request:fulfil`                                              |
| `read:policy`                                              | `policy:read`                                               |     | `acknowledge:policy:self`                             | `policy:acknowledge:self`                                              |
| `read:policy_acknowledgement:self`                         | `policy:ack:read:self`                                      |     | `read:policy_acknowledgement`                         | `policy:ack:read:any`                                                  |
| `create:policy_version` / `update:policy_version`          | `policy:author`                                             |     | `publish:policy_version`                              | `policy:publish`                                                       |
| `archive:policy`                                           | `policy:archive`                                            |     | `read:announcement`                                   | `announcement:read`                                                    |
| `create:announcement` / `update:announcement`              | `announcement:author`                                       |     | `publish:announcement` / `pin:announcement`           | `announcement:publish` / `announcement:pin`                            |
| `create:ticket:self`                                       | `ticket:create:self`                                        |     | `read:ticket:self`                                    | `ticket:read:self`                                                     |
| `comment:ticket:self`                                      | `ticket:comment:self`                                       |     | `close:ticket:self`                                   | `ticket:close:self`                                                    |
| `read:ticket:queue`                                        | `ticket:read:any` (+ queue predicate)                       |     | `assign:ticket` / `resolve:ticket`                    | `ticket:assign` / `ticket:resolve`                                     |
| `read:faq`                                                 | `faq:read`                                                  |     | `manage:faq`                                          | `faq:manage`                                                           |
| `read:notification:self`                                   | `notification:read:self`                                    |     | _(mark-read)_                                         | `notification:mark_read:self`                                          |
| `read:audit:hr`                                            | `audit:read` (HR predicate)                                 |     | `read:audit:payroll`                                  | `audit:read` (payroll predicate)                                       |
| `verify:audit_chain`                                       | `audit:verify`                                              |     | `export:employee_data` / `export:payroll_data`        | `audit:export` / `payroll:export`                                      |
| `invite:user`                                              | `employee:create`                                           |     | `suspend:user` / `offboard:user`                      | `employee:deactivate`                                                  |
| `grant:role` / `revoke:role`                               | `role:assign`                                               |     | _(role listing)_                                      | `role:read`                                                            |
| `reset:mfa`                                                | `security:mfa:reset`                                        |     | `revoke:session`                                      | `security:session:revoke`                                              |
| _(new, §2.6)_                                              | `security:account:unlock`                                   |     | `manage:org_unit` / `manage:reporting_line`           | `org:manage`                                                           |
| `read:org_setting`                                         | `org:read`                                                  |     | `update:org_setting`                                  | `org:manage`                                                           |
| `create:audit_event`, `update:*`/`delete:*` on audit       | **no permission exists**                                    |     | _(approval inbox)_                                    | `approval:task:act`                                                    |

**Permissions that §4.4 needed but never declared** — each is a real gap, not a rename, and each is
added to the matrix with the scope shown:

| Canonical                                                                           | Employee | Manager          | HR                | Accounts | Why it must exist                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------- | -------- | ---------------- | ----------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payroll:cycle:read`                                                                | —        | —                | ORG (status only) | ORG      | The Payroll screen cannot render a cycle's state without a permission to read it. HR's grant is narrowed by a DTO that exposes `status`, `period`, `scheduled_pay_date` and counts only — never an amount |
| `payroll:input:commit`                                                              | —        | —                | —                 | ORG ‡    | `WORKFLOWS.md` PIB-6 requires a commit step distinct from upload; without it a parsed-but-unreviewed batch would flow into validation                                                                     |
| `payroll:approve`                                                                   | —        | —                | —                 | ORG †‡   | `WORKFLOWS.md` PAY-17 publishes from `APPROVED`, not from `CALCULATED`. The approver is the maker-checker gate; the publisher is a _third_ check (§4.12)                                                  |
| `payroll:validation_issue:read`                                                     | —        | —                | ORG               | ORG      | HR must see the blocking list for the issues assigned to HR (`PAY_ATTENDANCE_MISSING`), or it cannot act on them. HR's rows are filtered to `owner_role='HR'`                                             |
| `attendance:reopen`                                                                 | —        | —                | ORG §             | —        | `WORKFLOWS.md` PAY-6/ATT-8 require it; without it a rejected attendance slice is a dead end                                                                                                               |
| `expense:policy_limit:read`                                                         | ORG      | ORG              | ORG               | ORG      | The prototype renders "Within ₹1,500 cap" and "Domestic per-diem is ₹2,500". Those are persisted policy numbers (D1) and need a read permission, or the UI would have to hardcode them                    |
| `holiday:read`                                                                      | ORG      | ORG              | ORG               | ORG      | Already used by the leave day-count calculation and the Home holidays card                                                                                                                                |
| `security:account:unlock`                                                           | —        | —                | ORG †§            | —        | §2.6 could create locks with no administrative way to clear them                                                                                                                                          |
| `notification:mark_read:self`                                                       | SELF     | SELF             | SELF              | SELF     | The notification dot count is persisted state and must be mutable by its owner                                                                                                                            |
| `approval:task:act`                                                                 | —        | DIRECT_REPORTS § | ORG §             | ORG §    | The unified Approvals inbox in `API.md`; it is a _router_, and acting through it re-checks the underlying domain permission — it never substitutes for one                                                |
| `role:read`                                                                         | —        | —                | ORG               | —        | Granting a role requires listing roles                                                                                                                                                                    |
| `policy:archive`, `announcement:pin`, `faq:read`, `faq:manage`, `ticket:close:self` | per §4.4 |                  |                   |          | Present in §4.4 but absent from the old grammar's verb list                                                                                                                                               |

### 4.4 Permission matrix

> **Read the left-hand column as a _label_, not as a permission string.** These tables predate
> the grammar decision of §4.3 (R1) and are retained verbatim because their _content_ — the
> scopes, the `†`/`‡`/`§` markers and the guard notes — is correct and load-bearing. The
> **permission string** for each row is the canonical seeded `permission.code` given by §4.3.1's
> mapping and listed in full in `ARCHITECTURE.md` §4.3. A route guard, a `state_transition` seed
> row, `packages/shared`'s union and `audit_event.actor_permission_code` all carry the canonical
> form and **never** the `verb:resource[:qualifier]` label below; `read:payslip:self` is not a
> string that exists anywhere in the running system.

Legend for cells: the **ABAC scope** the role gets for that permission, or `—` for no grant.
`SELF` appears on its own row group first because every authenticated user holds `EMPLOYEE`.
`†` = requires step-up MFA (§2.7). `‡` = maker-checker, actor ≠ the actor of the preceding step (§4.9).
`§` = self-dealing forbidden: denied when the resource's subject employee is the actor (§4.9).

#### Identity, profile and PII

| Permission                           | Employee | Manager        | HR     | Accounts | Produces / guards                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------- | -------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read:profile:self`                  | SELF     | SELF           | SELF   | SELF     | Profile screen, all four tabs                                                                                                                                                                                                                                                                                                                                                                             |
| `update:profile:self`                | SELF     | SELF           | SELF   | SELF     | Contact fields only: personal email, mobile, current address. Name/DOB/gender are request-only                                                                                                                                                                                                                                                                                                            |
| `create:profile_change_request:self` | SELF     | SELF           | SELF   | SELF     | "Request a change" on Profile; creates a `profile_change_request` + a linked Help-desk ticket                                                                                                                                                                                                                                                                                                             |
| `read:profile:full`                  | —        | DIRECT_REPORTS | ORG    | —        | Full personal tab incl. DOB, personal contact, addresses                                                                                                                                                                                                                                                                                                                                                  |
| `approve:profile_change_request`     | —        | —              | ORG §  | —        | Applies the change in one transaction with the audit write                                                                                                                                                                                                                                                                                                                                                |
| `read:directory`                     | ORG      | ORG            | ORG    | ORG      | Directory screen. Restricted DTO: name, designation, department, work location, **work** email, **work** phone, manager. Never personal contact, DOB, or compensation. Attribute predicate: `employee.status = 'ACTIVE'` — a departed colleague disappears from the directory rather than lingering as an org-wide contact record, and an `EX_EMPLOYEE` actor has no `directory:read` grant at all (§2.5) |
| `read:reporting_line`                | ORG      | ORG            | ORG    | ORG      | The reporting-line widget; read from `employee_reporting_closure`                                                                                                                                                                                                                                                                                                                                         |
| `read:emergency_contact:self`        | SELF     | SELF           | SELF   | SELF     | Emergency contacts tab                                                                                                                                                                                                                                                                                                                                                                                    |
| `update:emergency_contact:self`      | SELF     | SELF           | SELF   | SELF     |                                                                                                                                                                                                                                                                                                                                                                                                           |
| `read:emergency_contact`             | —        | DIRECT_REPORTS | ORG    | —        | Implements the persisted policy note "Emergency contacts are visible only to People Ops and your manager"                                                                                                                                                                                                                                                                                                 |
| `read:bank_account:masked:self`      | SELF     | SELF           | SELF   | SELF     | `•••• •••• 4412` — masking applied server-side (§7.5)                                                                                                                                                                                                                                                                                                                                                     |
| `read:bank_account:full`             | —        | —              | —      | ORG †    | **HR cannot see full bank numbers.** Only Accounts, only for payroll execution, always step-up, always audited with the subject employee id                                                                                                                                                                                                                                                               |
| `create:bank_change_request:self`    | SELF †   | SELF †         | SELF † | SELF †   | Requires a cancelled-cheque upload (§5.3)                                                                                                                                                                                                                                                                                                                                                                 |
| `verify:bank_change_request`         | —        | —              | —      | ORG †§   | The "verified by Payroll within 2 working days" step; applies the new account and revokes the old                                                                                                                                                                                                                                                                                                         |
| `read:statutory_id:masked:self`      | SELF     | SELF           | SELF   | SELF     | `AXYPR••••K`, `•••• •••• 8821`                                                                                                                                                                                                                                                                                                                                                                            |
| `read:statutory_id:full`             | —        | —              | —      | ORG †    | PAN/UAN/PF/ESI for statutory filing and Form 16 only                                                                                                                                                                                                                                                                                                                                                      |
| `read:salary_structure:self`         | SELF     | SELF           | SELF   | SELF     | Only after the first payslip is published (D3)                                                                                                                                                                                                                                                                                                                                                            |
| `read:salary_structure`              | —        | —              | —      | ORG      | Managers never see compensation, including for their own reports                                                                                                                                                                                                                                                                                                                                          |
| `update:salary_structure`            | —        | —              | —      | ORG ‡    | Requires an HR-originated `compensation_change` record to exist; Accounts executes, HR authorises                                                                                                                                                                                                                                                                                                         |

#### Payroll (see `docs/WORKFLOWS.md` for the state machine)

| Permission                                                            | Employee | Manager           | HR    | Accounts | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | -------- | ----------------- | ----- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create:payroll_run`                                                  | —        | —                 | —     | ORG      | Creates the run for a `period` in `DRAFT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `upload:payroll_input`                                                | —        | —                 | —     | ORG      | **Step 1** of D3. CSV/XLSX validated per §5.3; every row persisted to `payroll_input_item` with the `file_object` id and row number for traceability; the batch is `COMMITTED` by a separate `payroll:input:commit` step before it counts as an input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `read:payroll_input`                                                  | —        | —                 | —     | ORG      | HR is excluded: input files carry compensation for the whole org                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `submit:attendance_period`                                            | —        | —                 | ORG   | —        | **Step 2.** HR submits the period for every employee in scope; transitions `attendance_period.status` `OPEN → HR_SUBMITTED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `read:attendance:self`                                                | SELF     | SELF              | SELF  | SELF     |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `read:attendance`                                                     | —        | DIRECT_REPORTS    | ORG   | ORG      | Accounts sees approved day counts only, never leave reasons                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `approve:attendance`                                                  | —        | DIRECT_REPORTS §‡ | —     | —        | **Step 3.** Manager approves their own reports' attendance. A manager's _own_ attendance is approved by their manager (`REPORTING_CHAIN depth 1` of the skip level); if none exists, HR approves under `approve:attendance:escalated`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `reject:attendance`                                                   | —        | DIRECT_REPORTS §‡ | —     | —        | Returns the period to HR with a mandatory reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `approve:attendance:escalated`                                        | —        | —                 | ORG § | —        | Only when the employee has no live `employee_manager` row or the manager is `SUSPENDED`/`OFFBOARDED`; the escalation reason is persisted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `validate:payroll_run`                                                | —        | —                 | —     | ORG      | **Step 4.** Server-side, deterministic: every in-scope employee has an approved attendance record, a salary structure effective for the period, a verified bank account, and **exactly one** matched `payroll_input_item` per `(employee, kind, pay_component)`. Matching is on `employee_code` (`^WDT-\d{5}$`), never on name or email; zero matches, two matches and a code naming an out-of-scope employee are three distinct, separately reported validation issues. The pass also persists `payroll_cycle.input_manifest_sha256` (§4.12 P-3), which is what stops inputs changing between validation and calculation. Failures are persisted as `payroll_validation_result` rows and rendered as a real blocking list — never as a generic error |
| `generate:payroll`                                                    | —        | —                 | —     | ORG      | **Step 5.** Enqueues the generation job; the job runs as the service identity but records `initiated_by_user_id`. Payslips are created in `GENERATED` (`ess_payslip_status`; there is no `DRAFT` member, R3) and are invisible to employees until a `payslip_publication` row exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `publish:payroll`                                                     | —        | —                 | —     | ORG †‡   | **Step 6.** Publisher MUST NOT be the uploader, the committer or the `payroll:approve` approver of the same cycle (§4.9, §4.12 P-2). Sets `payroll_cycle.status='PUBLISHED'`, `payslip.status='PUBLISHED'`, and inserts one `payslip_publication` row per payslip — **that row's existence is what makes a payslip visible** (§4.12 P-1). The PDF render job and the `PAYSLIP_PUBLISHED` notification are enqueued in the same transaction (P-8)                                                                                                                                                                                                                                                                                                      |
| `lock:payroll_run`                                                    | —        | —                 | —     | ORG †    | `payroll:close`. Post-publication freeze once the pay date has passed and reimbursements are settled; afterwards corrections are `payroll_correction` cycles producing new, superseding payslips — never edits (§4.12 P-5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `read:payslip:self`                                                   | SELF     | SELF              | SELF  | SELF     | **Guarded inside the repository function, not the controller.** The predicate printed here previously (`payroll_run.status IN ('PUBLISHED','LOCKED')`) is an **impossible query** — `ess_payroll_run_status` has no such members (R2/R3). The correct, buildable predicate is in §4.12 and is the _only_ way any code may reach a payslip row                                                                                                                                                                                                                                                                                                                                                                                                         |
| `download:payslip:self`                                               | SELF     | SELF              | SELF  | SELF     | Signed URL, 120 s, audited as `PAYROLL.PAYSLIP_DOWNLOADED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `email:payslip:self`                                                  | SELF     | SELF              | SELF  | SELF     | Destination is **always** the work email on record; no recipient is accepted from the client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `read:payslip:any`                                                    | —        | —                 | —     | ORG †    | Payroll support. Managers and HR are excluded — a manager must not see a report's net pay                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `read:payslip_source`                                                 | —        | —                 | —     | ORG      | The traceability view: payslip → `payslip_line` → `payroll_input_item` → `payroll_input_batch` → `file_object` → `attendance_record` → `attendance_approval`, plus `payroll_run.{engine_version, ruleset_sha256, input_manifest_sha256}` and `payslip.input_sha256`. Satisfies D3's audit requirement, and §4.12 P-7 makes it **verifiable** rather than merely displayable                                                                                                                                                                                                                                                                                                                                                                           |
| `read:tax_quarter:self` / `read:form16:self` / `download:form16:self` | SELF     | SELF              | SELF  | SELF     | Tax slips screen. Quarters with no persisted TDS render `—` (D5), never `₹0`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `issue:form16`                                                        | —        | —                 | —     | ORG †    | Creates the `document` row and the audit event                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

#### Leave

| Permission                                       | Employee | Manager          | HR     | Accounts | Notes                                                                                                             |
| ------------------------------------------------ | -------- | ---------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `create:leave_request:self`                      | SELF     | SELF             | SELF   | SELF     | Server recomputes working days from `holiday_calendar` + `week_pattern`; the client-computed day count is ignored |
| `read:leave_request:self`                        | SELF     | SELF             | SELF   | SELF     |                                                                                                                   |
| `withdraw:leave_request:self`                    | SELF     | SELF             | SELF   | SELF     | Only while `status='PENDING'`; a `409` otherwise                                                                  |
| `read:leave_request`                             | —        | DIRECT_REPORTS   | ORG    | —        | Accounts never sees leave reasons (free-text, often medical → A4/A6)                                              |
| `approve:leave_request` / `reject:leave_request` | —        | DIRECT_REPORTS § | ORG §‡ | —        | HR's grant is an audited override, not the normal path                                                            |
| `read:leave_balance:self`                        | SELF     | SELF             | SELF   | SELF     | Derived from `leave_balance_ledger`, never stored as a mutable number (D1)                                        |
| `read:leave_balance`                             | —        | DIRECT_REPORTS   | ORG    | —        | Powers the "Balance after: 9.5 days" line on the approvals card                                                   |
| `adjust:leave_balance`                           | —        | —                | ORG †  | —        | Writes a signed `leave_balance_ledger` entry with a mandatory reason; balances are never overwritten              |
| `read:holiday_calendar`                          | ORG      | ORG              | ORG    | ORG      |                                                                                                                   |
| `manage:holiday_calendar`                        | —        | —                | ORG    | —        |                                                                                                                   |

#### Expenses

| Permission                                                | Employee   | Manager          | HR   | Accounts | Notes                                                                                                                                                                             |
| --------------------------------------------------------- | ---------- | ---------------- | ---- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create:expense_claim:self`                               | SELF       | SELF             | SELF | SELF     | Amount validated against `expense_limit` server-side                                                                                                                              |
| `read:expense_claim:self` / `withdraw:expense_claim:self` | SELF       | SELF             | SELF | SELF     | Withdraw only while `SUBMITTED`                                                                                                                                                   |
| `read:expense_claim`                                      | —          | DIRECT_REPORTS   | —    | ORG      | HR has no business need                                                                                                                                                           |
| `approve:expense_claim` / `reject:expense_claim`          | —          | DIRECT_REPORTS § | —    | —        | Above `expense_limit.escalation_amount_minor` the required approver widens to `REPORTING_CHAIN depth 2` (skip level); the rule is data-driven from `expense_limit`, not hardcoded |
| `reimburse:expense_claim`                                 | —          | —                | —    | ORG †    | Links the claim to a `payroll_run` or a direct payment; sets `REIMBURSED`                                                                                                         |
| `read:expense_attachment`                                 | SELF (own) | DIRECT_REPORTS   | —    | ORG      | Bills frequently contain addresses and card fragments                                                                                                                             |

#### Benefits

| Permission                                            | Employee | Manager | HR     | Accounts | Notes                                                                                                                             |
| ----------------------------------------------------- | -------- | ------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `read:benefit_enrolment:self` / `read:dependent:self` | SELF     | SELF    | SELF   | SELF     |                                                                                                                                   |
| `create:dependent_change_request:self`                | SELF     | SELF    | SELF   | SELF     | Enrolment-window check is server-side from `benefit_plan_year.enrolment_window_opens_on`/`_closes_on`                             |
| `read:benefit_enrolment` / `read:dependent`           | —        | —       | ORG    | —        | **Managers and Accounts are excluded**: dependants include minors (A5) and enrolment implies health data (A6)                     |
| `approve:dependent_change_request`                    | —        | —       | ORG §† | —        |                                                                                                                                   |
| `read:benefit_deduction`                              | —        | —       | —      | ORG      | Accounts sees only the payroll-affecting _amount_ per employee per period — never the plan, the dependants or the medical context |
| `manage:benefit_plan`                                 | —        | —       | ORG    | —        |                                                                                                                                   |

#### Documents, letters, policies, announcements, directory

| Permission                                        | Employee | Manager        | HR     | Accounts                 | Notes                                                                                                             |
| ------------------------------------------------- | -------- | -------------- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `read:document:self` / `download:document:self`   | SELF     | SELF           | SELF   | SELF                     | Offer, appointment, appraisal, promotion, salary-revision letters                                                 |
| `read:document`                                   | —        | —              | ORG    | ORG (payroll class only) | Accounts is restricted by `document.class IN ('PAYSLIP','FORM16','TAX')` — an attribute predicate on top of `ORG` |
| `issue:document`                                  | —        | —              | ORG †  | —                        |                                                                                                                   |
| `create:letter_request:self`                      | SELF     | SELF           | SELF   | SELF                     | Salary certificate, address proof, employment verification                                                        |
| `issue:letter`                                    | —        | —              | ORG †  | —                        | Generates the PDF from persisted data; the addressee string is escaped into the template (§5.6)                   |
| `read:policy`                                     | ORG      | ORG            | ORG    | ORG                      | Only `policy_version.status='PUBLISHED'` **and** the version whose `applies_to` matches the employee's attributes |
| `acknowledge:policy:self`                         | SELF     | SELF           | SELF   | SELF                     | Writes `(employee_id, policy_version_id, status, acknowledged_at, ip_hash, user_agent_hash)`                      |
| `read:policy_acknowledgement:self`                | SELF     | SELF           | SELF   | SELF                     |                                                                                                                   |
| `read:policy_acknowledgement`                     | —        | DIRECT_REPORTS | ORG    | —                        | **Status and timestamp only** — a manager sees "pending/acknowledged", never any other content                    |
| `create:policy_version` / `update:policy_version` | —        | —              | ORG    | —                        | Drafts only; the published body is immutable                                                                      |
| `publish:policy_version`                          | —        | —              | ORG †‡ | —                        | Publisher ≠ author. Publication is what makes acknowledgements due; it is irreversible (supersede, never edit)    |
| `archive:policy`                                  | —        | —              | ORG †  | —                        |                                                                                                                   |
| `read:announcement`                               | ORG      | ORG            | ORG    | ORG                      | `PUBLISHED` + audience match                                                                                      |
| `create:announcement` / `update:announcement`     | —        | —              | ORG    | —                        |                                                                                                                   |
| `publish:announcement` / `pin:announcement`       | —        | —              | ORG ‡  | —                        |                                                                                                                   |

#### Help desk

| Permission                                                       | Employee | Manager | HR            | Accounts      | Notes                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------- | -------- | ------- | ------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create:ticket:self`                                             | SELF     | SELF    | SELF          | SELF          | Persisted first, then queued for `helpdesk@widedroptech.com` (§8.6)                                                                                                                                                                     |
| `read:ticket:self` / `comment:ticket:self` / `close:ticket:self` | SELF     | SELF    | SELF          | SELF          |                                                                                                                                                                                                                                         |
| `read:ticket:queue`                                              | —        | —       | ORG + queue   | ORG + queue   | Queue membership is an **attribute predicate**, not a scope: HR holds queues `HR`, `BENEFITS`, `IT_ACCESS`, `GENERAL`, `DATA_REQUEST`; Accounts holds `PAYROLL_TAX`, `EXPENSES`. A ticket outside the actor's queues is invisible (404) |
| `assign:ticket` / `resolve:ticket`                               | —        | —       | ORG + queue § | ORG + queue § | Cannot self-assign _and_ resolve one's own ticket                                                                                                                                                                                       |
| `read:faq`                                                       | ORG      | ORG     | ORG           | ORG           |                                                                                                                                                                                                                                         |
| `manage:faq`                                                     | —        | —       | ORG           | —             |                                                                                                                                                                                                                                         |

#### Notifications, audit, exports, administration

| Permission                                              | Employee   | Manager    | HR         | Accounts   | Notes                                                                                                                                                          |
| ------------------------------------------------------- | ---------- | ---------- | ---------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read:notification:self`                                | SELF       | SELF       | SELF       | SELF       | A notification is generated only for a recipient who already holds the permission+scope to see the underlying resource; the fan-out function re-checks (§4.10) |
| `read:audit:hr`                                         | —          | —          | ORG        | —          | HR/people-domain + authn/authz events                                                                                                                          |
| `read:audit:payroll`                                    | —          | —          | —          | ORG        | Payroll-domain events                                                                                                                                          |
| `verify:audit_chain`                                    | —          | —          | ORG        | ORG        | Read-only integrity verification endpoint (§8.4)                                                                                                               |
| `create:audit_event` / `update:*` / `delete:*` on audit | **nobody** | **nobody** | **nobody** | **nobody** | Audit rows are written only by `apps/api/src/audit/audit.ts` inside the request transaction. No HTTP route can create, edit or delete one                      |
| `export:employee_data`                                  | —          | —          | ORG †      | —          | Queued, one concurrent export per actor, watermarked with the actor and timestamp, CSV-injection-safe (§5.7), audited with the exact filter and row count      |
| `export:payroll_data`                                   | —          | —          | —          | ORG †      |                                                                                                                                                                |
| `invite:user` / `suspend:user` / `offboard:user`        | —          | —          | ORG †      | —          |                                                                                                                                                                |
| `grant:role` / `revoke:role`                            | —          | —          | ORG †‡§    | —          | HR cannot grant a role to themselves (§); granting `HR` or `ACCOUNTS` requires a second HR approver (‡)                                                        |
| `reset:mfa`                                             | —          | —          | ORG †§     | —          | Forces re-enrolment; notifies the user; never reveals a secret                                                                                                 |
| `revoke:session`                                        | —          | —          | ORG †      | —          |                                                                                                                                                                |
| `manage:org_unit` / `manage:reporting_line`             | —          | —          | ORG †      | —          | Any `manager_id` change rebuilds `employee_reporting_closure` in the same transaction (§4.2)                                                                   |
| `read:org_setting`                                      | ORG        | ORG        | ORG        | ORG        | Non-secret settings only (e.g. `mfa_grace_days`)                                                                                                               |
| `update:org_setting`                                    | —          | —          | ORG †      | —          |                                                                                                                                                                |

### 4.5 How Accounts is scoped away from non-payroll PII

Three independent layers, so a mistake in any one does not leak:

1. **Permission layer.** The `ACCOUNTS` column above simply contains no grant for
   `read:profile:full`, `read:emergency_contact`, `read:dependent`, `read:benefit_enrolment`,
   `read:leave_request`, `read:document` (non-payroll class) or `read:policy_acknowledgement`.
2. **DTO layer.** `apps/api/src/dto/employee.ts` exposes exactly **four** mappers —
   `toSelfProfileDto`, `toManagerEmployeeDto`, `toDirectoryDto`, `toPayrollEmployeeDto` — each one an
   explicit field allowlist, and an `EX_EMPLOYEE` actor is served `toSelfProfileDto` only (§2.5). A Prisma model is **never** serialised directly; an ESLint rule
   (`no-restricted-syntax`) forbids returning a Prisma result object from a route handler.
3. **Database layer.** Accounts' payroll code path reads through a dedicated read-only view:

```sql
CREATE VIEW payroll_employee_v AS
SELECT e.id, e.employee_code, e.full_name, e.org_unit_id, e.cost_centre,
       e.date_of_joining, e.employment_type, e.status, e.manager_id,
       e.work_email
FROM employee e;
-- deliberately excludes: date_of_birth, gender, blood_group, marital_status,
-- personal_email, personal_phone, current_address, permanent_address, nationality
GRANT SELECT ON payroll_employee_v TO ess_app;
```

Bank and statutory columns are reached through `employee_bank_account` / `employee_statutory_id` under
`read:bank_account:full` / `read:statutory_id:full` with step-up MFA, and are decrypted per-row with
the subject employee id recorded in the audit event — so "Accounts looked at 400 bank accounts in
5 minutes" is a detectable, alertable event (§11.4).

### 4.6 Server-side enforcement, deny-by-default, and the no-IDOR pattern

**Deny by default.** Every Fastify route MUST declare, in its route options, exactly one of:

```ts
config: { permission: 'read:payslip:self', scopeParam: 'employeeId' }   // guarded
config: { public: true, reason: 'login endpoint' }                      // explicitly public
```

`apps/api/src/plugins/authorize.ts` registers an `onRoute` hook that throws at **boot** if a route has
neither, and a `preHandler` that denies any request reaching a handler without a resolved
`request.authz` context. `apps/api/test/routes.guard.test.ts` walks the printed route table and
asserts the same invariant, so a new route cannot be merged unguarded.

**The complete unauthenticated / non-bearer surface.** The earlier "exactly five public routes"
sentence was wrong — it omitted routes this same document requires elsewhere, and the boot assertion
would have failed on them. This table is exhaustive and the boot assertion compares the live route
table against it by exact match, failing the process on any addition:

**This table and `API.md` §4.1 are one list.** Paths are canonical, namespaced and
`/api/v1`-prefixed; the bearer-less routes each name a single-use, purpose-scoped opaque token in
their stored record and are rejected on any other route, which is what `config.public.boundToken`
asserts at boot. There are **twelve** such routes — neither the "exactly five" of an earlier draft
of this section nor the "eight" of an earlier draft of `API.md` §4.1, both of which omitted routes
their own document required elsewhere:

| Route                                                                   | Credential it actually accepts                     | Extra controls                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/v1/auth/login`                                               | none (email + password in body)                    | §2.4 generic responses, 250 ms floor, §2.6 ladder, §9.1 IP + account limits. Returns `mfaToken` on success, never tokens                                                                                                 |
| `POST /api/v1/auth/mfa/challenge`                                       | `mfaToken` (§2.4), **not** a session               | 5-attempt consume, IP/UA binding, §9.1. Mints `mfa_at`                                                                                                                                                                   |
| `POST /api/v1/auth/mfa/recovery/use`                                    | `mfaToken`                                         | as above, plus forced TOTP re-enrolment                                                                                                                                                                                  |
| `POST /api/v1/auth/mfa/enrol`, `POST /api/v1/auth/mfa/verify-enrolment` | `mfaToken` **or** a session with fresh `reauth_at` | §2.7. These require `reauth_at`, never `mfa_at` — a first enrolment has no second factor to assert, and requiring one is a deadlock (`API.md` §4.3)                                                                      |
| `POST /api/v1/auth/refresh`                                             | `__Host-wd_rt` cookie only                         | §3.3 rotation + reuse detection, §3.5 clause 2. The **only** unsafe route exempt from `X-WD-CSRF`                                                                                                                        |
| `POST /api/v1/auth/logout`, `POST /api/v1/auth/logout-all`              | `__Host-wd_rt` cookie + `X-WD-CSRF`                | §3.5. Not exempt: by the time they are called the SPA holds a CSRF token                                                                                                                                                 |
| `POST /api/v1/auth/password-reset/request`                              | none                                               | always `202`, §9.1                                                                                                                                                                                                       |
| `POST /api/v1/auth/password-reset/confirm`                              | single-use reset token                             | §2.8                                                                                                                                                                                                                     |
| `POST /api/v1/auth/accept-invitation`                                   | single-use `invitationToken` (`user_invitation`)   | §2.5; sets the first password and forces MFA. This is the route an earlier draft called `/auth/activate`                                                                                                                 |
| `POST /api/v1/auth/password/forced-change`                              | single-use `changeToken`                           | The restricted session of §2.3; the authorize plugin denies every other route while it is live                                                                                                                           |
| `GET /api/v1/healthz`                                                   | none                                               | Returns exactly `{"status":"ok"}` with **no** version, build SHA, dependency status, uptime or hostname. A liveness probe is not a reconnaissance endpoint; the rich `GET /api/v1/readyz` lives on the internal listener |
| `POST /api/v1/csp-report`                                               | none                                               | §6.3 caps, §3.5 clause 7 exemption, 10 % sampling, never writes `audit_event`                                                                                                                                            |
| `OPTIONS *`                                                             | none                                               | Answered by the CORS plugin before authentication, for an allowlisted `Origin` only (`API.md` §1.1). The only method exempt from the permission assertion                                                                |

Internal-listener-only (not reachable from the internet at all, §3.2): `GET /.well-known/jwks.json`
(unprefixed at the origin root, per RFC 8615 — the single path in the system outside `/api/v1`),
`GET /api/v1/metrics`, `GET /api/v1/readyz` and `GET /api/v1/version`. These declare
`config: { internal: true }`, which the boot assertion rejects on the public instance.

Every other route in the system declares a `permission`. There is no third category.

**Authorization is never derived from the client.** The chain is:

```
Bearer token → verify signature/iss/aud/exp/alg → load session by sid (must exist, not revoked)
             → compare ver with app_user.token_version  (MISMATCH ⇒ 401 TOKEN_STALE, stop — §2.9;
                                                          never "repaired" by reloading mid-request)
             → resolve roles + scopes from user_role (60 s cache keyed by (user_id, token_version))
             → actor = { userId, employeeId, roles[], scopeOrgUnitIds[], mfaAt, authTime }
             → required = route.config.permission
             → grants = matrix[role][required] for every role held   (union, §4.7)
             → if none → 403 AUTHZ_DENIED (audited)
             → scope = widest grant for THIS permission
             → where = authzWhere(actor, required, scope)            (a Prisma where-fragment)
```

**The no-IDOR pattern.** Object access is never "fetch then check". The scope predicate is compiled
into the query:

```ts
// apps/api/src/authz/where.ts
const where = { ...authzWhere(actor, 'read:leave_request'), id: params.id };
const row = await prisma.leaveRequest.findFirst({ where });
if (!row) return reply.code(404).send({ code: 'NOT_FOUND' });
```

Rules:

- **`404`, not `403`, when the object is outside the actor's scope.** Returning `403` would confirm the
  id exists — an enumeration oracle over employee ids and payslip ids. `403` is reserved for
  "you can see this object but you may not perform this action on it" (e.g. a manager viewing a leave
  request they may read but not approve because it is their own).
- Self-scoped **writes** never accept an identity from the payload. `POST /leave-requests` has no
  `employeeId` field in its Zod schema at all; supplying one is an unknown key and is rejected (§5.1).
  The employee id comes from `actor.employeeId`.
- Nested writes (`create` with a relation id from the body) re-verify the parent's scope in the same
  transaction before inserting.
- Batch endpoints apply the scope predicate to the whole set and then assert
  `returned.length === requested.length`, failing the entire request with `404` otherwise — a partial
  success would leak which ids exist.
- Every cursor/pagination token is opaque and HMAC-signed with the actor's `sub`, so a cursor cannot be
  transplanted to another user's session.

### 4.7 Users holding multiple roles

1. **Permissions union.** The actor holds a permission if **any** held role grants it.
2. **Scope resolved per permission, as the _union of the resolved row sets_ — not "the widest scope
   wins".** For permission `p`, `authzWhere()` builds one predicate per granting role and ORs them:

   ```ts
   const fragments = rolesGranting(actor, p).map((r) => scopePredicate(actor, r, p));
   const where = fragments.length === 1 ? fragments[0] : { OR: fragments };
   ```

   The earlier rule — pick the single widest scope from the ordered chain
   `ORG > DEPARTMENT > REPORTING_CHAIN > DIRECT_REPORTS > SELF` — is **wrong whenever a scope is
   narrowed**, which is exactly the HRBP model this document mandates. Concretely: a user who is
   `HR(scope_org_unit_id = 'Design')` **and** `MANAGER` of a Platform Engineering team would, under
   "widest wins", resolve `profile:read_sensitive:any` to _ORG-narrowed-to-Design_ and thereby **lose
   access to their own direct reports** — a broader-looking scope that is a strict subset of the
   narrower one. The chain ordering is not a total order once `scope_org_unit_id` exists, so only a
   union is correct. The ordering survives solely as a tie-break for _which single scope label to
   record in `audit_event.actor_permission_code`'s companion field_, never as a filter.

   `ORG` with no `scope_org_unit_id` short-circuits the union (it subsumes every fragment); an `ORG`
   grant **with** `scope_org_unit_id` is a subtree predicate like any other and does not.

   Worked examples:
   - _Manager + HR_: `read:profile:full` → `ORG` (from HR). `approve:expense_claim` → `DIRECT_REPORTS`
     (HR grants it not at all, so the manager scope stands) — being HR does not let them approve any
     expense in the company.
   - _Manager + Accounts_: `read:bank_account:full` → `ORG`; `read:leave_request` → `DIRECT_REPORTS`;
     `read:payslip:any` → `ORG`. They still cannot approve their own team's attendance for a period
     in which they are a subject (§).
   - _HR + Accounts_ (a small-company reality): union gives both sides, but the maker-checker rules
     (‡) then bite: they cannot both author and publish a policy, nor both upload payroll input and
     publish the run. The system refuses and names the required second approver.

3. **HRBP narrowing composes by union across grants of the same role, never by widening to ORG.** If
   a user holds `HR(scope_org_unit_id = 'People Ops')` and `HR(scope_org_unit_id = 'Design')`, the
   reach of HR-granted permissions is the union of those two subtrees, **not** the whole org. Two
   narrow grants never add up to an unnarrowed one: the resolver treats `scope_org_unit_id IS NULL`
   as a distinct, stronger grant and never synthesises it. (The previous heading said "by
   intersection", which contradicted its own body text; union is correct — a person can be HRBP for
   two departments.)
4. **Deny always wins over union** for the `§` self-dealing and `‡` maker-checker rules: these are
   evaluated after the union and can only subtract.
5. The effective permission set is recomputed from `user_role` on every `ver` mismatch and cached
   in-process for at most 60 s keyed by `(user_id, token_version)`; a role change bumps
   `token_version`, so the cache is correct by construction.

### 4.8 Guard implementation surface

| File                                 | Responsibility                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/permissions.ts` | The permission string union (single source of truth, shared with the SPA for cosmetic gating)                     |
| `apps/api/src/authz/matrix.ts`       | The literal table from §4.4 as a typed const; exhaustiveness-checked against the permission union at compile time |
| `apps/api/src/authz/scopes.ts`       | `SELF`/`DIRECT_REPORTS`/`REPORTING_CHAIN`/`DEPARTMENT`/`ORG` resolution                                           |
| `apps/api/src/authz/where.ts`        | `authzWhere(actor, permission)` → Prisma where-fragment, per resource                                             |
| `apps/api/src/authz/predicates.ts`   | Attribute predicates: ticket queue membership, `document.class`, `payslip.published_at`, enrolment windows        |
| `apps/api/src/authz/separation.ts`   | `§` self-dealing and `‡` maker-checker evaluation                                                                 |
| `apps/api/src/plugins/authorize.ts`  | Fastify plugin: boot-time route assertion + `preHandler` guard + denial auditing                                  |
| `apps/web/src/lib/can.ts`            | **Cosmetic only.** Header comment states that hiding UI is not a security control                                 |

Tests that must exist: a matrix-driven table test that, for every (role, permission) pair marked `—`,
issues a real request with a session holding only that role and asserts `403`/`404`; a scope test per
resource asserting a manager cannot reach a non-report; a multi-role test per §4.7's worked examples;
and the boot-time unguarded-route assertion.

### 4.9 Separation of duties

| Rule                                                                                                                                                                      | Where enforced                                                                                             | Failure response                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| A user may not approve, verify or resolve an item whose subject employee is themselves (`§`)                                                                              | `separation.ts#denySelfSubject()`                                                                          | `403 {"code":"SELF_APPROVAL_FORBIDDEN"}` + audit                                       |
| Payroll publisher ≠ payroll-input uploader for the same run (`‡`)                                                                                                         | `publishPayrollRun()` transaction                                                                          | `409 {"code":"SEGREGATION_REQUIRED","requires":"a second Accounts approver"}`          |
| Policy publisher ≠ policy-version author (`‡`)                                                                                                                            | `publishPolicyVersion()`                                                                                   | same shape                                                                             |
| Granting `HR`/`ACCOUNTS`/`MANAGER` needs a second HR approver (`‡`)                                                                                                       | `role_grant_request` two-phase table                                                                       | grant stays `PENDING_APPROVAL` until a different HR user approves; both actors audited |
| HR may not grant a role to their own user (`§`)                                                                                                                           | `separation.ts`                                                                                            | `403`                                                                                  |
| The attendance approver for a manager's own record is their skip-level manager, else HR escalation                                                                        | `approveAttendance()`                                                                                      | `409` naming the required approver                                                     |
| The attendance **approver** must not be the HR user who **submitted** the period (`‡` on `attendance:approve:team`)                                                       | `approveAttendance()` compares against `attendance_submission.submitted_by_user_id`                        | `409 {"code":"SEGREGATION_REQUIRED"}`                                                  |
| The payroll **publisher** must differ from both the input **uploader/committer** and the **approver** of the same cycle — three distinct users where three exist          | `publishPayrollCycle()` (§4.12)                                                                            | `409` naming which of the two collides                                                 |
| An expense above `expense_limit.escalation_amount_minor` must be approved at `REPORTING_CHAIN depth 2`; the depth-1 manager's decision is rejected, not silently accepted | `approveExpenseClaim()` reads the limit row for the claim's category **as of the claim's `spent_on` date** | `409 {"code":"ESCALATION_REQUIRED","requiredApproverEmployeeId":…}`                    |
| A policy may not be **acknowledged** by anyone other than its subject employee — no HR "acknowledge on behalf" path exists (§4.13)                                        | route has no `employeeId` input at all                                                                     | n/a — unrepresentable                                                                  |
| A user may not approve a `role_grant_request` they raised, nor one that grants a role to themselves                                                                       | `separation.ts`                                                                                            | `403`                                                                                  |

**What `‡` means precisely, since it was ambiguous.** `‡` on a permission means: _the actor of this
step must not be the actor of the named preceding step of the same object_. The preceding step is
named in the row's Notes column and is resolved from persisted actor columns
(`…_by_user_id`), never from the audit trail — a control must not depend on a log being
queryable. Where only one user in the organisation holds the required role, the action is **blocked**
and the error names the missing second approver; it does not degrade to a warning. `org_setting`
carries no "allow single-approver mode" flag, deliberately: an org too small for segregation of
duties should feel that, not toggle it off.

### 4.10 Authorization of derived values (D1 + least privilege)

Badge counts, metric tiles, search results, notifications and to-do items are all produced by the same
`authzWhere()` predicates as the screens they summarise:

- The Approvals nav badge is `COUNT(*)` over exactly the query that populates the Approvals screen.
- Global search runs four scoped sub-queries (module / person / policy / payslip). The _person_ query
  uses the directory DTO, the _payslip_ query uses `read:payslip:self`, so search can never surface a
  row the user could not open.
- `notification` rows are created by `apps/api/src/notifications/fanout.ts`, which calls
  `canSee(recipient, resourceType, resourceId)` for every candidate recipient before inserting, and
  stores only a `resource_ref` plus a template key — **never** a rendered amount. The amount is
  resolved at read time through the same authorized query, so a stale or over-broad notification
  cannot leak a number.
- The payslip sub-query, the Home "latest payslip" card, the YTD tiles and every payslip
  notification compose `publishedPayslipWhere` (§4.12 P-1), so an unpublished payslip cannot surface
  through a count, a search hit or a notification either (§4.12 P-8).
- When a scoped query returns nothing, the API returns an empty collection with `total: 0` and the UI
  renders the designed empty state (D5). A denial is never rendered as a zero, and an _absent_
  measure is `null` (rendered `—`), not `0` — the three cases are specified in §4.11.1 and tested to
  be indistinguishable where they must be and distinguishable where they must be.

### 4.11 The anti-fabrication contract (D1 + D5), as an enforceable rule

D1 and D5 are stated as design principles everywhere else in this repository. They are also a
**security** requirement — a number that is not backed by persisted data is indistinguishable, to an
auditor, from a number an attacker injected — so they are specified here as testable rules.

**4.11.1 Absent, zero and denied are three different things, and the API must distinguish them.**

| Situation                                                      | API representation                                               | UI (per `design/DESIGN-SYSTEM.md` §8)                                                                                                                |
| -------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| No persisted row exists for this measure                       | the field is `null`, or the collection is `[]` with `"total": 0` | metric tile renders `—` in `--text-muted` with a sub-label saying _why_ (e.g. "No payslip published yet"); list renders the dashed empty-state block |
| Rows exist and the deterministic computation over them is zero | the field is `0` (an integer, in paise for money)                | renders `₹0` — which is a fact, not a placeholder                                                                                                    |
| The actor has no scope over the underlying rows                | identical to _absent_ (`null` / `[]` / `total: 0`)               | identical empty state                                                                                                                                |

The third row is a security property: an out-of-scope read must be **byte-identical** to an empty
one, or the empty state becomes an existence oracle ("HR's dashboard shows `—`, my manager's shows
`0`, therefore rows exist"). `apps/api/test/empty-vs-denied.test.ts` asserts this by diffing the two
responses for every collection endpoint.

Conversely, a denial is **never** rendered as a zero. A `0` in this system always means "we counted,
and the answer was none". This is the difference between "you have no leave left" and "we could not
tell you your leave", and the leave-request form must not let the user act on a confusion between
them.

**4.11.2 No server-side default may manufacture a value.**

- No DTO field has a non-null default. `?? 0`, `|| 0`, `?? '—'`, `?? 'N/A'` and
  `COALESCE(x, 0)` over a _measure_ column are banned by a Semgrep rule
  (`infra/semgrep/widedrop.yml#no-coalesce-measure`). `COALESCE` remains legal over a _flag_ or a
  _sort key_, never over money, a count, a balance, a percentage or a date.
- Aggregates return `null`, not `0`, when the underlying row set is empty:
  `SELECT sum(x) FROM …` already does this in Postgres, and the repository layer must not
  "helpfully" coerce it. `count(*)` legitimately returns `0` because counting an empty set _is_ zero.
- No money, count, rate, day-count, percentage or currency literal may appear in
  `apps/api/src/services/**` or `apps/web/src/**` outside a test or a unit-conversion constant. The
  Semgrep rule `no-business-literals` fails the build on one; the values live in
  `org_setting`, `expense_limit`, `leave_type`, `salary_component`, `benefit_plan`,
  `holiday_calendar` and `retention_rule`. This is what makes the prototype's `₹1,500 cap`,
  `2,500 per-diem`, `1.5 days per month accrual`, `30-day carry-forward` and `14-day MFA grace`
  auditable numbers rather than code.
- The prototype's sample arrays (`PAYSLIPS`, `PROFILE`, `PEOPLE`, `ANN`, `BAL`, `TAXQ`, `FORM16`,
  `EXP0`, `TK0`, `APR0`, `HIS0`, `BENEFITS`, `DEPENDENTS`, `DOCS`, `LET0`, `HOL`, `FAQ`) MUST NOT be
  ported. A CI grep fails the build if any of those identifiers appears under `apps/`.

**4.11.3 Derived values that the prototype fabricates, and where each must come from.**

Every one of these renders a number or a status in the prototype from a hardcoded literal. Each row
names the persisted source and the authorizing permission; none may be computed client-side.

| Prototype value                                                                                                    | Persisted source                                                                                                                                                                        | Permission                  | Empty state                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------- |
| Home YTD tiles (`Gross earned`, `Net credited`, `TDS deducted`, `PF contributed`) and their `5 payslips` sub-label | `payslip_fy_rollup` for the current FY (decrypted in-app, R7), and `count(*)` of **published** payslips                                                                                 | `payslip:read:self`         | `—` + "No payslip published in FY 2026–27 yet"                                    |
| `latestNet` / "your payslip for August is ready"                                                                   | the most recent payslip satisfying §4.12's visibility predicate                                                                                                                         | `payslip:read:self`         | Home card renders the empty state; the notification is never created (§4.12.6)    |
| Tax quarter amounts (`₹70,510`, `In progress`, `Upcoming`)                                                         | `tds_quarter` rows for the FY; a quarter with no row renders `—` and the `gray` "Upcoming" chip derived from the quarter's end date vs today — **never `₹0`**                           | `tax:quarter:read:self`     | `—`                                                                               |
| Leave balances and the progress-bar percentage                                                                     | `sum(leave_balance_ledger.delta)` per `leave_type`; `pct = round(left/total*100)` computed server-side and returned as an integer 0–100                                                 | `leave:balance:read:self`   | tile hidden if the employee has no entitlement row for that type; never a 0/0 bar |
| "Balance after: 9.5 days" on an approval card                                                                      | the same ledger sum minus the pending request's working days                                                                                                                            | `leave:balance:read:team`   | omitted from the card                                                             |
| Approvals nav badge / `pendingCount`                                                                               | `count(*)` over exactly the Approvals query                                                                                                                                             | `approval:task:act`         | badge absent at 0, not "0"                                                        |
| Expense stats (`Awaiting approval`, `Approved · paying 30 Sep`, `Reimbursed FY`, `4 claims since April`)           | `expense_claim` sums and counts by status, scoped to self; the pay date comes from the linked `payroll_cycle.scheduled_pay_date`                                                        | `expense:claim:read:self`   | `—` per tile                                                                      |
| Directory "Available" / "On leave" today                                                                           | an approved `leave_request` overlapping today, else an `attendance_record` for today. **If neither exists, the chip is omitted** — the prototype's blanket `Available` is a fabrication | `leave:request:read:team`   | no chip                                                                           |
| `Tenure: 4 years 2 months`                                                                                         | deterministic from `employment.date_of_joining` and today                                                                                                                               | `profile:read:self`         | omitted if no DOJ                                                                 |
| Policy `Pending` / `Acknowledged` chip and the Home to-do count                                                    | presence of a `policy_acknowledgement` row for the **current** `policy_version` (§4.13)                                                                                                 | `policy:ack:read:self`      | "You're all caught up" empty state                                                |
| Ticket reference `HD-4831`                                                                                         | `nextval('helpdesk_ticket_ref_seq')`, allocated server-side in the insert transaction                                                                                                   | `ticket:create:self`        | n/a                                                                               |
| Expense reference `EXP-2291`                                                                                       | `nextval('expense_claim_ref_seq')`                                                                                                                                                      | `expense:claim:create:self` | n/a                                                                               |
| Payslip reference `WDT-PS-2608-1847`                                                                               | persisted `payslip.reference`, generated at calculation from the cycle period and `employee_code`                                                                                       | `payslip:read:self`         | n/a                                                                               |
| Recovery-codes-remaining to-do                                                                                     | `count(*) FROM mfa_recovery_code WHERE used_at IS NULL`                                                                                                                                 | self                        | n/a                                                                               |
| Notification dot colours                                                                                           | `notification.severity` → the five design-system tones; never chosen client-side                                                                                                        | `notification:read:self`    | popover empty state                                                               |
| Greeting ("Good morning")                                                                                          | the **only** legitimate client-computed value in the shell: it derives from the viewer's clock and is not business data                                                                 | —                           | n/a                                                                               |

**4.11.4 Idempotency, so the UI cannot manufacture duplicates.**
Every `POST` that creates a business record (`leave:request:create:self`, `expense:claim:create:self`,
`ticket:create:self`, `document:request:create:self`, `policy:acknowledge:self`,
`payroll:input:upload`) requires an `Idempotency-Key` header (a client-generated UUIDv4). The key,
the actor and a hash of the canonicalised body are stored in
`idempotency_key(key, user_id, route, request_digest, response_status, response_body_digest, created_at, expires_at)`
with a unique index on `(user_id, route, key)` and a 24-hour TTL. A replay with the same digest
returns the **original** response; a replay with a different digest is `409 {"code":"IDEMPOTENCY_KEY_REUSED"}`.
Without this, a double-submitted leave form produces two requests, two approvals and a leave balance
that is wrong in the database — a D1 violation created by the client.

---

### 4.12 Payroll: the invariants that make D3 true

`docs/WORKFLOWS.md` §1 defines the state machine (`payroll_cycle`: `DRAFT · INPUTS_OPEN ·
INPUTS_LOCKED · ATTENDANCE_SUBMITTED · ATTENDANCE_APPROVED · VALIDATING · VALIDATION_FAILED ·
VALIDATED · CALCULATING · CALCULATED · APPROVED · PUBLISHED · CLOSED · CANCELLED`). This section
states the **security** invariants over it: what must be impossible, and the mechanism that makes it
impossible. Each is an integration test in `apps/api/test/payroll-invariants.test.ts`.

**P-1 — Payslip visibility has exactly one definition, in exactly one place.**

```ts
// apps/api/src/authz/predicates.ts — the ONLY expression of D3 in the codebase
export const publishedPayslipWhere = {
  status: { in: ['PUBLISHED', 'SUPERSEDED'] as const }, // SUPERSEDED stays readable: it was published once
  publication: { isNot: null }, // a payslip_publication row exists
  payrollCycle: { status: { in: ['PUBLISHED', 'CLOSED'] as const } },
};
```

Every path to a payslip composes this: `payslip:read:self`, `payslip:read:any`,
`payslip:download:self`, `payslip:email:self`, `GET /files/:id` when the object's
`file_object.purpose = 'PAYSLIP_PDF'`, global search, the Home "latest payslip" card, the YTD tiles,
`payslip_fy_rollup`, `tds_quarter`, and every notification fan-out. A Semgrep rule forbids
`prisma.payslip.find*` / `count` / `aggregate` in any file other than
`src/repositories/payslip.ts`, and that repository's every query is built from
`publishedPayslipWhere`. A `GENERATED` payslip is not "hidden by the UI" — it is unreachable by any
authenticated request, which is what D3 actually demands.

**P-2 — Order cannot be short-circuited, because each transition asserts the _persisted_ predecessor.**
`state_transition` (`DATA-MODEL.md` §2.1) makes an out-of-order transition unrepresentable, and
`trg_guard_state_transition` re-checks it on `UPDATE`, so even a direct SQL write cannot skip a step.
On top of that, each step re-derives its precondition from data rather than trusting the status:

| Step                          | Precondition re-derived from persisted rows                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 Accounts uploads            | cycle is `INPUTS_OPEN`; the file is `AVAILABLE` (AV-clean, §5.3)                                                     |
| 2 HR submits attendance       | every in-scope employee has an `attendance_record`; **no** `payroll_input_batch` is uncommitted                      |
| 3 Manager approves            | one `attendance_approval` per manager-slice; the approver is the **approver of record** (P-4); no slice is `PENDING` |
| 4 Validate                    | `attendance.every_slice_approved`; the full `payroll_validation_result` pass with zero `ERROR` rows                  |
| 5 Calculate                   | cycle is `VALIDATED` **and** `input_manifest_sha256` still matches (P-3)                                             |
| 6 Approve (`payroll:approve`) | every in-scope employee has exactly one `GENERATED` payslip; control totals reconcile                                |
| 7 Publish                     | cycle is `APPROVED`; publisher ∉ {uploader, committer, approver}                                                     |

**P-3 — The TOCTOU hole between validation and calculation is closed by an input manifest.**
Without this, Accounts could validate a clean cycle, upload a superseding input batch, and calculate
against inputs no one validated — passing every status check while producing unvalidated payslips.

- At the `VALIDATING` transition the server computes and persists
  `payroll_cycle.input_manifest_sha256 = SHA-256( JCS-canonical JSON of the ordered list of
{ payroll_input_batch.id, batch.file_sha256, batch.committed_at, item_count, parsed_total_minor }
for every COMMITTED batch, ‖ the ordered list of { attendance_record.id, approved_at, approval_id,
payable_days, lop_days } for every in-scope employee, ‖ the ordered list of
{ salary_structure.id, effective_from, version } in force for the period ) `.
- `payroll:calculate` recomputes the manifest and **aborts with `409 {"code":"INPUTS_CHANGED"}`** if
  it differs, emitting `PAYROLL.VALIDATION_INVALIDATED` (severity `WARN`).
- `payroll_run.input_manifest_sha256` (already in `DATA-MODEL.md` §10.6.1) is set from the value that
  was actually calculated against, so a published payslip is provably traceable to a specific,
  validated input set.
- Any write that would change a manifest input while the cycle is `VALIDATED` or later — committing a
  batch, reopening attendance, changing a salary structure effective in the period — is refused by a
  `CHECK`-backed guard clause and by `attendance_period.status='LOCKED'`, not merely by convention.

**P-4 — The approver of record is snapshotted, so a reorg cannot rewrite who approved.**
`DIRECT_REPORTS` resolves against the _current_ `employee.manager_id`. If attendance approval used
that live value, a manager change mid-period would (a) strand a pending approval with no one able to
act on it, and (b) let a **new** manager approve a period they had no visibility of. Therefore
`attendance_approval.approver_employee_id` is written **at submission time** from the reporting line
in force on `attendance_period.period_end`, and the authorization check for
`attendance:approve:team` is `attendance_approval.approver_employee_id = actor.employeeId` — an
equality against a persisted snapshot, not a live closure lookup. If that employee is no longer
`ACTIVE`, the only route forward is `attendance:approve:any` (HR escalation) with a persisted reason.
The same snapshot rule applies to `leave_request.approver_employee_id` and
`expense_claim.approver_employee_id`, set when the request is submitted.

**P-5 — Published is terminal for amounts.** After `PUBLISHED` there is no edit path: `payslip`
columns are immutable (trigger), corrections are a `payroll_correction` (`WORKFLOWS.md` §1.10.3)
producing a **new** `payroll_run` whose payslips supersede the old ones, and the superseded payslip
stays readable so the employee's history is not silently rewritten. `payroll:close` freezes the
cycle. `REVOKED` is reserved for a payslip published in error; it disappears from the employee's list
and its revocation is an audited, reason-bearing event — it does not delete the row.

**P-6 — Accounts sees payroll, not people.** `payroll:input:read` and `payroll:export` return only
the columns in `payroll_employee_v` (§4.5) joined to payroll amounts. A payroll input file that
contains a column outside the template allowlist is rejected at parse (§5.3.9), so Accounts cannot
smuggle arbitrary employee attributes into a table they may read.

**P-7 — Every published amount is traceable, and the traceability is verifiable, not asserted.**
`payslip.amount_sha256 = SHA-256( JCS-canonical JSON of { payslipId, employeeId, cycleId,
payrollRunId, engineVersion, rulesetSha256, inputManifestSha256, attendance: {payableDays, lopDays,
approvalId}, structure: {salaryStructureId, version}, lines: [{code, sequence, amountMinor,
basisAmountMinor}] sorted by sequence } )`, computed **after** the lines are written and stored on the
payslip. Two digests exist and are not interchangeable (`DATA-MODEL.md` §10.7, `DEPLOYMENT.md` R-15):
**`payslip.input_sha256`** covers the _inputs_ (structure, attendance, committed input items) and is
what proves the calculation was fed the rows the validation pass froze; **`payslip.amount_sha256`**
covers the _decrypted amounts_ above and is what proves the published lines have not been edited.
`GET /payroll/cycles/:id/payslips/:pid/verify` (permission `payroll:cycle:read`) recomputes both and
returns `{ok, inputSha256, amountSha256, recomputed}`. A mismatch on either is
`SECURITY.PAYSLIP_DIGEST_MISMATCH` (`CRITICAL`, P1). This is what turns "traceable and auditable"
from a claim into a check a payroll auditor can run.

**P-8 — Nothing about an unpublished cycle leaks through a side channel.** No notification, no
badge count, no search result, no export, no email and no `document` row references a payslip before
publication; `payslip_publication` is the row whose creation _is_ publication, and the
`PAYSLIP_PUBLISHED` notification and the payslip PDF render job are enqueued in that same
transaction. The PDF itself is generated after publication; before it exists, `file:download:self`
has nothing to resolve, so even a leaked object key names no object.

---

### 4.13 Policy acknowledgement integrity (D7)

An acknowledgement is legal evidence (A7). It must be impossible to forge, impossible to lose, and
must say _what_ was agreed to — none of which the earlier one-line description guaranteed.

1. **One row per (employee, policy_version), created only by its subject.**
   `ux_policy_ack__employee_version UNIQUE (employee_id, policy_version_id)`. The route
   `POST /policies/versions/:versionId/acknowledge` has **no** `employeeId` in its schema; the id comes
   from `actor.employeeId`. There is no HR "acknowledge on behalf" permission anywhere in §4.4, and
   adding one would require an ADR explaining how the signature is still the employee's.
2. **Append-only.** `REVOKE UPDATE, DELETE ON policy_acknowledgement FROM ess_app`, plus a trigger.
   A mistaken acknowledgement is corrected by publishing a new version, never by deleting evidence.
   `WAIVED` is a separate, HR-created row kind carrying a mandatory reason — it is not an ack.
3. **The employee must have been shown the version they acknowledged.** The ack row stores
   `body_sha256_ack` copied from `policy_version.body_sha256`, and the write asserts it equals the
   version's current digest. Since `trg_policy_version_immutable` freezes the body at publication, the
   digest proves the exact text. A prior `POLICY.VIEWED` audit event for the same
   `(employee, policy_version)` is **required**: the API rejects an acknowledgement with
   `422 {"code":"POLICY_NOT_READ"}` if none exists. The directive is "read each applicable policy and
   explicitly acknowledge it"; without this the acknowledgement is a button, not a record.
4. **Stored fields**, per the directive, plus what makes it defensible:
   `(employee_id, policy_version_id, status, acknowledged_at, body_sha256_ack, ip_hash,
user_agent_hash, request_id, audit_event_id)`. `acknowledged_at` is `now()` from the database
   clock — never a client timestamp.
5. **Pending/overdue is computed, never stored** (matching `DATA-MODEL.md` §4061): an employee owes an
   acknowledgement when a `PUBLISHED` `policy_version` with `requires_acknowledgement` matches them via
   `policy_assignment` and no ack row exists. `OVERDUE` is that state past
   `acknowledgement_due_on`. This means the Home to-do count and the Policies "Pending" chip are
   deterministic functions of persisted rows — they cannot drift.
6. **`applies_to` is a persisted predicate, not prose.** The prototype's "All employees &
   contractors" / "Full-time employees · India" strings are _labels_. The machine-readable rule is
   `policy_assignment(policy_version_id, org_unit_id NULL, employment_type NULL, work_location_country NULL, employee_id NULL)`:
   a version applies to an employee if **any** assignment row matches on every non-null column it
   specifies. Assignment rows are written when the version is published and are immutable
   thereafter, so "who owed this acknowledgement" is answerable years later even after reorgs.
7. **Publishing a new version resets the obligation** for everyone the new version assigns, and does
   **not** delete the acks of the old version. `policy:publish` is `†‡` (publisher ≠ author).
8. `POLICY.ACKNOWLEDGED` is written in the same transaction and carries `policy_version_id` and
   `body_sha256_ack` in its payload — those are non-PII identifiers and are explicitly allowlisted in
   `audit-payload-schemas.ts`.

---

### 4.14 Help-desk queue routing (D8)

`ticket:read:any`, `ticket:assign` and `ticket:resolve` are gated by a **queue predicate**, so the
queue mapping must be persisted rather than inferred from a category string in code:

`helpdesk_queue(code, name, owner_persona, grievance_officer boolean, sla_first_response_hours, sla_resolution_hours)`
and `helpdesk_category(code, label, queue_code, is_active, sort_order)`.

| Prototype category          | `helpdesk_category.code` | Queue          | Owning persona                  |
| --------------------------- | ------------------------ | -------------- | ------------------------------- |
| Payroll & tax               | `PAYROLL_TAX`            | `PAYROLL_TAX`  | ACCOUNTS                        |
| IT & access                 | `IT_ACCESS`              | `IT_ACCESS`    | HR                              |
| Benefits                    | `BENEFITS`               | `BENEFITS`     | HR                              |
| Expenses                    | `EXPENSES`               | `EXPENSES`     | ACCOUNTS                        |
| HR / General                | `GENERAL`                | `GENERAL`      | HR                              |
| Data request (DPDP §11/§12) | `DATA_REQUEST`           | `DATA_REQUEST` | HR                              |
| Grievance (DPDP §13)        | `GRIEVANCE`              | `GRIEVANCE`    | HR (`grievance_officer = true`) |

A ticket whose queue is outside the actor's queue membership
(`user_queue_membership(user_id, queue_code)`) is invisible — `404`, not `403` (§4.6). Queue
membership is granted by HR alongside the role and is audited as `ADMIN.QUEUE_MEMBERSHIP_CHANGED`.
The SLA hours drive the "first response within 1 working day" copy the prototype shows; that string
must be rendered from `sla_first_response_hours`, not hardcoded (§4.11.2).

---

## 5. Input validation and output encoding

### 5.1 Zod at every boundary

`apps/api/src/plugins/validation.ts` wires Zod into Fastify's `validatorCompiler` and
`serializerCompiler` (via `fastify-type-provider-zod`). **Every** route declares four schemas; a
missing one is a boot-time failure alongside the permission assertion (§4.6):

```ts
schema: {
  params:  z.object({ id: z.string().uuid() }).strict(),
  querystring: PaginationQuery.strict(),
  body:    CreateLeaveRequestBody.strict(),
  headers: z.object({ 'x-request-id': z.string().uuid().optional() }).passthrough(),
  response: { 201: LeaveRequestDto, 400: ErrorDto, 403: ErrorDto, 409: ErrorDto },
}
```

Rules:

| Rule                                    | Detail                                                                                                                                                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.strict()` everywhere                  | Unknown keys are **rejected**, not stripped. Stripping silently accepts an attacker's `{employeeId: …}` and hides the attempt; rejecting surfaces it as a `400` and an audit-worthy signal. The only exception is `headers`, which must be `.passthrough()`            |
| No coercion of security-relevant fields | `z.coerce` is permitted for query-string numbers/dates only; never for ids, amounts or enums                                                                                                                                                                           |
| Ids                                     | `z.string().uuid()` — never `z.string()`. Employee codes: `/^WDT-\d{5}$/`                                                                                                                                                                                              |
| Money                                   | Integer **paise** (`z.number().int().min(0).max(10_000_000_00)`), never floats. Display formatting (`₹86,000`) happens in the SPA from the integer                                                                                                                     |
| Dates                                   | ISO-8601 date (`YYYY-MM-DD`) or instant; every date is re-validated against a business range (`>= date_of_joining`, `<= today + 365d`)                                                                                                                                 |
| Strings                                 | Every string has an explicit `.max()`. Defaults: subject 200, short note 500, long description 5000, address 300, name 120. `.trim()` then re-check min length                                                                                                         |
| Enums                                   | `z.enum([...])` from the shared const, never free strings                                                                                                                                                                                                              |
| Arrays                                  | Explicit `.max()` (attachments 5, batch ids 100)                                                                                                                                                                                                                       |
| Response serialisation                  | The `response` schema is enforced in production too. This is the last guard against accidental over-exposure: a field not in the DTO schema cannot be serialised even if the query returned it                                                                         |
| Body size                               | Global `bodyLimit: 128 KiB` for JSON; multipart handled separately (§5.3)                                                                                                                                                                                              |
| Parameter pollution                     | Fastify's default query parser returns arrays for repeated keys; schemas that expect a scalar reject arrays, so `?id=a&id=b` is a `400`                                                                                                                                |
| Content type                            | Only `application/json` and `multipart/form-data` are registered. `text/plain`, `application/x-www-form-urlencoded` and `application/xml` parsers are **not** registered — which also removes XXE from the threat surface entirely (there is no XML parser in the API) |
| Error shape                             | `400 {"code":"VALIDATION_FAILED","fieldErrors":{path:[messages]}}`. Messages are static strings from the schema; the submitted value is **never** echoed back (it may be a password or a PAN)                                                                          |

`422` is used for semantically valid but business-invalid input (breached password, leave exceeding
balance, expense above policy cap); `400` strictly for schema failures. The distinction matters
because the SPA renders `422` inside the form's inline error banner (the prototype's `lfErr`/`efErr`/
`tfErr` pattern) while `400` indicates a client bug.

### 5.2 Anti-prototype-pollution

- JSON body parser replaced with `secure-json-parse` in `protoAction: 'error', constructorAction: 'error'`
  mode — a body containing `__proto__` or `constructor.prototype` is rejected with `400` and audited
  as `SECURITY.SUSPICIOUS_PAYLOAD`.
- `.strict()` Zod objects reject those keys anyway; this is the belt to that's braces.
- Node runs with `--disable-proto=delete` in production (`NODE_OPTIONS` in the container spec).
- No deep-merge of user input anywhere. `lodash.merge`/`defaultsDeep` are banned by an ESLint
  `no-restricted-imports` rule; config merging uses explicit field assignment.
- Lookup maps built from user-controlled keys use `new Map()` or `Object.create(null)`.

### 5.3 File upload validation

Contexts and caps (`apps/api/src/files/upload.ts`, `@fastify/multipart`):

| Context                          | Permission                        | Allowed types                                                                   | Max size    | Max count            |
| -------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- | ----------- | -------------------- |
| Expense bill                     | `create:expense_claim:self`       | `application/pdf`, `image/jpeg`, `image/png`, `image/heic`                      | 10 MiB each | 5 per claim          |
| Bank proof (cancelled cheque)    | `create:bank_change_request:self` | `application/pdf`, `image/jpeg`, `image/png`                                    | 10 MiB      | 1                    |
| Payroll input                    | `upload:payroll_input`            | `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | 25 MiB      | 1 per run per upload |
| Policy / announcement attachment | `create:policy_version`           | `application/pdf`                                                               | 20 MiB      | 3                    |
| Help-desk attachment             | `create:ticket:self`              | pdf, jpeg, png                                                                  | 10 MiB      | 3                    |

Validation pipeline, in order — any failure aborts and deletes the temp file:

1. **Route-level authorization first.** The multipart stream is not even consumed until the permission
   check passes, so an unauthenticated client cannot make us buffer bytes.
2. **Size cap** enforced by the streaming parser (`limits.fileSize`), which truncates and errors
   rather than buffering the whole body.
3. **Extension** from the _declared_ filename must be in the context's allowlist (case-folded, after
   taking the last dot segment only). Double extensions (`x.pdf.exe`) therefore fail.
4. **Declared MIME** must be in the allowlist.
5. **Magic-byte sniffing** with `file-type` over the first 4 KiB. The sniffed type must equal the
   declared MIME **and** be consistent with the extension. A mismatch is a hard reject plus
   `SECURITY.UPLOAD_TYPE_MISMATCH`. (This is what stops a polyglot GIF/JS or a renamed HTML file.)
6. **SVG is never accepted anywhere**, in any context — it is an XSS vector by design.
7. **Images are re-encoded**, never stored as received: `sharp(buffer).rotate().resize({width:4000, height:4000, fit:'inside', withoutEnlargement:true}).jpeg({quality:82, mozjpeg:true})` (or `.png()`),
   with `.withMetadata(false)` so **all EXIF — including GPS coordinates — is stripped**. HEIC is
   transcoded to JPEG. Re-encoding destroys any appended payload and normalises the file.
8. **PDFs cannot be safely re-encoded**, so they are inspected: reject if the raw bytes contain
   `/JavaScript`, `/JS`, `/OpenAction`, `/AA`, `/Launch`, `/EmbeddedFile`, or `/RichMedia`; reject if
   encrypted; cap at 200 pages and 20 MiB. Accepted PDFs are served **attachment-only, never inline**
   (step 12), so even a missed active-content vector has no origin to run in.
9. **Antivirus runs _before_ any parser touches the bytes.** The earlier draft parsed CSV/XLSX at
   step 9 and scanned at step 10 — i.e. it fed unscanned attacker-controlled input to a parser, which
   is the one ordering that makes the scanner pointless. Corrected order: the file is streamed to a
   ClamAV sidecar (`clamd` INSTREAM) with a 60 s timeout; a clean verdict promotes `file_object` to
   `AVAILABLE`; a detection deletes the object and emits `SECURITY.UPLOAD_MALWARE_DETECTED` (P1);
   an unknown verdict or an unavailable scanner leaves the object `QUARANTINED` — invisible to every
   reader, retried with backoff, promoted only on a clean verdict. **Nothing downstream of this step
   may run against a non-`AVAILABLE` object**, and that includes image re-encoding, PDF inspection,
   spreadsheet parsing, hashing for `payslip.input_sha256`, and signed-URL issue. In production
   `CLAMAV_HOST` is mandatory (§10.2) and a missing scanner therefore stalls uploads rather than
   waving them through.
10. **CSV/XLSX** are parsed only once the object is `AVAILABLE`, in a worker thread, with:
    a 30 s wall-clock timeout; a 50 000-row cap; a 60-column cap; a **10 MiB compressed / 200 MiB
    decompressed / 100:1 ratio** cap enforced while streaming the OOXML zip (an XLSX is a zip archive
    and is otherwise a textbook decompression bomb); a hard rejection of any workbook containing
    external links, DDE/OLE objects, VBA (`xl/vbaProject.bin`), or a `xl/externalLinks/` part; and a
    column allowlist derived from `payroll_input_template`. Every accepted row is persisted to
    `payroll_input_item` with `row_number` and the `file_object` id. Formulas are never evaluated —
    cells are read as raw strings (`cellFormula` ignored, `cellText` only) and coerced by Zod. A
    rejected row is persisted too, with `is_rejected` and a reason, so the blocking list the UI shows
    is real data (§4.11).
11. **Storage key is server-generated and contains no user input**:
    `ess/<env>/<context>/<yyyy>/<mm>/<uuidv7>.<canonical-ext>`. The original filename is stored only
    as a `file.original_name` column, used for display and for `Content-Disposition`, and never for
    path construction. `file.sha256` is computed over the stored bytes for integrity (§7.4);
    `file.byte_size`, `file.content_type` (the sniffed one) and `file.uploaded_by_user_id` are
    persisted.
12. **Serving.** `GET /files/:id` authorizes the _entity_ that owns the file (an expense attachment is
    reachable only by someone who may read that claim) by composing that entity's own
    `authzWhere()` predicate — never by a standalone "can this user read files?" check. Three
    conditions are checked in addition, because a file is the easiest way to bypass a row-level
    guard:
    - `file_object.scan_status = 'AVAILABLE'` (step 9);
    - for `purpose = 'PAYSLIP_PDF'`, the owning payslip must satisfy `publishedPayslipWhere` (§4.12
      P-1) — the object key alone must never be sufficient;
    - `file_object.sha256` is re-verified against the stored bytes (§7.4) before a URL is signed.

    It then returns `302` to a storage-signed URL valid for **120 seconds**, single-object, with
    response-header overrides. `file_object.original_name` is capped at 200 characters at upload,
    NFKC-normalised, and stripped of control characters, path separators and RTL-override codepoints
    (`U+202E`) before it is ever used in a header or rendered:

```
Content-Disposition: attachment; filename="payslip.pdf"; filename*=UTF-8''payslip%20Aug%202026.pdf
Content-Type: <the sniffed type, never the declared one>
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; sandbox
Cache-Control: private, no-store
```

    The filename in `Content-Disposition` is sanitised: CR, LF, `"` and `\` removed, then RFC 5987
    percent-encoding for the `filename*` form. Never `inline`. Never a user-controlled `Content-Type`.

13. The bucket has public access blocked, no static website hosting, no CORS allowing `*`, and
versioning + object-lock (governance mode) on the payroll and document prefixes.

### 5.4 SQL injection posture

- Prisma Client is the only data-access path; all generated SQL is parameterised.
- `$queryRawUnsafe` and `$executeRawUnsafe` are **banned** by
  `no-restricted-properties` in ESLint, enforced in CI.
- Where raw SQL is genuinely needed (the recursive closure rebuild, the audit-chain verification scan,
  the `ON CONFLICT` rate-limit upsert), it uses the tagged template form `prisma.$queryRaw` so every
  interpolation becomes a bind parameter. Identifiers (table/column names) are never interpolated —
  they are literals in the template.
- Full-text search uses `websearch_to_tsquery($1)`; `ILIKE` searches escape `%`, `_` and `\` in the
  user term before binding.
- `ORDER BY` and pagination fields come from a closed `z.enum` mapped to a static column list — never
  from a raw string.
- The `ess_app` DB role has no DDL rights, no `pg_read_server_files`, and `search_path` is pinned.

### 5.5 SSRF

The API makes exactly **three** classes of outbound request: HIBP (§2.3), the email provider API
(§8.6), and S3-compatible storage. **No user-supplied URL is ever fetched** — there is no avatar-by-URL,
no webhook registration, no "import from link", and no link-preview feature. This is a design
constraint, recorded here so it is not quietly relaxed.

`apps/api/src/lib/safe-fetch.ts` wraps every outbound call:

1. The target host must be in `OUTBOUND_ALLOWLIST` (env, validated at boot): exactly
   `api.pwnedpasswords.com`, the mail provider host, the storage endpoint host.
2. Scheme must be `https:`; port must be 443.
3. DNS is resolved explicitly and every returned address is checked against a deny list —
   `127.0.0.0/8`, `::1`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (incl. the cloud metadata
   endpoint `169.254.169.254`), `100.64/10`, `192.0.0/24`, `198.18/15`, multicast, and all IPv6
   ULA/link-local. The connection is then pinned to the validated address to close the DNS-rebinding
   window.
4. `redirect: 'manual'` — redirects are never followed.
5. Timeouts: 2 s connect, 5 s total (storage uploads: 60 s). Response body capped at 1 MiB except for
   storage.
6. No request carries the caller's Authorization header, cookies or session context.

### 5.6 XSS and output encoding

| Surface                                                         | Rule                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All React rendering                                             | JSX auto-escaping. `dangerouslySetInnerHTML` is **banned** by `react/no-danger: error` with no allowed exceptions, enforced in CI                                                                                                                    |
| Rich bodies (policy body, policy key points, announcement body) | Stored as **structured JSON**, not HTML: `PolicyBlock = {type:'paragraph'                                                                                                                                                                            | 'heading' | 'bullet_list' | 'ordered_list' | 'link', text?, items?, href?}`, validated by a Zod schema (recursion depth ≤ 3, ≤ 500 blocks, ≤ 5000 chars per block). Rendered by `apps/web/src/components/RichText.tsx`, which switches on `type` and emits real React elements. **No HTML string is ever stored or rendered**, so there is nothing to sanitise at render time |
| Links inside rich bodies                                        | `href` must match `^https://` or `^mailto:` (Zod). Rendered with `rel="noopener noreferrer nofollow"` and `target="_blank"`. `javascript:`, `data:`, `vbscript:` and protocol-relative URLs are rejected at write time and re-checked at render time |
| HTML pasted by an author                                        | The editor converts paste to the block model client-side; the server additionally runs `DOMPurify` (jsdom) over any incoming `text` field with `ALLOWED_TAGS: []`, i.e. tags are stripped to text, before Zod validation                             |
| Generated PDFs (letters, payslips)                              | Rendered from a template where every substitution passes through a text-escaping function appropriate to the renderer; the addressee string from `letter_request.addressee` is treated as untrusted (it is free text from the employee)              |
| Emails                                                          | Text and a templated HTML part built with an auto-escaping template engine; no user string is ever concatenated into raw HTML or into a header                                                                                                       |
| CSV/XLSX exports                                                | See §5.7                                                                                                                                                                                                                                             |
| `Content-Type` of every API response                            | `application/json; charset=utf-8`, with `X-Content-Type-Options: nosniff`                                                                                                                                                                            |
| Trusted Types                                                   | `require-trusted-types-for 'script'` in the CSP (§6.3) turns any missed DOM-XSS sink into a runtime error rather than an injection                                                                                                                   |

### 5.7 CSV / formula injection

Every exported cell whose value begins with `=`, `+`, `-`, `@`, TAB (`0x09`), CR (`0x0D`) or LF
(`0x0A`) is prefixed with a single apostrophe and the whole field is quoted with internal quotes
doubled. Applied in `apps/api/src/export/csv.ts`, unit-tested with the OWASP payload set. XLSX exports
write cells with an explicit string type rather than letting the writer infer a formula.

### 5.8 Path traversal

The API serves **no** file from its own filesystem — there is no static-file plugin registered, and
`/files/:id` resolves through the database to a storage key. Storage keys are validated on read
against `^ess\/(dev|staging|prod)\/[a-z_]+\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.[a-z0-9]{2,5}$` before being
signed; a key that fails is a `500` and a `SECURITY.STORAGE_KEY_INVALID` audit event (it implies data
corruption or tampering). `..`, `%2e%2e`, backslashes, absolute paths and NUL bytes cannot appear in a
matching key. Download filenames go through `path.basename()` plus the header sanitisation in §5.3.12.

### 5.9 ReDoS

- No `new RegExp()` is ever constructed from user input. ESLint `security/detect-non-literal-regexp`
  is set to `error`.
- Every regex literal in the codebase is linear-time; `redos-detector` runs in CI over the source and
  fails the build on a finding. No nested quantifiers, no `(a+)+` shapes, no unbounded backtracking
  alternations.
- Every string is `.max()`-capped by Zod **before** any regex touches it, so even a pathological
  pattern is bounded.
- Search is `ILIKE`/`tsquery` in Postgres, never a regex, and the search term is capped at 80 chars.
- A 15 s Node-level request timeout and a 15 s Postgres `statement_timeout` bound the worst case.

### 5.10 Mass assignment

Update endpoints accept an explicit, minimal field set. `PATCH /me/profile` accepts exactly
`{personalEmail?, personalPhone?, currentAddress?}`; `status`, `employeeCode`, `managerId`,
`orgUnitId`, `dateOfJoining`, `salaryStructureId` and every statutory field are absent from the schema
and therefore rejected as unknown keys (§5.1). Prisma updates are written with explicit `data`
objects, never `data: req.body`, enforced by an ESLint rule.

### 5.11 Error handling contract

`apps/api/src/plugins/error-handler.ts` is the **only** place an error becomes a response. Without a
single serialiser, "errors never leak stack traces" (§13 A05) is an aspiration rather than a
mechanism.

| Rule                  | Detail                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Shape                 | Every error response is `{"code": "<SCREAMING_SNAKE>", "message": "<static, human, non-revealing>", "requestId": "<uuid>"}`, plus `fieldErrors` on `400` and `retryAfterSeconds` on `429`/`423`. Nothing else is ever added                                        |
| Closed code set       | `packages/shared/src/error-codes.ts` is a union; an unlisted code is a compile error. The SPA switches on `code`, never on `message`, so copy can change without breaking behaviour                                                                                |
| Unexpected errors     | Any throw that is not an `AppError` becomes `500 {"code":"INTERNAL","message":"Something went wrong.","requestId":…}`. The stack, the original message, the Prisma error code and the SQL are logged server-side against that `requestId` and **never** serialised |
| Prisma errors         | Mapped explicitly: `P2002` (unique) → `409 CONFLICT` with the _constraint's_ business meaning, never the column list; `P2025` (not found) → `404 NOT_FOUND`; `P2003` (FK) → `409`. A raw Prisma message never reaches a client — it names tables and columns       |
| Never in a body       | Stack traces, file paths, SQL, library versions, Node version, environment variable names, hostnames, internal ids the actor cannot otherwise read, or the submitted value (§5.1)                                                                                  |
| Serialisation failure | If a response fails its own `response` schema (§5.1), the handler returns `500 INTERNAL` and logs it as a defect. It must **never** fall back to sending the unvalidated object — that is precisely the over-exposure the schema exists to prevent                 |
| `404` vs `403`        | Per §4.6: out-of-scope object ⇒ `404`; visible object, forbidden action ⇒ `403`. The error handler cannot make this choice — it is made in the repository — so `AppError` carries it explicitly                                                                    |
| Correlation           | `requestId` is echoed in the `X-Request-Id` response header and stored on every related `audit_event`, so a user can quote it to the help desk and HR can find the exact event                                                                                     |
| Client display        | The SPA renders the designed inline error banner (`lfErr`/`efErr`/`tfErr` in the prototype) from `code`; a raw status code or `message` is never shown alone, and an error is never rendered as empty data (§4.11.1)                                               |

---

## 6. Transport and security headers

### 6.1 TLS

| Setting         | Value                                                                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum version | TLS 1.2; TLS 1.3 preferred and negotiated by default on both platforms                                                                                   |
| Ciphers         | Platform-managed modern suites; no RC4/3DES/CBC-SHA1; no renegotiation                                                                                   |
| Certificates    | Let's Encrypt via Netlify (`ess.widedrop.com`) and via the container host (`api-ess.widedrop.com`); auto-renewed; expiry monitored with a 21-day alert   |
| HTTP            | `301` to HTTPS on both hosts; no plaintext listener on the API                                                                                           |
| DB connection   | `sslmode=verify-full` with the provider CA bundle pinned in the image; `DATABASE_URL` must contain `sslmode=verify-full` or the boot check fails (§10.2) |
| Storage         | HTTPS only; signed URLs are HTTPS                                                                                                                        |

### 6.2 HSTS

```
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

Sent on `ess.widedrop.com` and `api-ess.widedrop.com`. **`preload` is deliberately omitted for now.**
`includeSubDomains` on a host does not affect siblings, but submitting `widedrop.com` to the preload
list would force HTTPS on _every_ current and future `*.widedrop.com` host, including ones owned by
the marketing site on a separate Netlify account. The preload submission is a tracked follow-up
(`infra/TODO-hsts-preload.md`) gated on an inventory confirming every subdomain is HTTPS-only.

### 6.3 Content-Security-Policy for the SPA — and the inline-style problem

The prototype expresses **539 inline `style="…"` attributes**, because its runtime computes layout from
a `ResizeObserver` and colours from status tones. A production CSP with `style-src 'unsafe-inline'`
would defeat much of the XSS defence, and a nonce cannot be used on a purely static Netlify site
without an edge function rewriting `index.html` per request. **Therefore the production CSS strategy
eliminates inline style attributes entirely**, rather than permitting or hashing them:

1. **Tokens as CSS custom properties.** Every value in `design/DESIGN-SYSTEM.md` §1–§3 becomes a
   custom property on `:root` in `apps/web/src/styles/tokens.css`, authored once and shipped as a
   static stylesheet.
2. **Component styles are compiled, not runtime.** CSS Modules (Vite built-in) — or vanilla-extract if
   the team prefers typed tokens — produce static `.css` files. No CSS-in-JS runtime that injects
   `<style>` elements at runtime, because those also violate `style-src 'self'` unless nonced.
3. **Discrete variation becomes data attributes, not inline styles.** Every dynamic style in the
   prototype is drawn from a closed set, so each maps to a CSS selector:
   - status tone (5 values) → `<span class="chip" data-tone="green|amber|red|blue|gray">`
   - department accent (6 + fallback) → `data-dept="platform-engineering|design|…"`
   - nav item active/inactive, tab active/inactive → `data-active="true|false"`
   - `compact` / `narrow` / `stack` from the `ResizeObserver` → `data-compact`, `data-narrow` on the
     shell element; `splitCols`/`formCols`/`calCols`/`apprCols` become four named grid classes whose
     template columns flip under `[data-stack="true"]`
   - toast offset (`28px` desktop / `86px` compact) → the same `[data-compact]` selector
4. **Continuous values become quantised classes.** The only genuinely continuous value in the
   prototype is the leave-balance progress bar, and the design system already rounds it to a whole
   percent (`Math.round(left/total*100)`). A build-time-generated stylesheet ships
   `.bar[data-pct="0"] … .bar[data-pct="100"] { inline-size: N%; }` (≈ 1.4 KiB gzipped). Any future
   continuous value follows the same pattern or is bucketed.
5. **Result:** zero `style` attributes in the shipped DOM, verified by a Playwright assertion
   (`document.querySelectorAll('[style]').length === 0`) in CI, and zero runtime `<style>` injection.

Exact production header, served by Netlify for `ess.widedrop.com`:

```
Content-Security-Policy:
  default-src 'none';
  script-src 'self';
  style-src 'self';
  style-src-attr 'none';
  style-src-elem 'self';
  img-src 'self' blob:;
  font-src 'self';
  connect-src 'self' https://api-ess.widedrop.com;
  manifest-src 'self';
  worker-src 'self';
  form-action 'none';
  frame-ancestors 'none';
  frame-src 'none';
  base-uri 'none';
  object-src 'none';
  media-src 'none';
  upgrade-insecure-requests;
  require-trusted-types-for 'script';
  trusted-types default;
  report-uri https://api-ess.widedrop.com/api/v1/csp-report;
  report-to csp
```

Notes on specific directives:

- `default-src 'none'` + explicit allowances means a directive we forgot fails closed.
- `script-src 'self'` with **no** `unsafe-inline`, no `unsafe-eval`, no nonce and no external origin.
  Vite must be configured accordingly: `build.modulePreload.polyfill = false`, no `@vitejs/plugin-legacy`
  (it injects inline scripts), and no inline runtime env injection — configuration reaches the SPA via
  a fetched `/config.json` or build-time `import.meta.env`, never an inline `<script>window.__ENV=…`.
- `blob:` in `img-src` supports client-side preview of a just-selected upload before it is sent. If
  preview is dropped, tighten to `'self'`.
- `form-action 'none'`: the SPA has no HTML form submissions — everything is `fetch`. This blocks a
  classic injected-form exfiltration.
- `frame-ancestors 'none'` is the modern clickjacking control; `X-Frame-Options: DENY` is also sent
  for older clients.
- `require-trusted-types-for 'script'` + `trusted-types default` converts any surviving DOM-XSS sink
  into a thrown `TypeError`.
- **`report-to csp` requires a group definition that the earlier draft never specified.** Netlify
  must also send, on every SPA response:

  ```
  Reporting-Endpoints: csp="https://api-ess.widedrop.com/api/v1/csp-report"
  ```

  `report-uri` is retained alongside it for browsers that have not yet migrated; both name the same
  endpoint. Without the `Reporting-Endpoints` header the `report-to` directive is inert and only the
  deprecated path works — which is how a "clean" report-only rollout can be clean because nothing was
  ever delivered.

- **`/api/v1/csp-report` must accept the content types browsers actually send.** §5.1 registers only
  `application/json` and `multipart/form-data`, but a `report-uri` delivery arrives as
  `application/csp-report` and a `report-to` delivery as `application/reports+json`. Both are
  therefore registered **on that route only**, via a route-scoped `addContentTypeParser` that reuses
  `secure-json-parse` (§5.2) and rejects anything over 8 KiB. Registering them globally would widen
  the parser surface for every other route, so it is deliberately local.
- `/api/v1/csp-report` accepts reports unauthenticated, is exempt from CSRF and CORS (§3.5 clause 7), is
  rate-limited by IP (§9.1), body-capped at 8 KiB, schema-validated against the CSP report shape with
  `.strip()` (not `.strict()` — browsers add fields), and sampled at 10 % into structured logs; it
  never writes to `audit_event` (an unauthenticated endpoint must not be able to grow the audit
  table). `blocked-uri`, `document-uri` and `script-sample` are truncated to 256 characters and are
  treated as **untrusted attacker-controlled strings** in every dashboard that renders them.
- A `Content-Security-Policy-Report-Only` variant with the same policy runs for one release before
  enforcement on any policy change.

**API responses** carry their own, maximally restrictive policy:

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox
```

### 6.4 The rest of the header set

Sent by `apps/api/src/plugins/security-headers.ts` (`@fastify/helmet` with explicit options) for the
API, and by `apps/web/public/_headers` / `infra/netlify/netlify.toml` for the SPA:

| Header                              | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Applies to                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `X-Content-Type-Options`            | `nosniff`                                                                                                                                                                                                                                                                                                                                                                                                                                              | both                                                                                   |
| `Referrer-Policy`                   | `strict-origin-when-cross-origin` on the SPA; `no-referrer` on the API                                                                                                                                                                                                                                                                                                                                                                                 | both                                                                                   |
| `X-Frame-Options`                   | `DENY`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | both (legacy companion to `frame-ancestors`)                                           |
| `Permissions-Policy`                | `accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(self), screen-wake-lock=(), usb=(), xr-spatial-tracking=()`                                                                                                                                                    | SPA (`publickey-credentials-get=(self)` is pre-provisioned for the WebAuthn follow-up) |
| `Cross-Origin-Opener-Policy`        | `same-origin`                                                                                                                                                                                                                                                                                                                                                                                                                                          | SPA                                                                                    |
| `Cross-Origin-Embedder-Policy`      | `require-corp`                                                                                                                                                                                                                                                                                                                                                                                                                                         | SPA                                                                                    |
| `Cross-Origin-Resource-Policy`      | `same-site`                                                                                                                                                                                                                                                                                                                                                                                                                                            | API                                                                                    |
| `X-Permitted-Cross-Domain-Policies` | `none`                                                                                                                                                                                                                                                                                                                                                                                                                                                 | both                                                                                   |
| `X-DNS-Prefetch-Control`            | `off`                                                                                                                                                                                                                                                                                                                                                                                                                                                  | SPA                                                                                    |
| `Origin-Agent-Cluster`              | `?1`                                                                                                                                                                                                                                                                                                                                                                                                                                                   | SPA                                                                                    |
| `Server` / `X-Powered-By`           | removed (helmet `hidePoweredBy`; the platform's own `Server` header is stripped at the edge where possible and is otherwise accepted as unavoidable and non-load-bearing)                                                                                                                                                                                                                                                                              | API                                                                                    |
| `Clear-Site-Data`                   | `"cache", "storage"` on `POST /auth/logout` and `/auth/logout-all` only (§3.4)                                                                                                                                                                                                                                                                                                                                                                         | API                                                                                    |
| `Cross-Origin-Embedder-Policy` note | `require-corp` is set on the SPA for defence in depth, not because `SharedArrayBuffer` is used. It is compatible with this design because every subresource is same-origin and the only cross-origin traffic is CORS `fetch`, which COEP does not gate. If a future third-party asset is ever introduced it must ship `Cross-Origin-Resource-Policy`, or this header must be relaxed to `credentialless` in a reviewed change — never silently dropped | SPA                                                                                    |

### 6.5 CORS

`@fastify/cors` in `apps/api/src/plugins/cors.ts`:

```ts
{
  origin: (origin, cb) => cb(null, ALLOWED_ORIGINS.includes(origin)),   // exact string match
  credentials: true,
  methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Authorization','Content-Type','X-WD-CSRF','X-Request-Id'],
  exposedHeaders: ['X-Request-Id','Retry-After'],
  maxAge: 600,
  strictPreflight: true,
}
```

| Rule                                                               | Detail                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist                                                          | `ALLOWED_ORIGINS` is an env array validated at boot; production contains exactly `https://ess.widedrop.com`. Staging contains exactly `https://ess-staging.widedrop.com`                                                                                                                                                                                                                                                                                                                    |
| No wildcards, ever                                                 | No `*`, no regex, no `endsWith('.widedrop.com')` — that last one is the classic bug that would re-admit T-SUB                                                                                                                                                                                                                                                                                                                                                                               |
| Netlify deploy previews                                            | Deploy-preview URLs (`*.netlify.app`) are **not** allowlisted against production. Previews point at the staging API, which has its own origin allowlist and its own database with no production data                                                                                                                                                                                                                                                                                        |
| `credentials: true`                                                | Required for the refresh cookie; safe only because the origin allowlist is exact                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Vary: Origin`                                                     | Always sent, so a CDN cannot serve one origin's CORS headers to another                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Requests with no `Origin`                                          | Permitted for `GET /api/v1/healthz` and `POST /api/v1/csp-report` only; every other route requires a matching `Origin` on unsafe methods (§3.5)                                                                                                                                                                                                                                                                                                                                             |
| **CORS is not an access control, and this callback is not a gate** | `cb(null, false)` makes `@fastify/cors` _omit_ the CORS headers — it does **not** reject the request, and the handler still runs. A non-browser client (curl, a server-side attacker, a compromised CI job) is entirely unaffected by CORS. The enforcement that actually rejects is the `Origin` + fetch-metadata check in §3.5 on unsafe methods, and the `Authorization`-bearer requirement on safe ones. CORS here only stops a _browser_ on another origin from **reading** a response |
| Preflight                                                          | `strictPreflight: true` requires both `Origin` and `Access-Control-Request-Method`; a malformed preflight is `400`, not a silent allow                                                                                                                                                                                                                                                                                                                                                      |
| Header allowlist                                                   | `allowedHeaders` is exact and closed. `Idempotency-Key` (§4.11.4) is added to it; anything not listed is rejected by the browser at preflight, so a new client header cannot appear without a deliberate change here                                                                                                                                                                                                                                                                        |

### 6.6 Cache headers

| Response class                                     | Headers                                                                                                                                                                                                                                            |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Every authenticated API response**               | `Cache-Control: no-store`, `Pragma: no-cache`, `Vary: Origin, Authorization`. Set by a global `onSend` hook, not per-route, so a new route cannot forget it. This is what keeps a payslip out of a corporate proxy or a shared-machine back-button |
| API error responses                                | same                                                                                                                                                                                                                                               |
| `GET /api/v1/healthz`                              | `Cache-Control: no-store` (it is trivial, and caching hides outages)                                                                                                                                                                               |
| Signed file URLs                                   | `Cache-Control: private, no-store` via response-header override                                                                                                                                                                                    |
| SPA `index.html`, `/config.json`                   | `Cache-Control: no-store` — guarantees a security-header or CSP change reaches clients on the next navigation                                                                                                                                      |
| SPA hashed assets (`/assets/*.js`, `*.css`, fonts) | `Cache-Control: public, max-age=31536000, immutable` — safe because the filename contains a content hash                                                                                                                                           |
| SPA `/sw.js` if ever added                         | `Cache-Control: no-store`                                                                                                                                                                                                                          |

No API response is ever marked `public`, and there is no CDN in front of `api-ess.widedrop.com`.

---

## 7. Encryption

### 7.1 At rest — the two layers

**Layer 1 — platform.** Managed PostgreSQL 16 with provider-managed volume encryption (AES-256),
encrypted automated backups and encrypted PITR WAL archives. Object storage has SSE-S3/SSE-KMS
enabled bucket-wide. This defends against disk/backup theft (T-PLAT, physical) but **not** against
anyone who can run `SELECT`.

**Layer 2 — application-layer envelope encryption (AES-256-GCM)** on the columns below. This is what
makes a stolen dump, a mis-scoped read replica, a support-engineer `psql` session, or a leaked backup
useless for the highest-value data, because the keys live outside the database.

| Table.column                                                                                                     | Contains                      | Encrypted                                          | Blind index          | Masked read               |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------- | -------------------- | ------------------------- |
| `statutory_identity.pan_ciphertext`                                                                              | PAN                           | ✔                                                  | `pan_fpr`            | `AXYPR••••K`              |
| `statutory_identity.aadhaar_ciphertext`                                                                          | Aadhaar                       | ✔                                                  | `aadhaar_fpr`        | `•••• •••• 8821`          |
| `statutory_identity.uan_ciphertext`                                                                              | UAN                           | ✔                                                  | —                    | `1012 3456 ••••`          |
| `statutory_identity.pf_account_ciphertext`                                                                       | PF account                    | ✔                                                  | —                    | last 7 chars              |
| `statutory_identity.esi_ciphertext`                                                                              | ESI                           | ✔                                                  | —                    | last 4                    |
| `bank_account.account_number_ciphertext`                                                                         | Bank a/c                      | ✔                                                  | `account_number_fpr` | `•••• •••• 4412`          |
| `bank_account.account_number_last4`                                                                              | last 4 digits, plaintext      | ✘ (derived, stored for masking without decryption) | —                    | shown as-is               |
| `bank_account.ifsc`                                                                                              | IFSC                          | ✘ (public routing code, not secret)                | —                    | shown                     |
| `bank_account.name_on_account_ciphertext`                                                                        | Name on account               | ✔                                                  | —                    | HR/Accounts only          |
| `employee.date_of_birth_ciphertext`                                                                              | DOB                           | ✔                                                  | —                    | `••/••/1994` for non-self |
| `employee.personal_email_ciphertext`                                                                             | Personal email                | ✔                                                  | `personal_email_fpr` | `p•••••@gmail.com`        |
| `employee.personal_phone_ciphertext`                                                                             | Mobile                        | ✔                                                  | `personal_phone_fpr` | `+91 •••• •2234`          |
| `employee.current_address_ciphertext`                                                                            | Address                       | ✔                                                  | —                    | city + PIN only           |
| `employee.permanent_address_ciphertext`                                                                          | Address                       | ✔                                                  | —                    | city + PIN only           |
| `employee.blood_group_ciphertext`, `.marital_status_ciphertext`, `.gender_ciphertext`, `.nationality_ciphertext` | Sensitive personal attributes | ✔                                                  | —                    | hidden                    |
| `emergency_contact.name_ciphertext`, `.phone_ciphertext`, `.relationship_ciphertext`                             | A5                            | ✔                                                  | —                    | hidden                    |
| `dependent.name_ciphertext`, `.date_of_birth_ciphertext`, `.relationship_ciphertext`                             | A5, includes minors           | ✔                                                  | —                    | hidden                    |
| `mfa_credential.secret_ciphertext`                                                                               | TOTP secret                   | ✔                                                  | —                    | never readable            |
| `ticket_message.body_ciphertext`                                                                                 | Free-text PII channel (A12)   | ✔                                                  | —                    | queue members only        |
| `profile_change_request.payload_ciphertext`                                                                      | Proposed PII values           | ✔                                                  | —                    | —                         |

**Compensation columns (A1) — corrected: they ARE application-encrypted.**

An earlier revision of this section listed `payslip.*`, `payslip_line.*` and `salary_structure.*` as
deliberately *un*encrypted, on the grounds that aggregation would otherwise force a decrypt-in-app.
That reasoning is withdrawn (R7), and `docs/adr/0004-payroll-columns-not-app-encrypted.md` is
superseded by `docs/adr/0009-payroll-columns-encrypted.md`. Per `DATA-MODEL.md` class **M1**, the
following are envelope-encrypted like every other restricted column:

| Table.column                                                                                       | Contains               |
| -------------------------------------------------------------------------------------------------- | ---------------------- |
| `salary_structure.annual_ctc_minor`, `salary_structure_component.amount_minor`                     | Compensation           |
| `payroll_input_item.amount_minor`                                                                  | Uploaded payroll input |
| `payslip_line.amount_minor`, `payslip_line.basis_amount_minor`                                     | Payslip lines          |
| `payslip.{gross_earnings,total_deductions,net_pay,employer_pf,tds}_minor`                          | Payslip totals         |
| `payslip_fy_rollup.{gross_earned,net_credited,total_deductions,tds,employee_pf,employer_pf}_minor` | FY rollup              |
| `tds_quarter.tds_deducted_minor`                                                                   | Quarterly TDS          |
| `employee_tax_declaration{,_item}` amounts                                                         | Declarations           |

Two things make this practical rather than merely principled:

1. **The aggregates are persisted, not computed at read time.** `payslip_fy_rollup` is one row per
   employee per financial year and `tds_quarter` one row per employee per quarter, both folded
   forward inside the publication transaction (`WORKFLOWS.md` PAY-17). Rendering the Home YTD tiles
   therefore costs **one** AES-GCM decrypt, not a scan. Encrypting the payslip rows while leaving the
   rollup in plaintext would have been the worst of both worlds — it would hand an attacker a
   ready-made annual-compensation table for the whole organisation in a single `SELECT`.
2. **D1 is unaffected.** The tiles are still a deterministic computation over persisted data; the
   computation simply happens in the application after an authorized decrypt rather than in SQL. §14.2's
   "server-side aggregation" rule is amended accordingly: aggregation of M1 columns happens in the API
   process over the persisted rollup row; aggregation of non-M1 columns (counts, day counts, ticket
   and claim counts) continues to happen in SQL. In neither case is a row set shipped to the client
   "just in case".

Consequences that must be honoured: `ORDER BY net_pay`, `WHERE net_pay > x` and `SUM(net_pay)` in SQL
are **impossible** and any such requirement is met from the rollup or refused; payroll control totals
are computed during calculation and stored (encrypted) on `payroll_run`, not recomputed by scanning.

**Deliberately _not_ application-encrypted, with justification:**

- `employee.full_name`, `work_email`, `work_phone`, `designation`, `org_unit_id`, `employee_code` —
  ORG-visible by design (the Directory screen); encrypting them would encrypt the directory itself.
- `bank_account.ifsc` — a public bank routing code, not a secret.
- `bank_account.account_number_last4` — a derived masking helper (see the table above), stored
  precisely so a masked read performs no decryption.
- `policy_acknowledgement` — integrity matters, confidentiality does not; protected by the hash chain
  and by append-only grants (§4.13).
- `audit_event` payloads — already redacted at write time (§8.5); encrypting them would make the
  chain unverifiable without key access, defeating the point of an independently checkable record.

### 7.2 Envelope scheme

```
KEK  (Key Encryption Key)  — AES-256, held in the cloud KMS (preferred) or, where KMS is
                             unavailable on the chosen container host, as MASTER_KEK_V<n> in the
                             platform secret store. Never in Postgres. Never in the repo.
DEK  (Data Encryption Key) — AES-256, generated by the app, used to encrypt column values.
                             Stored only in wrapped form.
```

**The key table is `data_encryption_key` (`DATA-MODEL.md` §17.3), not `data_key`** — R15. Its
columns are `(id uuid pk, organization_id, version integer, purpose text, wrapped_key bytea,
kms_key_arn text, algorithm text, status text, activated_at, retired_at, rotation_due_on)`, with
`ux_dek__org_purpose_version UNIQUE (organization_id, purpose, version)` and
`ux_dek__one_active` partial-unique on `(organization_id, purpose) WHERE status = 'ACTIVE'`.

`purpose` separates key domains so a compromise or rotation is contained, and the list is the
three of `DATA-MODEL.md` §17.3: **`FIELD_DEFAULT`** (all PII, statutory ids, bank accounts,
ticket bodies, dependants, nominees — the earlier `PII`/`STATUTORY`/`BANK`/`TICKET` split is
withdrawn, because four purposes over one uniform `_dek_id` envelope multiplies rotation surface
without changing the blast radius, which is already bounded by the per-row AAD), **`PAYROLL`**
(the class-M1 money envelopes) and **`MFA`** (TOTP secrets). `status` is
`PENDING` | `ACTIVE` | `RETIRED` | `COMPROMISED`; `RETIRING` is withdrawn and `COMPROMISED`
carries the four-step behaviour of `DATA-MODEL.md` §17.3. Unwrapped DEKs are cached in process memory for 15 minutes in a `Buffer` that is
explicitly zeroed on eviction; they are never written to disk, never logged, and never serialised.

**Ciphertext envelope format** (`apps/api/src/crypto/envelope.ts`). `DATA-MODEL.md` §1.6 splits the
envelope across sibling columns (`<field>_ct`, `_iv`, `_tag`, `_dek_id uuid`) and that is the
normative storage shape (R8). The single-`bytea` form below is the **wire and digest** form, used when
an envelope must be hashed, exported or moved as one value; the two are inter-convertible and
`envelope.ts` exposes both:

```
byte 0        : format_version, uint8, currently 0x01
bytes 1–2     : dek_ordinal, uint16 big-endian   -- data_encryption_key.ordinal (1..65535)
bytes 3–14    : iv, 12 bytes, CSPRNG, unique per encryption
bytes 15..n-17: ciphertext
bytes n-16..n : tag, 16 bytes (AES-256-GCM)
```

Two corrections to the earlier layout. First, `v1` was written as if it were a literal two-character
string while the rotation scan in §7.3.2 read the key id from byte offset 2 — the two could not both
be true. `format_version` is now an explicit single byte and every offset above is absolute.
Second, the key id was one byte while `data_encryption_key.id` was declared `smallint`, so 32 512 of its legal
values were unrepresentable in the envelope; the field is now **two** bytes, and
`data_encryption_key.ordinal smallint CHECK (ordinal BETWEEN 1 AND 32767)` is the value stored
(the table's own PK stays a uuid, per R8/R10). A fresh IV per encryption is mandatory and is asserted
by a unit test — GCM nonce reuse under one key is a total loss of confidentiality **and**
authenticity, which is the single worst mistake available in this design.

**AAD binds the ciphertext to its location:** `aad = utf8("<table>:<column>:<row_id>")`. This defeats
a privileged attacker who can `UPDATE` the table: copying employee A's encrypted PAN into employee B's
row produces an authentication-tag failure on decrypt, which is raised as
`SECURITY.CIPHERTEXT_AAD_MISMATCH` (severity `CRITICAL`) rather than silently returning A's data.
Because the row id is part of the AAD, encryption happens after the row id is known — for inserts the
id is generated in application code (UUIDv7) rather than by the database.

A decrypt failure **never** degrades to returning the raw bytes or an empty string; it throws, the
request returns `500 {"code":"DECRYPTION_FAILED"}`, and the event is alerted.

**Blind indexes** (`*_fpr bytea`, R9) enable exact-match lookup without decryption:
`fpr = HMAC-SHA256(BLIND_INDEX_KEY_V<n>, normalise(value))` — the **full 32 bytes**, not
truncated. The earlier 16-byte truncation is withdrawn: it bought nothing against an offline
confirmation attack (the attacker who can compute a candidate's MAC already has the key, and
without the key both widths are equally opaque) while it introduced a real collision surface into
columns that carry `UNIQUE` constraints, where a collision is a _false duplicate-PAN rejection_
against a real employee. Every `_fpr` column carries a mandatory sibling
`<field>_fpr_pepper_version smallint`, and every uniqueness index is
`(organization_id, <field>_fpr_pepper_version, <field>_fpr)` so both generations stay enforceable
during a pepper roll. `normalise()` is the fixed, schema-contract function of `DATA-MODEL.md`
§1.6 — not a per-call-site choice. Blind indexes support only equality, never range or prefix —
searching bank accounts by partial number is not a feature. `BLIND_INDEX_KEY_V<n>` is a distinct
secret from the KEK and from the password pepper.

**The columns, normatively — `DATA-MODEL.md` §1.6 is canonical for the spelling:**

| Column                                                   | Normalisation                                                                                                            | Index                                                                                                   | Why it must exist                                                                                                                                                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `employee_statutory_id.value_fpr` where `kind='PAN'`     | `upper(trim())`                                                                                                          | `ux_employee_statutory_id__org_kind_fpr` per organisation                                               | "Is this PAN already registered to another employee?" is a statutory correctness check; without a blind index it is a full-table decrypt, i.e. a mass-unmask event that would trip §11.4's own alert                                                                                                         |
| `employee_statutory_id.value_fpr` where `kind='AADHAAR'` | strip non-alphanumerics, `upper()`                                                                                       | same index, `kind` discriminates                                                                        | duplicate detection only; Aadhaar is never searched by a user                                                                                                                                                                                                                                                |
| `employee_bank_account.account_number_fpr`               | strip non-alphanumerics, `upper()`, with `ifsc` in the normalised input so the same number at two banks does not collide | `UNIQUE (organization_id, account_number_fpr_pepper_version, account_number_fpr, ifsc) WHERE is_active` | **The salary-redirection control (A3).** It makes "has this account number just been attached to a second employee?" a cheap, indexed check, which is the signature of the highest-value attack on an ESS. A hit raises `SECURITY.BANK_ACCOUNT_COLLISION` (P1) and blocks the change pending Accounts review |
| `employee_personal_detail.personal_email_fpr`            | `lower(trim())`                                                                                                          | non-unique                                                                                              | duplicate-account detection at invite time                                                                                                                                                                                                                                                                   |
| `employee_personal_detail.personal_mobile_fpr`           | digits only, last 10                                                                                                     | non-unique                                                                                              | same                                                                                                                                                                                                                                                                                                         |

A blind index is **not** returned by any API and is never used as an identifier in a URL, a cursor or
an export — it is a lookup key only. The full 256-bit width is deliberate: a `_fpr` collision on a
`UNIQUE` index would reject a legitimate employee's real PAN as a duplicate, and at 256 bits that
is not reachable (a collision is handled as
a candidate set, then resolved by decrypting only the candidates).

### 7.3 Key management, versioning and rotation

| Key                                                                | Where                       | Rotation                               | Procedure                                                          |
| ------------------------------------------------------------------ | --------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `MASTER_KEK_V<n>`                                                  | KMS / platform secret store | 12 months, or immediately on suspicion | §7.3.1                                                             |
| DEKs (`data_encryption_key`)                                       | wrapped in Postgres         | 12 months, or immediately on suspicion | §7.3.2                                                             |
| `PASSWORD_PEPPER_V<n>`                                             | secret store                | 24 months                              | lazy re-hash at next login (§2.1)                                  |
| `BLIND_INDEX_KEY_V<n>`                                             | secret store                | with the DEK rotation                  | recompute all `*_fpr` in the same backfill                         |
| `JWT_SIGNING_KEY_<kid>`                                            | secret store                | 90 days                                | §3.2                                                               |
| `AUDIT_CHAIN_KEY_V<n>`                                             | secret store                | 12 months                              | §8.3 — never re-keys history                                       |
| `CSRF_KEY`, `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`, `CURSOR_HMAC_KEY` | secret store                | 12 months                              | rotation invalidates live cursors/CSRF tokens only; users re-fetch |

**7.3.1 KEK rotation (cheap).** Only the wrapped DEKs change. Add `MASTER_KEK_V<n+1>`; for each
`data_encryption_key` row, unwrap with the old KEK and re-wrap with the new one in a transaction; set
`kek_version = n+1`. No column data is touched. Old KEK is retained for 30 days, then destroyed.

**7.3.2 DEK rotation / re-encryption (expensive, online).** For a `purpose`:

1. Insert a new `data_encryption_key` row with `status='PENDING'`, wrapped under the current KEK.
2. Flip it to `ACTIVE` and the previous one to `RETIRING`. From this moment **new writes use the new
   DEK; reads still decrypt with whichever `dek_id` the envelope names** — this dual-read capability is
   inherent to the format and requires no feature flag.
3. `apps/api/src/crypto/reencrypt-worker.ts` walks each affected table in `id` order in batches of
   **500 rows per transaction**, `SELECT … FOR UPDATE SKIP LOCKED`, decrypting with the old DEK and
   re-encrypting with the new one (recomputing the blind index if the index key also rotated).
   Progress is checkpointed in `reencryption_job(purpose, table_name, last_id, rows_done, started_at, finished_at)`
   so it is resumable. Throttled to ≤ 5 % of DB CPU; runs outside payroll windows.
4. When no row references the retiring key — verified by
   `SELECT count(*) FROM <table> WHERE <field>_dek_id = $1` per encrypted column, driven by a
   generated list so a newly added column cannot be forgotten — set it `RETIRED` and delete the
   wrapped material after 30 days. (The earlier text scanned `substring(col from 2 for 1)`, which
   read the wrong byte of the wrong storage shape; with `_dek_id` as its own indexed column the check
   is an index scan, not a table scan.)
5. The whole rotation emits `SECURITY.KEY_ROTATION_STARTED` / `…_COMPLETED` audit events with counts.

**Rotation is rehearsed in staging before every production run**, and the runbook lives in
`docs/runbooks/key-rotation.md`. A rotation that stalls leaves the system fully functional — that is
the point of the dual-read format.

**Break-glass.** If all copies of a KEK were lost, the affected columns are unrecoverable. Therefore
the KEK is escrowed in the KMS's own durable store (or, for the secret-store variant, in a sealed
offline copy held by two officers under split knowledge), and a quarterly restore drill decrypts a
canary row from a real backup and records the result in `docs/runbooks/dr-drill-log.md`.

### 7.4 Hashing — the right primitive for each job

| Purpose                                        | Primitive                                                                                                                                                                                      | Rationale                                                                              |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Password storage                               | **Argon2id** (m=64 MiB, t=3, p=1) over an HMAC-SHA512 pepper pre-hash                                                                                                                          | Slow, memory-hard, salted — the only correct choice for low-entropy secrets (§2.1)     |
| Refresh tokens, reset/invite/activation tokens | **SHA-256** of the raw token                                                                                                                                                                   | 256-bit random input; a slow hash buys nothing and would add latency to every refresh  |
| MFA recovery codes                             | **HMAC-SHA256** under `RECOVERY_CODE_KEY`                                                                                                                                                      | 128-bit random; the key makes a DB-only dump useless                                   |
| File integrity                                 | **SHA-256** over the stored bytes → `file.sha256`, verified on every read-back from storage before signing a URL; a mismatch blocks the download and raises `SECURITY.FILE_INTEGRITY_MISMATCH` | Detects silent storage corruption or tampering                                         |
| Payslip source traceability                    | **SHA-256** over the canonical JSON of the inputs that produced a payslip → `payslip.input_sha256`, recomputed by the verification endpoint                                                    | Proves a published payslip matches its persisted inputs (D3)                           |
| Audit chain                                    | **HMAC-SHA256** under `AUDIT_CHAIN_KEY`                                                                                                                                                        | Keyed, so an attacker with DB write access still cannot recompute a valid chain (§8.3) |
| CSRF token binding                             | **HMAC-SHA256** under `CSRF_KEY`                                                                                                                                                               | §3.5                                                                                   |
| Blind indexes                                  | **HMAC-SHA256** truncated to 128 bits                                                                                                                                                          | §7.2                                                                                   |
| Log/audit IP and user-agent                    | **HMAC-SHA256** under `LOG_HASH_KEY` → `ip_hash`, `user_agent_hash`                                                                                                                            | Correlatable across events without storing the raw identifier (§14.3)                  |
| Pagination cursors                             | **HMAC-SHA256** under `CURSOR_HMAC_KEY`, bound to `sub`                                                                                                                                        | Cursors cannot be transplanted between users                                           |

Plain SHA-1 appears **only** inside the HIBP k-anonymity protocol (§2.3), where the algorithm is fixed
by the upstream API and only 5 hex characters ever leave the process. MD5 and unsalted SHA of
passwords appear nowhere.

All secret comparisons use `crypto.timingSafeEqual` on equal-length buffers; an ESLint rule forbids
`===` on any identifier ending in `Hash`, `Token`, `Secret` or `Hmac`.

### 7.5 Masking rules for reads

Masking is applied **server-side in the DTO mapper**, never in the SPA — the client never receives the
full value it is meant to mask. `apps/api/src/crypto/mask.ts`:

| Value                                 | Mask                                                                                                  | Example                         | Who sees full                                |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------- | -------------------------------------------- |
| PAN                                   | first 5 + `••••` + last 1                                                                             | `AXYPR••••K`                    | `read:statutory_id:full` (Accounts, step-up) |
| Aadhaar                               | `•••• •••• ` + last 4                                                                                 | `•••• •••• 8821`                | `read:statutory_id:full`                     |
| Bank account                          | `•••• •••• ` + last 4 (from the plaintext `last4` column, so no decryption happens for a masked read) | `•••• •••• 4412`                | `read:bank_account:full`                     |
| UAN                                   | first 9 + `••••`                                                                                      | `1012 3456 ••••`                | `read:statutory_id:full`                     |
| Personal phone                        | `+91 ••••• ` + last 5                                                                                 | `+91 ••••• 12234`               | self, `read:profile:full`                    |
| Personal email                        | first char + `•••••@` + domain                                                                        | `p•••••@gmail.com`              | self, `read:profile:full`                    |
| DOB                                   | `••/••/YYYY`                                                                                          | `••/••/1994`                    | self, `read:profile:full`                    |
| Address                               | locality + PIN only                                                                                   | `Koramangala, Bengaluru 560095` | self, `read:profile:full`                    |
| TOTP secret, recovery codes, any hash | **never returned by any endpoint**                                                                    | —                               | nobody                                       |

Three invariants: (1) a masked value is computed from the plaintext `last4`/domain columns wherever
possible so that a masked read performs **no decryption at all**, minimising key use; (2) a masked
value is never used as an input to a write (the client cannot send back `•••• 4412` and have it
accepted); (3) unmasking is a distinct permission, always step-up, always audited with the subject
employee id — so a mass unmask is visible in the audit trail as N events, not one.

---

## 8. Audit logging

### 8.1 What MUST be audited

Non-exhaustive but mandatory. Each row records `action` from this closed vocabulary
(`packages/shared/src/audit-actions.ts`), so a missing action is a compile error at the call site.

| Domain                                                                               | Actions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication                                                                       | `AUTH.LOGIN_SUCCEEDED`, `AUTH.LOGIN_FAILED`, `AUTH.MFA_CHALLENGED`, `AUTH.MFA_SUCCEEDED`, `AUTH.MFA_FAILED`, `AUTH.MFA_ENROLLED`, `AUTH.MFA_RESET`, `AUTH.MFA_RECOVERY_USED`, `AUTH.LOGOUT`, `AUTH.LOGOUT_ALL`, `AUTH.ACCOUNT_LOCKED`, `AUTH.LOGIN_THROTTLE_ENGAGED`, `AUTH.PASSWORD_CHANGED`, `AUTH.PASSWORD_RESET_REQUESTED`, `AUTH.PASSWORD_RESET_COMPLETED`, `AUTH.REFRESH_ROTATED`, `AUTH.REFRESH_REUSE_DETECTED`, `AUTH.SESSION_REVOKED`, `AUTH.BREACH_CHECK_DEGRADED`                                                                                                                                                                                         |
| Authorization                                                                        | `AUTHZ.DENIED` (every 403), `AUTHZ.OUT_OF_SCOPE` (every scope-induced 404 on a single-object read), `AUTHZ.STEP_UP_REQUIRED`, `AUTHZ.SELF_APPROVAL_BLOCKED`, `AUTHZ.SEGREGATION_BLOCKED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Payroll state machine (D3)                                                           | `PAYROLL.RUN_CREATED`, `PAYROLL.INPUT_UPLOADED`, `PAYROLL.INPUT_ROWS_PARSED`, `PAYROLL.ATTENDANCE_SUBMITTED`, `PAYROLL.ATTENDANCE_APPROVED`, `PAYROLL.ATTENDANCE_REJECTED`, `PAYROLL.ATTENDANCE_ESCALATED`, `PAYROLL.VALIDATION_STARTED`, `PAYROLL.VALIDATION_FAILED`, `PAYROLL.VALIDATION_PASSED`, `PAYROLL.GENERATION_STARTED`, `PAYROLL.PAYSLIP_GENERATED`, `PAYROLL.GENERATION_COMPLETED`, `PAYROLL.RUN_PUBLISHED`, `PAYROLL.RUN_LOCKED`, `PAYROLL.RUN_CANCELLED`, `PAYROLL.AMENDMENT_CREATED`                                                                                                                                                                   |
| Payslip access                                                                       | `PAYSLIP.VIEWED`, `PAYSLIP.DOWNLOADED`, `PAYSLIP.EMAILED`, `PAYSLIP.VIEWED_BY_ACCOUNTS` (separate action so third-party access is trivially queryable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Tax                                                                                  | `TAX.FORM16_ISSUED`, `TAX.FORM16_DOWNLOADED`, `TAX.QUARTER_FILED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Profile & bank                                                                       | `PROFILE.UPDATED`, `PROFILE.CHANGE_REQUESTED`, `PROFILE.CHANGE_APPROVED`, `PROFILE.CHANGE_REJECTED`, `BANK.CHANGE_REQUESTED`, `BANK.CHANGE_VERIFIED`, `BANK.CHANGE_REJECTED`, `BANK.FULL_VIEWED`, `STATUTORY.FULL_VIEWED`                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Leave & expenses                                                                     | `LEAVE.REQUESTED`, `LEAVE.APPROVED`, `LEAVE.REJECTED`, `LEAVE.WITHDRAWN`, `LEAVE.BALANCE_ADJUSTED`, `EXPENSE.SUBMITTED`, `EXPENSE.APPROVED`, `EXPENSE.REJECTED`, `EXPENSE.REIMBURSED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Benefits                                                                             | `BENEFIT.DEPENDENT_CHANGE_REQUESTED`, `BENEFIT.DEPENDENT_CHANGE_APPROVED`, `BENEFIT.PLAN_UPDATED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Policies (D4/D7)                                                                     | `POLICY.VERSION_CREATED`, `POLICY.VERSION_PUBLISHED`, `POLICY.ARCHIVED`, `POLICY.ACKNOWLEDGED`, `POLICY.ACK_REMINDER_SENT`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Announcements                                                                        | `ANNOUNCEMENT.CREATED`, `ANNOUNCEMENT.PUBLISHED`, `ANNOUNCEMENT.PINNED`, `ANNOUNCEMENT.ARCHIVED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Documents                                                                            | `DOCUMENT.ISSUED`, `DOCUMENT.DOWNLOADED`, `LETTER.REQUESTED`, `LETTER.ISSUED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Help desk                                                                            | `TICKET.CREATED`, `TICKET.EMAIL_QUEUED`, `TICKET.EMAIL_SENT`, `TICKET.EMAIL_FAILED`, `TICKET.ASSIGNED`, `TICKET.COMMENTED`, `TICKET.RESOLVED`, `TICKET.REOPENED`, `TICKET.CLOSED`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Exports                                                                              | `EXPORT.REQUESTED`, `EXPORT.COMPLETED`, `EXPORT.DOWNLOADED`, `EXPORT.FAILED` — each with the exact filter, column set and row count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Administration                                                                       | `ADMIN.USER_INVITED`, `ADMIN.USER_ACTIVATED`, `ADMIN.USER_STATUS_CHANGED`, `ADMIN.ROLE_GRANT_REQUESTED`, `ADMIN.ROLE_GRANTED`, `ADMIN.ROLE_REVOKED`, `ADMIN.REPORTING_LINE_CHANGED`, `ADMIN.ORG_UNIT_CHANGED`, `ADMIN.ORG_SETTING_CHANGED`, `ADMIN.MFA_RESET_FOR_USER`, `ADMIN.SESSION_REVOKED_FOR_USER`                                                                                                                                                                                                                                                                                                                                                             |
| Newly required (were used elsewhere in this document but absent from the vocabulary) | `AUTH.PASSWORD_CHANGE_FORCED`, `AUTH.MFA_CHALLENGE_BINDING_MISMATCH`, `AUTH.MFA_CLOCK_DRIFT_SUSPECTED`, `ADMIN.USER_UNLOCKED`, `ADMIN.QUEUE_MEMBERSHIP_CHANGED`, `POLICY.VIEWED` (the §4.13 read-evidence event), `PAYROLL.INPUTS_OPENED`, `PAYROLL.INPUTS_LOCKED`, `PAYROLL.INPUTS_REOPENED`, `PAYROLL.INPUT_COMMITTED`, `PAYROLL.INPUT_DISCARDED`, `PAYROLL.ATTENDANCE_RETURNED`, `PAYROLL.VALIDATION_INVALIDATED`, `PAYROLL.CYCLE_APPROVED`, `PAYROLL.RUN_DISCARDED`, `PAYROLL.CYCLE_CLOSED`, `PAYSLIP.REVOKED`, `SECURITY.PAYSLIP_DIGEST_MISMATCH`, `SECURITY.BANK_ACCOUNT_COLLISION`, `SECURITY.HELPDESK_RECIPIENT_CHANGED`, `SECURITY.AUDIT_PARTITION_MISSING` |
| Security / system                                                                    | `SECURITY.CSRF_REJECTED`, `SECURITY.SUSPICIOUS_PAYLOAD`, `SECURITY.UPLOAD_TYPE_MISMATCH`, `SECURITY.UPLOAD_MALWARE_DETECTED`, `SECURITY.RATE_LIMIT_TRIPPED`, `SECURITY.IP_BLOCKED`, `SECURITY.CIPHERTEXT_AAD_MISMATCH`, `SECURITY.FILE_INTEGRITY_MISMATCH`, `SECURITY.STORAGE_KEY_INVALID`, `SECURITY.KEY_ROTATION_STARTED`, `SECURITY.KEY_ROTATION_COMPLETED`, `SECURITY.AUDIT_CHAIN_VERIFICATION_FAILED`                                                                                                                                                                                                                                                           |

### 8.2 Schema

> **Three corrections to the DDL below, each of which would have failed in production.**
>
> 1. **A partitioned table's primary key must contain every partition-key column.** `PRIMARY KEY
(seq)` on a table declared `PARTITION BY RANGE (occurred_at)` is rejected by PostgreSQL outright,
>    as is `id uuid UNIQUE`. The key is `(seq, occurred_at)` and the uuid constraint is
>    `UNIQUE (id, occurred_at)`. Global uniqueness of `seq` is guaranteed by its allocator (§8.3), not
>    by a cross-partition index, which cannot exist.
> 2. **`bigserial` is not gapless**, so the "gapless by construction" comment and the verification
>    step "any gap is a deletion" contradicted each other: a rolled-back transaction permanently
>    consumes a sequence value, which would report a _false tamper detection_ on the first rollback in
>    production — the worst possible failure mode for an integrity alarm. `seq` is allocated from
>    `audit_chain_head` inside the transaction (§8.3), so a rollback returns it.
> 3. **The chain is per `organization_id`** (R13), matching `DATA-MODEL.md`'s
>    `ux_audit_event__org_sequence`. `prev_hash` links the previous row _of the same organisation_.

```sql
CREATE TABLE audit_event (
  seq              bigint       NOT NULL,             -- chain order, per organization_id; see §8.3
  organization_id  uuid         NOT NULL,
  id               uuid         NOT NULL,
  occurred_at      timestamptz  NOT NULL DEFAULT now(),
  action           text         NOT NULL,             -- closed vocabulary, §8.1
  outcome          text         NOT NULL,             -- SUCCESS | FAILURE | DENIED
  severity         text         NOT NULL,             -- INFO | NOTICE | WARN | CRITICAL
  actor_user_id    uuid         NULL,                 -- NULL for system/worker actions
  actor_employee_id uuid        NULL,
  actor_roles      text[]       NOT NULL DEFAULT '{}',
  actor_kind       text         NOT NULL,             -- USER | SYSTEM | WORKER | CI
  subject_employee_id uuid      NULL,                 -- whose data was touched — the key query axis
  resource_type    text         NULL,
  resource_id      text         NULL,
  request_id       uuid         NULL,
  session_id       uuid         NULL,
  ip_hash          bytea        NULL,
  user_agent_hash  bytea        NULL,
  payload          jsonb        NOT NULL DEFAULT '{}'::jsonb,  -- redacted, §8.5
  actor_permission_code text    NULL,                 -- the exact permission that authorised it
  actor_role_persona text        NULL,                 -- which persona a multi-role actor acted under
  actor_email_snapshot citext    NULL,                 -- WORK address only, frozen (R14)
  api_route        text         NULL,                  -- templated, e.g. POST /leave-requests/:id/approve
  http_status      smallint     NULL,
  reason           text         NULL,                  -- the mandatory note on guarded transitions
  prev_hash        bytea        NULL,                  -- NULL only for an organisation's genesis row
  hash             bytea        NOT NULL,
  chain_key_version smallint    NOT NULL,
  PRIMARY KEY (seq, occurred_at),
  UNIQUE (id, occurred_at),
  UNIQUE (organization_id, seq, occurred_at),
  CHECK (actor_kind <> 'USER' OR actor_user_id IS NOT NULL)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX ON audit_event (subject_employee_id, occurred_at DESC);
CREATE INDEX ON audit_event (actor_user_id, occurred_at DESC);
CREATE INDEX ON audit_event (action, occurred_at DESC);
CREATE INDEX ON audit_event (resource_type, resource_id);
CREATE INDEX ON audit_event (organization_id, seq);
```

Partitioned monthly by `occurred_at` (`PARTITION BY RANGE`), with the chain running across partitions
by `(organization_id, seq)`. Partitions for the next three months are pre-created by a scheduled job
and its failure is a `P2` alert — a missing partition makes every audited write fail, which by the
same-transaction rule (§8.5) makes every business write fail.

**`on_behalf_of_user_id` must not exist (R6).** `DATA-MODEL.md` §17.1 carries such a column labelled
"impersonation support". §4.1 forbids impersonation anywhere in this system, and an impersonation
path would bypass every `§` self-dealing rule, every `‡` maker-checker rule and every step-up
requirement in §4 — while leaving an audit trail that says the _impersonated_ user did it. The column
is removed; if it must remain for migration reasons it carries
`CONSTRAINT ck_audit__no_impersonation CHECK (on_behalf_of_user_id IS NULL)` and no code path may
reference it. Investigating "what did this user see" is done by querying `audit_event` under
`audit:read`, which is itself audited.

**`ip_address` and `user_agent` are stored hashed, never raw (R5).** `DATA-MODEL.md` §17.1 declares
`ip_address inet` and `user_agent text`. Those columns are replaced by `ip_hash bytea` and
`user_agent_hash bytea` (HMAC-SHA256 under `LOG_HASH_KEY`), per §14.3. Every question security needs
to answer — "same source?", "same device?", "repeat offender?" — is answerable from the hash, and the
raw values would turn an 8-year-retention integrity record into an 8-year location history of every
employee. Raw IPs exist only transiently in memory and in the platform's own edge logs under the
provider's shorter retention.

### 8.3 Hash-chain construction

```
canonical(e) = JCS-canonical JSON of
               { organization_id, seq, id, occurred_at (RFC3339 UTC, exactly 3 fractional digits),
                 action, outcome, severity,
                 actor_kind, actor_user_id, actor_employee_id, actor_roles (sorted),
                 actor_role_persona, actor_permission_code, actor_email_snapshot,
                 subject_employee_id, resource_type, resource_id,
                 api_route, http_status, reason,
                 request_id, session_id,
                 ip_hash (lowercase hex), user_agent_hash (lowercase hex),
                 payload (JCS-canonical) }
               -- every field of the row except prev_hash, hash and chain_key_version is covered;
               -- a field added to the table without being added here is a CI failure
               -- (test: reflect over the Prisma model and diff against this list)

e.prev_hash = (this organisation's first row) ? NULL : the organisation's previous row's hash
e.hash      = HMAC-SHA256( AUDIT_CHAIN_KEY[v],  canonical(e) ‖ coalesce(e.prev_hash, 32 zero bytes) )
```

- **Keyed, not a bare hash.** This is the single most important property in §8, and it is where
  `DATA-MODEL.md` §17.1 is wrong (R4): it computes `row_hash` with plain `sha256()` in a
  `BEFORE INSERT` trigger. An unkeyed chain is trivially forgeable by exactly the adversary the chain
  exists to catch — T-HR/T-ACC/T-PLAT, who has `UPDATE` on the database. They edit a row, recompute
  `sha256` for it and every successor, and the chain verifies. With `HMAC-SHA256` under
  `AUDIT_CHAIN_KEY`, they cannot, because the key is in the platform secret store (A10) and never in
  Postgres.
- **The chain is therefore computed in the application, not in a database trigger.** A trigger cannot
  do keyed hashing without the key being reachable from inside the database, which would defeat the
  control. `trg_audit_chain` is reduced to enforcement only: it rejects an insert whose `hash` is
  NULL, whose `seq` does not follow the organisation's head, or whose `prev_hash` does not equal the
  head's `hash` — so a hand-written `INSERT` from `psql` cannot append an unchained row.
- **JCS (RFC 8785) canonicalisation** so key ordering and number formatting cannot change the hash.
- `chain_key_version` is stored per row; key rotation starts using v+1 from a given `seq` onward and
  **never re-keys history**. Verification uses the version recorded on each row.

**Allocation and locking, stated precisely — the earlier "held for microseconds" was not true.**
`pg_advisory_xact_lock` is released at **commit**, not when the statement finishes. Taking it "at the
start of the audit write" inside a transaction that then does more work would serialise every
mutating transaction in the system end-to-end, and a bulk job (payroll generation writing thousands
of payslips) would hold it for the job's entire duration. The corrected discipline:

1. `audit_chain_head(organization_id uuid PRIMARY KEY, next_seq bigint NOT NULL, last_hash bytea)`
   holds the head. It is the allocator, so `seq` is **gapless**: a rolled-back transaction rolls back
   the `UPDATE` that consumed the number.
2. `withAudit()` does **not** insert as entries are recorded — `audit(…)` only _queues_ them in the
   transaction-scoped context. The flush is the **last statement before commit**, enforced by the
   helper's own control flow (callers never get the transaction handle after the flush) and asserted
   by a test that fails if any statement executes after a flush in the same transaction.
3. The flush takes `pg_advisory_xact_lock(hashtext('audit:' || organization_id))`, reads and updates
   `audit_chain_head`, computes each row's HMAC in order, inserts them in one statement, and returns.
   The lock is therefore genuinely held for the flush plus the commit — sub-millisecond — and it is
   **per organisation**, so one tenant cannot stall another.
4. **Bulk operations must chunk.** Any job producing more than 500 audit rows splits into
   transactions of ≤ 500 (payslip generation, retention deletion, re-encryption). A lint rule flags a
   `withAudit` inside an unbounded loop.
5. The flush's duration is measured as `audit_write_latency_seconds`; a p99 above 50 ms is a `P3`
   alert, because it means the advisory lock has become a real contention point and the chain design
   needs revisiting before it becomes an availability problem.

### 8.4 Tamper-evidence: checkpoints and verification

**Checkpoints.** Hourly, `apps/api/src/audit/checkpoint-worker.ts` records
`audit_checkpoint(id, seq, hash, created_at, external_ref)` and writes the same `(seq, hash,
created_at)` tuple to an **append-only external sink**: an object-storage prefix with versioning and
object-lock in compliance mode and a 10-year retention, plus a daily digest emailed to a
security distribution list. Without an external anchor, an attacker with full DB access could delete a
suffix of the chain and re-checkpoint; with it, **truncation is detectable** because the external
anchor references a `seq` that no longer exists or a `hash` that no longer matches.

**Verification procedure** (`npm run audit:verify -- --from <seq> --to <seq>`, and
`GET /audit/verify?from&to` under `verify:audit_chain`):

1. Read rows in `seq` order in batches of 10 000.
2. Assert `seq` is contiguous **within each `organization_id`** — with the `audit_chain_head`
   allocator (§8.3) `seq` really is gapless, so a gap now means a deletion rather than a rollback,
   and this check is finally sound. (Under the old `bigserial` it would have fired on the first
   rolled-back transaction.)
3. For each row: recompute `canonical(e)`, recompute `hash` with the key named by
   `chain_key_version`, compare with `timingSafeEqual`; assert `prev_hash` equals the previous row's
   `hash`.
4. Assert every `audit_checkpoint` matches the row at its `seq`, and every external anchor matches its
   `audit_checkpoint`.
5. Output `{from, to, rowsVerified, ok, firstBadSeq?, reason?}`.

Any failure sets `SECURITY.AUDIT_CHAIN_VERIFICATION_FAILED` (severity `CRITICAL`), pages the security
contact, and — because that event is itself appended to the chain — is preserved. A **full
verification runs nightly**; an incremental verification of the last 24 h runs hourly after
checkpointing.

**Append-only enforcement at the database:**

```sql
REVOKE UPDATE, DELETE, TRUNCATE ON audit_event FROM ess_app;
GRANT  SELECT, INSERT              ON audit_event TO   ess_app;

CREATE FUNCTION audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'audit_event is append-only'; END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION audit_immutable();
```

Notes that matter for this to actually work on a partitioned table:

- Row-level triggers declared on a partitioned parent propagate to every partition from PostgreSQL 13
  onward; PostgreSQL 16 is the floor for this system, so the declaration above is sufficient. A
  partition created later inherits the trigger automatically — which is why partitions are created by
  `ALTER TABLE … ATTACH`/`CREATE TABLE … PARTITION OF` and never as standalone tables.
- A row trigger cannot block `TRUNCATE`; the `REVOKE` above is what does, and `ess_app` additionally
  has no `TRUNCATE` on anything.
- The trigger blocks `DELETE`, so retention **must** use partition detach-and-drop, never `DELETE`
  (§8.7). Partition drop is performed by `ess_migrator` from a scheduled job, never by the app role,
  and is itself audited.
- `ess_app` must also lack `pg_write_server_files`, `pg_execute_server_program` and superuser; a role
  that can `COPY … TO PROGRAM` can rewrite anything regardless of grants.

### 8.5 Same-transaction rule and PII redaction

**The rule:** the audit write happens **inside the same database transaction** as the change it
records. `apps/api/src/audit/audit.ts` exposes only

```ts
await withAudit(prisma, ctx, async (tx, audit) => {
  const updated = await tx.leaveRequest.update({ ... });
  audit({ action: 'LEAVE.APPROVED', subjectEmployeeId: updated.employeeId,
          resourceType: 'leave_request', resourceId: updated.id,
          payload: { from: 'PENDING', to: 'APPROVED' } });
  return updated;
});
```

so it is impossible to mutate state without an audit row: the helper takes the transaction, and a
lint rule forbids importing `prisma.$transaction` directly in the `routes/` and `services/` layers.
If the business write rolls back, the audit row rolls back with it — no phantom entries. If the audit
write fails, the business write fails. **Failure-path audits** (`AUTHZ.DENIED`, `AUTH.LOGIN_FAILED`)
have no business transaction to join, so they are written in their own short transaction on the
`onResponse`/error path, and a delivery failure there is logged and retried once from an in-memory
buffer with a hard cap (an audit outage must not become an availability outage for login _failures_).

**PII redaction inside `payload`.** The payload records _what changed_, not _the data_:

| Rule                               | Detail                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Never store plaintext A2–A5 values | A `PROFILE.UPDATED` payload holds `{"changedFields":["personalPhone","currentAddress"]}`, not the old or new values                                                                                                               |
| Before/after for sensitive fields  | Store `HMAC-SHA256(LOG_HASH_KEY, value)` as `beforeHash`/`afterHash`, so "was it actually changed?" and "was it changed back?" are answerable without holding the value                                                           |
| Non-sensitive state transitions    | Stored literally: `{"from":"PENDING","to":"APPROVED"}`, `{"amountPaise":186000}`, `{"leaveDays":5}` — payroll and approval amounts must be in the audit trail for D4 and are protected by the same RBAC as the underlying records |
| Free text                          | Ticket bodies, leave reasons and rejection notes are **never** copied into `payload`; the audit row references `resource_id` and the reader must hold the permission to open it                                                   |
| Structural guard                   | `payload` passes through `redactPayload()` which walks the object and drops any key matching the denylist `/pan                                                                                                                   | aadhaar | account_?number | ifsc | password | secret | token | otp | dob | date_of_birth | address | phone | email | salary | ciphertext/i`unless it is explicitly allowlisted per action in`audit-payload-schemas.ts`. Every action has a Zod schema for its payload; an unschema'd payload is rejected at write time |
| Size                               | `payload` capped at 8 KiB                                                                                                                                                                                                         |
| Access                             | Reading audit rows requires `read:audit:hr` or `read:audit:payroll` (§4.4); the audit reader itself emits an audit event for bulk reads (> 100 rows)                                                                              |

### 8.6 Help-desk ticket email (D8) — persisted first, delivered reliably

1. `POST /tickets` validates, then **in one transaction**: inserts `ticket` + first `ticket_message`
   (body encrypted, §7.1), inserts a `email_outbox` row targeting
   `helpdesk@widedroptech.com`, and writes `TICKET.CREATED` + `TICKET.EMAIL_QUEUED`.
2. The API responds `201` with the persisted ticket reference (e.g. `HD-4831`), generated from a
   Postgres sequence — never a client-side counter, per D1.
3. `apps/api/src/workers/outbox-worker.ts` delivers via the mail provider's HTTPS API (not raw SMTP
   concatenation), with exponential backoff (1 m, 5 m, 15 m, 1 h, 6 h; 5 attempts), idempotency key =
   `email_outbox.id`. Success ⇒ `TICKET.EMAIL_SENT`; final failure ⇒ `TICKET.EMAIL_FAILED`,
   severity `WARN`, alert, and the ticket is flagged in the HR queue so it is never silently lost.
4. The mail body contains the ticket reference, category, subject, requester **work** email and a deep
   link — and **no** PII beyond that; the full body is read in the portal under the queue permission.
   Every header-bound field has CR/LF stripped (§B5).
5. The recipient address lives in `org_setting.helpdesk_email` (seeded to `helpdesk@widedroptech.com`),
   so changing it is an audited `ADMIN.ORG_SETTING_CHANGED` event rather than a redeploy.
6. **That setting is a redirection target for every help-desk request in the company, so it is not an
   ordinary setting.** Changing it requires `org:manage` **with step-up MFA**, the new value must
   match `ORG_SETTING_EMAIL_DOMAIN_ALLOWLIST` (env, production value
   `widedroptech.com,widedrop.com`), the change raises a `P2` alert
   (`SECURITY.HELPDESK_RECIPIENT_CHANGED`) regardless of legitimacy, and the previous recipient is
   emailed a notice. Without these, an HR insider — or anyone who compromises one HR account — could
   silently point the entire ticket stream, including DPDP data requests and grievances, at an
   attacker-controlled mailbox, and nothing in the product would look different.
7. `helpdesk@widedroptech.com` sits on a **different registrable domain** from the sender
   (`MAIL_FROM` is `@widedroptech.com`, §10.2 / `DEPLOYMENT.md` R-2). That is legitimate and intentional, and it has two
   consequences that are easy to miss: (a) DMARC alignment is evaluated on the _From_ domain, so
   `widedrop.com` needs SPF/DKIM/DMARC and `widedroptech.com` needs only to accept the mail — but
   `widedroptech.com` MUST still publish `v=DMARC1; p=reject` and an SPF record with no senders, or
   it is a free lookalike domain for phishing Widedrop staff (§15.2); (b) the mail body carries the
   ticket reference, category, subject and the requester's **work** email and nothing more, precisely
   because it crosses a domain boundary into a mailbox this system does not control.
8. **Delivery is never a precondition for persistence.** The `201` is returned on the strength of the
   committed `helpdesk_ticket` row alone. If the mail provider is down for a day, tickets still
   exist, are visible in the queue, and their SLA clocks still run. `TICKET.EMAIL_FAILED` after the
   final retry flags the ticket in the HR queue so a human sees it — the directive is that tickets are
   persisted **and** emailed, and the persisted half must never be held hostage to the emailed half.

### 8.7 Retention and break-glass

| Audit class                                                       | Retention                                      | Basis                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| Payroll, tax, payslip, bank, statutory, export, role-grant, admin | **8 years** from the end of the financial year | Income-tax and EPF record-keeping windows; payroll disputes |
| Policy acknowledgement events                                     | Employment duration + **8 years**              | POSH / ISP compliance evidence                              |
| Leave, expense, benefit, document, ticket lifecycle               | **5 years**                                    | Employment-dispute window                                   |
| `AUTHZ.*` denials                                                 | **18 months**                                  | Security investigation                                      |
| `AUTH.*` authentication events                                    | **18 months**                                  | Security investigation                                      |
| `SECURITY.*`                                                      | **8 years**                                    | Incident forensics                                          |
| `login_attempt` (not an audit row)                                | **90 days**                                    | Rate limiting only                                          |

Expiry drops whole monthly partitions; the drop records the partition's `seq` range and final `hash`
in `audit_partition_archive` **before** dropping, and the partition is exported to object storage
under object-lock first, so the chain remains verifiable end-to-end from the archive.

**Break-glass DB access** (production `psql`): requires two-person approval recorded in
`docs/runbooks/break-glass.md`, a time-boxed credential (≤ 4 h) issued by the platform, session
recording, and a manual `SECURITY.*` audit entry created through the API afterwards. Any break-glass
window is cross-checked against the audit chain verification for that period.

---

## 9. Rate limiting and abuse prevention

### 9.1 Per-route limits

`apps/api/src/plugins/rate-limit.ts` (`@fastify/rate-limit` with the custom store in §9.3). Every
route declares `config.rateLimit`; the boot assertion in §4.6 also fails a route with no limit
declared, falling back to the "general" bucket only when explicitly marked.

| Route / class                                             | Key                    | Limit                      | Window                | On exceed                                                                                             |
| --------------------------------------------------------- | ---------------------- | -------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `POST /auth/login`                                        | `ip`                   | 10                         | 15 min                | 429                                                                                                   |
| `POST /auth/login`                                        | `account (email_hash)` | 10                         | 15 min                | 429; lockout ladder §2.6 continues independently                                                      |
| `POST /auth/login`                                        | `ip` (global spray)    | 60                         | 60 min                | 429 + `SECURITY.IP_BLOCKED`                                                                           |
| `POST /auth/mfa/verify`                                   | `user`                 | 5                          | 5 min                 | 429, then 15 min cooldown                                                                             |
| `POST /auth/mfa/enrol`, `/mfa/recovery/regenerate`        | `user`                 | 5                          | 60 min                | 429                                                                                                   |
| `POST /auth/password-reset/request`                       | `ip`                   | 5                          | 60 min                | 202 (never reveals throttling) but no mail sent                                                       |
| `POST /auth/password-reset/request`                       | `account`              | 3                          | 60 min                | as above                                                                                              |
| `POST /auth/password-reset/confirm`                       | `ip`                   | 10                         | 60 min                | 429                                                                                                   |
| `POST /auth/refresh`                                      | `session`              | 60                         | 5 min                 | 429 + investigate (a healthy client refreshes ≈ 6×/h)                                                 |
| `POST /auth/activate`                                     | `ip`                   | 10                         | 60 min                | 429                                                                                                   |
| `GET /search` (global search)                             | `user`                 | 30                         | 1 min                 | 429                                                                                                   |
| `GET /directory`                                          | `user`                 | 60                         | 1 min                 | 429                                                                                                   |
| File upload (any)                                         | `user`                 | 20                         | 1 h                   | 429                                                                                                   |
| File upload (any)                                         | `user`, bytes          | 200 MiB                    | 24 h                  | 429                                                                                                   |
| `GET /files/:id` (signed-URL issue)                       | `user`                 | 120                        | 1 h                   | 429                                                                                                   |
| `POST /exports/*`                                         | `user`                 | 3                          | 1 h; max 1 concurrent | 429                                                                                                   |
| `POST /tickets`                                           | `user`                 | 10                         | 1 h                   | 429                                                                                                   |
| `POST /policies/:id/acknowledge`                          | `user`                 | 30                         | 1 h                   | 429                                                                                                   |
| Approval decisions (`approve:*`, `reject:*`)              | `user`                 | 200                        | 1 h                   | 429 + `SECURITY.RATE_LIMIT_TRIPPED` (bulk rubber-stamping signal)                                     |
| `upload:payroll_input`, `publish:payroll`                 | `user`                 | 10                         | 1 h                   | 429                                                                                                   |
| `read:bank_account:full`, `read:statutory_id:full`        | `user`                 | **30**                     | 1 h                   | 429 **and** a `CRITICAL` alert — a legitimate payroll session unmasks a handful, not hundreds (§11.4) |
| General authenticated **read** (`GET`)                    | `user`                 | 300                        | 1 min                 | 429                                                                                                   |
| General authenticated **write**                           | `user`                 | 60                         | 1 min                 | 429                                                                                                   |
| Unauthenticated (`/api/v1/healthz`, `/api/v1/csp-report`) | `ip`                   | 60                         | 1 min                 | 429                                                                                                   |
| Platform edge                                             | `ip`                   | provider WAF/DDoS defaults | —                     | —                                                                                                     |

### 9.2 Keying strategy

A request is evaluated against **every** applicable key; the most restrictive decision wins.

| Key       | Derivation                                                                                                                                                                                                                                                                               | Why                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ip`      | `HMAC-SHA256(LOG_HASH_KEY, client_ip)`, where `client_ip` is the **last** entry of `X-Forwarded-For` added by the trusted platform proxy (Fastify `trustProxy` configured with the exact proxy CIDRs — never `true`, which would let a client spoof its own IP and evade every IP limit) | Blocks distributed guessing from one source                     |
| `account` | `HMAC-SHA256(LOG_HASH_KEY, lower(email))` — used on unauthenticated routes where no user id exists yet                                                                                                                                                                                   | Prevents one account being sprayed from many IPs                |
| `user`    | `user.id`                                                                                                                                                                                                                                                                                | Post-authentication abuse                                       |
| `session` | `session.id`                                                                                                                                                                                                                                                                             | Refresh-loop detection                                          |
| `route`   | `method + routerPath` (the templated path, so `/payslips/:id` is one bucket, not one per id)                                                                                                                                                                                             | Prevents a cheap route's budget from shielding an expensive one |

The stored key is always
`sha256( scope ‖ ':' ‖ route ‖ ':' ‖ HMAC-SHA256(LOG_HASH_KEY, rawValue) )`, so neither the Redis
keyspace nor the Postgres fallback table contains a raw IP, email or user id (§14.3, R12).
`DATA-MODEL.md` §17's example buckets (`ip:<cidr>`, `user:<id>`) are illustrative of _shape_ only and
must not be implemented literally — a limiter is a high-cardinality, long-lived store of exactly the
identifiers this system is careful not to accumulate anywhere else.

**`client_ip` derivation, because getting this wrong disables every IP limit silently.** Fastify's
`trustProxy` is configured with the platform's exact proxy CIDRs, never `true` and never a hop count.
The client IP is the right-most entry of `X-Forwarded-For` that is **not** within a trusted CIDR,
walking from the right; if the immediate peer is not itself in a trusted CIDR, the header is ignored
entirely and the socket address is used. A boot check fails the process if `TRUSTED_PROXY_CIDRS` is
empty in production. With `trustProxy: true` a client could prepend an arbitrary `X-Forwarded-For`
and mint a fresh IP bucket per request, which would turn every per-IP limit and the spray detector
in §2.6 into decoration.

**Evaluation is one round trip, not five.** A request that is subject to five keys evaluates all of
them in a single pipelined Redis `MULTI` (or a single multi-row `INSERT … ON CONFLICT … RETURNING`
against the fallback), and the most restrictive result wins. Issuing one round trip per key would add
five network hops to every request and would make the limiter itself the latency problem it is meant
to prevent.

### 9.3 Storage

**Primary: Redis/Valkey token buckets** (R11 — this matches `DATA-MODEL.md`, which already treats
Postgres as the fallback). Counters are keyed as in §9.2 with a TTL equal to the window, incremented
by a Lua script so check-and-increment is atomic, and are deliberately **not** durable: losing a
window's counters on a Redis restart costs at most one window of over-permissiveness, which is a
better trade than a write to the primary database on every request. The managed Redis instance is on
the private network, `requirepass` + TLS, and is never exposed publicly.

**Fallback: Postgres.** `ess_ops.rate_limit_counter(bucket_key bytea, window_start timestamptz, count int NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY (bucket_key, window_start))`,
used when Redis is unreachable. The fixed-window upsert below is the fallback's implementation:

```sql
INSERT INTO rate_limit_counter (bucket_key, window_start, count, expires_at)
VALUES ($1, date_trunc('second', now()), 1, now() + $2::interval)
ON CONFLICT (bucket_key) DO UPDATE
  SET count = CASE WHEN rate_limit_counter.expires_at <= now() THEN 1
                   ELSE rate_limit_counter.count + 1 END,
      window_start = CASE WHEN rate_limit_counter.expires_at <= now() THEN now()
                          ELSE rate_limit_counter.window_start END,
      expires_at   = CASE WHEN rate_limit_counter.expires_at <= now() THEN now() + $2::interval
                          ELSE rate_limit_counter.expires_at END
RETURNING count, expires_at;
```

A shared store rather than in-memory, because the API runs more than one instance and an in-memory
limiter would multiply every limit by the instance count — a silent, dangerous failure that looks
fine in a single-instance staging environment. A sweeper deletes expired fallback rows every 5
minutes.

**Failure behaviour, stated per class:** if **both** stores are unavailable the limiter fails
**closed** on `/auth/*` and on every route marked `sensitive: true` (`bank_account:read_sensitive:any`,
`statutory_identity:read_sensitive:any`, every `export:*`, `payroll:publish`) with
`503 {"code":"UNAVAILABLE"}`, and fails **open** with a `WARN` and a `P2` alert on general reads.
Brute-force and mass-unmask protection is never traded for availability; a read of the Directory is.
The dual-store design means a single-component failure degrades rather than trips this rule. The
choice is recorded in `docs/adr/0006-rate-limit-store.md`.

### 9.4 `429` semantics

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
RateLimit-Limit: 10
RateLimit-Remaining: 0
RateLimit-Reset: 42
Cache-Control: no-store
Content-Type: application/json

{"code":"RATE_LIMITED","message":"Too many requests. Try again shortly.","retryAfterSeconds":42}
```

- `Retry-After` is **always** present on `429` and on `423 ACCOUNT_LOCKED`, in seconds.
- The message never reveals which key tripped (IP vs account) — that would be an enumeration oracle.
- The SPA surfaces this as the designed inline error banner with a countdown, never a raw status code,
  and disables the submit button until `retryAfterSeconds` elapses.
- Every trip writes `SECURITY.RATE_LIMIT_TRIPPED` with the route and key scope (not the key value)
  and increments a metric; sustained tripping alerts (§11.4).
- `429` responses are exempt from the response-schema serialiser only in that they share one
  `ErrorDto`.

---

## 10. Secrets management

### 10.1 No secrets in the repository — ever

- `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`, `*.p12`, `*.jks` are in `.gitignore`.
- `gitleaks` runs as a pre-commit hook (`.husky/pre-commit`) and as a CI job over the full history on
  every PR; GitHub secret scanning with **push protection** is enabled on the repository.
- Seed data (`prisma/seed.ts`) contains **no** credentials: it creates the first HR user in `INVITED`
  status and prints a one-time activation link to stdout. There is no default password anywhere in
  the codebase, and no "admin/admin" path to a working login.
- Test fixtures use obviously-fake, clearly-labelled values generated per run.

### 10.2 Environment schema, validated at boot, fail-fast

`apps/api/src/config/env.ts` — a Zod schema parsed **before** the Fastify instance is created. Any
failure prints the offending variable names (never values) and calls `process.exit(1)`. The container
therefore never serves traffic in a misconfigured state.

| Variable                                                                                                     | Type / constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                                                   | `z.enum(['development','test','production'])`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PORT`                                                                                                       | int 1–65535                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DATABASE_URL`                                                                                               | URL, must start `postgresql://`, **must contain `sslmode=verify-full` when `NODE_ENV=production`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ALLOWED_ORIGINS`                                                                                            | comma-separated list of absolute `https://` origins; **rejects `*` and any value containing `*`**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TRUSTED_PROXY_CIDRS`                                                                                        | comma-separated CIDR list; required in production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `JWT_ISSUER`, `JWT_AUDIENCE`                                                                                 | absolute https URLs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JWT_ACTIVE_KID`                                                                                             | matches `^wd-ess-\d{6}-[0-9a-f]{4}$`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `JWT_SIGNING_KEY_<kid>`                                                                                      | PKCS#8 PEM, Ed25519, parsed at boot to prove validity. A Zod _object_ schema cannot express a dynamic variable name, so this row is validated by a second pass: the loader reads every `process.env` key matching `^JWT_SIGNING_KEY_wd-ess-\d{6}-[0-9a-f]{4}$`, requires at least the one named by `JWT_ACTIVE_KID`, parses each as an Ed25519 private key, asserts each public half matches the `jwks` row for that `kid`, and rejects any unmatched `JWT_SIGNING_KEY_*` variable so a typo'd name cannot sit silently unused. The same pattern validates `PASSWORD_PEPPER_V<n>`, `MASTER_KEK_V<n>`, `BLIND_INDEX_KEY_V<n>` and `AUDIT_CHAIN_KEY_V<n>` |
| `PRIVATE_PORT`                                                                                               | int 1–65535, required, `!= PORT`, `>= 1024`; the internal listener of §3.2 (named `PRIVATE_PORT` in `DEPLOYMENT.md` §7.2, which is canonical for variable _names_; R20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `REDIS_URL`                                                                                                  | `rediss://` only in production; required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ORG_SETTING_EMAIL_DOMAIN_ALLOWLIST`                                                                         | comma-separated domains; production `widedroptech.com,widedrop.com` (§8.6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `EX_EMPLOYEE_WINDOW_DAYS_MAX`                                                                                | int 0–365; an upper bound on what HR may set in `org_setting` (§2.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ACCESS_TOKEN_TTL_SECONDS`                                                                                   | int 60–900                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `REFRESH_TOKEN_TTL_DAYS` / `REFRESH_FAMILY_MAX_DAYS`                                                         | int 1–30 / 1–60                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `PASSWORD_PEPPER_V1` (+ `_V2`…)                                                                              | base64, **≥ 32 bytes decoded**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `KEY_PROVIDER`                                                                                               | `z.enum(['kms','env'])`. Selects which of the next two rows is required — the earlier schema demanded `MASTER_KEK_V1` unconditionally while §7.2 said the KEK "preferably" lives in a cloud KMS, so a KMS deployment could not boot                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `KMS_KEY_ARN` / `KMS_KEY_URI`                                                                                | required **iff** `KEY_PROVIDER='kms'`; the key is validated by performing a wrap/unwrap round trip of a test vector at boot                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MASTER_KEK_V1` (+ …)                                                                                        | required **iff** `KEY_PROVIDER='env'`; base64, exactly 32 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `BLIND_INDEX_KEY_V1`                                                                                         | base64, ≥ 32 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AUDIT_CHAIN_KEY_V1`                                                                                         | base64, ≥ 32 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CSRF_KEY`, `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`, `CURSOR_HMAC_KEY`                                           | base64, ≥ 32 bytes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_REGION` | required; endpoint must be https                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MAIL_PROVIDER_API_KEY`, `MAIL_FROM`                                                                         | required; `MAIL_FROM` must end **`@widedroptech.com`** (`DEPLOYMENT.md` R-2 — the earlier `@widedrop.com` was wrong: the mandated help-desk recipient is `helpdesk@widedroptech.com`, and keeping every ESS mail DNS record in the `widedroptech.com` zone is what guarantees no SPF/DKIM/DMARC/MX record in `widedrop.com` is ever touched)                                                                                                                                                                                                                                                                                                            |
| `HELPDESK_EMAIL_FALLBACK`                                                                                    | email; `helpdesk@widedroptech.com`. Used **only** when `org_setting.helpdesk_email` is unset (first boot, before seeding); it is not an override and never wins over the persisted value                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `AUDIT_EXTERNAL_ANCHOR_BUCKET`, `AUDIT_EXTERNAL_ANCHOR_PREFIX`                                               | required in production; the object-lock anchor sink of §8.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SECURITY_ALERT_EMAIL`                                                                                       | the distribution list for the §8.4 daily digest and §11.4 P1 alerts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `OUTBOUND_ALLOWLIST`                                                                                         | comma-separated hostnames (§5.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `HIBP_ENABLED`                                                                                               | boolean, default `true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `CLAMAV_HOST`, `CLAMAV_PORT`                                                                                 | required in production                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LOG_LEVEL`                                                                                                  | `z.enum(['fatal','error','warn','info','debug'])`; `debug` is **refused** when `NODE_ENV=production`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

**Weak-secret refusal.** Beyond the length checks, in production the loader refuses to start if any
secret: is present in the committed `.env.example`; matches a known development placeholder
(`changeme`, `dev-secret`, 32 identical bytes, all-zero); has Shannon entropy below 3.5 bits/byte over
its decoded form; or is reused across two different variables. Each refusal names the variable and
the rule, never the value.

`apps/web` has no secrets at all. Its only build-time configuration is `VITE_API_BASE_URL`, and a
CI check asserts no `VITE_*` variable name matches `/KEY|SECRET|TOKEN|PASSWORD|PEPPER/i` — a bundled
secret is a public secret.

### 10.3 `.env.example`

Committed, with every variable from §10.2 present, documented in a comment, and set to an obvious
non-functional placeholder plus the exact command to mint a real one, e.g.:

```dotenv
# 32 random bytes, base64. Generate: openssl rand -base64 32
MASTER_KEK_V1=REPLACE_ME__openssl_rand_base64_32
```

A CI job parses `env.ts` and `.env.example` and fails if either contains a variable the other lacks —
so a new secret cannot be introduced without being documented.

### 10.4 Rotation

| Secret                                | Cadence                                                  | Downtime                                                                                                             | Procedure                                                                                                 |
| ------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `JWT_SIGNING_KEY`                     | 90 d                                                     | none                                                                                                                 | §3.2 `NEXT → CURRENT → RETIRED`                                                                           |
| `MASTER_KEK`                          | 12 m                                                     | none                                                                                                                 | §7.3.1 re-wrap DEKs                                                                                       |
| DEKs + `BLIND_INDEX_KEY`              | 12 m                                                     | none                                                                                                                 | §7.3.2 online re-encryption                                                                               |
| `PASSWORD_PEPPER`                     | 24 m                                                     | none                                                                                                                 | lazy re-hash at login (§2.1)                                                                              |
| `AUDIT_CHAIN_KEY`                     | 12 m                                                     | none                                                                                                                 | new version from a given `seq`; history never re-keyed (§8.3)                                             |
| `CSRF_KEY`, `CURSOR_HMAC_KEY`         | 12 m                                                     | users re-fetch cursors / re-arm CSRF on next request                                                                 | deploy the new value                                                                                      |
| `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`   | 12 m                                                     | recovery codes must be regenerated by users; `ip_hash` correlation breaks across the boundary (accepted, documented) | staged                                                                                                    |
| DB, storage and mail credentials      | 6 m, and immediately on any personnel change with access | none (dual credentials during overlap)                                                                               | platform console + deploy                                                                                 |
| **Any secret, on suspected exposure** | immediately                                              | —                                                                                                                    | `docs/runbooks/secret-rotation.md`, followed by an audit-chain verification and a session mass-revocation |

Rotations are tracked in `docs/secret-inventory.md` (owner, purpose, last rotated, next due) — no
secret values, only metadata.

### 10.5 CI/CD secret story

- **No long-lived cloud credentials in CI.** GitHub Actions authenticates to the container host and
  to object storage via **OIDC federation** with short-lived tokens scoped to the specific deploy
  role. Netlify deploys use a build hook plus a repository-scoped token stored as an Actions secret.
- Runtime secrets live **only** in the container host's and Netlify's own secret stores, injected as
  environment variables. CI never reads them; CI cannot print them.
- Actions are pinned to full commit SHAs, `permissions:` is set to least privilege per workflow
  (default `contents: read`), and `pull_request_target` is not used.
- Deploys to production run only from `main`, require a passing CI suite and a protected-environment
  approval.
- Database migrations run in a dedicated job as `ess_migrator` with credentials that exist only for
  that job's OIDC-issued lifetime.
- Build logs are scanned for secret patterns; a match fails the job and the log is purged.
- `npm ci --ignore-scripts` in CI; a small allowlist of packages needing lifecycle scripts (e.g.
  `sharp`, `argon2` prebuilds) is installed in a separate, reviewed step.

---

## 11. Logging and monitoring

### 11.1 Structured logs

`pino` in JSON, one line per event, to stdout; the platform ships them to the log backend.
Every line carries: `time` (ISO-8601 UTC), `level`, `service` (`ess-api`), `env`, `version` (git SHA),
`requestId`, `route` (**templated**, `/payslips/:id`), `method`, `statusCode`, `durationMs`,
`userId` (uuid only), `sessionId`, `roles`, `ipHash`, `outcome`.

`requestId` comes from an inbound `X-Request-Id` if it is a valid UUID, otherwise it is generated; it
is echoed in the response header, stored on `audit_event.request_id`, and propagated into worker jobs
via the job payload — so one identifier ties an HTTP request, its audit rows, its logs and its
background work together.

### 11.2 Redaction: denylist plus allowlist

Two independent mechanisms, because either alone fails:

1. **Denylist (pino `redact`)** removes, at every depth: `req.headers.authorization`,
   `req.headers.cookie`, `req.headers["x-wd-csrf"]`, `res.headers["set-cookie"]`, `*.password`,
   `*.newPassword`, `*.currentPassword`, `*.token`, `*.refreshToken`, `*.accessToken`, `*.secret`,
   `*.totp`, `*.otp`, `*.code`, `*.recoveryCode`, `*.pan`, `*.aadhaar`, `*.accountNumber`, `*.ifsc`,
   `*.dateOfBirth`, `*.personalEmail`, `*.personalPhone`, `*.currentAddress`, `*.permanentAddress`,
   `*.ciphertext`, `*.body` (ticket/leave free text).
2. **Allowlist (the real control).** Request and response **bodies are never logged at all.** The HTTP
   logger emits only the fixed field list in §11.1. Domain logs must use
   `log.info({ ...allowlistedFields }, 'static message')`; an ESLint rule forbids template literals
   and string concatenation in the message argument of a logger call, which is what stops
   `log.info(\`saving ${email}\`)` — the single most common PII leak into logs.

**Never logged, under any level or circumstance:** passwords or any derivative; access, refresh,
reset, invite or CSRF tokens; TOTP secrets, TOTP codes, recovery codes; any DEK, KEK, pepper or HMAC
key; decrypted PAN/Aadhaar/UAN/bank/address/DOB/personal contact values; payslip amounts; ticket,
leave or rejection free text; raw client IPs or raw user-agent strings (hashes only, §14.3);
full SQL parameter values (Prisma query logging is `warn`+ in production, never `query`).

`LOG_LEVEL=debug` is refused in production (§10.2). Log retention: 30 days hot, 180 days cold, then
deleted — logs are an operational artefact, the audit trail is the record of truth.

### 11.3 Metrics

Prometheus-style counters and histograms exposed on an internal-only `/metrics`:
`http_requests_total{route,status}`, `http_request_duration_seconds`, `auth_login_total{outcome}`,
`auth_lockout_total`, `authz_denied_total{permission,role}`, `refresh_reuse_total`,
`mfa_failure_total`, `rate_limit_tripped_total{route}`, `pii_unmask_total{kind,actor_role}`,
`export_total{kind}`, `payroll_state_transitions_total{from,to}`, `outbox_pending`,
`outbox_failed_total`, `hibp_degraded_total`, `audit_chain_verification_failures_total`,
`audit_write_latency_seconds`, `decrypt_failures_total`, `upload_rejected_total{reason}`.

### 11.4 Security alerting

| Alert                                       | Condition                                                                                           | Severity | Route                                           |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------- |
| Refresh-token reuse                         | any `AUTH.REFRESH_REUSE_DETECTED`                                                                   | **P1**   | page security on-call + email the affected user |
| Audit chain broken                          | any verification failure                                                                            | **P1**   | page                                            |
| AAD mismatch / decrypt failure              | any `SECURITY.CIPHERTEXT_AAD_MISMATCH`, or `decrypt_failures_total` > 0                             | **P1**   | page                                            |
| Mass PII unmask                             | `pii_unmask_total` > 30 per actor per hour                                                          | **P1**   | page + auto-suspend the session pending review  |
| Malware in upload                           | any `SECURITY.UPLOAD_MALWARE_DETECTED`                                                              | **P1**   | page                                            |
| Credential-stuffing wave                    | > 100 `AUTH.LOGIN_FAILED` org-wide in 5 min, or ≥ 25 distinct accounts from one `ip_hash` in 10 min | **P2**   | alert channel                                   |
| Payroll published outside the change window | `PAYROLL.RUN_PUBLISHED` outside the configured window, or by a first-time publisher                 | **P2**   | alert + HR notification                         |
| Bulk approvals                              | > 100 approve/reject by one actor in an hour                                                        | **P2**   | alert (rubber-stamping / compromised manager)   |
| Role granted                                | any `ADMIN.ROLE_GRANTED` for `HR`/`ACCOUNTS`                                                        | **P2**   | alert channel, always, even when legitimate     |
| Export volume                               | any export > 1 000 rows, or > 3 exports/actor/day                                                   | **P2**   | alert                                           |
| Breach-check degraded                       | `hibp_degraded_total` rising for 15 min                                                             | **P3**   | ticket                                          |
| Outbox backlog                              | `outbox_pending` > 50 for 15 min or any `TICKET.EMAIL_FAILED`                                       | **P3**   | ticket                                          |
| CSP violations                              | a new `blocked-uri` appearing after a release                                                       | **P3**   | ticket                                          |
| Cert expiry                                 | < 21 days                                                                                           | **P3**   | ticket                                          |

Alert definitions live in `infra/monitoring/alerts.yaml` and are reviewed quarterly. Every P1 has a
runbook in `docs/runbooks/`.

---

## 12. Dependency and supply-chain security

| Control            | Implementation                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lockfile           | A single `package-lock.json` at the workspace root, committed. `npm ci` everywhere — `npm install` is forbidden in CI and blocked by a CI check on lockfile drift                                                                                                                                                                                                       |
| Install hardening  | `npm ci --ignore-scripts` by default; `.npmrc` sets `ignore-scripts=true`, `audit=true`, `fund=false`, `save-exact=true`; native prebuilds installed in a separate reviewed step                                                                                                                                                                                        |
| Version pinning    | Exact versions for runtime dependencies (no `^`), so a patch release cannot enter production without a PR                                                                                                                                                                                                                                                               |
| Vulnerability gate | `npm audit --audit-level=high` as a **required** CI job. High/critical blocks merge. An accepted risk needs a dated, owner-signed entry in `docs/security-exceptions.md` with an expiry ≤ 90 days, and CI fails on an expired exception                                                                                                                                 |
| Update automation  | **Renovate** (`renovate.json`): grouped weekly minor/patch PRs, immediate PRs for security advisories, automerge only for devDependency patches with green CI, and a dependency dashboard                                                                                                                                                                               |
| SAST               | **Semgrep** (`p/typescript`, `p/nodejs`, `p/owasp-top-ten`, plus `infra/semgrep/widedrop.yml` with project rules: no `$queryRawUnsafe`, no `dangerouslySetInnerHTML`, no `new RegExp(` with a non-literal, no `prisma` import in `routes/`, no logger template literals, no `data: req.body` in a Prisma write, no route without `config.permission`) — required CI job |
| CodeQL             | GitHub Advanced Security `javascript-typescript` on PR and a weekly full scan                                                                                                                                                                                                                                                                                           |
| Secret scanning    | GitHub secret scanning + **push protection**; `gitleaks` in pre-commit and CI (§10.1)                                                                                                                                                                                                                                                                                   |
| Container          | Distroless/slim Node 22 base, pinned by digest; non-root user; read-only root filesystem; no shell in the runtime image; **Trivy** image scan in CI, failing on high/critical OS CVEs; image rebuilt weekly so base-image patches ship even without a code change                                                                                                       |
| Provenance         | `npm pkg set` provenance for any published internal package; SBOM (CycloneDX) generated per build and attached to the release artefact                                                                                                                                                                                                                                  |
| License compliance | `license-checker` CI job with an allowlist (MIT/ISC/BSD/Apache-2.0); copyleft requires review                                                                                                                                                                                                                                                                           |
| Web bundle         | No third-party runtime scripts, no analytics, no font CDN (fonts are self-hosted, which is also why `font-src 'self'` holds). Bundle size and the dependency list are reviewed on every Renovate PR that touches `apps/web`                                                                                                                                             |
| Branch protection  | `main` requires a PR, one approving review, all required checks green, no force-push, signed commits encouraged and required for release tags                                                                                                                                                                                                                           |

---

## 13. OWASP Top 10 (2021) compliance

| #       | Category                                 | Controls in this system                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Where it lives                                                                                                                                                              |
| ------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A01** | Broken Access Control                    | Deny-by-default route guard with boot-time assertion; the §4.4 permission matrix; ABAC scopes compiled into the Prisma `WHERE` (no fetch-then-check); `404` for out-of-scope objects; no client-supplied role/id ever trusted; self-scoped writes derive the employee id from the token; separation of duties (§4.9); HMAC-bound cursors; no impersonation feature                                                                                                                                                                                                                                                                                                                                                                      | `apps/api/src/plugins/authorize.ts`, `src/authz/{matrix,scopes,where,predicates,separation}.ts`, `apps/api/test/routes.guard.test.ts`, `packages/shared/src/permissions.ts` |
| **A02** | Cryptographic Failures                   | TLS 1.2+ with HSTS; Argon2id + pepper; AES-256-GCM envelope encryption with AAD row binding on A2–A5; KEK/DEK with versioning and online rotation; blind indexes for lookup; keys never in the DB or repo; SHA-256 file integrity; HMAC audit chain; server-side masking; `no-store` on every authenticated response                                                                                                                                                                                                                                                                                                                                                                                                                    | `src/crypto/{envelope,keys,blind-index,mask}.ts`, `src/auth/password.ts`, `src/plugins/security-headers.ts`, §6.6                                                           |
| **A03** | Injection                                | Prisma parameterisation with `*Unsafe` banned; tagged-template raw SQL only; Zod `.strict()` on body/query/params/headers; `secure-json-parse` against prototype pollution; React auto-escaping with `dangerouslySetInnerHTML` banned; structured (non-HTML) rich text; CSV formula-injection escaping; no XML parser registered (no XXE); email sent via a provider API with CR/LF stripping                                                                                                                                                                                                                                                                                                                                           | `src/plugins/validation.ts`, `src/export/csv.ts`, `apps/web/src/components/RichText.tsx`, `infra/semgrep/widedrop.yml`                                                      |
| **A04** | Insecure Design                          | Threat model (§1) driving the design; the payroll invariants of §4.12 (single visibility predicate, persisted-predecessor transitions, the input-manifest digest closing the validate→calculate TOCTOU, snapshotted approvers, terminal publication, verifiable `input_digest`); maker-checker and self-dealing bans with the `‡` semantics pinned down (§4.9); MFA step-up on high-impact actions; the anti-fabrication contract (§4.11) so a denial never renders a number; acknowledgement integrity (§4.13); idempotency keys so the client cannot manufacture duplicate records; explicit no-impersonation (R6) and no-user-supplied-URL design constraints                                                                        | this document §4.11–§4.14, `docs/WORKFLOWS.md`, `src/services/payroll/*.ts`                                                                                                 |
| **A05** | Security Misconfiguration                | Zod-validated env with fail-fast and weak-secret refusal; strict CSP with no `unsafe-inline` (and the CSS strategy that makes it achievable, §6.3); full security-header set; exact-match CORS allowlist; `trustProxy` pinned to known CIDRs; least-privilege DB roles; non-root read-only container; errors never leak stack traces or echo input                                                                                                                                                                                                                                                                                                                                                                                      | `src/config/env.ts`, `src/plugins/{security-headers,cors}.ts`, `apps/web/public/_headers`, `infra/netlify/netlify.toml`, `infra/docker/Dockerfile`                          |
| **A06** | Vulnerable & Outdated Components         | Lockfile + `npm ci --ignore-scripts`; exact pinning; `npm audit` CI gate with expiring exceptions; Renovate; Trivy image scanning; weekly base-image rebuild; SBOM                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `.github/workflows/ci.yml`, `renovate.json`, `.npmrc`                                                                                                                       |
| **A07** | Identification & Authentication Failures | Argon2id + pepper; breach check with graceful degradation; no composition rules or forced rotation; progressive per-account/per-IP/global lockout; generic errors with a timing floor; mandatory TOTP MFA with replay prevention and hashed recovery codes; short access tokens; rotating refresh tokens with family reuse detection; revocation on password/role/status change                                                                                                                                                                                                                                                                                                                                                         | `src/auth/*`, §2, §3                                                                                                                                                        |
| **A08** | Software & Data Integrity Failures       | Pinned action SHAs and OIDC deploys; no third-party runtime scripts; hash-chained append-only audit with external checkpoint anchoring; `payslip.input_sha256` proving a payslip matches its inputs; file `sha256` verified before every download; immutable published policy versions and locked payroll runs; AAD-bound ciphertext detecting row swaps                                                                                                                                                                                                                                                                                                                                                                                | `src/audit/{audit,chain,verify,checkpoint-worker}.ts`, `src/files/storage.ts`, `.github/workflows/*`                                                                        |
| **A09** | Security Logging & Monitoring Failures   | The mandatory audit vocabulary (§8.1) written in the same transaction as the change; a **keyed** HMAC chain computed in the application rather than an unkeyed one in a database trigger (§8.3, R4) — the difference between tamper-evidence and tamper-theatre against a privileged insider; gapless `seq` from `audit_chain_head`, so the integrity alarm does not cry wolf on the first rollback; external object-locked checkpoint anchoring making truncation detectable; authn and authz-denial auditing; hashed IP/UA so the record is not a location history (R5); structured logs with request-id correlation; redaction allowlist+denylist; security metrics; the P1–P3 alert table with runbooks; nightly chain verification | `src/audit/*`, `src/lib/logger.ts`, `infra/monitoring/alerts.yaml`                                                                                                          |
| **A10** | Server-Side Request Forgery              | No feature anywhere fetches a user-supplied URL; `safeFetch()` host allowlist, https-only, DNS resolution with private/link-local/metadata range denial, address pinning, no redirect following, tight timeouts and body caps; platform egress allowlist                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `src/lib/safe-fetch.ts`, §5.5                                                                                                                                               |

---

## 14. Privacy — DPDP Act 2023 alignment

Widedrop Technologies is the **Data Fiduciary**; employees are **Data Principals**. The ESS is a
processing system for employment purposes.

### 14.1 Lawful purpose and notice

Processing relies on the **legitimate use for employment** ground (DPDP §7(i)) for payroll,
attendance, leave, benefits administration, statutory filing and workplace safety — consent is not
the basis, and the system therefore does not present a misleading consent dialog for those purposes.
For anything outside employment purposes (e.g. an optional wellness programme), a separate,
revocable, purpose-specific consent record is required in `consent_record(employee_id, purpose,
granted_at, withdrawn_at, notice_version)` before the data is collected.

- A plain-language privacy notice is published as a **policy version** (the persisted "Data Privacy
  Policy" the prototype already shows), so notice delivery and acknowledgement inherit the
  version-controlled, timestamped acknowledgement machinery (D7) and are provable.
- The notice names: the categories collected, the purpose of each, the retention period, how to
  exercise rights, and the Grievance Officer's contact — all read from persisted `org_setting` values,
  not hardcoded.
- `policy_acknowledgement` for the privacy notice constitutes the record of notice receipt.

### 14.2 Data minimisation in API responses

- **Collect** only what a named purpose requires. Blood group (medical emergency), marital status and
  gender (statutory reporting, benefits) each have a documented purpose in
  `docs/DATA-MODEL.md#field-purposes`; a field without a purpose is not added.
- **Return** only what the screen needs. The four DTO mappers (§4.5) are explicit allowlists, the
  response schema is enforced in production (§5.1), and a Prisma object is never serialised directly.
  Concretely: the Directory screen's payload contains no DOB, no personal contact, no compensation and
  no employee-code-derived identifiers beyond what is displayed.
- **No `GET /employees` returning everything.** Every collection endpoint is scoped, paginated
  (default 25, max 100) and field-limited.
- **Server-side aggregation.** Leave balances, expense totals, ticket and claim counts and every
  badge count are computed in SQL and returned as single numbers; the underlying rows are not shipped
  to the client "just in case". YTD and quarterly **compensation** tiles are the documented exception
  (§7.1, R7): those columns are envelope-encrypted, so the aggregate is read from the persisted,
  encrypted `payslip_fy_rollup` / `tds_quarter` row and decrypted in the API process — still one
  number over the wire, still a deterministic computation over persisted data (D1), simply summed at
  publication time instead of at read time.
- **Telemetry minimisation.** No analytics, no session-replay, no third-party scripts (§12). Raw IPs
  and user-agents are hashed at the boundary (§14.3).

### 14.3 Identifiers in security records

`ip_hash` and `user_agent_hash` (HMAC-SHA256 under `LOG_HASH_KEY`) are stored instead of raw values in
`audit_event`, `login_attempt`, `refresh_token`, `policy_acknowledgement` and the rate limiter. This
preserves everything security needs — correlation, repeat-offender detection, "was this the same
device?" — while ensuring the security subsystem is not itself a location-tracking database. Raw IPs
exist only transiently in memory and in platform edge logs under the provider's own retention.

### 14.4 Right to access, correct, and the other Data Principal rights

All rights are exercised through the **Help desk** flow, which gives every request a persisted record,
an SLA clock, an assignee and a full audit trail — rather than an unlogged email.

| Right (DPDP)                                 | How it is exercised                                                                                                                                                                                                   | SLA                          | Implementation                                                                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access / summary of processing** (§11)     | Ticket in the `DATA_REQUEST` queue, or self-service: the Profile screen already _is_ the access surface for most categories                                                                                           | 30 days                      | `export:employee_data` scoped to the single subject produces a machine-readable JSON + PDF pack: profile, employment, bank (masked), statutory (masked), leave ledger, payslips, documents, policy acknowledgements, tickets, and the list of categories shared with which processors |
| **Correction / completion / updating** (§12) | Self-service for contact fields; `profile_change_request` + ticket for name, DOB, bank and statutory fields (matching the prototype's "Request a change" affordance and the persisted note that ID proof is required) | 30 days                      | `approve:profile_change_request` (HR) / `verify:bank_change_request` (Accounts), both audited with before/after hashes (§8.5)                                                                                                                                                         |
| **Erasure** (§12(3))                         | Ticket                                                                                                                                                                                                                | 30 days, subject to override | Granted only where no statutory retention applies (§14.5). A refusal is recorded with its legal basis and communicated to the employee — silent refusal is not acceptable                                                                                                             |
| **Grievance redressal** (§13)                | Ticket auto-routed to the Grievance Officer queue                                                                                                                                                                     | 30 days                      | Escalation contact published in the privacy notice                                                                                                                                                                                                                                    |
| **Nomination** (§14)                         | `dependent`/nominee records in Benefits                                                                                                                                                                               | —                            | Already modelled                                                                                                                                                                                                                                                                      |

A data request never bypasses authorization: the requester's identity is the authenticated session,
and the export is scoped to `subject_employee_id = actor.employeeId` unless HR is fulfilling a
verified request on someone's behalf, which is itself audited.

### 14.5 Retention schedule

Erasure is **purpose-based**, not blanket: when the purpose is served and no statutory obligation
remains, the data goes.

| Data                                                      | Retention                                                                                                                              | Basis                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Payslips, payroll runs, payroll inputs, salary structures | 8 years from the end of the financial year                                                                                             | Income-tax / EPF record-keeping       |
| Form 16 and tax records                                   | 8 years                                                                                                                                | Income-tax                            |
| Statutory identifiers (PAN, UAN, PF, ESI)                 | Employment + 8 years                                                                                                                   | Statutory filing and dispute          |
| Aadhaar                                                   | **Only if a statutory purpose requires it**; else not collected. If collected, employment + 8 years, encrypted, never exported in bulk | DPDP minimisation                     |
| Bank account                                              | Employment + 8 years (payment evidence); superseded accounts retained 3 years then purged                                              | Payment dispute                       |
| Attendance records                                        | 5 years                                                                                                                                | Shops & Establishments / wage records |
| Leave ledger and requests                                 | 5 years                                                                                                                                | Employment dispute                    |
| Expense claims and bills                                  | 8 years                                                                                                                                | Income-tax substantiation             |
| Benefit enrolments, dependants                            | Employment + 3 years (claims tail)                                                                                                     | Insurance claim window                |
| Emergency contacts                                        | **Deleted 90 days after the last working day**                                                                                         | Purpose ends at exit                  |
| Personal contact details and addresses                    | Deleted 180 days after the last working day, unless a statutory or legal-hold reason applies                                           | Purpose ends at exit                  |
| Documents and letters issued                              | Employment + 8 years                                                                                                                   | Evidence                              |
| Policy acknowledgements                                   | Employment + 8 years                                                                                                                   | POSH/ISP compliance evidence          |
| Help-desk tickets                                         | 3 years (5 years for `DATA_REQUEST` and grievance tickets)                                                                             | Dispute and regulator evidence        |
| Notifications                                             | 12 months                                                                                                                              | Operational                           |
| Audit events                                              | Per §8.7                                                                                                                               | Security and statutory                |
| `login_attempt`                                           | 90 days                                                                                                                                | Rate limiting                         |
| Application logs                                          | 30 days hot / 180 days cold                                                                                                            | Operational                           |
| Backups / PITR                                            | 35 days rolling, encrypted                                                                                                             | Recovery                              |

`apps/api/src/workers/retention-worker.ts` runs nightly, driven by a `retention_rule` table (so the
schedule is data, auditable and changeable without a deploy), and each deletion or anonymisation batch
writes an audit event with the rule id and row count. **Legal hold**
(`legal_hold(subject_employee_id, reason, placed_by, placed_at, released_at)`) suspends every rule for
that subject; the worker skips held subjects and records that it did.

**Backup lag is documented, not hidden:** a record deleted today persists in encrypted backups for up
to 35 more days. Backups are not searched for individual erasure; the erasure request is recorded as
complete when the live system and the 35-day backup window have both elapsed, and the employee is told
this explicitly.

### 14.6 The scope rule, restated as a privacy rule

**An employee's personal data is never exposed to a role that lacks scope over that employee** —
regardless of how the data is reached: a screen, a list, a search result, a badge count, an aggregate,
a notification, an export, a PDF, an email, a log line, or an audit payload. Every one of those paths
goes through `authzWhere()` (§4.6) or the DTO allowlist (§4.5), and the empty-state contract (D5) means
the correct rendering of an out-of-scope or absent value is a designed empty state, never a fabricated
one.

Practical consequences worth stating because they are easy to get wrong:

- A Manager sees a report's **leave dates and resulting balance** but never their **payslip, salary,
  bank details, dependants, benefit enrolment or tickets**.
- HR sees profile and employment data org-wide but never **full bank account numbers**.
- Accounts sees bank, statutory and payroll data but never **leave reasons, dependants, benefit
  enrolments, emergency contacts, non-payroll documents or policy acknowledgements**.
- No role can read another user's authentication material — no permission for it exists.
- The Directory is ORG-visible by design and therefore contains **work** contact data only.

### 14.7 Processors, transfers and breach reporting

- Sub-processors (hosting, managed Postgres, object storage, email, ClamAV image source) are listed in
  `docs/PROCESSORS.md` with the data categories each touches and the contractual basis; the list is
  reviewed at each renewal and referenced from the privacy notice.
- Data is hosted in an Indian or equivalent region where the provider offers it; the region is pinned
  in `infra/` and any change requires an ADR.
- **Breach notification:** on a confirmed personal-data breach, the Data Protection Board of India and
  every affected Data Principal are notified without delay, per DPDP §8(6) and the applicable rules.
  `docs/runbooks/breach-response.md` defines detection (§11.4 alerts), containment (mass session
  revocation, key rotation), assessment (audit-chain reconstruction of exactly which
  `subject_employee_id` rows were accessed, by which actor, at what time — this is precisely what the
  `subject_employee_id` index exists for), notification drafting, and the post-incident review.

---

## 15. Deployment boundary: coexisting with `widedrop.com` on Netlify (D10)

The brief requires the ESS to live alongside an existing public site on a Netlify free-tier account.
§1 assumes the resulting host layout; this section specifies the controls that make the assumption
hold, because "same registrable domain, different security posture" is the weakest joint in the
architecture (T-SUB) and it is the one part of the system Widedrop does not fully control today.

### 15.1 Separation of the two properties

| Control                   | Requirement                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Netlify teams             | The ESS SPA lives on a **separate Netlify site under a separate Netlify team** from the marketing site, with no shared collaborators beyond the two named ESS owners. A compromise of the marketing site's Netlify login must not be able to deploy the ESS bundle. The free tier does not restrict this — it is an account-structure decision, not a paid feature                                |
| Build source              | The ESS site builds only from `main` of the ESS repository, via a CI-triggered build hook. Netlify's own Git auto-build is **disabled** for the ESS site so a repository push cannot deploy without passing the CI gates in §12                                                                                                                                                                   |
| Deploy previews           | **Disabled** on the ESS site. Netlify deploy previews are public, unindexed-but-guessable URLs; a preview of an ESS build is a free copy of the application shell for an attacker to study, and previews cannot be password-protected on the free tier. Staging is a separate, named site (`ess-staging.widedrop.com`) pointed at the staging API                                                 |
| **No path-based hosting** | The ESS must never be served at `widedrop.com/ess` or any path of the marketing origin. That would put the SPA in the **same origin** as marketing content, making every cookie, `localStorage` entry and script on the marketing site same-origin with the ESS — and it would make the `__Host-` cookie defence (§3.4) irrelevant. A dedicated host is not a preference here; it is load-bearing |
| Environment isolation     | Production and staging use different databases, different object-storage buckets, different KEKs, different signing keys and different mail credentials. No staging credential can read a production row. Staging holds **no** production data — payroll data is synthesised, never copied and masked, because a masking bug is unrecoverable                                                     |
| Shared-nothing failure    | An ESS outage cannot take down `widedrop.com` and vice versa: different platforms for compute, no shared origin, no shared DNS record, no shared account                                                                                                                                                                                                                                          |

### 15.2 DNS, certificates and the anti-takeover controls

T-SUB is the adversary this subsection exists for. A stale `CNAME` pointing at a decommissioned
service is the cheapest way to obtain a `*.widedrop.com` host, and a same-site host is a materially
better position than an unrelated one.

- **Record inventory.** Every `widedrop.com` record is inventoried in `infra/dns-inventory.md` with
  its owner, target and purpose. A record whose target no longer resolves to an account Widedrop
  controls is a takeover candidate and is removed the same day. The review is **quarterly and
  automated**: a scheduled job resolves every record and opens a `P3` ticket on a dangling `CNAME`,
  an `NXDOMAIN` target or a bucket/app name that is no longer claimed. A calendar reminder is not a
  control.
- **CAA records** on `widedrop.com`: `0 issue "letsencrypt.org"` plus `0 iodef "mailto:security@widedrop.com"`,
  so no other CA will issue for any subdomain, including one an attacker has taken over.
- **DNSSEC** enabled at the registrar, and **registrar lock** (`clientTransferProhibited`,
  `clientUpdateProhibited`) with registrar-account MFA. A domain transfer defeats every control in
  this document at once.
- **Certificate Transparency monitoring** for `widedrop.com`, `*.widedrop.com` and
  `widedroptech.com`, alerting on any certificate this system did not request (`P2`).
- **Lookalike watch.** `widedroptech.com` is a second registrable domain that already looks like a
  Widedrop property. It — and any similar registration — MUST publish `v=DMARC1; p=reject; rua=…`
  and an SPF record naming only the senders that legitimately exist, even though the ESS never sends
  _from_ it (§8.6.7). An unprotected lookalike domain is a phishing kit someone else can pick up, and
  T-PHISH's goal in §1.2 is salary redirection.
- **Mail authentication on `widedrop.com`:** SPF (hard fail), DKIM on the mail provider's selector,
  `DMARC p=reject` with aggregate reports to a monitored address, and MTA-STS + TLS-RPT. The
  password-reset and payslip-published notices are the two mails an attacker most wants to spoof.
- **HSTS preload** stays deliberately unsubmitted (§6.2) until the inventory above confirms every
  `*.widedrop.com` host is HTTPS-only — preloading the apex would force HTTPS on hosts owned by a
  team that did not consent to the constraint, and the list is slow to leave.

### 15.3 Netlify-side configuration for the ESS site

- `infra/netlify/netlify.toml` and `apps/web/public/_headers` carry the §6.3–§6.4 header set. A
  Playwright check in CI fetches the deployed `index.html` and asserts every header is present with
  the exact expected value; a header silently dropped by a platform change is a build failure, not a
  discovery made during an incident.
- SPA history fallback is a `200` rewrite of unknown paths to `/index.html`; `/index.html` and
  `/config.json` are `no-store` (§6.6) so a CSP change reaches clients on the next navigation.
- No Netlify Functions, no Edge Functions, no Forms, no Identity, no Analytics on the ESS site: the
  SPA host serves **static assets only** and holds no secret (§10.2). This is what makes B1 in §1.3
  a zero-trust boundary rather than a second place to audit.
- `/config.json` contains only the API base URL and the environment name. A CI check asserts the
  deployed bundle and `config.json` contain no string matching `/KEY|SECRET|TOKEN|PEPPER|PASSWORD/i`.

### 15.4 Backend platform requirements (what "appropriate for persistent business data" means)

- Managed PostgreSQL 16 with: automated daily backups **plus** PITR/WAL archiving, a 35-day recovery
  window (§14.5), encryption at rest, private networking with **no public endpoint**, and
  `sslmode=verify-full` enforced by the boot check (§6.1).
- **Restore is tested, not assumed.** A quarterly drill restores the latest backup into an isolated
  environment, runs the audit-chain verification (§8.4) and the §7.3 canary decrypt over the restored
  data, and records the result in `docs/runbooks/dr-drill-log.md`. A backup that has never been
  restored is a hypothesis.
- **A restore must not resurrect revoked authority.** After any restore to a point in the past,
  `token_version` is bumped for every user, every `session` and `refresh_token` row is deleted, and
  role grants are reconciled against the audit trail from the restore point forward — otherwise a
  restore silently reinstates a role revoked after the snapshot. This step is in the restore runbook
  and is part of the drill.
- Object storage: private bucket, block-public-access, versioning, object-lock (governance) on the
  payroll and document prefixes and compliance-mode lock on the audit anchor prefix (§8.4),
  lifecycle rules aligned to §14.5, and access only through the API's own credentials.
- The container host runs the API as a non-root user on a read-only root filesystem with no shell in
  the image (§12), a minimum of two instances behind the platform's load balancer, and outbound
  egress restricted to `OUTBOUND_ALLOWLIST` (§5.5) where the platform supports it.
- Data residency is pinned to an Indian region where the provider offers one (§14.7); any change is
  an ADR, because DPDP obligations and the employment context both attach to it.

---

## Appendix A — Security acceptance criteria (must pass before production)

1. Boot-time assertion: every route declares a permission or an explicit `public: true`; the suite
   fails on any unguarded route.
2. Matrix-driven authorization tests: for every `—` cell in §4.4, a real request with only that role
   returns `403` or `404`; for every granted cell, an in-scope request succeeds and an out-of-scope one
   returns `404`.
3. A payslip is unreachable by any API path until its `payroll_cycle` is `PUBLISHED` and a
   `payslip_publication` row exists (§4.12 P-1), proven by an integration test that walks the full
   workflow and asserts `404` at **every** earlier state, through **every** path: `payslip:read:self`,
   `payslip:read:any`, `payslip:download:self`, `payslip:email:self`, `GET /files/:id` with a known
   object id, global search, the Home card, the YTD tiles, the notification table and every export.
4. Audit chain verification passes over a seeded dataset, and fails with the correct `firstBadSeq`
   when a row is mutated directly in SQL.
5. `document.querySelectorAll('[style]').length === 0` on every screen, and no CSP violation is
   reported during a full end-to-end run with the production policy enforced.
6. `npm audit --audit-level=high`, Semgrep, CodeQL, gitleaks and Trivy all clean.
7. The API refuses to boot with a missing, short, placeholder or reused secret (tested for each rule).
8. No response body anywhere contains a full PAN, Aadhaar, bank account number or TOTP secret, proven
   by a response-scanning test fixture run across the whole integration suite.
9. Key rotation and the DR decrypt drill have both been rehearsed in staging and logged.
10. Every screen renders its designed empty state against an empty database, with no console errors
    and no fabricated values.
11. **Empty and denied are byte-identical.** For every collection endpoint, the response to an actor
    with no scope equals the response to an actor with scope over zero rows (§4.11.1).
12. **No fabricated constant.** `no-business-literals` and `no-coalesce-measure` (§4.11.2) pass, and a
    CI grep finds none of the prototype's sample-data identifiers under `apps/`.
13. **Workflow cannot be short-circuited.** `payroll-invariants.test.ts` proves P-2 through P-5: each
    transition is refused from every non-predecessor state; changing a committed input batch after
    `VALIDATED` forces `INPUTS_CHANGED` on calculate; the publisher cannot be the uploader,
    committer or approver; a published payslip cannot be updated by any route or by direct SQL.
14. **Traceability verifies.** `payslip.input_sha256` recomputes for every payslip in a seeded run
    (P-7), and mutating one `payslip_line` in SQL makes exactly that payslip fail.
15. **Acknowledgement integrity.** A second ack for the same `(employee, policy_version)` is refused
    by the unique index; an ack without a prior `POLICY.VIEWED` is `422`; `UPDATE`/`DELETE` on
    `policy_acknowledgement` is refused at the database; the stored `body_sha256_ack` matches the
    published version (§4.13).
16. **Audit chain is keyed and gapless.** Verification passes over a seeded dataset; it still passes
    after a deliberately rolled-back transaction (no false gap); it fails with the correct
    `firstBadSeq` when a row is mutated in SQL; and it fails when the chain is recomputed with a
    _bare_ SHA-256, proving the HMAC key is actually load-bearing (§8.3, R4).
17. **CSRF is reachable and enforced.** An end-to-end run proves the SPA obtains its CSRF token from
    a response body (never from `document.cookie`, which is cross-host and would silently fail), that
    `/auth/refresh` succeeds on a cold load without one, and that `/auth/logout` fails without one
    (§3.5).
18. **MFA is unbypassable.** A correct password alone never yields a session for any role; an expired,
    consumed, or IP/UA-mismatched `mfa_challenge` is refused; five wrong codes consume the challenge
    (§2.4).
19. **Unauthenticated surface matches §4.6 exactly.** The boot assertion diffs the live route table
    against that table and fails on any addition; `GET /.well-known/jwks.json` and `/metrics` are
    unreachable on the public listener.
20. **CSP reports actually arrive.** A deliberate violation in a report-only run produces a stored
    report — proving the `Reporting-Endpoints` header, the `application/csp-report` parser and the
    CSRF/CORS exemption are all present (§6.3). A rollout that reports nothing is assumed broken
    until this test passes.
21. **Uploads are scanned before they are parsed.** An EICAR-bearing XLSX is quarantined and never
    reaches the spreadsheet parser; a zip-bomb XLSX is rejected on the decompression ratio cap
    (§5.3.9–10).
22. **Restore drill.** A production backup restores into an isolated environment, the audit chain
    verifies over it, a canary row decrypts, and the post-restore revocation step (§15.4) is executed
    and logged.
23. **Domain controls.** CAA, DNSSEC, registrar lock, `DMARC p=reject` on both `widedrop.com` and
    `widedroptech.com`, and a clean dangling-record scan are all evidenced before go-live (§15.2).
