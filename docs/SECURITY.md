# Widedrop ESS — Security Architecture, RBAC/ABAC Model and Privacy Controls

**Status:** Normative specification. An implementer MUST NOT deviate without an ADR in `docs/adr/`.
**Scope:** `apps/api` (Fastify 5 / Node 22 / Prisma / PostgreSQL 16), `apps/web` (React 18 / Vite SPA),
`packages/shared`, `infra/`. Companion documents: `docs/DATA-MODEL.md`, `docs/API.md`,
`docs/WORKFLOWS.md`, `docs/DEPLOYMENT.md`, `design/DESIGN-SYSTEM.md`.

**Host layout assumed throughout (see `docs/DEPLOYMENT.md`):**

| Host | Serves | Platform |
|---|---|---|
| `widedrop.com` | existing public marketing site | Netlify free tier (untouched) |
| `ess.widedrop.com` | ESS SPA — static assets only, no server code | Netlify (separate site) |
| `api-ess.widedrop.com` | ESS API — the only trusted compute | container host (Render/Fly) |
| `db` (private network) | PostgreSQL 16 | managed, not publicly routable |
| `files.<provider>` | S3-compatible object storage, private bucket | signed URLs only |

`ess.widedrop.com` and `api-ess.widedrop.com` are **cross-origin but same-site** (registrable domain
`widedrop.com`). Every cookie and CSRF decision below is justified against that fact.

**Prime directives inherited from the product brief (restated so they are testable here):**

- D1 — Every displayed value comes from persisted data or a deterministic computation over it. Security
  consequence: authorization is applied to the *query*, not to the rendered output, so an unscoped read
  cannot leak through an aggregate, a badge count, a search result or a notification.
- D2 — Exactly four personas: Employee, Manager, HR, Accounts. A user may hold several.
- D3 — Payslips do not exist or become visible until the payroll workflow completes.
- D4 — Complete auditability for HR, payroll, approval, policy and administrative actions.
- D5 — Empty states are first-class; a denied or out-of-scope read renders the designed empty state,
  never a fabricated value and never a stack trace.

---

## 1. Threat model

### 1.1 Assets, by sensitivity

| # | Asset | Where it lives | Classification | Impact if breached |
|---|---|---|---|---|
| A1 | Payroll amounts (`payslip`, `payslip_line`, `salary_structure`, `payroll_input_row`) | Postgres | **Restricted** | Financial disclosure, industrial-relations damage, insider trading on comp data |
| A2 | Statutory identifiers (PAN, Aadhaar, UAN, PF account, ESI) | Postgres, app-layer encrypted | **Restricted / DPDP sensitive** | Identity theft, statutory fraud; Aadhaar misuse is a criminal exposure |
| A3 | Bank account number + IFSC (`bank_account`) | Postgres, app-layer encrypted | **Restricted** | Direct financial fraud — salary redirection is the single highest-value attack on an ESS |
| A4 | Personal PII (DOB, personal email/phone, home addresses, blood group, marital status, gender) | Postgres, app-layer encrypted for the named columns | **Confidential / DPDP personal data** | Doxxing, social engineering, DPDP contravention |
| A5 | Dependants & emergency contacts (minor's data) | Postgres, encrypted | **Confidential / children's data under DPDP §9** | Statutory breach; children's data has stricter handling |
| A6 | Health/benefit enrolment (GMC, dependants covered, NPS PRAN) | Postgres | **Confidential** | Health inference, discrimination risk |
| A7 | Policy acknowledgements (`policy_acknowledgement`) | Postgres | **Confidential, integrity-critical** | POSH/ISP compliance evidence; forging or deleting one defeats a legal defence |
| A8 | Audit trail (`audit_event`, `audit_checkpoint`) | Postgres, append-only, hash-chained | **Integrity-critical** | Loss of non-repudiation; an attacker who can edit it erases everything else |
| A9 | Authentication material (Argon2id hashes, TOTP secrets, recovery-code hashes, refresh-token hashes) | Postgres, encrypted/ hashed | **Restricted** | Full account takeover |
| A10 | Signing & encryption keys (JWT Ed25519 private keys, KEK, pepper, blind-index key, audit chain key) | Platform secret store / KMS — **never** Postgres, **never** the repo | **Critical** | Total compromise: forge tokens, decrypt A2–A5, rewrite A8 |
| A11 | Documents & letters (offer, appraisal, Form 16, salary certificates, expense bills) | Private object storage | **Confidential** | Payroll + PII disclosure in one file |
| A12 | Help-desk ticket bodies (often contain PAN corrections, bank details, medical context) | Postgres | **Confidential** | Free-text PII channel — treat as A4 |
| A13 | Availability of payroll publication on the pay date | Whole system | **High** | Statutory wage-payment deadlines |

### 1.2 Actors

**Authorized:** Employee, Manager, HR, Accounts (D2); the API service identity; the payroll generation
worker; platform operators (Render/Fly, Netlify, managed Postgres); CI/CD (GitHub Actions).

**Adversaries:**

| ID | Adversary | Capability | Primary goal |
|---|---|---|---|
| T-EXT | Unauthenticated internet attacker | Can reach `ess.widedrop.com`, `api-ess.widedrop.com` | Credential stuffing, enumeration, RCE |
| T-PHISH | Phisher | Can send mail as a lookalike, can host a fake login page | Harvest credentials + OTP, then redirect salary (A3) |
| T-EMP | Curious/malicious authenticated Employee | Valid session, browser devtools, can edit client JS | Read peers' payslips, manager approvals, HR data |
| T-MGR | Malicious Manager | Valid privileged session | Read outside own reporting chain; approve own leave/expense/attendance |
| T-HR / T-ACC | Malicious privileged insider | Broad legitimate access | Mass export, silent salary edit, grant self a role, erase the audit trail |
| T-SUB | Attacker controlling **any other `*.widedrop.com` host** (incl. the Netlify marketing site, a stale DNS record, a subdomain takeover) | Same-site with the ESS | Cookie injection, same-site CSRF, token theft |
| T-SUPPLY | Compromised npm dependency / CI token | Code execution in build or runtime | Exfiltrate A10, backdoor auth |
| T-PLAT | Platform / DB operator | Raw disk, raw DB | Read A1–A5 at rest |

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

| STRIDE | Threat | Control |
|---|---|---|
| S | Phishing clone at `ess-widedrop.com` (T-PHISH) | WebAuthn-ready TOTP-now MFA (§2.6); mail from `no-reply@widedrop.com` with DMARC `p=reject`; login page never framed (`frame-ancestors 'none'`); user education banner sourced from `announcement` |
| T | Malicious JS injected via a compromised build or third-party script | No third-party scripts at all; CSP `script-src 'self'` with **no** `unsafe-inline`/`unsafe-eval` (§6.3); Subresource Integrity is unnecessary because nothing is cross-origin; immutable hashed asset filenames |
| R | — | — |
| I | Tokens stolen from `localStorage` by XSS | Access token held **in a JS closure in memory only**; refresh token in an `HttpOnly` cookie the SPA cannot read (§3) |
| D | Netlify outage | SPA is static and cached; API and data are on a different provider, so an ESS outage never takes down `widedrop.com` and vice versa |
| E | Subdomain takeover of a stale `*.widedrop.com` record (T-SUB) | `__Host-` cookie prefix (blocks cookie injection from a sibling host), CSRF token bound to the session (§3.5), strict CORS allowlist, quarterly DNS record review recorded in `infra/dns-inventory.md` |

#### B2 — browser ↔ API  *(the authorization boundary)*

| STRIDE | Threat | Control |
|---|---|---|
| S | Credential stuffing / password spraying (T-EXT) | Argon2id + pepper (§2.1), breach check (§2.3), per-account progressive lockout + per-IP + global spray detection (§2.5, §9) |
| S | Token forgery | Ed25519-signed access JWT with `kid`; `alg` allowlist of exactly `["EdDSA"]`; `iss`/`aud` verified; no JWK embedded in the token |
| S | Session fixation / replay after logout | Server-side `session` row consulted on every request (`sid` claim), refresh rotation + family reuse detection (§3.2) |
| T | Parameter tampering: `POST /leave-requests {employeeId: <someone else>}` | `employeeId` is **never** accepted from the body for self-scoped writes; it is derived from the token's `sub` (§4.6) |
| T | CSRF on the cookie-authenticated refresh/logout routes | Signed double-submit token + `Origin`/`Sec-Fetch-Site` enforcement (§3.5) |
| R | "I never approved that expense / never acknowledged that policy" | Hash-chained audit written in the same transaction as the state change (§8) |
| I | IDOR: `GET /payslips/9f3…` belonging to another employee (T-EMP) | Scope compiled into the Prisma `WHERE`, never a post-fetch check; out-of-scope ⇒ **404** (§4.6) |
| I | Enumeration of employees / emails via login, reset, search | Uniform generic responses + constant-ish timing (§2.4), directory search returns only the ORG-safe DTO (§4.4) |
| D | Expensive queries, upload floods, export abuse | Per-route rate limits (§9), pagination caps, upload size caps, exports queued and serialised per actor |
| E | Client sets `X-Roles: HR` or edits the JWT payload | Signature verified; roles are re-read from `user_role` when `ver` mismatches; **no** header, query param or body field ever influences authorization (B2-1) |

#### B3 — API ↔ PostgreSQL

| STRIDE | Threat | Control |
|---|---|---|
| T | SQL injection | Prisma parameterised queries; `$queryRawUnsafe` banned by ESLint; raw SQL only via tagged `$queryRaw` with typed params (§5.4) |
| R | Privileged insider edits a payslip row directly (T-HR/T-ACC/T-PLAT) | App DB role has no `UPDATE`/`DELETE` on `audit_event`; audit chain verification job detects gaps; payslips are immutable after publication (amendments are new rows) |
| I | Disk/backup theft (T-PLAT) | Provider-managed encryption at rest **plus** application-layer AES-256-GCM envelope encryption on A2–A5 columns, keys outside the DB (§7) |
| D | Connection exhaustion | Prisma pool caps, statement timeout `15s`, `idle_in_transaction_session_timeout 30s` |
| E | App role creating roles / altering schema at runtime | Runtime role `ess_app` has only `SELECT/INSERT/UPDATE/DELETE` on the application schema and `SELECT/INSERT` on `audit_event`; migrations run as a separate `ess_migrator` role from CI only |

#### B4 — API ↔ object storage

| STRIDE | Threat | Control |
|---|---|---|
| S/E | Guessable object keys | Keys are server-generated UUIDv7 paths with no user input (§5.3) |
| T | Malicious upload (polyglot, PDF with JS, SVG with script) | Magic-byte sniffing, extension+MIME agreement, image re-encode, SVG rejected outright, PDF active-content rejection (§5.3) |
| I | Public bucket / leaked long-lived URL | Bucket private, no public ACL, block-public-access on; URLs signed for 120 s, single resource, `Content-Disposition: attachment` |
| D | Storage fills | Per-actor and per-entity upload caps and quotas (§9) |

#### B5/B6 — API ↔ email & HIBP

| STRIDE | Threat | Control |
|---|---|---|
| I | Password or hash leaving the process | HIBP receives only the **first 5 hex chars** of the SHA-1 (§2.3) |
| T | SSRF pivot via an outbound call | `safeFetch()` host allowlist + private-IP rejection + no redirects (§5.5); no user-supplied URL is ever fetched |
| S | Email header/content injection into the helpdesk mail | Provider API (JSON) not raw SMTP concatenation; CR/LF stripped from every header-bound field; body fields are text-only, length-capped |
| D | Mail provider outage blocks ticket creation | Ticket is persisted first, mail is an outbox row (`notification_outbox`) delivered by a worker with retries — a mail failure never fails the user's write (§8.6) |

#### B7/B8 — CI/CD and operators

| STRIDE | Threat | Control |
|---|---|---|
| T/E | Malicious dependency or workflow (T-SUPPLY) | Lockfile + `npm ci`, `--ignore-scripts` in CI, pinned action SHAs, OIDC deploy (no long-lived cloud keys), branch protection with required review, SAST + secret scanning (§12) |
| R | Unattributed production change | All deploys from `main` via CI; console access requires SSO+MFA; break-glass DB access is a documented, time-boxed, logged procedure (§8.7) |
| I | Secrets in logs/artifacts | Redaction allowlist (§11), secret scanning with push protection (§12) |

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

| Rule | Value |
|---|---|
| Minimum length | 12 characters for `EMPLOYEE`-only users; **14** if the user holds `MANAGER`, `HR` or `ACCOUNTS` |
| Maximum length | 256 characters (DoS cap; enforced before hashing) |
| Composition rules | **None.** No upper/lower/digit/symbol requirement, no forced rotation |
| Normalisation | Unicode NFKC before any check or hash; all codepoints allowed including spaces and emoji |
| Breach check | Rejected if found in HIBP (§2.3) |
| Local blocklist | Rejected if in `packages/shared/data/common-passwords-10k.txt` (case-folded) |
| Context check | Rejected if it contains, case-insensitively and after stripping non-alphanumerics, any of: work email local-part, personal email local-part, first name, last name, `employee_code`, `widedrop`, `ess` |
| Strength | `zxcvbn-ts` score ≥ 3 with the above as user inputs |
| Reuse | Rejected if it matches any of the last 5 hashes in `password_history` (verified with Argon2id against each stored hash, capped at 5 verifications) |
| Expiry | None. Rotation is event-driven only (breach signal, compromise, offboarding) |

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
- Set `user.breach_check_pending = true` on the credential written while degraded. A nightly job
  re-checks those passwords' stored *SHA-1 prefix*… which is not recoverable from the Argon2 hash, so
  instead the job simply flags the user to be re-prompted at next login when the service recovers:
  the login flow, on seeing `breach_check_pending`, performs the HIBP check against the plaintext the
  user has just supplied, clears the flag, and if breached forces a password change before issuing a
  session. This is the only correct way to close the gap without storing weaker hashes.

### 2.4 Generic responses and enumeration resistance

| Endpoint | Always returns | Notes |
|---|---|---|
| `POST /auth/login` | `401 {"code":"INVALID_CREDENTIALS"}` for unknown user, wrong password, unverified, suspended or offboarded account | Locked accounts are the single exception: `423 {"code":"ACCOUNT_LOCKED","retryAfterSeconds":n}` only **after** the password was verified correct, so lock state is never an oracle for an attacker who does not already know the password |
| `POST /auth/password-reset/request` | `202 {"status":"accepted"}` always | Mail sent only if an active account exists |
| `POST /auth/password-reset/confirm` | `400 {"code":"INVALID_OR_EXPIRED_TOKEN"}` for wrong, used, expired or unknown token | |
| `POST /auth/mfa/verify` | `401 {"code":"INVALID_MFA_CODE"}` | Never distinguishes "no MFA enrolled" |
| `POST /auth/activate` | `400 {"code":"INVALID_OR_EXPIRED_TOKEN"}` | |

**Timing.** The login handler always performs one Argon2id verification: when the user does not exist
it verifies against a fixed dummy PHC hash generated at boot from a random password
(`DUMMY_ARGON2_HASH`). Every negative path then sleeps until a floor of 250 ms total handler time
(`await untilFloor(startedAt, 250)`), so response time does not distinguish the branches.

No endpoint anywhere returns "user not found", an email address that was not supplied by the caller,
or a count that reveals whether an identifier exists.

### 2.5 Account lifecycle

`user.status` enum: `INVITED → PENDING_MFA → ACTIVE → SUSPENDED → OFFBOARDED` (+ `LOCKED` as a
transient overlay held in `user.locked_until`, not a status).

| State | Meaning | Can authenticate? | Entered by |
|---|---|---|---|
| `INVITED` | HR created the user; invite token issued; no password yet | No | `POST /admin/users` (`invite:user`) |
| `PENDING_MFA` | Password set, MFA enrolment not yet completed | Only to `/auth/mfa/enrol*` | activation |
| `ACTIVE` | Normal | Yes | MFA enrolled (or employee grace period, §2.6) |
| `SUSPENDED` | Temporarily disabled (investigation, long leave) | No | `suspend:user` |
| `OFFBOARDED` | Terminal. Sessions revoked, login permanently refused | No | `offboard:user`, or automatically at 23:59 IST on `employment.last_working_day` |

**Invite / activation.** Invite token: 32 random bytes, base64url, stored **only** as
`SHA-256` in `activation_token.token_hash`, `expires_at = now() + 7 days`, single-use, bound to
`user_id`. Delivered to the **work email on record**. Activation sets the password (§2.2), forces MFA
enrolment, then transitions to `ACTIVE`. Expired invites are re-issued by HR only, which invalidates
the previous token.

**Transitions are audited** (`ADMIN.USER_STATUS_CHANGED`) with old and new status, actor and reason,
and `SUSPENDED`/`OFFBOARDED` immediately revoke all sessions and refresh-token families and bump
`user.token_version`.

**Offboarding also:** freezes payslip access to read-only for 90 days after the last working day (so
the employee can retrieve Form 16 and payslips through a time-boxed `EX_EMPLOYEE` grant — an
attribute on `user_role`, not a fifth persona), then removes it; revokes all role grants; and starts
the retention clocks in §14.5.

### 2.6 Login rate limiting and progressive lockout — exact thresholds

State in `login_attempt(id, user_id nullable, email_hash bytea, ip_hash bytea, outcome, occurred_at)`
(90-day retention) and counters in `rate_limit_counter` (§9.3). `email_hash`/`ip_hash` are
`HMAC-SHA256` under `LOG_HASH_KEY` so the table itself is not a PII store.

Per **account** (keyed on `user_id`, all IPs), counting consecutive failures since the last success:

| Consecutive failures | Action |
|---|---|
| 1 – 4 | Normal `401` |
| 5 | `401` + `AUTH.LOGIN_THROTTLE_ENGAGED` audit |
| 6 – 8 | 30 s cooldown; attempts during it ⇒ `429` + `Retry-After` |
| 9 – 10 | 5 min cooldown |
| 11 – 14 | 15 min lock (`user.locked_until`), email to the user's work address, `AUTH.ACCOUNT_LOCKED` audit |
| 15+ | 60 min lock (hard ceiling), security alert (§11.4), MFA re-verification required on next success |

A successful password + MFA verification resets the counter to 0. Locks are **not** cleared by a
password reset alone — the reset clears the counter only after the new password is set, so lockout
cannot be used to bypass throttling.

Per **IP** (`ip_hash`): 20 failed logins / 15 min ⇒ `429` for 15 min; 60 / 60 min ⇒ 60 min block and a
`SECURITY.IP_BLOCKED` audit event.

**Spray detection (cross-account):** ≥ 25 distinct `user_id` values failing from one `ip_hash` within
10 min, or ≥ 100 failures org-wide in 5 min ⇒ alert, and every subsequent login from that IP requires
MFA even when the password is correct and the device is remembered.

`Retry-After` is always sent on `429` and `423` (§9.4).

### 2.7 TOTP MFA

`apps/api/src/auth/totp.ts` — RFC 6238.

| Parameter | Value |
|---|---|
| Algorithm | `SHA-1` (authenticator-app interoperability; the secret's 160-bit entropy carries the security, not the PRF) |
| Digits | 6 |
| Period | 30 s |
| Accepted window | ±1 step (previous, current, next) ⇒ ≤ 90 s |
| Secret | 20 bytes CSPRNG, base32 (RFC 4648, no padding) for display |
| Storage | `mfa_credential.secret_ciphertext` — AES-256-GCM envelope-encrypted (§7.2), AAD `mfa_credential:secret:<id>`. Never returned by any API after enrolment |
| Provisioning URI | `otpauth://totp/Widedrop%20ESS:{work_email}?secret=…&issuer=Widedrop%20ESS&algorithm=SHA1&digits=6&period=30` — rendered as a QR **client-side** from the one-time enrolment response; never logged |
| Replay | `mfa_credential.last_accepted_step bigint`; a code is rejected if its step ≤ `last_accepted_step`. Updated in the same transaction as the successful verification |
| Clock drift | No per-user drift tracking; hosts run NTP. Verification failures at ±2 steps emit `AUTH.MFA_CLOCK_DRIFT_SUSPECTED` for operability |
| Verification rate limit | 5 attempts per 5 min per `user_id`, then 15 min cooldown; 10 failures ⇒ account lock per §2.6 |

**Enrolment** requires a fresh password re-authentication (≤ 5 min) and is confirmed by submitting a
valid code; only then is the secret marked `ACTIVE` and recovery codes issued.

**Recovery codes.** 10 codes × 128 bits, rendered as `xxxxx-xxxxx-xxxxx` (Crockford base32).
Stored as `HMAC-SHA256(RECOVERY_CODE_KEY, code)` in `mfa_recovery_code.code_hmac` — a fast keyed hash
is correct here because the codes are full-entropy random, unlike passwords. Single-use
(`used_at`), shown exactly once, regenerable (which invalidates all previous codes). Using a recovery
code emits `AUTH.MFA_RECOVERY_USED`, emails the user, and forces TOTP re-enrolment before the next
login. When 2 or fewer remain, a to-do item appears on Home (sourced from `mfa_recovery_code` counts —
a real persisted count, per D1).

**Who MUST have MFA.**

| Role held | MFA requirement |
|---|---|
| `HR`, `ACCOUNTS`, `MANAGER` | **Mandatory before the account can reach `ACTIVE`.** No grace period. A role grant to a user without active MFA transitions them to `PENDING_MFA` and forces enrolment at next login |
| `EMPLOYEE` only | Mandatory, with a **14-day grace** from activation. During grace a non-dismissible to-do item ("Set up two-step verification") appears on Home; after 14 days login completes only through the enrolment flow |

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
   `password_reset_token(id, user_id, token_hash, purpose, expires_at, used_at, requested_ip_hash)`.
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

`user.token_version int` is embedded in every access token as `ver`. A mismatch ⇒ `401`
`{"code":"TOKEN_STALE"}`, which the SPA handles by attempting one refresh and then logging out.

`token_version` is incremented, and **all** sessions + refresh families revoked, on: password change
or reset; any role grant or revoke; MFA enrolment, reset or recovery-code use; `SUSPENDED` or
`OFFBOARDED`; refresh-token reuse detection (§3.2); user-initiated "sign out everywhere"; and an HR
`revoke:session` action. Because access tokens live only 10 minutes, revocation is fully effective
within 10 minutes worst-case; for the highest-impact case (offboarding) the session row is deleted
too, and `sid` is checked against `session` on **every** request, so revocation there is immediate.

---

## 3. Tokens and sessions

### 3.1 Access token

| Property | Value |
|---|---|
| Type | JWT, compact serialisation |
| Algorithm | **EdDSA (Ed25519)**. Verifier accepts exactly `["EdDSA"]`; `alg:none` and any HMAC alg are rejected before parsing |
| TTL | **10 minutes** (`ACCESS_TOKEN_TTL_SECONDS`, max permitted value 900) |
| Transport | `Authorization: Bearer …` header only. **Never** in a cookie, URL, query string or `localStorage` |
| Client storage | In-memory closure inside `apps/web/src/lib/auth-store.ts`; lost on reload and re-obtained via the refresh cookie |
| Key location | Private key `JWT_SIGNING_KEY_<kid>` (PKCS#8 PEM) in the platform secret store; never in Postgres, never in the repo |

Claims (`apps/api/src/auth/tokens.ts`):

| Claim | Type | Meaning |
|---|---|---|
| `iss` | string | `https://api-ess.widedrop.com` |
| `aud` | string | `https://ess.widedrop.com` |
| `sub` | uuid | `user.id` |
| `sid` | uuid | `session.id` — looked up on every request; revocation point |
| `jti` | uuid | unique per token; used for replay forensics in audit |
| `iat`,`nbf`,`exp` | number | `nbf = iat`, `exp = iat + 600`; 30 s clock skew tolerated |
| `ver` | int | `user.token_version` (§2.9) |
| `roles` | string[] | e.g. `["EMPLOYEE","MANAGER"]` — a **cache** for cheap 401/403 short-circuits and SPA cosmetics. Authoritative role/scope resolution always re-reads `user_role` (§4.7) |
| `emp` | uuid \| null | `employee.id` — convenience only; server re-derives it for writes |
| `amr` | string[] | `["pwd"]` or `["pwd","otp"]` |
| `auth_time` | number | epoch seconds of the original password authentication; drives step-up (§2.7) |
| `mfa_at` | number \| null | epoch seconds of the last MFA assertion |

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
- `GET /.well-known/jwks.json` is served **only on the internal network interface**; it is not needed
  publicly because the API is the sole verifier. It exists so future internal services can verify
  without shared secrets.
- Verification caches the JWKS in-process for 5 min with a forced refresh on unknown `kid`
  (rate-limited to 1 refresh / 30 s to prevent a `kid`-flood DoS).

### 3.3 Refresh token

| Property | Value |
|---|---|
| Format | **Opaque**, 32 bytes (256 bits) from `crypto.randomBytes`, base64url. Not a JWT — it carries no claims and cannot be parsed or forged offline |
| Storage (server) | `refresh_token(id uuid, user_id, session_id, family_id uuid, parent_id uuid null, token_hash bytea, issued_at, expires_at, used_at, revoked_at, revoked_reason, ip_hash, user_agent_hash)`; `token_hash = SHA-256(token)` with a unique index. The plaintext is never stored or logged |
| Storage (client) | `__Host-wd_rt` cookie only (§3.4) |
| Idle TTL | 7 days (`expires_at`) |
| Absolute family TTL | 14 days from `family.created_at`; after that re-authentication is required regardless of activity |
| Rotation | **Every** use. `POST /auth/refresh` validates, marks the presented token `used_at`, issues a new token in the same `family_id` with `parent_id` set, and returns a new access token. All in one transaction |

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

A 10-second grace is granted for the *immediate* predecessor of the current token from the *same*
`ip_hash` **and** `user_agent_hash`, to absorb double-fired refreshes from React StrictMode or a
racing tab; outside that narrow window the full revocation above applies. The grace re-returns the
already-issued successor rather than minting a new one.

### 3.4 Cookie attributes, justified

```
Set-Cookie: __Host-wd_rt=<opaque>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800
Set-Cookie: __Host-wd_csrf=<opaque>; Path=/; Secure; SameSite=Strict; Max-Age=604800
```

| Attribute | Choice | Justification for this host layout |
|---|---|---|
| `__Host-` prefix | required | Forbids a `Domain` attribute, so the cookie is **host-locked to `api-ess.widedrop.com`**. This is the specific defence against T-SUB: a compromised or taken-over sibling host (including the Netlify marketing site at `widedrop.com`) cannot set or overwrite a `Domain=.widedrop.com` cookie that the API would then accept. It also forces `Secure` and `Path=/` |
| `HttpOnly` (on `wd_rt`) | yes | XSS in the SPA cannot read the refresh token. Combined with the access token being memory-only, an XSS gets at most a 10-minute window and cannot persist |
| Not `HttpOnly` (on `wd_csrf`) | intentional | The SPA must read it to echo it in the `X-WD-CSRF` header (double-submit). It is not a credential on its own — it is only meaningful together with the session cookie and the HMAC binding (§3.5) |
| `Secure` | yes | TLS only; implied by `__Host-` but stated |
| `SameSite=Strict` | yes | `ess.widedrop.com → api-ess.widedrop.com` is **same-site**, so `Strict` does not break the SPA's own XHR. It does block every genuinely cross-site request, including top-level navigations from a phishing page to `/auth/refresh`. `Lax` would be unnecessarily weaker; `None` would be wrong |
| `Path=/` | forced by `__Host-` | We accept the slightly wider path in exchange for the host-locking guarantee, which matters more here. Route-level enforcement (only `/auth/refresh` and `/auth/logout` read the cookie) provides the narrowing that `Path` would have given |
| `Domain` | **absent** | See `__Host-` |
| `Max-Age` | 604800 (7 d) | Matches the refresh idle TTL; the server is authoritative regardless |
| `Partitioned` (CHIPS) | not set | Not a third-party cookie context |

Logout sends `Set-Cookie: __Host-wd_rt=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` **and**
revokes server-side — clearing the cookie alone is never treated as logout.

### 3.5 CSRF defence, and why it is still required

Most API calls carry a `Bearer` token from JS memory and are therefore structurally CSRF-immune (a
cross-site attacker cannot read or set that header without CORS permission). The cookie-authenticated
surface is small and explicit: `POST /auth/refresh`, `POST /auth/logout`,
`POST /auth/logout-all`. Those routes get the full defence.

**Why `SameSite=Strict` is not sufficient on its own:**

1. **Same-site siblings are not cross-site.** Any `*.widedrop.com` host — the Netlify marketing site,
   a future landing page, a stale CNAME taken over by an attacker (T-SUB) — can issue requests that
   the browser considers same-site, and `SameSite` will happily attach the cookie. Given the brief
   explicitly keeps the public site on a separate Netlify free-tier account, this is a *live* risk,
   not a theoretical one.
2. Browsers and embedded webviews have shipped `SameSite` bugs and downgrade behaviours; some
   enterprise/legacy clients ignore the attribute.
3. `SameSite` is a defence the *browser* chooses to apply. CSRF tokens are a defence the *server*
   enforces. Defence in depth requires at least one server-enforced check.

**The mechanism (`apps/api/src/auth/csrf.ts`), on every unsafe method (`POST/PUT/PATCH/DELETE`):**

1. **Signed double-submit.** `__Host-wd_csrf` holds `<nonce>.<hmac>` where
   `nonce = 16 random bytes (base64url)` and `hmac = HMAC-SHA256(CSRF_KEY, nonce || ":" || session_id)`.
   The client echoes the whole value in `X-WD-CSRF`. The server requires (a) header present,
   (b) `timingSafeEqual(header, cookie)`, (c) the HMAC recomputes correctly against the `session_id`
   derived from the request's own session. Binding to the session is what makes this resistant to a
   sibling host that can *set* cookies but cannot mint a valid HMAC for the victim's session.
2. **`Origin` enforcement.** `Origin` must be present and exactly `https://ess.widedrop.com` (or the
   configured staging origin). Absent or mismatched ⇒ `403 {"code":"CSRF_ORIGIN_REJECTED"}`. `Referer`
   is used only as a fallback when `Origin` is absent on same-origin requests.
3. **Fetch-metadata enforcement.** When the headers are present:
   `Sec-Fetch-Site` must be `same-site` or `same-origin`; `Sec-Fetch-Mode` must be `cors` (never
   `navigate`); `Sec-Fetch-Dest` must be `empty`. Any other combination on an unsafe method ⇒ `403`.
   This alone kills form-post and top-level-navigation CSRF in all modern browsers.
4. All three checks run — they are not alternatives. A failure at any step emits
   `SECURITY.CSRF_REJECTED` with the request id, route and the reason code.
5. `GET`/`HEAD`/`OPTIONS` are exempt but must be side-effect free; a lint rule and a route-table
   assertion at boot fail the build if a `GET` route declares a write permission (§4.8).

The CSRF cookie is rotated on login and on every `token_version` bump, and is deleted on logout.

---

## 4. Authorization — RBAC + ABAC

### 4.1 Roles

Exactly four persona roles (D2), stored in `role(code, name)` and granted through
`user_role(user_id, role_code, scope_org_unit_id null, granted_by, granted_at, expires_at null, revoked_at null)`.

| Code | Persona | Who holds it | Scope default |
|---|---|---|---|
| `EMPLOYEE` | Employee | **Every** user with an `employee` record, always, in addition to any other role | `SELF` + `ORG` for the public directory/policy/announcement surfaces |
| `MANAGER` | Manager | Derived-but-explicit: granted by HR to any user who has ≥ 1 active direct report. A nightly reconciliation job flags mismatches; it never auto-grants or auto-revokes (a silent privilege change would be unauditable) | `DIRECT_REPORTS`, widened to `REPORTING_CHAIN` only for the specific escalation permissions marked below |
| `HR` | People Ops / HR Business Partner | Granted by HR with maker-checker (§4.9) | `ORG`, optionally narrowed to an org-unit subtree via `user_role.scope_org_unit_id` (the HRBP model) |
| `ACCOUNTS` | Finance / Payroll | Granted by HR with maker-checker | `ORG`, but structurally excluded from non-payroll PII (§4.5) |

There is **no** super-admin, no `SUPPORT` role and **no impersonation capability anywhere in the
system**. Investigating a user's view of the portal is done by reading the audit trail and the same
API as that user would call under an explicit, audited `read:` permission — never by assuming their
identity. `packages/shared/src/permissions.ts` contains the permission string union; a compile error
is the first line of defence against inventing a permission at a call site.

### 4.2 Scopes (ABAC)

| Scope | Resolves to | Computed from |
|---|---|---|
| `SELF` | `{ employee_id = actor.employee_id }` | the access token's `sub` → `employee.user_id`; **never** from the request |
| `DIRECT_REPORTS` | `{ employee_id IN (SELECT id FROM employee WHERE manager_id = actor.employee_id AND status='ACTIVE') }` | `employee.manager_id` |
| `REPORTING_CHAIN` | `{ employee_id IN (SELECT descendant_id FROM reporting_closure WHERE ancestor_id = actor.employee_id AND depth BETWEEN 1 AND 6) }` | `reporting_closure` |
| `DEPARTMENT` | `{ org_unit_id IN (subtree of actor's org_unit) }` | `org_unit` adjacency + `org_unit_closure` |
| `ORG` | no employee predicate; still subject to resource-level attribute predicates | — |

`reporting_closure(ancestor_id, descendant_id, depth, PRIMARY KEY(ancestor_id, descendant_id))` is a
**materialised transitive closure**, rewritten inside the same transaction as any `employee.manager_id`
change (and any employee create/terminate) by
`apps/api/src/authz/reporting-closure.ts#rebuildSubtree()`. Reasons: (a) a scope check becomes one
indexed lookup instead of a recursive CTE per request, (b) the closure is a persisted fact that the
audit trail can reference, (c) `depth ≤ 6` bounds the blast radius of a cyclic or corrupted
`manager_id` — and a `CHECK` plus an insertion-time cycle test rejects cycles outright.

Self-reference `(x, x, 0)` is stored so `REPORTING_CHAIN` including self is expressible, but every
permission in §4.4 that uses `REPORTING_CHAIN` requires `depth ≥ 1`, i.e. **a manager is never inside
their own approval scope**.

### 4.3 Permission string grammar

```
verb:resource[:qualifier]
verb     ::= read | create | update | delete | submit | approve | reject | withdraw
           | acknowledge | publish | generate | validate | issue | verify | assign
           | resolve | export | grant | revoke | upload | download | lock
resource ::= snake_case noun, singular
qualifier::= self | full | masked | any | queue | chain   (semantic narrowing, not the ABAC scope)
```

The ABAC **scope** is *not* part of the string; it is the value stored per (role, permission) in the
matrix and per grant in `user_role.scope_org_unit_id`. This separation is deliberate: it keeps the
permission vocabulary small and makes "same permission, different reach" expressible for a user who
holds several roles (§4.7).

### 4.4 Permission matrix

Legend for cells: the **ABAC scope** the role gets for that permission, or `—` for no grant.
`SELF` appears on its own row group first because every authenticated user holds `EMPLOYEE`.
`†` = requires step-up MFA (§2.7). `‡` = maker-checker, actor ≠ the actor of the preceding step (§4.9).
`§` = self-dealing forbidden: denied when the resource's subject employee is the actor (§4.9).

#### Identity, profile and PII

| Permission | Employee | Manager | HR | Accounts | Produces / guards |
|---|---|---|---|---|---|
| `read:profile:self` | SELF | SELF | SELF | SELF | Profile screen, all four tabs |
| `update:profile:self` | SELF | SELF | SELF | SELF | Contact fields only: personal email, mobile, current address. Name/DOB/gender are request-only |
| `create:profile_change_request:self` | SELF | SELF | SELF | SELF | "Request a change" on Profile; creates a `profile_change_request` + a linked Help-desk ticket |
| `read:profile:full` | — | DIRECT_REPORTS | ORG | — | Full personal tab incl. DOB, personal contact, addresses |
| `approve:profile_change_request` | — | — | ORG § | — | Applies the change in one transaction with the audit write |
| `read:directory` | ORG | ORG | ORG | ORG | Directory screen. Restricted DTO: name, designation, department, work location, **work** email, **work** phone, manager. Never personal contact, DOB, or compensation |
| `read:reporting_line` | ORG | ORG | ORG | ORG | The reporting-line widget; read from `reporting_closure` |
| `read:emergency_contact:self` | SELF | SELF | SELF | SELF | Emergency contacts tab |
| `update:emergency_contact:self` | SELF | SELF | SELF | SELF | |
| `read:emergency_contact` | — | DIRECT_REPORTS | ORG | — | Implements the persisted policy note "Emergency contacts are visible only to People Ops and your manager" |
| `read:bank_account:masked:self` | SELF | SELF | SELF | SELF | `•••• •••• 4412` — masking applied server-side (§7.5) |
| `read:bank_account:full` | — | — | — | ORG † | **HR cannot see full bank numbers.** Only Accounts, only for payroll execution, always step-up, always audited with the subject employee id |
| `create:bank_change_request:self` | SELF † | SELF † | SELF † | SELF † | Requires a cancelled-cheque upload (§5.3) |
| `verify:bank_change_request` | — | — | — | ORG †§ | The "verified by Payroll within 2 working days" step; applies the new account and revokes the old |
| `read:statutory_id:masked:self` | SELF | SELF | SELF | SELF | `AXYPR••••K`, `•••• •••• 8821` |
| `read:statutory_id:full` | — | — | — | ORG † | PAN/UAN/PF/ESI for statutory filing and Form 16 only |
| `read:salary_structure:self` | SELF | SELF | SELF | SELF | Only after the first payslip is published (D3) |
| `read:salary_structure` | — | — | — | ORG | Managers never see compensation, including for their own reports |
| `update:salary_structure` | — | — | — | ORG ‡ | Requires an HR-originated `compensation_change` record to exist; Accounts executes, HR authorises |

#### Payroll (see `docs/WORKFLOWS.md` for the state machine)

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `create:payroll_run` | — | — | — | ORG | Creates the run for a `period` in `DRAFT` |
| `upload:payroll_input` | — | — | — | ORG | **Step 1** of D3. CSV/XLSX validated per §5.3; every row persisted to `payroll_input_row` with the `file_id` and row number for traceability |
| `read:payroll_input` | — | — | — | ORG | HR is excluded: input files carry compensation for the whole org |
| `submit:attendance_period` | — | — | ORG | — | **Step 2.** HR submits the period for every employee in scope; transitions `ATTENDANCE_DRAFT → ATTENDANCE_SUBMITTED` |
| `read:attendance:self` | SELF | SELF | SELF | SELF | |
| `read:attendance` | — | DIRECT_REPORTS | ORG | ORG | Accounts sees approved day counts only, never leave reasons |
| `approve:attendance` | — | DIRECT_REPORTS §‡ | — | — | **Step 3.** Manager approves their own reports' attendance. A manager's *own* attendance is approved by their manager (`REPORTING_CHAIN depth 1` of the skip level); if none exists, HR approves under `approve:attendance:escalated` |
| `reject:attendance` | — | DIRECT_REPORTS §‡ | — | — | Returns the period to HR with a mandatory reason |
| `approve:attendance:escalated` | — | — | ORG § | — | Only when `employee.manager_id IS NULL` or the manager is `SUSPENDED`/`OFFBOARDED`; the escalation reason is persisted |
| `validate:payroll_run` | — | — | — | ORG | **Step 4.** Server-side, deterministic: every in-scope employee has an approved attendance record, a salary structure effective for the period, a verified bank account, and a matched `payroll_input_row`. Failures are persisted as `payroll_validation_issue` rows and rendered as a real blocking list — never as a generic error |
| `generate:payroll` | — | — | — | ORG | **Step 5.** Enqueues the generation job; the job runs as the service identity but records `initiated_by_user_id`. Payslips are created in `DRAFT` and are invisible to employees |
| `publish:payroll` | — | — | — | ORG †‡ | **Step 6.** Publisher MUST NOT be the uploader of `payroll_input` for the same run. Sets `payroll_run.status='PUBLISHED'`, `payslip.published_at`, and only then do payslips become visible |
| `lock:payroll_run` | — | — | — | ORG † | Post-publication freeze; afterwards corrections are new amendment runs, never edits |
| `read:payslip:self` | SELF | SELF | SELF | SELF | **Guarded by `payslip.published_at IS NOT NULL AND payroll_run.status IN ('PUBLISHED','LOCKED')` inside the repository function, not the controller** |
| `download:payslip:self` | SELF | SELF | SELF | SELF | Signed URL, 120 s, audited as `PAYROLL.PAYSLIP_DOWNLOADED` |
| `email:payslip:self` | SELF | SELF | SELF | SELF | Destination is **always** the work email on record; no recipient is accepted from the client |
| `read:payslip:any` | — | — | — | ORG † | Payroll support. Managers and HR are excluded — a manager must not see a report's net pay |
| `read:payslip_source` | — | — | — | ORG | The traceability view: payslip → `payslip_line` → `payroll_input_row` → `file` → `attendance_approval`. Satisfies D3's audit requirement |
| `read:tax_quarter:self` / `read:form16:self` / `download:form16:self` | SELF | SELF | SELF | SELF | Tax slips screen. Quarters with no persisted TDS render `—` (D5), never `₹0` |
| `issue:form16` | — | — | — | ORG † | Creates the `document` row and the audit event |

#### Leave

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `create:leave_request:self` | SELF | SELF | SELF | SELF | Server recomputes working days from `holiday_calendar` + `week_pattern`; the client-computed day count is ignored |
| `read:leave_request:self` | SELF | SELF | SELF | SELF | |
| `withdraw:leave_request:self` | SELF | SELF | SELF | SELF | Only while `status='PENDING'`; a `409` otherwise |
| `read:leave_request` | — | DIRECT_REPORTS | ORG | — | Accounts never sees leave reasons (free-text, often medical → A4/A6) |
| `approve:leave_request` / `reject:leave_request` | — | DIRECT_REPORTS § | ORG §‡ | — | HR's grant is an audited override, not the normal path |
| `read:leave_balance:self` | SELF | SELF | SELF | SELF | Derived from `leave_ledger`, never stored as a mutable number (D1) |
| `read:leave_balance` | — | DIRECT_REPORTS | ORG | — | Powers the "Balance after: 9.5 days" line on the approvals card |
| `adjust:leave_balance` | — | — | ORG † | — | Writes a signed `leave_ledger` entry with a mandatory reason; balances are never overwritten |
| `read:holiday_calendar` | ORG | ORG | ORG | ORG | |
| `manage:holiday_calendar` | — | — | ORG | — | |

#### Expenses

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `create:expense_claim:self` | SELF | SELF | SELF | SELF | Amount validated against `expense_policy_limit` server-side |
| `read:expense_claim:self` / `withdraw:expense_claim:self` | SELF | SELF | SELF | SELF | Withdraw only while `SUBMITTED` |
| `read:expense_claim` | — | DIRECT_REPORTS | — | ORG | HR has no business need |
| `approve:expense_claim` / `reject:expense_claim` | — | DIRECT_REPORTS § | — | — | Above `expense_policy_limit.escalation_amount` the required approver widens to `REPORTING_CHAIN depth 2` (skip level); the rule is data-driven from `expense_policy_limit`, not hardcoded |
| `reimburse:expense_claim` | — | — | — | ORG † | Links the claim to a `payroll_run` or a direct payment; sets `REIMBURSED` |
| `read:expense_attachment` | SELF (own) | DIRECT_REPORTS | — | ORG | Bills frequently contain addresses and card fragments |

#### Benefits

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `read:benefit_enrolment:self` / `read:dependent:self` | SELF | SELF | SELF | SELF | |
| `create:dependent_change_request:self` | SELF | SELF | SELF | SELF | Enrolment-window check is server-side from `benefit_plan.window_start/end` |
| `read:benefit_enrolment` / `read:dependent` | — | — | ORG | — | **Managers and Accounts are excluded**: dependants include minors (A5) and enrolment implies health data (A6) |
| `approve:dependent_change_request` | — | — | ORG §† | — | |
| `read:benefit_deduction` | — | — | — | ORG | Accounts sees only the payroll-affecting *amount* per employee per period — never the plan, the dependants or the medical context |
| `manage:benefit_plan` | — | — | ORG | — | |

#### Documents, letters, policies, announcements, directory

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `read:document:self` / `download:document:self` | SELF | SELF | SELF | SELF | Offer, appointment, appraisal, promotion, salary-revision letters |
| `read:document` | — | — | ORG | ORG (payroll class only) | Accounts is restricted by `document.class IN ('PAYSLIP','FORM16','TAX')` — an attribute predicate on top of `ORG` |
| `issue:document` | — | — | ORG † | — | |
| `create:letter_request:self` | SELF | SELF | SELF | SELF | Salary certificate, address proof, employment verification |
| `issue:letter` | — | — | ORG † | — | Generates the PDF from persisted data; the addressee string is escaped into the template (§5.6) |
| `read:policy` | ORG | ORG | ORG | ORG | Only `policy_version.status='PUBLISHED'` **and** the version whose `applies_to` matches the employee's attributes |
| `acknowledge:policy:self` | SELF | SELF | SELF | SELF | Writes `(employee_id, policy_version_id, status, acknowledged_at, ip_hash, user_agent_hash)` |
| `read:policy_acknowledgement:self` | SELF | SELF | SELF | SELF | |
| `read:policy_acknowledgement` | — | DIRECT_REPORTS | ORG | — | **Status and timestamp only** — a manager sees "pending/acknowledged", never any other content |
| `create:policy_version` / `update:policy_version` | — | — | ORG | — | Drafts only; the published body is immutable |
| `publish:policy_version` | — | — | ORG †‡ | — | Publisher ≠ author. Publication is what makes acknowledgements due; it is irreversible (supersede, never edit) |
| `archive:policy` | — | — | ORG † | — | |
| `read:announcement` | ORG | ORG | ORG | ORG | `PUBLISHED` + audience match |
| `create:announcement` / `update:announcement` | — | — | ORG | — | |
| `publish:announcement` / `pin:announcement` | — | — | ORG ‡ | — | |

#### Help desk

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `create:ticket:self` | SELF | SELF | SELF | SELF | Persisted first, then queued for `helpdesk@widedroptech.com` (§8.6) |
| `read:ticket:self` / `comment:ticket:self` / `close:ticket:self` | SELF | SELF | SELF | SELF | |
| `read:ticket:queue` | — | — | ORG + queue | ORG + queue | Queue membership is an **attribute predicate**, not a scope: HR holds queues `HR`, `BENEFITS`, `IT_ACCESS`, `GENERAL`, `DATA_REQUEST`; Accounts holds `PAYROLL_TAX`, `EXPENSES`. A ticket outside the actor's queues is invisible (404) |
| `assign:ticket` / `resolve:ticket` | — | — | ORG + queue § | ORG + queue § | Cannot self-assign *and* resolve one's own ticket |
| `read:faq` | ORG | ORG | ORG | ORG | |
| `manage:faq` | — | — | ORG | — | |

#### Notifications, audit, exports, administration

| Permission | Employee | Manager | HR | Accounts | Notes |
|---|---|---|---|---|---|
| `read:notification:self` | SELF | SELF | SELF | SELF | A notification is generated only for a recipient who already holds the permission+scope to see the underlying resource; the fan-out function re-checks (§4.10) |
| `read:audit:hr` | — | — | ORG | — | HR/people-domain + authn/authz events |
| `read:audit:payroll` | — | — | — | ORG | Payroll-domain events |
| `verify:audit_chain` | — | — | ORG | ORG | Read-only integrity verification endpoint (§8.4) |
| `create:audit_event` / `update:*` / `delete:*` on audit | **nobody** | **nobody** | **nobody** | **nobody** | Audit rows are written only by `apps/api/src/audit/audit.ts` inside the request transaction. No HTTP route can create, edit or delete one |
| `export:employee_data` | — | — | ORG † | — | Queued, one concurrent export per actor, watermarked with the actor and timestamp, CSV-injection-safe (§5.7), audited with the exact filter and row count |
| `export:payroll_data` | — | — | — | ORG † | |
| `invite:user` / `suspend:user` / `offboard:user` | — | — | ORG † | — | |
| `grant:role` / `revoke:role` | — | — | ORG †‡§ | — | HR cannot grant a role to themselves (§); granting `HR` or `ACCOUNTS` requires a second HR approver (‡) |
| `reset:mfa` | — | — | ORG †§ | — | Forces re-enrolment; notifies the user; never reveals a secret |
| `revoke:session` | — | — | ORG † | — | |
| `manage:org_unit` / `manage:reporting_line` | — | — | ORG † | — | Any `manager_id` change rebuilds `reporting_closure` in the same transaction (§4.2) |
| `read:org_setting` | ORG | ORG | ORG | ORG | Non-secret settings only (e.g. `mfa_grace_days`) |
| `update:org_setting` | — | — | ORG † | — | |

### 4.5 How Accounts is scoped away from non-payroll PII

Three independent layers, so a mistake in any one does not leak:

1. **Permission layer.** The `ACCOUNTS` column above simply contains no grant for
   `read:profile:full`, `read:emergency_contact`, `read:dependent`, `read:benefit_enrolment`,
   `read:leave_request`, `read:document` (non-payroll class) or `read:policy_acknowledgement`.
2. **DTO layer.** `apps/api/src/dto/employee.ts` exposes exactly three mappers —
   `toSelfProfileDto`, `toManagerEmployeeDto`, `toDirectoryDto`, `toPayrollEmployeeDto` — each one an
   explicit field allowlist. A Prisma model is **never** serialised directly; an ESLint rule
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

Bank and statutory columns are reached through `bank_account` / `statutory_identity` under
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
neither, and an `preHandler` that denies any request reaching a handler without a resolved
`request.authz` context. `apps/api/test/routes.guard.test.ts` walks the printed route table and
asserts the same invariant, so a new route cannot be merged unguarded. There are exactly five public
routes: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/password-reset/request`,
`POST /auth/password-reset/confirm`, `GET /healthz`.

**Authorization is never derived from the client.** The chain is:

```
Bearer token → verify signature/iss/aud/exp/alg → load session by sid (must exist, not revoked)
             → compare ver with user.token_version (reload roles from user_role on mismatch)
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
2. **Scope resolved per permission, not per user.** For permission `p`, the effective scope is the
   widest scope among the roles that grant `p` — `ORG > DEPARTMENT > REPORTING_CHAIN > DIRECT_REPORTS > SELF`.
   Widening never leaks across permissions. Worked examples:
   - *Manager + HR*: `read:profile:full` → `ORG` (from HR). `approve:expense_claim` → `DIRECT_REPORTS`
     (HR grants it not at all, so the manager scope stands) — being HR does not let them approve any
     expense in the company.
   - *Manager + Accounts*: `read:bank_account:full` → `ORG`; `read:leave_request` → `DIRECT_REPORTS`;
     `read:payslip:any` → `ORG`. They still cannot approve their own team's attendance for a period
     in which they are a subject (§).
   - *HR + Accounts* (a small-company reality): union gives both sides, but the maker-checker rules
     (‡) then bite: they cannot both author and publish a policy, nor both upload payroll input and
     publish the run. The system refuses and names the required second approver.
3. **HRBP narrowing composes by intersection *within* the HR role only.** If a user holds
   `HR(scope_org_unit_id = 'People Ops')` and `HR(scope_org_unit_id = 'Design')`, the ORG scope for
   HR-granted permissions is the union of those two subtrees, not the whole org.
4. **Deny always wins over union** for the `§` self-dealing and `‡` maker-checker rules: these are
   evaluated after the union and can only subtract.
5. The effective permission set is recomputed from `user_role` on every `ver` mismatch and cached
   in-process for at most 60 s keyed by `(user_id, token_version)`; a role change bumps
   `token_version`, so the cache is correct by construction.

### 4.8 Guard implementation surface

| File | Responsibility |
|---|---|
| `packages/shared/src/permissions.ts` | The permission string union (single source of truth, shared with the SPA for cosmetic gating) |
| `apps/api/src/authz/matrix.ts` | The literal table from §4.4 as a typed const; exhaustiveness-checked against the permission union at compile time |
| `apps/api/src/authz/scopes.ts` | `SELF`/`DIRECT_REPORTS`/`REPORTING_CHAIN`/`DEPARTMENT`/`ORG` resolution |
| `apps/api/src/authz/where.ts` | `authzWhere(actor, permission)` → Prisma where-fragment, per resource |
| `apps/api/src/authz/predicates.ts` | Attribute predicates: ticket queue membership, `document.class`, `payslip.published_at`, enrolment windows |
| `apps/api/src/authz/separation.ts` | `§` self-dealing and `‡` maker-checker evaluation |
| `apps/api/src/plugins/authorize.ts` | Fastify plugin: boot-time route assertion + `preHandler` guard + denial auditing |
| `apps/web/src/lib/can.ts` | **Cosmetic only.** Header comment states that hiding UI is not a security control |

Tests that must exist: a matrix-driven table test that, for every (role, permission) pair marked `—`,
issues a real request with a session holding only that role and asserts `403`/`404`; a scope test per
resource asserting a manager cannot reach a non-report; a multi-role test per §4.7's worked examples;
and the boot-time unguarded-route assertion.

### 4.9 Separation of duties

| Rule | Where enforced | Failure response |
|---|---|---|
| A user may not approve, verify or resolve an item whose subject employee is themselves (`§`) | `separation.ts#denySelfSubject()` | `403 {"code":"SELF_APPROVAL_FORBIDDEN"}` + audit |
| Payroll publisher ≠ payroll-input uploader for the same run (`‡`) | `publishPayrollRun()` transaction | `409 {"code":"SEGREGATION_REQUIRED","requires":"a second Accounts approver"}` |
| Policy publisher ≠ policy-version author (`‡`) | `publishPolicyVersion()` | same shape |
| Granting `HR`/`ACCOUNTS`/`MANAGER` needs a second HR approver (`‡`) | `role_grant_request` two-phase table | grant stays `PENDING_APPROVAL` until a different HR user approves; both actors audited |
| HR may not grant a role to their own user (`§`) | `separation.ts` | `403` |
| The attendance approver for a manager's own record is their skip-level manager, else HR escalation | `approveAttendance()` | `409` naming the required approver |

### 4.10 Authorization of derived values (D1 + least privilege)

Badge counts, metric tiles, search results, notifications and to-do items are all produced by the same
`authzWhere()` predicates as the screens they summarise:

- The Approvals nav badge is `COUNT(*)` over exactly the query that populates the Approvals screen.
- Global search runs four scoped sub-queries (module / person / policy / payslip). The *person* query
  uses the directory DTO, the *payslip* query uses `read:payslip:self`, so search can never surface a
  row the user could not open.
- `notification` rows are created by `apps/api/src/notifications/fanout.ts`, which calls
  `canSee(recipient, resourceType, resourceId)` for every candidate recipient before inserting, and
  stores only a `resource_ref` plus a template key — **never** a rendered amount. The amount is
  resolved at read time through the same authorized query, so a stale or over-broad notification
  cannot leak a number.
- When a scoped query returns nothing, the API returns an empty collection with `total: 0` and the UI
  renders the designed empty state (D5). A denial is never rendered as a zero.

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

| Rule | Detail |
|---|---|
| `.strict()` everywhere | Unknown keys are **rejected**, not stripped. Stripping silently accepts an attacker's `{employeeId: …}` and hides the attempt; rejecting surfaces it as a `400` and an audit-worthy signal. The only exception is `headers`, which must be `.passthrough()` |
| No coercion of security-relevant fields | `z.coerce` is permitted for query-string numbers/dates only; never for ids, amounts or enums |
| Ids | `z.string().uuid()` — never `z.string()`. Employee codes: `/^WDT-\d{5}$/` |
| Money | Integer **paise** (`z.number().int().min(0).max(10_000_000_00)`), never floats. Display formatting (`₹86,000`) happens in the SPA from the integer |
| Dates | ISO-8601 date (`YYYY-MM-DD`) or instant; every date is re-validated against a business range (`>= date_of_joining`, `<= today + 365d`) |
| Strings | Every string has an explicit `.max()`. Defaults: subject 200, short note 500, long description 5000, address 300, name 120. `.trim()` then re-check min length |
| Enums | `z.enum([...])` from the shared const, never free strings |
| Arrays | Explicit `.max()` (attachments 5, batch ids 100) |
| Response serialisation | The `response` schema is enforced in production too. This is the last guard against accidental over-exposure: a field not in the DTO schema cannot be serialised even if the query returned it |
| Body size | Global `bodyLimit: 128 KiB` for JSON; multipart handled separately (§5.3) |
| Parameter pollution | Fastify's default query parser returns arrays for repeated keys; schemas that expect a scalar reject arrays, so `?id=a&id=b` is a `400` |
| Content type | Only `application/json` and `multipart/form-data` are registered. `text/plain`, `application/x-www-form-urlencoded` and `application/xml` parsers are **not** registered — which also removes XXE from the threat surface entirely (there is no XML parser in the API) |
| Error shape | `400 {"code":"VALIDATION_FAILED","fieldErrors":{path:[messages]}}`. Messages are static strings from the schema; the submitted value is **never** echoed back (it may be a password or a PAN) |

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

| Context | Permission | Allowed types | Max size | Max count |
|---|---|---|---|---|
| Expense bill | `create:expense_claim:self` | `application/pdf`, `image/jpeg`, `image/png`, `image/heic` | 10 MiB each | 5 per claim |
| Bank proof (cancelled cheque) | `create:bank_change_request:self` | `application/pdf`, `image/jpeg`, `image/png` | 10 MiB | 1 |
| Payroll input | `upload:payroll_input` | `text/csv`, `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | 25 MiB | 1 per run per upload |
| Policy / announcement attachment | `create:policy_version` | `application/pdf` | 20 MiB | 3 |
| Help-desk attachment | `create:ticket:self` | pdf, jpeg, png | 10 MiB | 3 |

Validation pipeline, in order — any failure aborts and deletes the temp file:

1. **Route-level authorization first.** The multipart stream is not even consumed until the permission
   check passes, so an unauthenticated client cannot make us buffer bytes.
2. **Size cap** enforced by the streaming parser (`limits.fileSize`), which truncates and errors
   rather than buffering the whole body.
3. **Extension** from the *declared* filename must be in the context's allowlist (case-folded, after
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
9. **CSV/XLSX** are parsed in a worker thread with a 30 s timeout, a 50 000-row cap, a 60-column cap,
   and a column allowlist derived from the payroll input template; every accepted row is persisted to
   `payroll_input_row` with `row_number` and `source_file_id`. Formulas are never evaluated — values
   are read as raw strings and coerced by Zod.
10. **Antivirus**: the file is streamed to a ClamAV sidecar (`clamd` INSTREAM) before commit; unknown
    verdict or scanner-unavailable ⇒ the upload is accepted into a `QUARANTINED` state, invisible to
    every reader, retried by a worker, and only then promoted to `AVAILABLE`.
11. **Storage key is server-generated and contains no user input**:
    `ess/<env>/<context>/<yyyy>/<mm>/<uuidv7>.<canonical-ext>`. The original filename is stored only
    as a `file.original_name` column, used for display and for `Content-Disposition`, and never for
    path construction. `file.sha256` is computed over the stored bytes for integrity (§7.4);
    `file.byte_size`, `file.content_type` (the sniffed one) and `file.uploaded_by_user_id` are
    persisted.
12. **Serving.** `GET /files/:id` authorizes the *entity* that owns the file (an expense attachment is
    reachable only by someone who may read that claim), then returns `302` to a storage-signed URL
    valid for **120 seconds**, single-object, with response-header overrides:

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

| Surface | Rule |
|---|---|
| All React rendering | JSX auto-escaping. `dangerouslySetInnerHTML` is **banned** by `react/no-danger: error` with no allowed exceptions, enforced in CI |
| Rich bodies (policy body, policy key points, announcement body) | Stored as **structured JSON**, not HTML: `PolicyBlock = {type:'paragraph'|'heading'|'bullet_list'|'ordered_list'|'link', text?, items?, href?}`, validated by a Zod schema (recursion depth ≤ 3, ≤ 500 blocks, ≤ 5000 chars per block). Rendered by `apps/web/src/components/RichText.tsx`, which switches on `type` and emits real React elements. **No HTML string is ever stored or rendered**, so there is nothing to sanitise at render time |
| Links inside rich bodies | `href` must match `^https://` or `^mailto:` (Zod). Rendered with `rel="noopener noreferrer nofollow"` and `target="_blank"`. `javascript:`, `data:`, `vbscript:` and protocol-relative URLs are rejected at write time and re-checked at render time |
| HTML pasted by an author | The editor converts paste to the block model client-side; the server additionally runs `DOMPurify` (jsdom) over any incoming `text` field with `ALLOWED_TAGS: []`, i.e. tags are stripped to text, before Zod validation |
| Generated PDFs (letters, payslips) | Rendered from a template where every substitution passes through a text-escaping function appropriate to the renderer; the addressee string from `letter_request.addressee` is treated as untrusted (it is free text from the employee) |
| Emails | Text and a templated HTML part built with an auto-escaping template engine; no user string is ever concatenated into raw HTML or into a header |
| CSV/XLSX exports | See §5.7 |
| `Content-Type` of every API response | `application/json; charset=utf-8`, with `X-Content-Type-Options: nosniff` |
| Trusted Types | `require-trusted-types-for 'script'` in the CSP (§6.3) turns any missed DOM-XSS sink into a runtime error rather than an injection |

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

---

## 6. Transport and security headers

### 6.1 TLS

| Setting | Value |
|---|---|
| Minimum version | TLS 1.2; TLS 1.3 preferred and negotiated by default on both platforms |
| Ciphers | Platform-managed modern suites; no RC4/3DES/CBC-SHA1; no renegotiation |
| Certificates | Let's Encrypt via Netlify (`ess.widedrop.com`) and via the container host (`api-ess.widedrop.com`); auto-renewed; expiry monitored with a 21-day alert |
| HTTP | `301` to HTTPS on both hosts; no plaintext listener on the API |
| DB connection | `sslmode=verify-full` with the provider CA bundle pinned in the image; `DATABASE_URL` must contain `sslmode=verify-full` or the boot check fails (§10.2) |
| Storage | HTTPS only; signed URLs are HTTPS |

### 6.2 HSTS

```
Strict-Transport-Security: max-age=63072000; includeSubDomains
```

Sent on `ess.widedrop.com` and `api-ess.widedrop.com`. **`preload` is deliberately omitted for now.**
`includeSubDomains` on a host does not affect siblings, but submitting `widedrop.com` to the preload
list would force HTTPS on *every* current and future `*.widedrop.com` host, including ones owned by
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
  report-uri https://api-ess.widedrop.com/csp-report;
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
- `/csp-report` accepts reports unauthenticated but is rate-limited (§9.1), body-capped at 8 KiB,
  schema-validated, and sampled at 10 % into structured logs; it never writes to `audit_event`
  (an unauthenticated endpoint must not be able to grow the audit table).
- A `Content-Security-Policy-Report-Only` variant with the same policy runs for one release before
  enforcement on any policy change.

**API responses** carry their own, maximally restrictive policy:

```
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox
```

### 6.4 The rest of the header set

Sent by `apps/api/src/plugins/security-headers.ts` (`@fastify/helmet` with explicit options) for the
API, and by `apps/web/public/_headers` / `infra/netlify/netlify.toml` for the SPA:

| Header | Value | Applies to |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | both |
| `Referrer-Policy` | `strict-origin-when-cross-origin` on the SPA; `no-referrer` on the API | both |
| `X-Frame-Options` | `DENY` | both (legacy companion to `frame-ancestors`) |
| `Permissions-Policy` | `accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(self), screen-wake-lock=(), usb=(), xr-spatial-tracking=()` | SPA (`publickey-credentials-get=(self)` is pre-provisioned for the WebAuthn follow-up) |
| `Cross-Origin-Opener-Policy` | `same-origin` | SPA |
| `Cross-Origin-Embedder-Policy` | `require-corp` | SPA |
| `Cross-Origin-Resource-Policy` | `same-site` | API |
| `X-Permitted-Cross-Domain-Policies` | `none` | both |
| `X-DNS-Prefetch-Control` | `off` | SPA |
| `Origin-Agent-Cluster` | `?1` | SPA |
| `Server` / `X-Powered-By` | removed (`app.server.headersTimeout`, helmet `hidePoweredBy`) | API |

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

| Rule | Detail |
|---|---|
| Allowlist | `ALLOWED_ORIGINS` is an env array validated at boot; production contains exactly `https://ess.widedrop.com`. Staging contains exactly `https://ess-staging.widedrop.com` |
| No wildcards, ever | No `*`, no regex, no `endsWith('.widedrop.com')` — that last one is the classic bug that would re-admit T-SUB |
| Netlify deploy previews | Deploy-preview URLs (`*.netlify.app`) are **not** allowlisted against production. Previews point at the staging API, which has its own origin allowlist and its own database with no production data |
| `credentials: true` | Required for the refresh cookie; safe only because the origin allowlist is exact |
| `Vary: Origin` | Always sent, so a CDN cannot serve one origin's CORS headers to another |
| Requests with no `Origin` | Permitted for `GET /healthz` only; all other routes require a matching `Origin` on unsafe methods (§3.5) |

### 6.6 Cache headers

| Response class | Headers |
|---|---|
| **Every authenticated API response** | `Cache-Control: no-store`, `Pragma: no-cache`, `Vary: Origin, Authorization`. Set by a global `onSend` hook, not per-route, so a new route cannot forget it. This is what keeps a payslip out of a corporate proxy or a shared-machine back-button |
| API error responses | same |
| `GET /healthz` | `Cache-Control: no-store` (it is trivial, and caching hides outages) |
| Signed file URLs | `Cache-Control: private, no-store` via response-header override |
| SPA `index.html`, `/config.json` | `Cache-Control: no-store` — guarantees a security-header or CSP change reaches clients on the next navigation |
| SPA hashed assets (`/assets/*.js`, `*.css`, fonts) | `Cache-Control: public, max-age=31536000, immutable` — safe because the filename contains a content hash |
| SPA `/sw.js` if ever added | `Cache-Control: no-store` |

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

| Table.column | Contains | Encrypted | Blind index | Masked read |
|---|---|---|---|---|
| `statutory_identity.pan_ciphertext` | PAN | ✔ | `pan_bidx` | `AXYPR••••K` |
| `statutory_identity.aadhaar_ciphertext` | Aadhaar | ✔ | `aadhaar_bidx` | `•••• •••• 8821` |
| `statutory_identity.uan_ciphertext` | UAN | ✔ | — | `1012 3456 ••••` |
| `statutory_identity.pf_account_ciphertext` | PF account | ✔ | — | last 7 chars |
| `statutory_identity.esi_ciphertext` | ESI | ✔ | — | last 4 |
| `bank_account.account_number_ciphertext` | Bank a/c | ✔ | `account_number_bidx` | `•••• •••• 4412` |
| `bank_account.account_number_last4` | last 4 digits, plaintext | ✘ (derived, stored for masking without decryption) | — | shown as-is |
| `bank_account.ifsc` | IFSC | ✘ (public routing code, not secret) | — | shown |
| `bank_account.name_on_account_ciphertext` | Name on account | ✔ | — | HR/Accounts only |
| `employee.date_of_birth_ciphertext` | DOB | ✔ | — | `••/••/1994` for non-self |
| `employee.personal_email_ciphertext` | Personal email | ✔ | `personal_email_bidx` | `p•••••@gmail.com` |
| `employee.personal_phone_ciphertext` | Mobile | ✔ | `personal_phone_bidx` | `+91 •••• •2234` |
| `employee.current_address_ciphertext` | Address | ✔ | — | city + PIN only |
| `employee.permanent_address_ciphertext` | Address | ✔ | — | city + PIN only |
| `employee.blood_group_ciphertext`, `.marital_status_ciphertext`, `.gender_ciphertext`, `.nationality_ciphertext` | Sensitive personal attributes | ✔ | — | hidden |
| `emergency_contact.name_ciphertext`, `.phone_ciphertext`, `.relationship_ciphertext` | A5 | ✔ | — | hidden |
| `dependent.name_ciphertext`, `.date_of_birth_ciphertext`, `.relationship_ciphertext` | A5, includes minors | ✔ | — | hidden |
| `mfa_credential.secret_ciphertext` | TOTP secret | ✔ | — | never readable |
| `ticket_message.body_ciphertext` | Free-text PII channel (A12) | ✔ | — | queue members only |
| `profile_change_request.payload_ciphertext` | Proposed PII values | ✔ | — | — |

**Deliberately *not* application-encrypted, with justification:**

- `payslip.*`, `payslip_line.*`, `salary_structure.*` (A1) — these are summed, filtered, grouped and
  ordered constantly (YTD tiles, FY totals, payroll validation). Application-layer encryption would
  force full-table decrypt-in-app for every aggregate, destroying both performance and the
  deterministic-computation guarantee of D1. They are protected by RBAC (§4.4 — no Manager or HR
  grant), the `payroll_employee_v` restriction (§4.5), platform encryption, and heavy auditing.
  This trade-off is recorded as `docs/adr/0004-payroll-columns-not-app-encrypted.md`.
- `employee.full_name`, `work_email`, `work_phone`, `designation`, `org_unit_id` — ORG-visible by
  design (the Directory screen).
- `policy_acknowledgement` — integrity matters, confidentiality does not; protected by the hash chain.

### 7.2 Envelope scheme

```
KEK  (Key Encryption Key)  — AES-256, held in the cloud KMS (preferred) or, where KMS is
                             unavailable on the chosen container host, as MASTER_KEK_V<n> in the
                             platform secret store. Never in Postgres. Never in the repo.
DEK  (Data Encryption Key) — AES-256, generated by the app, used to encrypt column values.
                             Stored only in wrapped form.
```

`data_key(id smallint pk, purpose text, wrapped_dek bytea, kek_version smallint, status enum('PENDING','ACTIVE','RETIRING','RETIRED'), created_at, retired_at)`

`purpose` separates key domains so a compromise or rotation is contained: `PII`, `STATUTORY`, `BANK`,
`MFA`, `TICKET`. Unwrapped DEKs are cached in process memory for 15 minutes in a `Buffer` that is
explicitly zeroed on eviction; they are never written to disk, never logged, and never serialised.

**Ciphertext envelope format** (`apps/api/src/crypto/envelope.ts`), stored as `bytea`:

```
v1 || dek_id(1 byte) || iv(12 bytes, CSPRNG per encryption) || ciphertext || tag(16 bytes)
```

**AAD binds the ciphertext to its location:** `aad = utf8("<table>:<column>:<row_id>")`. This defeats
a privileged attacker who can `UPDATE` the table: copying employee A's encrypted PAN into employee B's
row produces an authentication-tag failure on decrypt, which is raised as
`SECURITY.CIPHERTEXT_AAD_MISMATCH` (severity `CRITICAL`) rather than silently returning A's data.
Because the row id is part of the AAD, encryption happens after the row id is known — for inserts the
id is generated in application code (UUIDv7) rather than by the database.

A decrypt failure **never** degrades to returning the raw bytes or an empty string; it throws, the
request returns `500 {"code":"DECRYPTION_FAILED"}`, and the event is alerted.

**Blind indexes** (`*_bidx bytea`) enable exact-match lookup without decryption:
`bidx = HMAC-SHA256(BLIND_INDEX_KEY_V<n>, normalize(value))[0..16]` — truncated to 16 bytes to blunt
offline confirmation attacks while keeping collisions negligible at org scale. `normalize()` is
purpose-specific (uppercase + strip spaces for PAN; digits-only for Aadhaar/phone; lowercase for
email). Blind indexes support only equality, never range or prefix — searching bank accounts by
partial number is not a feature. `BLIND_INDEX_KEY` is a distinct secret from the KEK and from the
pepper.

### 7.3 Key management, versioning and rotation

| Key | Where | Rotation | Procedure |
|---|---|---|---|
| `MASTER_KEK_V<n>` | KMS / platform secret store | 12 months, or immediately on suspicion | §7.3.1 |
| DEKs (`data_key`) | wrapped in Postgres | 12 months, or immediately on suspicion | §7.3.2 |
| `PASSWORD_PEPPER_V<n>` | secret store | 24 months | lazy re-hash at next login (§2.1) |
| `BLIND_INDEX_KEY_V<n>` | secret store | with the DEK rotation | recompute all `*_bidx` in the same backfill |
| `JWT_SIGNING_KEY_<kid>` | secret store | 90 days | §3.2 |
| `AUDIT_CHAIN_KEY_V<n>` | secret store | 12 months | §8.3 — never re-keys history |
| `CSRF_KEY`, `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`, `CURSOR_HMAC_KEY` | secret store | 12 months | rotation invalidates live cursors/CSRF tokens only; users re-fetch |

**7.3.1 KEK rotation (cheap).** Only the wrapped DEKs change. Add `MASTER_KEK_V<n+1>`; for each
`data_key` row, unwrap with the old KEK and re-wrap with the new one in a transaction; set
`kek_version = n+1`. No column data is touched. Old KEK is retained for 30 days, then destroyed.

**7.3.2 DEK rotation / re-encryption (expensive, online).** For a `purpose`:

1. Insert a new `data_key` row with `status='PENDING'`, wrapped under the current KEK.
2. Flip it to `ACTIVE` and the previous one to `RETIRING`. From this moment **new writes use the new
   DEK; reads still decrypt with whichever `dek_id` the envelope names** — this dual-read capability is
   inherent to the format and requires no feature flag.
3. `apps/api/src/crypto/reencrypt-worker.ts` walks each affected table in `id` order in batches of
   **500 rows per transaction**, `SELECT … FOR UPDATE SKIP LOCKED`, decrypting with the old DEK and
   re-encrypting with the new one (recomputing the blind index if the index key also rotated).
   Progress is checkpointed in `reencryption_job(purpose, table_name, last_id, rows_done, started_at, finished_at)`
   so it is resumable. Throttled to ≤ 5 % of DB CPU; runs outside payroll windows.
4. When no envelope references the retiring `dek_id`
   (verified by a full scan counting `substring(col from 2 for 1)`), set it `RETIRED` and delete the
   wrapped material after 30 days.
5. The whole rotation emits `SECURITY.KEY_ROTATION_STARTED` / `…_COMPLETED` audit events with counts.

**Rotation is rehearsed in staging before every production run**, and the runbook lives in
`docs/runbooks/key-rotation.md`. A rotation that stalls leaves the system fully functional — that is
the point of the dual-read format.

**Break-glass.** If all copies of a KEK were lost, the affected columns are unrecoverable. Therefore
the KEK is escrowed in the KMS's own durable store (or, for the secret-store variant, in a sealed
offline copy held by two officers under split knowledge), and a quarterly restore drill decrypts a
canary row from a real backup and records the result in `docs/runbooks/dr-drill-log.md`.

### 7.4 Hashing — the right primitive for each job

| Purpose | Primitive | Rationale |
|---|---|---|
| Password storage | **Argon2id** (m=64 MiB, t=3, p=1) over an HMAC-SHA512 pepper pre-hash | Slow, memory-hard, salted — the only correct choice for low-entropy secrets (§2.1) |
| Refresh tokens, reset/invite/activation tokens | **SHA-256** of the raw token | 256-bit random input; a slow hash buys nothing and would add latency to every refresh |
| MFA recovery codes | **HMAC-SHA256** under `RECOVERY_CODE_KEY` | 128-bit random; the key makes a DB-only dump useless |
| File integrity | **SHA-256** over the stored bytes → `file.sha256`, verified on every read-back from storage before signing a URL; a mismatch blocks the download and raises `SECURITY.FILE_INTEGRITY_MISMATCH` | Detects silent storage corruption or tampering |
| Payslip source traceability | **SHA-256** over the canonical JSON of the inputs that produced a payslip → `payslip.input_digest`, recomputed by the verification endpoint | Proves a published payslip matches its persisted inputs (D3) |
| Audit chain | **HMAC-SHA256** under `AUDIT_CHAIN_KEY` | Keyed, so an attacker with DB write access still cannot recompute a valid chain (§8.3) |
| CSRF token binding | **HMAC-SHA256** under `CSRF_KEY` | §3.5 |
| Blind indexes | **HMAC-SHA256** truncated to 128 bits | §7.2 |
| Log/audit IP and user-agent | **HMAC-SHA256** under `LOG_HASH_KEY` → `ip_hash`, `user_agent_hash` | Correlatable across events without storing the raw identifier (§14.3) |
| Pagination cursors | **HMAC-SHA256** under `CURSOR_HMAC_KEY`, bound to `sub` | Cursors cannot be transplanted between users |

Plain SHA-1 appears **only** inside the HIBP k-anonymity protocol (§2.3), where the algorithm is fixed
by the upstream API and only 5 hex characters ever leave the process. MD5 and unsalted SHA of
passwords appear nowhere.

All secret comparisons use `crypto.timingSafeEqual` on equal-length buffers; an ESLint rule forbids
`===` on any identifier ending in `Hash`, `Token`, `Secret` or `Hmac`.

### 7.5 Masking rules for reads

Masking is applied **server-side in the DTO mapper**, never in the SPA — the client never receives the
full value it is meant to mask. `apps/api/src/crypto/mask.ts`:

| Value | Mask | Example | Who sees full |
|---|---|---|---|
| PAN | first 5 + `••••` + last 1 | `AXYPR••••K` | `read:statutory_id:full` (Accounts, step-up) |
| Aadhaar | `•••• •••• ` + last 4 | `•••• •••• 8821` | `read:statutory_id:full` |
| Bank account | `•••• •••• ` + last 4 (from the plaintext `last4` column, so no decryption happens for a masked read) | `•••• •••• 4412` | `read:bank_account:full` |
| UAN | first 9 + `••••` | `1012 3456 ••••` | `read:statutory_id:full` |
| Personal phone | `+91 ••••• ` + last 5 | `+91 ••••• 12234` | self, `read:profile:full` |
| Personal email | first char + `•••••@` + domain | `p•••••@gmail.com` | self, `read:profile:full` |
| DOB | `••/••/YYYY` | `••/••/1994` | self, `read:profile:full` |
| Address | locality + PIN only | `Koramangala, Bengaluru 560095` | self, `read:profile:full` |
| TOTP secret, recovery codes, any hash | **never returned by any endpoint** | — | nobody |

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

| Domain | Actions |
|---|---|
| Authentication | `AUTH.LOGIN_SUCCEEDED`, `AUTH.LOGIN_FAILED`, `AUTH.MFA_CHALLENGED`, `AUTH.MFA_SUCCEEDED`, `AUTH.MFA_FAILED`, `AUTH.MFA_ENROLLED`, `AUTH.MFA_RESET`, `AUTH.MFA_RECOVERY_USED`, `AUTH.LOGOUT`, `AUTH.LOGOUT_ALL`, `AUTH.ACCOUNT_LOCKED`, `AUTH.LOGIN_THROTTLE_ENGAGED`, `AUTH.PASSWORD_CHANGED`, `AUTH.PASSWORD_RESET_REQUESTED`, `AUTH.PASSWORD_RESET_COMPLETED`, `AUTH.REFRESH_ROTATED`, `AUTH.REFRESH_REUSE_DETECTED`, `AUTH.SESSION_REVOKED`, `AUTH.BREACH_CHECK_DEGRADED` |
| Authorization | `AUTHZ.DENIED` (every 403), `AUTHZ.OUT_OF_SCOPE` (every scope-induced 404 on a single-object read), `AUTHZ.STEP_UP_REQUIRED`, `AUTHZ.SELF_APPROVAL_BLOCKED`, `AUTHZ.SEGREGATION_BLOCKED` |
| Payroll state machine (D3) | `PAYROLL.RUN_CREATED`, `PAYROLL.INPUT_UPLOADED`, `PAYROLL.INPUT_ROWS_PARSED`, `PAYROLL.ATTENDANCE_SUBMITTED`, `PAYROLL.ATTENDANCE_APPROVED`, `PAYROLL.ATTENDANCE_REJECTED`, `PAYROLL.ATTENDANCE_ESCALATED`, `PAYROLL.VALIDATION_STARTED`, `PAYROLL.VALIDATION_FAILED`, `PAYROLL.VALIDATION_PASSED`, `PAYROLL.GENERATION_STARTED`, `PAYROLL.PAYSLIP_GENERATED`, `PAYROLL.GENERATION_COMPLETED`, `PAYROLL.RUN_PUBLISHED`, `PAYROLL.RUN_LOCKED`, `PAYROLL.RUN_CANCELLED`, `PAYROLL.AMENDMENT_CREATED` |
| Payslip access | `PAYSLIP.VIEWED`, `PAYSLIP.DOWNLOADED`, `PAYSLIP.EMAILED`, `PAYSLIP.VIEWED_BY_ACCOUNTS` (separate action so third-party access is trivially queryable) |
| Tax | `TAX.FORM16_ISSUED`, `TAX.FORM16_DOWNLOADED`, `TAX.QUARTER_FILED` |
| Profile & bank | `PROFILE.UPDATED`, `PROFILE.CHANGE_REQUESTED`, `PROFILE.CHANGE_APPROVED`, `PROFILE.CHANGE_REJECTED`, `BANK.CHANGE_REQUESTED`, `BANK.CHANGE_VERIFIED`, `BANK.CHANGE_REJECTED`, `BANK.FULL_VIEWED`, `STATUTORY.FULL_VIEWED` |
| Leave & expenses | `LEAVE.REQUESTED`, `LEAVE.APPROVED`, `LEAVE.REJECTED`, `LEAVE.WITHDRAWN`, `LEAVE.BALANCE_ADJUSTED`, `EXPENSE.SUBMITTED`, `EXPENSE.APPROVED`, `EXPENSE.REJECTED`, `EXPENSE.REIMBURSED` |
| Benefits | `BENEFIT.DEPENDENT_CHANGE_REQUESTED`, `BENEFIT.DEPENDENT_CHANGE_APPROVED`, `BENEFIT.PLAN_UPDATED` |
| Policies (D4/D7) | `POLICY.VERSION_CREATED`, `POLICY.VERSION_PUBLISHED`, `POLICY.ARCHIVED`, `POLICY.ACKNOWLEDGED`, `POLICY.ACK_REMINDER_SENT` |
| Announcements | `ANNOUNCEMENT.CREATED`, `ANNOUNCEMENT.PUBLISHED`, `ANNOUNCEMENT.PINNED`, `ANNOUNCEMENT.ARCHIVED` |
| Documents | `DOCUMENT.ISSUED`, `DOCUMENT.DOWNLOADED`, `LETTER.REQUESTED`, `LETTER.ISSUED` |
| Help desk | `TICKET.CREATED`, `TICKET.EMAIL_QUEUED`, `TICKET.EMAIL_SENT`, `TICKET.EMAIL_FAILED`, `TICKET.ASSIGNED`, `TICKET.COMMENTED`, `TICKET.RESOLVED`, `TICKET.REOPENED`, `TICKET.CLOSED` |
| Exports | `EXPORT.REQUESTED`, `EXPORT.COMPLETED`, `EXPORT.DOWNLOADED`, `EXPORT.FAILED` — each with the exact filter, column set and row count |
| Administration | `ADMIN.USER_INVITED`, `ADMIN.USER_ACTIVATED`, `ADMIN.USER_STATUS_CHANGED`, `ADMIN.ROLE_GRANT_REQUESTED`, `ADMIN.ROLE_GRANTED`, `ADMIN.ROLE_REVOKED`, `ADMIN.REPORTING_LINE_CHANGED`, `ADMIN.ORG_UNIT_CHANGED`, `ADMIN.ORG_SETTING_CHANGED`, `ADMIN.MFA_RESET_FOR_USER`, `ADMIN.SESSION_REVOKED_FOR_USER` |
| Security / system | `SECURITY.CSRF_REJECTED`, `SECURITY.SUSPICIOUS_PAYLOAD`, `SECURITY.UPLOAD_TYPE_MISMATCH`, `SECURITY.UPLOAD_MALWARE_DETECTED`, `SECURITY.RATE_LIMIT_TRIPPED`, `SECURITY.IP_BLOCKED`, `SECURITY.CIPHERTEXT_AAD_MISMATCH`, `SECURITY.FILE_INTEGRITY_MISMATCH`, `SECURITY.STORAGE_KEY_INVALID`, `SECURITY.KEY_ROTATION_STARTED`, `SECURITY.KEY_ROTATION_COMPLETED`, `SECURITY.AUDIT_CHAIN_VERIFICATION_FAILED` |

### 8.2 Schema

```sql
CREATE TABLE audit_event (
  seq              bigserial    PRIMARY KEY,          -- chain order; gapless by construction
  id               uuid         NOT NULL UNIQUE,
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
  prev_hash        bytea        NOT NULL,
  hash             bytea        NOT NULL,
  chain_key_version smallint    NOT NULL
);
CREATE INDEX ON audit_event (subject_employee_id, occurred_at DESC);
CREATE INDEX ON audit_event (actor_user_id, occurred_at DESC);
CREATE INDEX ON audit_event (action, occurred_at DESC);
CREATE INDEX ON audit_event (resource_type, resource_id);
```

Partitioned monthly by `occurred_at` (`PARTITION BY RANGE`), with the chain running across partitions
by `seq`.

### 8.3 Hash-chain construction

```
canonical(e) = JCS-canonical JSON of
               { seq, id, occurred_at (RFC3339 UTC, ms), action, outcome, severity,
                 actor_user_id, actor_employee_id, actor_roles (sorted), actor_kind,
                 subject_employee_id, resource_type, resource_id,
                 request_id, session_id,
                 ip_hash (hex), user_agent_hash (hex),
                 payload (JCS-canonical) }

e.prev_hash = (seq == 1) ? 32 zero bytes : previous row's hash
e.hash      = HMAC-SHA256( AUDIT_CHAIN_KEY[v],  canonical(e) || e.prev_hash )
```

- **Keyed**, not a bare hash: an insider with `UPDATE` on the table still cannot forge a consistent
  chain, because `AUDIT_CHAIN_KEY` lives only in the secret store (A10).
- **JCS (RFC 8785) canonicalisation** so key ordering and number formatting cannot change the hash.
- `chain_key_version` is stored per row; key rotation starts using v+1 from a given `seq` onward and
  **never re-keys history**. Verification uses the version recorded on each row.
- Writes are serialised through `SELECT pg_advisory_xact_lock(hashtext('audit_chain'))` taken at the
  start of the audit write, guaranteeing a single linear chain without serialising the whole
  application. The lock is held for microseconds.

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
2. Assert `seq` is contiguous — any gap is a deletion.
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

Partition drop for retention is performed by `ess_migrator` from a scheduled job, never by the app
role, and is itself audited.

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
buffer with a hard cap (an audit outage must not become an availability outage for login *failures*).

**PII redaction inside `payload`.** The payload records *what changed*, not *the data*:

| Rule | Detail |
|---|---|
| Never store plaintext A2–A5 values | A `PROFILE.UPDATED` payload holds `{"changedFields":["personalPhone","currentAddress"]}`, not the old or new values |
| Before/after for sensitive fields | Store `HMAC-SHA256(LOG_HASH_KEY, value)` as `beforeHash`/`afterHash`, so "was it actually changed?" and "was it changed back?" are answerable without holding the value |
| Non-sensitive state transitions | Stored literally: `{"from":"PENDING","to":"APPROVED"}`, `{"amountPaise":186000}`, `{"leaveDays":5}` — payroll and approval amounts must be in the audit trail for D4 and are protected by the same RBAC as the underlying records |
| Free text | Ticket bodies, leave reasons and rejection notes are **never** copied into `payload`; the audit row references `resource_id` and the reader must hold the permission to open it |
| Structural guard | `payload` passes through `redactPayload()` which walks the object and drops any key matching the denylist `/pan|aadhaar|account_?number|ifsc|password|secret|token|otp|dob|date_of_birth|address|phone|email|salary|ciphertext/i` unless it is explicitly allowlisted per action in `audit-payload-schemas.ts`. Every action has a Zod schema for its payload; an unschema'd payload is rejected at write time |
| Size | `payload` capped at 8 KiB |
| Access | Reading audit rows requires `read:audit:hr` or `read:audit:payroll` (§4.4); the audit reader itself emits an audit event for bulk reads (> 100 rows) |

### 8.6 Help-desk ticket email (D8) — persisted first, delivered reliably

1. `POST /tickets` validates, then **in one transaction**: inserts `ticket` + first `ticket_message`
   (body encrypted, §7.1), inserts a `notification_outbox` row targeting
   `helpdesk@widedroptech.com`, and writes `TICKET.CREATED` + `TICKET.EMAIL_QUEUED`.
2. The API responds `201` with the persisted ticket reference (e.g. `HD-4831`), generated from a
   Postgres sequence — never a client-side counter, per D1.
3. `apps/api/src/workers/outbox-worker.ts` delivers via the mail provider's HTTPS API (not raw SMTP
   concatenation), with exponential backoff (1 m, 5 m, 15 m, 1 h, 6 h; 5 attempts), idempotency key =
   `notification_outbox.id`. Success ⇒ `TICKET.EMAIL_SENT`; final failure ⇒ `TICKET.EMAIL_FAILED`,
   severity `WARN`, alert, and the ticket is flagged in the HR queue so it is never silently lost.
4. The mail body contains the ticket reference, category, subject, requester **work** email and a deep
   link — and **no** PII beyond that; the full body is read in the portal under the queue permission.
   Every header-bound field has CR/LF stripped (§B5).
5. The recipient address lives in `org_setting.helpdesk_email` (seeded to `helpdesk@widedroptech.com`),
   so changing it is an audited `ADMIN.ORG_SETTING_CHANGED` event rather than a redeploy.

### 8.7 Retention and break-glass

| Audit class | Retention | Basis |
|---|---|---|
| Payroll, tax, payslip, bank, statutory, export, role-grant, admin | **8 years** from the end of the financial year | Income-tax and EPF record-keeping windows; payroll disputes |
| Policy acknowledgement events | Employment duration + **8 years** | POSH / ISP compliance evidence |
| Leave, expense, benefit, document, ticket lifecycle | **5 years** | Employment-dispute window |
| `AUTHZ.*` denials | **18 months** | Security investigation |
| `AUTH.*` authentication events | **18 months** | Security investigation |
| `SECURITY.*` | **8 years** | Incident forensics |
| `login_attempt` (not an audit row) | **90 days** | Rate limiting only |

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

| Route / class | Key | Limit | Window | On exceed |
|---|---|---|---|---|
| `POST /auth/login` | `ip` | 10 | 15 min | 429 |
| `POST /auth/login` | `account (email_hash)` | 10 | 15 min | 429; lockout ladder §2.6 continues independently |
| `POST /auth/login` | `ip` (global spray) | 60 | 60 min | 429 + `SECURITY.IP_BLOCKED` |
| `POST /auth/mfa/verify` | `user` | 5 | 5 min | 429, then 15 min cooldown |
| `POST /auth/mfa/enrol`, `/mfa/recovery/regenerate` | `user` | 5 | 60 min | 429 |
| `POST /auth/password-reset/request` | `ip` | 5 | 60 min | 202 (never reveals throttling) but no mail sent |
| `POST /auth/password-reset/request` | `account` | 3 | 60 min | as above |
| `POST /auth/password-reset/confirm` | `ip` | 10 | 60 min | 429 |
| `POST /auth/refresh` | `session` | 60 | 5 min | 429 + investigate (a healthy client refreshes ≈ 6×/h) |
| `POST /auth/activate` | `ip` | 10 | 60 min | 429 |
| `GET /search` (global search) | `user` | 30 | 1 min | 429 |
| `GET /directory` | `user` | 60 | 1 min | 429 |
| File upload (any) | `user` | 20 | 1 h | 429 |
| File upload (any) | `user`, bytes | 200 MiB | 24 h | 429 |
| `GET /files/:id` (signed-URL issue) | `user` | 120 | 1 h | 429 |
| `POST /exports/*` | `user` | 3 | 1 h; max 1 concurrent | 429 |
| `POST /tickets` | `user` | 10 | 1 h | 429 |
| `POST /policies/:id/acknowledge` | `user` | 30 | 1 h | 429 |
| Approval decisions (`approve:*`, `reject:*`) | `user` | 200 | 1 h | 429 + `SECURITY.RATE_LIMIT_TRIPPED` (bulk rubber-stamping signal) |
| `upload:payroll_input`, `publish:payroll` | `user` | 10 | 1 h | 429 |
| `read:bank_account:full`, `read:statutory_id:full` | `user` | **30** | 1 h | 429 **and** a `CRITICAL` alert — a legitimate payroll session unmasks a handful, not hundreds (§11.4) |
| General authenticated **read** (`GET`) | `user` | 300 | 1 min | 429 |
| General authenticated **write** | `user` | 60 | 1 min | 429 |
| Unauthenticated (`/healthz`, `/csp-report`) | `ip` | 60 | 1 min | 429 |
| Platform edge | `ip` | provider WAF/DDoS defaults | — | — |

### 9.2 Keying strategy

A request is evaluated against **every** applicable key; the most restrictive decision wins.

| Key | Derivation | Why |
|---|---|---|
| `ip` | `HMAC-SHA256(LOG_HASH_KEY, client_ip)`, where `client_ip` is the **last** entry of `X-Forwarded-For` added by the trusted platform proxy (Fastify `trustProxy` configured with the exact proxy CIDRs — never `true`, which would let a client spoof its own IP and evade every IP limit) | Blocks distributed guessing from one source |
| `account` | `HMAC-SHA256(LOG_HASH_KEY, lower(email))` — used on unauthenticated routes where no user id exists yet | Prevents one account being sprayed from many IPs |
| `user` | `user.id` | Post-authentication abuse |
| `session` | `session.id` | Refresh-loop detection |
| `route` | `method + routerPath` (the templated path, so `/payslips/:id` is one bucket, not one per id) | Prevents a cheap route's budget from shielding an expensive one |

The stored key is always `sha256(scope || ':' || route || ':' || keyValue)`, so the limiter table
contains no raw IPs or emails (§14.3).

### 9.3 Storage

`rate_limit_counter(bucket_key bytea PRIMARY KEY, window_start timestamptz NOT NULL, count int NOT NULL, expires_at timestamptz NOT NULL)` in Postgres, incremented atomically:

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

Postgres rather than in-memory because the API runs more than one instance and an in-memory limiter
would multiply every limit by the instance count — a silent, dangerous failure. A sweeper deletes
expired rows every 5 minutes. If the limiter store itself errors, the limiter **fails closed on
authentication routes** (`503 {"code":"UNAVAILABLE"}`) and fails open with a `WARN` on general reads —
authentication brute-force protection is never traded for availability. Migrating to Redis/Valkey is a
drop-in store swap recorded in `docs/adr/0006-rate-limit-store.md`, warranted above roughly 200 rps.

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
