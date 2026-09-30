# Widedrop ESS — Deployment & Operations Architecture

> ### This is the design specification, not the built system
>
> Written before the implementation, and kept because the reasoning in it is
> worth having: it records why each decision went the way it did. But the
> build made its own decisions in places, and where the two disagree **the
> code is correct and this document is out of date.**
>
> What to read instead, for this document's subject: `infra/netlify/`, `infra/render/`, `apps/api/Dockerfile`, `.github/workflows/`, and `docs/RUNBOOK.md`.
>
> The largest divergence is the permission vocabulary. These documents fold
> the scope into the permission name (`payslip:read:any`,
> `approval:task:read:team`); what was built separates them, so a permission
> names an action and each role holds it _at a scope_ (`payslip:read-any` at
> `ORG`). `docs/RBAC.md` is generated from the module the API enforces, and
> CI fails if it drifts.

**Status:** implementation-ready specification.
**Audience:** the implementer and whoever is on call afterwards.
**Companions:** **`docs/ARCHITECTURE.md`** (the index and the tie-breaker — canonical entity,
enum, permission, state and environment-variable names), `docs/SECURITY.md` (controls),
`docs/DATA-MODEL.md` (schema), `docs/API.md` (wire contract), `docs/WORKFLOWS.md` (state
machines), `docs/FRONTEND.md` (the SPA this site serves).
This document is the authority for _where things run, how they are configured, how they
ship and how they are recovered_. Where it repeats a control from `SECURITY.md` it does so
only to state the deployment-time obligation; the security rationale lives there.

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

## 0. Conventions, and three reconciliations you must apply

### 0.1 Naming conventions

| Thing                   | Value                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| SPA host (production)   | `ess.widedrop.com`                                                                         |
| API host (production)   | `api-ess.widedrop.com`                                                                     |
| SPA host (staging)      | `ess-staging.widedrop.com`                                                                 |
| API host (staging)      | `api-ess-staging.widedrop.com`                                                             |
| API base path           | `/api/v1`                                                                                  |
| Mail sending domain     | `widedroptech.com`                                                                         |
| Existing marketing site | `widedrop.com` + `www.widedrop.com` — **untouched**                                        |
| Container image         | `ghcr.io/widedrop/ess-api:<git-sha>` (immutable; `:latest` is never deployed)              |
| Primary region          | `singapore` (Render) for API + Postgres; `apac` hint for R2; `ap-south-1` (Mumbai) for SES |

### 0.2 Reconciliation R-1 — the API hostname is flat, not nested

The brief for this document proposed `api.ess.widedrop.com`. `docs/SECURITY.md` §6.1/§6.3/§6.5
and `docs/API.md` §1.1 were written against **`api-ess.widedrop.com`**, and those strings are
baked into the CSP `connect-src`, the CORS allowlist, the JWT issuer/audience and the TLS
section. This document adopts **`api-ess.widedrop.com`** so the four documents agree.

The choice is security-neutral: both names sit under the registrable domain `widedrop.com`,
so both are _same-site_ with `ess.widedrop.com` (§1.4), and both are host-locked identically
because the refresh cookie uses the `__Host-` prefix and therefore carries no `Domain`
attribute at all. The flat form additionally avoids a third DNS label, which keeps the
certificate a plain single-name Let's Encrypt cert rather than needing a wildcard at the
`*.ess.widedrop.com` level. If the team prefers the nested form, change it in exactly four
places (`SECURITY.md` §6.1/§6.3/§6.5, `API.md` §1.1, `ALLOWED_ORIGINS`, `JWT_ISSUER`) and
nothing else in this document changes.

### 0.3 Reconciliation R-2 — the mail domain is `widedroptech.com`

`SECURITY.md` §10.2 states `MAIL_FROM` "must be `@widedrop.com`". That is wrong and must be
corrected to **`@widedroptech.com`**: the mandated help-desk recipient is
`helpdesk@widedroptech.com` (product directive 8) and `WORKFLOWS.md` §6.3 sends from
`no-reply@widedroptech.com`. Amend the `env.ts` refinement accordingly. The practical
benefit is a clean split: **all mail DNS lives in the `widedroptech.com` zone, so no SPF,
DKIM, DMARC or MX record in the `widedrop.com` zone is ever touched** — which is exactly the
isolation the marketing site needs.

### 0.4 Reconciliation R-3 — `apps/api/src/config/env.ts` needs renaming

The scaffold in `apps/api/src/config/env.ts` predates `SECURITY.md` §10.2 and uses
single-version key names that the rotation procedures in §7.3 and §3.2 of that document
cannot express. §7 of this document is the canonical table. Required edits:

| In the scaffold today                               | Canonical name                                                                                                                                                    | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CORS_ORIGINS`                                      | `ALLOWED_ORIGINS`                                                                                                                                                 | matches `SECURITY.md` §6.5                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KEY_ID` | `JWT_SIGNING_KEY_<kid>` / `JWT_PUBLIC_KEY_<kid>` / `JWT_ACTIVE_KID`                                                                                               | overlapping-key rotation (`SECURITY.md` §3.2) needs N keys resident at once                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `PASSWORD_PEPPER`                                   | `PASSWORD_PEPPER_V1` (+ `_V2`…)                                                                                                                                   | lazy re-hash rotation                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ENCRYPTION_KEK` / `ENCRYPTION_KEY_VERSION`         | `MASTER_KEK_V1` (+ …) / `MASTER_KEK_ACTIVE_VERSION`                                                                                                               | KEK re-wrap keeps the old KEK for 30 days                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `AUDIT_HMAC_KEY`                                    | `AUDIT_CHAIN_KEY_V1`                                                                                                                                              | chain history is never re-keyed                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `REDIS_URL` **required** in production              | `RATE_LIMIT_STORE=redis\|postgres` (default `redis`), `REDIS_URL` **required** in staging and production                                                          | **Corrected.** `SECURITY.md` §9.3 makes **Redis the primary** limiter store and Postgres the durable fallback, not the other way round. An earlier line here inverted it. The inversion matters: the Postgres fixed-window upsert is a write to the _primary business database_ on every rate-limited request, which turns a credential-stuffing burst into database load on the system of record. Both stores unavailable ⇒ fail **closed** on `/auth/*` and on every `sensitive: true` route |
| `S3_*`                                              | `STORAGE_*`                                                                                                                                                       | matches `SECURITY.md` §10.2                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SMTP_*`                                            | `MAIL_*` (HTTPS provider API)                                                                                                                                     | `WORKFLOWS.md` §6.3 forbids raw SMTP string concatenation                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `INTERNAL_PORT` (`SECURITY.md` §10.2)               | `PRIVATE_PORT`                                                                                                                                                    | One listener, one name. §7.2 here is canonical for variable **names**; `SECURITY.md` §10.2 is canonical for each variable's **constraint**                                                                                                                                                                                                                                                                                                                                                     |
| — (absent)                                          | `KEY_PROVIDER` (`kms`\|`env`), `KMS_KEY_ARN`, `ORG_SETTING_EMAIL_DOMAIN_ALLOWLIST`, `EX_EMPLOYEE_WINDOW_DAYS_MAX`                                                 | required by `SECURITY.md` §10.2; `MASTER_KEK_V<n>` is required **iff** `KEY_PROVIDER='env'`, so a KMS deployment could not boot without this                                                                                                                                                                                                                                                                                                                                                   |
| — (absent)                                          | `DIRECT_DATABASE_URL`                                                                                                                                             | session-scoped advisory locks and migrations must bypass the transaction pooler (§4.3)                                                                                                                                                                                                                                                                                                                                                                                                         |
| — (absent)                                          | `SERVICE_ROLE`, `TRUSTED_PROXY_CIDRS`, `BLIND_INDEX_KEY_V1`, `CSRF_KEY`, `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`, `CURSOR_HMAC_KEY`, `CLAMAV_*`, `OUTBOUND_ALLOWLIST` | required by `SECURITY.md` §5.3, §5.5, §7.2, §7.4, §9.2                                                                                                                                                                                                                                                                                                                                                                                                                                         |

| — (absent) | `PRIVATE_PORT` | `/readyz` and `/metrics` are served on a second listener the platform does not route (§9.2) |
| — (absent) | `TZ`, plus the rule that every business date resolves in `organization.timezone` | R-16: an unset container timezone silently shifts attendance days, pay dates and cut-offs |
| — (absent) | `SES_SNS_TOPIC_ARN` | the bounce/complaint webhook of §6.4 has no other way to pin its sender |
| — (absent) | `BLIND_INDEX_ACTIVE_VERSION` | the value written into every new `<field>_fpr_pepper_version` (`DATA-MODEL.md` §1.6); the pepper rotates inside the DEK backfill (§11.3.2 D2) and needs an active pointer |
| — (absent) | `BACKUP_AGE_RECIPIENT`, `BACKUP_BUCKET`, `BACKUP_ACCESS_KEY_ID`, `BACKUP_SECRET_ACCESS_KEY`, `BACKUP_DATABASE_URL` | the weekly off-provider dump (§4.5) is a real service with real credentials |
| — (absent) | `CSP_REPORT_ONLY` | `SECURITY.md` §6.3 requires one report-only release before the policy is enforced |

### 0.5 Reconciliation R-13 — the database roles are `DATA-MODEL.md` §1.8.1's six, not four

An earlier draft of §4.4 described **four** roles and gave `ess_owner` `LOGIN`.
`DATA-MODEL.md` §1.8.1 is canonical and now declares **six** — `ess_owner`, `ess_app`,
`ess_job`, `ess_migrator`, `ess_readonly`, `ess_backup` — all `NOINHERIT`, with `ess_owner`
**`NOLOGIN`**. `ess_backup` was referenced by §4.5, §7.2 (`BACKUP_DATABASE_URL`) and boot
refusal 18 here while existing in no schema document; it is now declared there: `SELECT`-only
on every table, `BYPASSRLS` (a backup that silently omitted rows is worse than no backup), and
its credential present in exactly one process, the weekly backup cron. §4.4 below is rewritten
to match. Two deployment-specific deviations are stated there and
nowhere else:

1. Render's managed PostgreSQL provisions the database with a **login** owner role, so on
   this platform `ess_owner` carries `LOGIN`. It is compensated: the role appears in no
   service's environment, its password lives only in the sealed envelope (§7.3), and the
   boot-time privilege assertion refuses to start if the connected role is `ess_owner`.
2. Because `ess_owner` can log in here, `ALTER TABLE … FORCE ROW LEVEL SECURITY`
   (`DATA-MODEL.md` §1.8.1) stops being a nicety and becomes load-bearing: without it a
   break-glass session silently bypasses every policy. The migration linter enforces it
   (§4.6 rule 4).

A third correction belongs with them. An earlier draft's boot assertion refused to start
"if the connected role has `rolbypassrls`". `ess_job` **is** `BYPASSRLS` by design
(`DATA-MODEL.md` §1.8.1), so that assertion would have refused to start the worker — the
one service that cannot be allowed to fail silently. The assertion is **role-aware** in
§4.4: `SERVICE_ROLE=api` must connect as a `NOBYPASSRLS` role, `SERVICE_ROLE=worker` must
connect as `ess_job`, and neither may ever be `ess_owner` or `ess_migrator`.

### 0.6 Reconciliation R-14 — the CSP report endpoint is `/api/v1/csp-report`

`SECURITY.md` §6.3 and `FRONTEND.md` write the report URL as
`https://api-ess.widedrop.com/csp-report`, with no version prefix. `API.md` §1.1 states that
`/api/v1` is **the** base path. This document adopts **`/api/v1/csp-report`** and requires
the same correction in `SECURITY.md` §6.3 (both the `report-uri` line and the
`Reporting-Endpoints` example) and in `FRONTEND.md`. The same applies to `/healthz`,
`/readyz` and `/metrics`, which `SECURITY.md` writes unprefixed and `API.md` §13 serves
under `/api/v1`. `/.well-known/jwks.json` is the single deliberate exception and is served
**unprefixed at the origin root**, because RFC 8615 fixes that path there; it is declared as
such in the route table so the boot-time route assertion does not flag it.

Two further corrections this forces into §2.3, both already mandated by `SECURITY.md` §6.3
and omitted by the earlier generator:

- the policy must carry `report-to csp` **and** the response must carry
  `Reporting-Endpoints: csp="…"`, or `report-to` is inert and only the deprecated
  `report-uri` path delivers — which is how a "clean" rollout is clean because nothing was
  ever reported;
- one release must ship `Content-Security-Policy-Report-Only` before the enforcing header,
  gated by `CSP_REPORT_ONLY`.

### 0.7 Reconciliation R-15 — persisted object names used by the runbooks

Earlier drafts of §4.5, §11.2, §11.3 and §11.5 named objects that do not exist in
`DATA-MODEL.md`. The canonical names, which the runbooks below now use:

| Earlier draft                                | Canonical (`DATA-MODEL.md`)                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `payroll_input_row`                          | `ess.payroll_input_batch` (the file) **+** `ess.payroll_input_item` (the row)           |
| `payslip.input_digest`                       | `ess.payslip.input_sha256` (inputs) and `ess.payslip.amount_sha256` (decrypted amounts) |
| attendance "batch sha256"                    | `ess.attendance_submission.payload_sha256`                                              |
| "the 21 named jobs"                          | the **named-job list** of `DATA-MODEL.md` §17.5 — read the list, never quote a count    |
| `ess_ops.background_job('worker-heartbeat')` | `worker-heartbeat` is **not** in that list; R-17 adds it                                |

**R-18 is now RESOLVED.** `SECURITY.md` §7.2 called the key table `data_key` with purposes
`PII`/`STATUTORY`/`BANK`/`MFA`/`TICKET`; `DATA-MODEL.md` §17.3 calls it
`data_encryption_key` with purposes `FIELD_DEFAULT`/`PAYROLL`/`MFA`. **`data_encryption_key`
wins**, with those three purposes and status `PENDING`/`ACTIVE`/`RETIRED`/`COMPROMISED`
(`RETIRING` withdrawn). Read `data_key` in §4.5, §11.3 and §11.5 below as
`data_encryption_key`, and read `data_encryption_key.purpose` as its three values; the runbooks still read
the live purpose list from the schema rather than from prose, so a future purpose added by
migration is picked up without editing a runbook. Minting a DEK per purpose under one name and
rotating it under the other is exactly how a key rotation silently misses a column, which is
why this could not stay open.

### 0.8 Reconciliation R-16 — business time is `Asia/Kolkata`, and the container is UTC

`DATA-MODEL.md` §1.2 interprets every `date` column in `organization.timezone`
(`Asia/Kolkata`). Nothing in an earlier draft of this document set a timezone anywhere, and
a container with no `TZ` runs in UTC — which puts every attendance day boundary, pay date,
expense cut-off, SLA clock and "published outside the change window" alert 5 h 30 m out of
step with the business. That produces **wrong numbers in the UI without any of them being
invented**, which is the failure mode directive 2 is least able to detect. The rule,
enforced at boot (§7.4 refusal 20):

- every container sets `TZ=UTC`; the database runs `timezone = 'UTC'`; every stored instant
  is `timestamptz`;
- **no business date is ever derived from the process clock's local calendar.** A civil date
  is `(instant AT TIME ZONE :org_tz)::date` in SQL, or an explicit `timeZone` option in
  `Intl`/`Temporal` in application code. An ESLint rule bans `new Date().getDate()`,
  `.getMonth()`, `.getFullYear()`, `.getDay()`, `.getHours()` and `toLocaleDateString()`
  called without an explicit `timeZone`;
- the SPA formats dates with `Intl.DateTimeFormat('en-IN', { timeZone: orgTimezone, … })`
  using the timezone the API returns in the bootstrap payload — never the browser's zone,
  so an employee travelling abroad does not see a different pay date;
- schedules in `ess_ops.background_job` store an IANA zone alongside the expression: a job
  that must run "02:00 IST" stores `Asia/Kolkata`, not a UTC offset, so it survives a future
  rule change.

---

## 1. Topology

### 1.1 Diagram

```
                         ┌──────────────────────────────────────────┐
                         │            E M P L O Y E E                │
                         │   browser · desktop / mobile · HTTPS only │
                         └──────────────┬───────────────────────────┘
                                        │
             ┌──────────────────────────┴───────────────────────────┐
             │ TLS 1.3                                    TLS 1.3   │
             ▼                                                      ▼
┌─────────────────────────────┐                    ┌───────────────────────────────────┐
│  NETLIFY CDN  (site #2)     │                    │  RENDER  (region: singapore)      │
│  ess.widedrop.com           │                    │  api-ess.widedrop.com             │
│  ─────────────────────────  │                    │  ───────────────────────────────  │
│  static SPA build only      │   fetch + cookie   │  Fastify 5 / Node 22 (Docker)     │
│  · immutable hashed assets  │ ─────────────────▶ │  2 × Standard, rolling deploy     │
│  · index.html  no-store     │   same-site        │  · Zod validation · RBAC guards   │
│  · CSP / HSTS / COOP-COEP   │ ◀───────────────── │  · audit chain · rate limiter     │
│  · SPA history fallback     │   JSON + 302       │  · signed-URL minting             │
│  NO secrets, NO SSR,        │                    └───┬───────┬──────────┬────────────┘
│  NO Netlify Functions       │                        │       │          │
└─────────────────────────────┘        private network │       │          │ private
             ▲                                          ▼       ▼          ▼  network
             │ deploy artifact                    ┌──────────┐ ┌────────┐ ┌──────────┐
             │ (netlify-cli)                      │ PgBouncer│ │ClamAV  │ │ WORKER   │
             │                                    │ txn pool │ │ clamd  │ │ 1 × always│
┌────────────┴────────────────┐                   └────┬─────┘ └────────┘ │ on        │
│  GITHUB ACTIONS             │                        │                  │ outbox +  │
│  build · test · scan        │   OIDC, no long-lived  ▼                  │ 21 sched. │
│  push image · migrate       │ ─────────────▶  ┌──────────────────────┐  │ jobs      │
│  deploy API · deploy SPA    │                 │ MANAGED POSTGRESQL 16│◀─┘ (DIRECT   │
└─────────────────────────────┘                 │ private · TLS verify │    url, for  │
                                                │ PITR · daily backup  │    session   │
                                                │ roles: app/job/migr. │    adv.locks)│
                                                └──────────────────────┘
                                        │                        │
                        S3 API, private │                        │ HTTPS API
                                        ▼                        ▼
                         ┌───────────────────────────┐  ┌──────────────────────────┐
                         │ CLOUDFLARE R2 (apac)      │  │ AMAZON SES (ap-south-1)  │
                         │ private buckets, SSE      │  │ DKIM-signed, SPF, DMARC  │
                         │ payslips · bills · policy │  │ → helpdesk@widedroptech  │
                         │ 120 s signed GET URLs     │  │ ← SNS bounce webhook     │
                         └───────────────────────────┘  └──────────────────────────┘

   UNTOUCHED, SEPARATE BLAST RADIUS:
   ┌─────────────────────────────────────────────────────────────────────┐
   │  NETLIFY (site #1, existing free-tier team)                         │
   │  widedrop.com + www.widedrop.com — marketing site                   │
   │  no config change · no build-minute consumption · no shared secret  │
   └─────────────────────────────────────────────────────────────────────┘
```

### 1.2 Component table

| #   | Component         | Product / plan                                                           | Purpose                                                                     | Holds persistent data?    | Reachable from the internet?            |
| --- | ----------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------- | --------------------------------------- |
| 1   | Marketing site    | Netlify, existing free team                                              | `widedrop.com`                                                              | no                        | yes (unchanged)                         |
| 2   | ESS SPA           | Netlify, **new dedicated site on a new team**                            | static React build at `ess.widedrop.com`                                    | no                        | yes                                     |
| 3   | ESS API           | Render Web Service (Docker), `singapore`, 2 instances                    | Fastify, all authorization, all business logic                              | no (stateless)            | yes, `api-ess.widedrop.com` only        |
| 4   | ESS worker        | Render Background Worker (same image, `SERVICE_ROLE=worker`), 1 instance | `email-dispatch` + every job in the named-job list of `DATA-MODEL.md` §17.5 | no (state is in Postgres) | **no**                                  |
| 5   | Connection pooler | Render Private Service, PgBouncer, transaction mode                      | multiplexes API connections onto Postgres                                   | no                        | **no**                                  |
| 6   | Malware scanner   | Render Private Service, `clamav/clamav:stable`, 2 GB                     | `clamd` INSTREAM scan of every upload (`SECURITY.md` §5.3.10)               | signature DB only         | **no**                                  |
| 7   | Database          | Render Managed PostgreSQL 16, `singapore`                                | **the system of record**                                                    | **yes**                   | **no** — private network + IP allowlist |
| 8   | Object storage    | Cloudflare R2, `apac` location hint                                      | payslip PDFs, expense bills, policy PDFs, letters, payroll input files      | **yes**                   | no public access; 120 s signed GET only |
| 9   | Email             | Amazon SES, `ap-south-1`                                                 | help-desk dispatch, invites, resets, notifications                          | no                        | outbound; inbound SNS webhook only      |
| 10  | CI/CD             | GitHub Actions + GHCR                                                    | build, test, scan, migrate, deploy                                          | build artifacts           | n/a                                     |
| 11  | Logs              | Better Stack (or Grafana Cloud Loki)                                     | structured JSON log sink, 30 d hot / 180 d cold                             | logs (PII-redacted)       | no                                      |
| 12  | Errors            | Sentry, PII scrubbing on                                                 | exception tracking                                                          | scrubbed events           | no                                      |
| 13  | Uptime            | Better Stack Uptime (or Healthchecks.io)                                 | external probe of `/api/v1/healthz` and the SPA                             | no                        | n/a                                     |

**What deliberately does not exist:** no Netlify Functions, no Netlify Edge Functions, no
serverless function as a system of record, no CDN in front of the API, no public database
endpoint, no browser-to-bucket write path, no SSR, no cookie shared with `widedrop.com`.

### 1.3 Why a second Netlify site, on a second Netlify team

| Option                                                       | Verdict                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Path on the existing site (`widedrop.com/ess`) via a rewrite | **Rejected.** One deploy pipeline for two products; a marketing deploy can break the portal; the CSP and HSTS the portal needs would be forced onto the marketing site; `Path=/` cookies would be shared with marketing pages; and there is no way to give HR/engineering access to one without the other. |
| Second site, same Netlify team                               | Workable but rejected as default. Free-tier **build minutes (300/mo) and bandwidth (100 GB/mo) are account-wide**, so ESS traffic would silently consume the marketing site's allowance, and one leaked Netlify token would reach both sites.                                                              |
| **Second site, separate Netlify team** (chosen)              | Independent quota, independent access control, independent deploy token, independent rollback. Free tier is sufficient for a static SPA. The marketing site's team is never given an ESS credential and never sees an ESS deploy.                                                                          |

**Build minutes are additionally reduced to zero** on _both_ teams: the SPA is built inside
GitHub Actions and uploaded with `netlify deploy --prod --dir=apps/web/dist --no-build`.
Netlify only serves the artifact. This means the ESS can ship any number of times a day
without ever touching a free-tier build-minute budget, on either team (§2.5).

### 1.4 Same-site cookie implications — the reason the subdomain choice matters

The refresh session lives in `__Host-wd_rt`, an `HttpOnly` cookie set by the API
(`SECURITY.md` §3.4). Whether the browser attaches it to the SPA's XHR is decided by the
**site** comparison, which uses the registrable domain (eTLD+1), _not_ the full host.

| Layout                                | SPA origin                 | API origin                                                        | eTLD+1                           | Browser verdict             | Cookie behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------- | ----------------------------------------------------------------- | -------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chosen**                            | `https://ess.widedrop.com` | `https://api-ess.widedrop.com`                                    | both `widedrop.com`              | **same-site**, cross-origin | `SameSite=Strict` attaches on the SPA's own `fetch`. `SameSite=Lax` would also work; `Strict` is chosen because nothing in the flow depends on a cross-site top-level navigation carrying the cookie, and `Strict` additionally blocks a phishing page navigating the victim to `/auth/refresh`.                                                                                                                                                                           |
| Nested alternative                    | `https://ess.widedrop.com` | `https://api.ess.widedrop.com`                                    | both `widedrop.com`              | identical                   | identical — the extra label changes nothing for `SameSite`.                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Cross-site alternative** (rejected) | `https://ess.widedrop.com` | `https://widedrop-ess-api.onrender.com` or `api.widedrop-ess.com` | `widedrop.com` vs `onrender.com` | **cross-site**              | Requires `SameSite=None; Secure` on the refresh cookie. That is strictly worse: the cookie is then attached to _every_ cross-site request the browser can be tricked into making, so CSRF defence rests entirely on the server-side token; Safari ITP and Firefox TCP treat it as third-party storage and may **partition or evict it**, silently logging users out; and `__Host-` plus `SameSite=None` is a combination several corporate proxies and webviews mishandle. |

Three consequences the implementer must honour:

1. **`credentials: 'include'` is still required** on the SPA's `fetch` to the API, because
   same-site is not same-_origin_. CORS is therefore still in play, with an exact-string
   origin allowlist and `credentials: true` (`SECURITY.md` §6.5). No wildcard, and
   specifically never `endsWith('.widedrop.com')`.
2. **Same-site is not a security boundary.** Every `*.widedrop.com` host — including the
   marketing site and any future or hijacked CNAME — is same-site with the API. This is
   precisely why the cookie carries the `__Host-` prefix (host-locked, no `Domain`) and why
   CSRF defence is the signed, session-bound double-submit token plus `Origin` plus
   `Sec-Fetch-*`, not `SameSite` alone (`SECURITY.md` §3.5). **`COOKIE_DOMAIN` must be empty
   in every environment**; setting it to `.widedrop.com` would hand the marketing site's
   blast radius the portal's session, and the boot check in §7.4 refuses to start if it is set.
3. **Dangling-DNS hygiene is an operational duty.** Because sibling hosts are same-site, a
   stale CNAME pointing at a de-provisioned third-party service is a takeover route into the
   same-site set. The quarterly DNS review in §11.7 exists for this.

---

## 2. Netlify — the ESS SPA site

### 2.1 Site settings (create once, in the new team)

| Setting                              | Value                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Site name                            | `widedrop-ess` (serves `widedrop-ess.netlify.app`)                                                                                                                                                                                                                            |
| Repository                           | connected **read-only for previews only**; production deploys arrive from CI (§2.5)                                                                                                                                                                                           |
| Base directory                       | `apps/web`                                                                                                                                                                                                                                                                    |
| Build command                        | `npm run build` (only used by deploy previews; production builds happen in CI)                                                                                                                                                                                                |
| Publish directory                    | `apps/web/dist`                                                                                                                                                                                                                                                               |
| Functions directory                  | **unset** — the ESS site runs no functions                                                                                                                                                                                                                                    |
| Node version                         | `22` (from `.nvmrc`, and pinned again in `netlify.toml`)                                                                                                                                                                                                                      |
| Custom domain                        | `ess.widedrop.com` (primary). No apex, no `www`.                                                                                                                                                                                                                              |
| HTTPS                                | Let's Encrypt, auto-renew; "Force HTTPS" **on**                                                                                                                                                                                                                               |
| Asset optimisation / post-processing | **off** — it rewrites markup and would break SRI and the no-inline-style guarantee (`SECURITY.md` §6.3)                                                                                                                                                                       |
| Production branch                    | **set to the unused branch `netlify-prod-locked`, and "Builds" set to _stopped_.** See the note below — this is what keeps CI the only path to production.                                                                                                                    |
| Branch deploys                       | `staging` only                                                                                                                                                                                                                                                                |
| Deploy previews                      | on, for PRs; they point at the **staging** API (§2.4)                                                                                                                                                                                                                         |
| Web fonts                            | **self-hosted** from `/fonts` (IBM Plex Sans / IBM Plex Mono, `design/DESIGN-SYSTEM.md` §2). No Google Fonts, no external stylesheet — `style-src 'self'` and `font-src 'self'` forbid it, and an external font host is an uncontrolled third party on an authenticated page. |
| Environment variables                | `VITE_API_BASE_URL`, `VITE_APP_ENV`, `VITE_BUILD_SHA`, `VITE_SENTRY_DSN` — all public build-time config, **never a secret**                                                                                                                                                   |

> **The production branch must not be `main`.** Netlify's default is to treat the repository's
> default branch as the production branch and to build and publish it on every push. Left at
> that default, a push to `main` would produce a **second, unreviewed production deploy** that
> bypasses `ci.yml`, ignores the `production` environment's required reviewer, and spends
> free-tier build minutes — defeating §2.5 and §8.3 simultaneously. Set the production branch
> to `netlify-prod-locked` (a branch that does not exist), or use **Site configuration → Build
> & deploy → Stop builds**, and verify with `netlify api getSite` that `build_settings.stop_builds`
> is `true` or `build_settings.repo_branch` is not `main`. A CI check asserts this on every
> deploy (§8.2, "Assert Netlify is not self-building").

### 2.2 `infra/netlify/netlify.toml` — committed, canonical

This file is the single source of truth for build config, the SPA fallback and every
**context-invariant** header. The `Content-Security-Policy` is _not_ here: its `connect-src`
must equal the API origin for the deploy context, so it is generated at build time into
`dist/_headers` (§2.3). No header name appears in both files — that rule is what prevents
Netlify's merge semantics from emitting two conflicting `Content-Security-Policy` headers.

```toml
# infra/netlify/netlify.toml  →  symlinked/copied to repo root as netlify.toml,
# or set "Configuration file path" to infra/netlify/netlify.toml in the site UI.

[build]
  # `base` is resolved from the repository root; `publish` and `command` are then
  # resolved RELATIVE TO `base`. Writing publish = "apps/web/dist" here would make
  # Netlify look for apps/web/apps/web/dist and fail the deploy with "directory
  # does not exist" — the single most common netlify.toml mistake in a monorepo.
  base    = "apps/web"
  command = "npm run build"
  publish = "dist"

[build.environment]
  NODE_VERSION  = "22"
  NPM_FLAGS     = "--workspaces --include-workspace-root"
  CI            = "true"
  NODE_ENV      = "production"

[build.processing]
  skip_processing = true

# ---------------------------------------------------------------------------
# Contexts. Production is built in CI and uploaded; these blocks govern
# Netlify-side builds (deploy previews and the staging branch deploy) only.
# ---------------------------------------------------------------------------
[context.production.environment]
  VITE_API_BASE_URL = "https://api-ess.widedrop.com"
  VITE_APP_ENV      = "production"

[context.branch-deploy.environment]
  VITE_API_BASE_URL = "https://api-ess-staging.widedrop.com"
  VITE_APP_ENV      = "staging"

[context.deploy-preview.environment]
  VITE_API_BASE_URL = "https://api-ess-staging.widedrop.com"
  VITE_APP_ENV      = "preview"

# ---------------------------------------------------------------------------
# ORDER IS SEMANTIC. Netlify evaluates redirect rules top to bottom and the
# FIRST match wins, so every specific rule must precede the catch-all. An
# earlier draft placed the /* fallback first, which made the /api/* rule below
# unreachable: /api/anything would have been answered with index.html and a
# 200, i.e. the SPA silently served in place of an API response.
#
# The SPA must never proxy the API. A Netlify rewrite to api-ess.widedrop.com
# would make the API same-ORIGIN, defeating the CORS allowlist and putting an
# uncontrolled CDN in front of authenticated responses. Explicitly refused:
# ---------------------------------------------------------------------------
[[redirects]]
  from   = "/api/*"
  to     = "/index.html"
  status = 404

# ---------------------------------------------------------------------------
# SPA history fallback. LAST rule, 200 (rewrite, not redirect) so deep links
# such as /payslips/<id> render the app instead of Netlify's 404 page.
# force = false, so a real file on disk always wins over the fallback.
# ---------------------------------------------------------------------------
[[redirects]]
  from   = "/*"
  to     = "/index.html"
  status = 200
  force  = false

# ---------------------------------------------------------------------------
# Security headers — everything EXCEPT Content-Security-Policy (see §2.3).
# ---------------------------------------------------------------------------
[[headers]]
  for = "/*"
  [headers.values]
    Strict-Transport-Security         = "max-age=63072000; includeSubDomains"
    X-Content-Type-Options            = "nosniff"
    X-Frame-Options                   = "DENY"
    Referrer-Policy                   = "strict-origin-when-cross-origin"
    Cross-Origin-Opener-Policy        = "same-origin"
    Cross-Origin-Embedder-Policy      = "require-corp"
    Cross-Origin-Resource-Policy      = "same-origin"
    X-Permitted-Cross-Domain-Policies = "none"
    X-DNS-Prefetch-Control            = "off"
    Origin-Agent-Cluster              = "?1"
    Permissions-Policy = "accelerometer=(), autoplay=(), camera=(), display-capture=(), encrypted-media=(), fullscreen=(self), geolocation=(), gyroscope=(), interest-cohort=(), magnetometer=(), microphone=(), midi=(), payment=(), publickey-credentials-get=(self), screen-wake-lock=(), usb=(), xr-spatial-tracking=()"

# index.html must never be cached: it is how a CSP or asset-hash change reaches clients.
[[headers]]
  for = "/index.html"
  [headers.values]
    Cache-Control = "no-store, must-revalidate"

[[headers]]
  for = "/"
  [headers.values]
    Cache-Control = "no-store, must-revalidate"

# Vite emits content-hashed filenames into /assets, so these are safe forever.
[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/fonts/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/config.json"
  [headers.values]
    Cache-Control = "no-store"
```

### 2.3 The generated CSP — `apps/web/scripts/gen-csp-headers.mjs`

Run as the last step of `npm run build -w @widedrop/web`; writes `apps/web/dist/_headers`.
Its only variable input is `VITE_API_BASE_URL`, so a preview build gets the staging API in
`connect-src` and production never widens.

```
# apps/web/dist/_headers  — GENERATED, do not edit, do not commit
# ${CSP_HEADER_NAME} is "Content-Security-Policy-Report-Only" when CSP_REPORT_ONLY=true
# (exactly one release, per SECURITY.md §6.3), otherwise "Content-Security-Policy".
/*
  ${CSP_HEADER_NAME}: default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; style-src-elem 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' ${VITE_API_BASE_URL}; manifest-src 'self'; worker-src 'self'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'; media-src 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types default; report-uri ${VITE_API_BASE_URL}/api/v1/csp-report; report-to csp
  Reporting-Endpoints: csp="${VITE_API_BASE_URL}/api/v1/csp-report"
```

`Reporting-Endpoints` is generated here, not in `netlify.toml`, for the same reason the CSP
is: its value contains `VITE_API_BASE_URL` and therefore varies by deploy context. It is the
header `report-to csp` resolves against; without it the `report-to` directive is inert
(R-14).

**The report endpoint is cross-origin, and that is fine.** A CSP report is sent by the
browser as an opaque `POST` that is not subject to `connect-src` and not preceded by a CORS
preflight, so no allowlist entry is needed and none is added. `POST /api/v1/csp-report` is
`public: true`, CSRF- and CORS-exempt (`SECURITY.md` §3.5 clause 7), accepts
`application/csp-report` and `application/reports+json` through a **route-scoped**
content-type parser, is capped at 8 KiB, rate-limited `ip` 60/min, sampled at 10 % into
structured logs, and **never writes an `audit_event`**.

> **Reconciliation R-19:** like the SES webhook (R-4), `POST /api/v1/csp-report` must appear
> in `API.md` §13 with a `public: true` guard block and an entry in the boot-time route
> assertion's public allowlist (`SECURITY.md` §4.8), or the "every route declares a
> permission" check fails at boot.

Build-time assertions in the same script, each failing the build:

1. `VITE_API_BASE_URL` is an absolute `https://` origin with no path and no `*`.
2. In the `production` context it equals exactly `https://api-ess.widedrop.com`, and
   `CSP_REPORT_ONLY` is `false` unless the release is explicitly the one report-only release
   (the flag is recorded in the deploy message so it cannot be left on by accident).
3. No `VITE_*` variable name matches `/KEY|SECRET|TOKEN|PASSWORD|PEPPER/i`.
4. `grep -c 'style="' dist/**/*.html` is `0`, and no emitted JS contains `.setAttribute('style'`
   or `.innerHTML =` — the no-inline-style guarantee that lets `style-src 'self'` stand
   (`SECURITY.md` §6.3). **This does not forbid React's `style` prop.** React assigns
   individual properties through CSSOM (`node.style.color = …`), which no CSP directive
   governs; `style-src-attr 'none'` blocks only the HTML `style` **attribute**. The
   prototype's inline style objects — which carry most of its visual language
   (`design/DESIGN-SYSTEM.md` §1–§3) — are therefore preserved unchanged. The assertion
   exists to catch server-rendered or string-built markup, not to force a refactor of the
   UI source of truth.
5. `apps/web/public/_headers` and `apps/web/public/_redirects` **do not exist** (they would be
   copied into `dist` and merged with the generated file). _Amend `SECURITY.md` §6.4, which
   mentions `apps/web/public/_headers`: that file is not used._
6. `dist/config.json` (if emitted) parses, contains only `apiBaseUrl`, `appEnv`, `buildSha`
   and `sentryDsn`, and contains **no** key matching `/KEY|SECRET|TOKEN|PASSWORD|PEPPER/i`.
   `netlify.toml` already marks it `no-store`; this asserts it is safe to serve at all.
7. Every font referenced by the emitted CSS resolves to a file under `dist/fonts/`; no
   `@import` or `<link>` points at an external host (`style-src 'self'`, `font-src 'self'`).
8. The **fabrication gate** and the **design-token gate** of §2.8 both pass.

### 2.4 Deploy previews

- Previews build on Netlify from the PR branch and are served at
  `deploy-preview-<n>--widedrop-ess.netlify.app`.
- They point at `api-ess-staging.widedrop.com`, which has its **own** origin allowlist, its
  own database and no production data. `*.netlify.app` is **never** added to the production
  API's `ALLOWED_ORIGINS` (`SECURITY.md` §6.5).
- **How a preview origin is allowed without a wildcard.** A deploy-preview host is
  `deploy-preview-<n>--widedrop-ess.netlify.app`, and `<n>` is unbounded, so an exact-string
  allowlist cannot enumerate them — while §7.4 refusal 7 rejects `*` outright. The
  resolution, and it is the only place in the system where a pattern is permitted: the
  staging API additionally reads `ALLOWED_ORIGIN_PATTERNS`, a comma-separated list of
  **anchored** regular expressions, and the boot check refuses the variable entirely when
  `NODE_ENV=production`. Staging sets exactly one:
  `^https://deploy-preview-\d{1,6}--widedrop-ess\.netlify\.app$`. It is anchored at both
  ends, the host label is fixed, and `\d{1,6}` cannot match a dot — so
  `https://deploy-preview-1--widedrop-ess.netlify.app.evil.test` does not match. A unit test
  asserts that and eight other near-miss strings. Production's `ALLOWED_ORIGIN_PATTERNS` is
  unset, and the boot check treats a set value as a fatal misconfiguration, not a warning.
- Because a preview origin is `*.netlify.app`, it is **cross-site** with the staging API, so
  the staging API sets `COOKIE_SAMESITE=none`. This is an accepted, staging-only relaxation;
  the boot check in §7.4 refuses `SameSite=None` when `NODE_ENV=production`.
- Previews are password-protected at the Netlify level if the team is on a plan that offers
  it; otherwise they carry no data worth protecting because staging holds only synthetic
  records seeded by `db:seed:demo`.

### 2.5 Production deploys consume zero Netlify build minutes

```bash
# inside GitHub Actions, after the SPA has already been built and verified
npx netlify-cli@17 deploy \
  --prod --no-build \
  --dir=apps/web/dist \
  --site="$NETLIFY_SITE_ID" \
  --auth="$NETLIFY_AUTH_TOKEN" \
  --message="ess-web ${GITHUB_SHA::7}"
```

The CLI reads `netlify.toml` **from the current working directory**, not from the site's
configured "Configuration file path" — that setting governs Netlify-side builds only. So the
deploy job must place the file where the CLI will find it, as its first step:

```bash
cp infra/netlify/netlify.toml ./netlify.toml     # committed source of truth → CLI cwd
node scripts/assert-netlify-config.mjs           # parses it; fails if publish != "dist",
                                                 # if /api/* is not before /*, or if any
                                                 # header name also appears in dist/_headers
```

With the file in place the redirects and headers apply to the uploaded deploy. The upload is
atomic and immutable and gets its own permalink — which is what makes the one-click rollback
in **§8.4** instant. (`dist/_headers` is merged by Netlify with `netlify.toml`'s headers;
the assertion above is what enforces the §2.2 rule that no header name may appear in both,
because a duplicate `Content-Security-Policy` is emitted twice and browsers then enforce the
**intersection** — usually breaking the app in a way that only shows up in production.)

### 2.6 What is NOT changed on `widedrop.com`

| Item                                                                                  | Change                                                               |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| The `widedrop.com` Netlify site, its build settings, its `netlify.toml`, its env vars | **none**                                                             |
| The apex `A` / `ALIAS` / `ANAME` record and the `www` `CNAME`                         | **none**                                                             |
| `MX`, existing `SPF`, existing `DKIM`, existing `DMARC` on `widedrop.com`             | **none** (all ESS mail DNS is in `widedroptech.com` — see R-2)       |
| `NS` and `SOA` of `widedrop.com`                                                      | **none**                                                             |
| The marketing team's Netlify members, tokens, or build-minute budget                  | **none**; ESS lives in a different team and builds in CI             |
| Marketing site TLS certificate                                                        | **none**; `ess` gets its own certificate on its own site             |
| Marketing site headers/CSP                                                            | **none**; Netlify headers are per-site, never inherited across sites |

**The one shared resource is the DNS zone.** Four records are added to it (two production,
two staging), all leaf `CNAME`s on previously unused labels. Adding a subdomain record
cannot affect apex resolution.

**HSTS does not leak upward.** `Strict-Transport-Security … includeSubDomains` is served on
`ess.widedrop.com`, and an HSTS policy applies to the **issuing host and its subdomains
only** — `*.ess.widedrop.com`, which is an empty set here. It cannot reach `widedrop.com`,
`www.widedrop.com` or any sibling label. This is why the header is safe to send from the ESS
site without the marketing owner's involvement, and it is also why **`preload` is deliberately
absent**: preloading is submitted per registrable domain and would pull the entire
`widedrop.com` zone — including the marketing site and any legacy `http://` host — into the
browser preload list irreversibly for months. Adding `preload` is a separate decision with
the marketing owner, not part of the ESS rollout.

### 2.7 DNS records to add

**Case A — `widedrop.com` DNS is at a registrar or Cloudflare (external DNS).**

| Name                      | Type    | Value                               | TTL | Note                                        |
| ------------------------- | ------- | ----------------------------------- | --- | ------------------------------------------- |
| `ess`                     | `CNAME` | `widedrop-ess.netlify.app.`         | 300 | Netlify then issues the cert automatically  |
| `api-ess`                 | `CNAME` | `ess-api.onrender.com.`             | 300 | Render's generated hostname for the service |
| `_acme-challenge.api-ess` | —       | —                                   | —   | not needed; Render uses HTTP-01             |
| `ess-staging`             | `CNAME` | `widedrop-ess-staging.netlify.app.` | 300 | staging only                                |
| `api-ess-staging`         | `CNAME` | `ess-api-staging.onrender.com.`     | 300 | staging only                                |

If the provider is Cloudflare, these records must be **DNS-only (grey cloud)**. Proxying
`api-ess` through Cloudflare would put a CDN in front of authenticated responses, which
`SECURITY.md` §6.6 forbids, and would replace the client IP that the rate limiter keys on.

**Case B — `widedrop.com` is delegated to Netlify DNS on the marketing team.**
The zone is edited in the marketing team's DNS panel, but _only by adding records_:

1. In the ESS team, add the custom domain `ess.widedrop.com` to the ESS site. Netlify will
   report that the domain's zone belongs to another team and offer a **TXT verification**.
2. In the marketing team's DNS panel add: the verification `TXT` on
   `netlify-challenge.ess` (removable afterwards), then `ess CNAME widedrop-ess.netlify.app`
   and `api-ess CNAME ess-api.onrender.com`.
3. Do not use Netlify's "add site domain" shortcut that rewrites the apex; add the records by
   hand. Do not move the zone.

**Verification after any DNS change** (run before announcing the portal):

```bash
dig +short widedrop.com A            # unchanged from the pre-change capture
dig +short www.widedrop.com CNAME    # unchanged
dig +short widedrop.com MX           # unchanged
dig +short ess.widedrop.com CNAME    # → widedrop-ess.netlify.app.
dig +short api-ess.widedrop.com      # → Render edge
curl -sI https://widedrop.com | head -1          # still 200
curl -sI https://ess.widedrop.com | grep -i strict-transport-security
curl -s https://api-ess.widedrop.com/api/v1/healthz   # {"status":"ok"}
```

Capture `dig` output for the whole zone **before** the change into
`infra/dns/widedrop.com.before.txt` and diff afterwards. The diff must contain only additions.

### 2.8 Build-time gates that enforce directives 1, 2 and 9

These are deployment controls, not style preferences: they are the only automated point at
which "no invented data" and "the prototype is the source of truth" stop being intentions.
All four run in `ci.yml` **and** again in `deploy.yml` before the upload, and each fails the
build.

| Gate                                | Script                                        | What it asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fabrication gate** (directive 2)  | `apps/web/scripts/assert-no-fixture-data.mjs` | The production bundle contains no sample dataset and no mocking layer. Concretely: no module under `apps/web/src/**` outside `**/__fixtures__/**` and `**/*.test.*` exports an array of operational-looking literals; the identifiers `PAYSLIPS`, `PROFILE`, `PEOPLE`, `ANN`, `BAL`, `EXP0`, `TK0`, `APR0`, `HIS0`, `LET0`, `DOCS`, `FORM16`, `TAXQ`, `BENEFITS`, `DEPENDENTS`, `HOL`, `LEAVES0`, `FAQ` and `POLICIES` do not appear in `dist/assets/*.js`; and `msw`, `@faker-js/faker`, `chance` and `casual` are not in the production dependency closure. The prototype's fixtures defined the layout and the copy tone; shipping one of them would put an invented rupee amount in front of an employee. |
| **Empty-state gate** (directive 9)  | `apps/web/scripts/empty-state.spec.ts`        | Every screen renders against a **zero-row** API: the suite mounts each of the thirteen routes of `design/DESIGN-SYSTEM.md` §6 (plus the HR and Accounts routes) with every collection endpoint answering `{"data":[],"meta":{"total":0}}` and every scalar answering `null`, and asserts for each screen that it renders without throwing, renders the designed empty block of §8 (dashed border, glyph, headline, explanation), shows `—` in `--text-muted` for every metric tile, and contains **no digit** outside a date, a label or a legitimate zero. A screen that renders a blank box, a spinner that never resolves, or a number is a failure.                                                       |
| **Design-token gate** (directive 1) | `apps/web/scripts/assert-design-tokens.mjs`   | Every hex colour, radius, sidebar width, breakpoint and font size emitted into `dist` is drawn from `design/DESIGN-SYSTEM.md`. The script parses that document's tables into the allowed set, scans the emitted CSS and JS for `#rrggbb` literals and for the six geometry constants (`248`, `72`, `880`, `820`, `66`, `40`), and fails on any value not in the set. It also asserts the nav group names and item order of §6 appear in the built navigation module in exactly that sequence.                                                                                                                                                                                                                 |
| **Netlify-config gate**             | `scripts/assert-netlify-config.mjs`           | `publish` is `dist`; the `/api/*` rule precedes `/*`; no header name appears in both `netlify.toml` and `dist/_headers`; `dist/_headers` exists and its CSP `connect-src` equals `VITE_API_BASE_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

The empty-state gate is the one that would otherwise be skipped, because an empty system is
not what a developer looks at day to day. It is a **required status check** (§8.3) precisely
for that reason, and §11.7 Q8 repeats it by hand each quarter against a real, freshly
migrated database — the automated version proves the components, the manual version proves
the whole deployed stack.

---

## 3. API hosting

### 3.1 Primary: Render, region `singapore`

Chosen over Fly.io as the primary because it gives, in one account and with no bespoke
operations work: Docker deploys from an immutable image digest, **background workers as a
first-class service type** (the outbox worker must be always-on, not a request-triggered
function), **private services** on a project-private network (PgBouncer and ClamAV are never
internet-reachable), managed PostgreSQL 16 with PITR on the same private network, zero-downtime
rolling deploys with health-gated cut-over, one-click rollback to a previous image, and
per-service environment groups.

Region `singapore` is the closest Render region to India (~50–70 ms RTT from Bengaluru/Mumbai).
It is the region pinned in `infra/` per `SECURITY.md` §14.7; changing it requires an ADR.
Under the DPDP Act 2023 there is no general localisation mandate — transfer is permitted except
to countries the Central Government restricts, and Singapore is not restricted — but the
residency trade-off is stated explicitly in `docs/PROCESSORS.md` and §3.7 gives the Mumbai
alternative if a customer contract later demands in-country storage.

### 3.2 `infra/render/render.yaml`

```yaml
# Render Blueprint for the Widedrop ESS production environment.
# Apply with: render blueprint launch  (or connect the repo in the Render dashboard).
# Secrets are NEVER in this file: every `sync: false` value is typed into the
# Render dashboard or the environment group once, and never read back by CI.

previewsEnabled: false # no Render preview environments; staging is explicit

databases:
  - name: ess-postgres
    databaseName: widedrop_ess
    user: ess_owner # the OWNER role; the app never uses it (§4.4)
    plan: standard # 4 GB RAM / 4 vCPU / 100 GB SSD, daily backup + PITR
    region: singapore
    postgresMajorVersion: '16'
    ipAllowList: [] # [] == private network only, NO public endpoint

envVarGroups:
  - name: ess-shared
    envVars:
      - key: NODE_ENV
        value: production
      - key: TZ
        value: UTC # R-16: containers are UTC; business dates resolve in organization.timezone
      - key: LOG_LEVEL
        value: info
      - key: HOST
        value: 0.0.0.0
      - key: PRIVATE_PORT
        value: '4001' # /readyz + /metrics listener; Render routes only PORT (§9.2)
      - key: API_PUBLIC_URL
        value: https://api-ess.widedrop.com
      - key: WEB_PUBLIC_URL
        value: https://ess.widedrop.com
      - key: ALLOWED_ORIGINS
        value: https://ess.widedrop.com
      - key: JWT_ISSUER
        value: https://api-ess.widedrop.com
      - key: JWT_AUDIENCE
        value: https://ess.widedrop.com
      - key: COOKIE_DOMAIN
        value: '' # MUST stay empty — __Host- forbids Domain (§1.4)
      - key: COOKIE_SAMESITE
        value: strict
      - key: COOKIE_SECURE
        value: 'true'
      - key: MFA_ISSUER_LABEL
        value: Widedrop ESS
      - key: HIBP_TIMEOUT_MS
        value: '2000'
      - key: PASSWORD_PEPPER_ACTIVE_VERSION
        value: '1'
      - key: AUDIT_CHAIN_ACTIVE_VERSION
        value: '1'
      - key: BLIND_INDEX_ACTIVE_VERSION
        value: '1'
      - key: DB_STATEMENT_TIMEOUT_MS
        value: '15000'
      - key: RATE_LIMIT_STORE
        value: postgres
      - key: STORAGE_DRIVER
        value: s3
      - key: STORAGE_ENDPOINT
        value: https://<r2-account-id>.r2.cloudflarestorage.com
      - key: STORAGE_REGION
        value: auto
      - key: STORAGE_BUCKET
        value: widedrop-ess-prod
      - key: STORAGE_FORCE_PATH_STYLE
        value: 'true'
      - key: SIGNED_URL_TTL_SECONDS
        value: '120'
      - key: MAIL_PROVIDER
        value: ses
      - key: MAIL_REGION
        value: ap-south-1
      - key: MAIL_FROM
        value: no-reply@widedroptech.com
      - key: HELPDESK_EMAIL_FALLBACK
        value: helpdesk@widedroptech.com
      - key: MAIL_CONFIGURATION_SET
        value: ess-prod
      - key: SES_SNS_TOPIC_ARN
        value: arn:aws:sns:ap-south-1:<aws-account-id>:ess-prod-events
      # sns.ap-south-1.amazonaws.com is NOT optional: §6.4 step 2 fetches the SNS
      # SigningCertURL to verify the webhook signature, and an egress allowlist that
      # omits it turns every bounce and complaint into a 403 the system reports as an
      # attack. Omitting it was a real defect in an earlier draft.
      - key: OUTBOUND_ALLOWLIST
        value: api.pwnedpasswords.com,email.ap-south-1.amazonaws.com,sns.ap-south-1.amazonaws.com,<r2-account-id>.r2.cloudflarestorage.com
      - key: HIBP_ENABLED
        value: 'true'
      - key: CLAMAV_HOST
        value: ess-clamav # Render private-service DNS name
      - key: CLAMAV_PORT
        value: '3310'
      # NOT a guess, and not left "confirm in the dashboard". The rate limiter, the
      # lockout counter and every ip_hash key on this system are derived from the
      # address this produces; a wrong value means an attacker supplies their own
      # rate-limit bucket by prepending X-Forwarded-For. Determine it ONCE at
      # bootstrap (§11.1 B5) by calling GET /api/v1/debug/forwarded (a staging-only
      # route) through the real edge and reading back the full chain, then pin the
      # observed proxy addresses here as exact CIDRs. Re-verify at each quarterly
      # review (§11.7 Q6) and after any platform migration. `true`, `0.0.0.0/0` and
      # a bare hop count are all refused at boot (§7.4 refusal 14).
      - key: TRUSTED_PROXY_CIDRS
        value: 10.0.0.0/8 # placeholder until B5 records the observed value
      - key: ACCESS_TOKEN_TTL_SECONDS
        value: '600'
      - key: REFRESH_TOKEN_TTL_DAYS
        value: '7'
      - key: REFRESH_FAMILY_MAX_DAYS
        value: '30'
      - key: JWT_ACTIVE_KID
        sync: false
      - key: JWT_SIGNING_KEY_wd-ess-202609-a1b2
        sync: false
      - key: JWT_PUBLIC_KEY_wd-ess-202609-a1b2
        sync: false
      - key: MASTER_KEK_ACTIVE_VERSION
        sync: false
      - key: MASTER_KEK_V1
        sync: false
      - key: PASSWORD_PEPPER_V1
        sync: false
      - key: BLIND_INDEX_KEY_V1
        sync: false
      - key: AUDIT_CHAIN_KEY_V1
        sync: false
      - key: CSRF_KEY
        sync: false
      - key: LOG_HASH_KEY
        sync: false
      - key: RECOVERY_CODE_KEY
        sync: false
      - key: CURSOR_HMAC_KEY
        sync: false
      - key: MAIL_ACCESS_KEY_ID
        sync: false
      - key: MAIL_SECRET_ACCESS_KEY
        sync: false
      - key: STORAGE_ACCESS_KEY_ID
        sync: false
      - key: STORAGE_SECRET_ACCESS_KEY
        sync: false
      - key: SENTRY_TRACES_SAMPLE_RATE
        value: '0.05'
      - key: METRICS_ENABLED
        value: 'true'
      - key: SENTRY_DSN
        sync: false
      - key: METRICS_BEARER_TOKEN
        sync: false
      - key: LOG_SINK_TOKEN
        sync: false

services:
  # ---------------------------------------------------------------- API ----
  - type: web
    name: ess-api
    runtime: image # deploy an immutable digest built in CI
    image:
      url: ghcr.io/widedrop/ess-api:REPLACED_BY_CI
      creds:
        fromRegistryCreds:
          name: ghcr-widedrop
    plan: standard # 1 vCPU / 2 GB
    region: singapore
    numInstances: 2 # two, so a rolling deploy is genuinely zero-downtime
    healthCheckPath: /api/v1/healthz
    autoDeploy: false # CI deploys explicitly; no deploy-on-push
    domains:
      - api-ess.widedrop.com
    envVars:
      - fromGroup: ess-shared
      - key: SERVICE_ROLE
        value: api
      - key: PORT
        value: '4000'
      # Both URLs are `sync: false` and typed into the dashboard in full, because
      # they embed the ess_app password. An earlier draft wrote a literal
      # `__FROM_SECRET__` placeholder into a synced `value:` — which would have been
      # committed to git verbatim AND pushed to the service as the real password,
      # failing the deploy in the best case and committing a credential shape in the
      # worst. There is no interpolation syntax in a Render blueprint; a value is
      # either literal or absent.
      #
      # DATABASE_URL  = postgresql://ess_app:<pw>@ess-pgbouncer:6432/widedrop_ess
      #                 ?pgbouncer=true&connection_limit=8&pool_timeout=10
      #                 &sslmode=disable&application_name=ess-api
      #   sslmode=disable is the ONE documented exception of §7.4 refusal 6, recognised
      #   by the ess-pgbouncer host; PgBouncer re-establishes TLS to Postgres itself.
      - key: DATABASE_URL # through PgBouncer, transaction pooling, role ess_app
        sync: false
      # DIRECT_DATABASE_URL = postgresql://ess_app:<pw>@<pg-host>:5432/widedrop_ess
      #                 ?sslmode=verify-full
      #                 &sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
      #                 &connection_limit=2&application_name=ess-api-direct
      #   NOT `fromDatabase.connectionString`: that property yields the OWNER
      #   (ess_owner) credentials, which §4.4 forbids the application from ever
      #   holding, and carries no sslmode, which §7.4 refusal 6 rejects at boot.
      - key: DIRECT_DATABASE_URL # straight to Postgres, session scope, role ess_app
        sync: false
      # APP_VERSION is baked into the image by the Dockerfile's GIT_SHA build arg.
      # `fromService … property: commitSha` is meaningless for a `runtime: image`
      # service (there is no connected repository to take a commit from) and would
      # clobber the correct value with an empty string, breaking GET /api/v1/version and the
      # `version` field on every log line.

  # -------------------------------------------------------------- WORKER ---
  - type: worker
    name: ess-worker
    runtime: image
    image:
      url: ghcr.io/widedrop/ess-api:REPLACED_BY_CI # THE SAME image as the API
      creds:
        fromRegistryCreds:
          name: ghcr-widedrop
    plan: starter # 0.5 vCPU / 512 MB
    region: singapore
    numInstances: 1 # exactly one; leases make >1 safe but it is not needed
    autoDeploy: false
    envVars:
      - fromGroup: ess-shared
      - key: SERVICE_ROLE
        value: worker
      - key: WORKER_POLL_INTERVAL_MS
        value: '15000'
      - key: WORKER_CONCURRENCY
        value: '4'
      - key: TZ
        value: UTC
      # The worker bypasses PgBouncer: pg_advisory_lock() is SESSION-scoped and does
      # not survive transaction pooling (§4.3). Both URLs are the SAME string and both
      # are `sync: false`, typed in full:
      #
      #   postgresql://ess_job:<pw>@<pg-host>:5432/widedrop_ess
      #     ?sslmode=verify-full
      #     &sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
      #     &connection_limit=5&application_name=ess-worker
      #
      # role ess_job, NOT ess_app (jobs act system-wide and need BYPASSRLS, §4.4) and
      # NOT `fromDatabase.connectionString` (that is ess_owner, forbidden at runtime,
      # and carries no sslmode so §7.4 refusal 6 would refuse to boot the worker —
      # the exact failure an earlier draft would have shipped).
      - key: DATABASE_URL
        sync: false
      - key: DIRECT_DATABASE_URL
        sync: false

  # ------------------------------------------------------------ PGBOUNCER ---
  # NOT the stock upstream image. `SERVER_TLS_CA_FILE` must point at a file that
  # exists INSIDE the pooler container, and `docker.io/edoburu/pgbouncer` does not
  # ship the provider CA — an earlier draft pointed it at a path that only exists in
  # the API image, so the pooler would have failed to start (or, worse, silently
  # fallen back to an unverified server connection). CI therefore builds a four-line
  # image, `infra/pgbouncer/Dockerfile`, from the upstream one plus:
  #   COPY infra/certs/render-postgres-ca.pem /etc/pgbouncer/render-postgres-ca.pem
  # and pushes it to ghcr.io/widedrop/ess-pgbouncer:<sha> alongside the API image.
  - type: pserv # private service: no public URL, ever
    name: ess-pgbouncer
    runtime: image
    image:
      url: ghcr.io/widedrop/ess-pgbouncer:REPLACED_BY_CI
      creds:
        fromRegistryCreds:
          name: ghcr-widedrop
    plan: starter
    region: singapore
    numInstances: 1
    envVars:
      - key: DB_HOST
        fromDatabase: { name: ess-postgres, property: host }
      - key: DB_PORT
        fromDatabase: { name: ess-postgres, property: port }
      - key: DB_NAME
        value: widedrop_ess
      - key: POOL_MODE
        value: transaction
      - key: MAX_CLIENT_CONN
        value: '400'
      # DEFAULT_POOL_SIZE is per (user, database) PAIR, not per pooler. Two runtime
      # roles could therefore reach 2 × 25 server connections; only ess_app connects
      # through the pooler (§4.2), so the real figure is 25. MAX_DB_CONNECTIONS caps
      # it regardless of how many roles appear later.
      - key: DEFAULT_POOL_SIZE
        value: '25'
      - key: MAX_DB_CONNECTIONS
        value: '40'
      - key: RESERVE_POOL_SIZE
        value: '5'
      - key: SERVER_TLS_SSLMODE
        value: verify-full
      - key: SERVER_TLS_CA_FILE
        value: /etc/pgbouncer/render-postgres-ca.pem
      # Client-side auth. AUTH_TYPE alone is not enough: pgbouncer needs the userlist
      # it authenticates clients against. AUTH_USER + AUTH_QUERY makes it look the
      # hash up in Postgres itself, which avoids a second copy of the credential in a
      # file — ess_auth is a dedicated NOLOGIN-adjacent role holding EXECUTE on one
      # SECURITY DEFINER function that returns (usename, passwd) for ess_app only
      # (§4.4). AUTH_TYPE=scram-sha-256 then verifies the client against that hash.
      - key: AUTH_TYPE
        value: scram-sha-256
      - key: AUTH_USER
        value: ess_auth
      - key: AUTH_QUERY
        value: SELECT usename, passwd FROM ess_ops.pgbouncer_get_auth($1)
      - key: AUTH_DBNAME
        value: widedrop_ess
      - key: DATABASE_URL # the ess_auth credential the AUTH_QUERY runs as
        sync: false
      # Client→pooler TLS. The hop never leaves Render's private network, so plaintext
      # here is the documented exception of §4.2/§7.4 refusal 6. Set CLIENT_TLS_SSLMODE
      # to `require` (and the API URL to sslmode=require) if the team prefers no
      # plaintext anywhere; the cost is a small CPU increase on a starter instance.
      - key: CLIENT_TLS_SSLMODE
        value: disable
      - key: IGNORE_STARTUP_PARAMETERS
        value: extra_float_digits,options,search_path
      - key: SERVER_RESET_QUERY
        value: DISCARD ALL # DATA-MODEL.md §1.8.2 depends on this
      - key: QUERY_WAIT_TIMEOUT
        value: '15' # fail fast rather than queue behind an exhausted pool

  # --------------------------------------------------------------- CLAMAV ---
  - type: pserv
    name: ess-clamav
    runtime: image
    image:
      url: docker.io/clamav/clamav:stable
    plan: standard # 2 GB — the signature database needs it
    region: singapore
    numInstances: 1
    # Without a persistent disk the ~1.3 GB signature database is re-downloaded on
    # every restart and deploy: several minutes during which CLAMAV_HOST answers but
    # every upload lands QUARANTINED (§7.1, R-10). The disk makes a restart a restart.
    disk:
      name: clamav-db
      mountPath: /var/lib/clamav
      sizeGB: 5
    envVars:
      - key: CLAMAV_NO_MILTERD
        value: 'true'
      - key: FRESHCLAM_CHECKS
        value: '4'

  # ---------------------------------------------------------- BACKUP CRON ---
  # The weekly off-provider dump of §4.5. It is one of exactly TWO platform-cron
  # jobs in the system (the other is the quarterly restore drill, §11.5); everything
  # else is scheduled inside the worker (§3.5). It is a platform cron because it must
  # keep running when the application cannot, and because it must not share the
  # worker's credentials.
  - type: cron
    name: ess-backup-weekly
    runtime: image
    image:
      url: ghcr.io/widedrop/ess-backup:REPLACED_BY_CI # pg_dump 16 + age + awscli
      creds:
        fromRegistryCreds:
          name: ghcr-widedrop
    plan: starter
    region: singapore
    schedule: '17 19 * * 0' # Sunday 19:17 UTC = Monday 00:47 IST, outside every window
    envVars:
      - key: TZ
        value: UTC
      - key: BACKUP_DATABASE_URL # role ess_backup, read-only, sslmode=verify-full
        sync: false
      - key: BACKUP_AGE_RECIPIENT # an age PUBLIC key — not a secret, but env-supplied
        sync: false
      - key: BACKUP_BUCKET
        value: widedrop-ess-backup
      - key: BACKUP_ENDPOINT
        value: https://<backup-r2-account-id>.r2.cloudflarestorage.com
      - key: BACKUP_ACCESS_KEY_ID # SECOND cloud account; cannot read the prod bucket
        sync: false
      - key: BACKUP_SECRET_ACCESS_KEY
        sync: false
```

### 3.3 `apps/api/Dockerfile` — production

```dockerfile
# syntax=docker/dockerfile:1.7
# ---------------------------------------------------------------------------
# Stage 1 — deps: install the FULL dependency tree once, cached on lockfile.
# --ignore-scripts per SECURITY.md §10.5; the few packages that need a
# lifecycle script are rebuilt explicitly and reviewably below.
# ---------------------------------------------------------------------------
FROM node:22.11-bookworm-slim AS deps
WORKDIR /repo
ENV NPM_CONFIG_FUND=false NPM_CONFIG_AUDIT=false
COPY package.json package-lock.json ./
COPY packages/shared/package.json  packages/shared/
COPY apps/api/package.json         apps/api/
COPY apps/web/package.json         apps/web/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts --workspace @widedrop/api --workspace @widedrop/shared \
           --include-workspace-root
RUN npm rebuild @node-rs/argon2 sharp

# ---------------------------------------------------------------------------
# Stage 2 — build: compile shared + api, generate the Prisma client, then
# prune dev dependencies so only runtime deps are copied forward.
# ---------------------------------------------------------------------------
FROM node:22.11-bookworm-slim AS build
WORKDIR /repo
ENV NODE_ENV=development
COPY --from=deps /repo/node_modules ./node_modules
COPY --from=deps /repo/apps/api/node_modules ./apps/api/node_modules
COPY . .
RUN npm run build -w @widedrop/shared \
 && npm run db:generate -w @widedrop/api \
 && npm run build -w @widedrop/api
RUN npm prune --omit=dev --workspace @widedrop/api --workspace @widedrop/shared \
               --include-workspace-root

# ---------------------------------------------------------------------------
# Stage 3 — runtime. bookworm-slim rather than distroless because the Prisma
# query engine links OpenSSL 3 and because tini + a shell make the container
# debuggable under incident conditions. No compilers, no npm, no source, no
# dev dependencies, no .env, non-root. The filesystem is treated as read-only
# by the application (nothing is written outside /tmp); where the platform
# supports it, run the container with `--read-only --tmpfs /tmp:size=64m`.
# ---------------------------------------------------------------------------
FROM node:22.11-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=1536 --disable-proto=delete" \
    PORT=4000 \
    SERVICE_ROLE=api
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates openssl \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 ess \
 && useradd  --system --uid 10001 --gid ess --home /app --shell /usr/sbin/nologin ess
WORKDIR /app

# Provider CA bundle, so DATABASE_URL can use sslmode=verify-full (SECURITY.md §6.1).
COPY --chown=root:root infra/certs/render-postgres-ca.pem /etc/ssl/certs/render-postgres-ca.pem

COPY --from=build --chown=root:root /repo/node_modules              ./node_modules
COPY --from=build --chown=root:root /repo/packages/shared/dist      ./packages/shared/dist
COPY --from=build --chown=root:root /repo/packages/shared/package.json ./packages/shared/package.json
COPY --from=build --chown=root:root /repo/apps/api/dist             ./apps/api/dist
COPY --from=build --chown=root:root /repo/apps/api/node_modules     ./apps/api/node_modules
COPY --from=build --chown=root:root /repo/apps/api/package.json     ./apps/api/package.json
COPY --from=build --chown=root:root /repo/apps/api/prisma           ./apps/api/prisma

ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV APP_VERSION=${GIT_SHA} BUILT_AT=${BUILT_AT}
LABEL org.opencontainers.image.source="https://github.com/widedrop/widedrop-ess" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.licenses="UNLICENSED"

USER 10001:10001
EXPOSE 4000

# Liveness only, touching no dependency (API.md §13.x) — a Postgres blip must
# not restart-loop the API.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node","-e","fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# tini is PID 1: it reaps zombies and forwards SIGTERM/SIGINT to node.
ENTRYPOINT ["/usr/bin/tini","-g","--"]
CMD ["node","apps/api/dist/entrypoint.js"]
```

**`.dockerignore` is mandatory and is part of this specification.** Stage 2 runs `COPY . .`.
Without a `.dockerignore` that copy pulls the build context wholesale into an image layer —
including `.env` and `.env.local` if a developer ever builds locally, `.git` (every secret
ever committed and force-pushed, per §7.6), `node_modules` (defeating the deps-stage cache),
`.storage`, `.mail` and the whole `design/` and `docs/` tree. Stage 3 copies selectively, so
none of it reaches the runtime image — but a build layer is still pushed to GHCR, and
`docker history` reads it. The committed file at repository root:

```gitignore
.git
.github
node_modules
**/node_modules
**/dist
.env
.env.*
!.env.example
*.pem
*.key
secrets/
.storage
.mail
docs
design
infra/dns
coverage
*.log
```

A CI step asserts the file exists and that `docker build --no-cache` produces a context
under 5 MiB; a context that suddenly grows is almost always a `.dockerignore` regression.

`apps/api/dist/entrypoint.js` branches on `SERVICE_ROLE`, so one image serves both services:

```
SERVICE_ROLE=api     → import('./server.js')
SERVICE_ROLE=worker  → import('./worker.js')
anything else        → log the offending value, exit 1
```

**Signal handling contract** (implement in both `server.ts` and `worker.ts`):

| Step                  | API                                                                                          | Worker                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. `SIGTERM` received | set `readyz` to `503` immediately, so the platform drains it from the load balancer          | stop claiming new jobs and new outbox rows                                                                                |
| 2. drain              | stop accepting new connections; let in-flight requests finish, **cap 25 s**                  | finish the in-flight job/batch, **cap 25 s**; a job that will not finish releases its lease so another worker reclaims it |
| 3. close              | `await prisma.$disconnect()`, flush pino, flush Sentry (2 s), close the storage client       | same                                                                                                                      |
| 4. exit               | `process.exit(0)`                                                                            | `process.exit(0)`                                                                                                         |
| Hard stop             | a 30 s watchdog calls `process.exit(1)` so a stuck handle cannot block the deploy            | same                                                                                                                      |
| Never                 | no `process.on('uncaughtException')` that swallows and continues — log, flush, exit non-zero | same                                                                                                                      |

Render sends `SIGTERM` then `SIGKILL` after 30 s; the caps above sit inside that window.

### 3.4 Resource sizing and concurrency

| Service         | Plan                           | Why that size                                                                                                                                                                                                                                                                                          | Scale trigger                                                                                         |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `ess-api`       | 2 × Standard (1 vCPU, 2 GB)    | Node is single-threaded per instance; Argon2id at m=64 MiB, t=3 costs ~90 ms and ~64 MB _per concurrent login_, which is the real memory driver. 2 GB leaves headroom for 8 concurrent hashes plus the Prisma client. Two instances make rolling deploys zero-downtime and survive one instance dying. | p95 latency > 800 ms for 10 min, or CPU > 70 % for 15 min → 3 instances                               |
| `ess-worker`    | 1 × Starter (0.5 vCPU, 512 MB) | The workload is IO-bound (outbox sends, SQL scans). The one CPU-heavy job, payroll calculation, is bounded by `WORKER_CONCURRENCY=4` and runs monthly.                                                                                                                                                 | `outbox_pending` > 50 for 15 min, or a payroll run exceeding 10 min → Standard for the payroll window |
| `ess-pgbouncer` | 1 × Starter                    | pgbouncer is a single-process event loop; 400 client connections fit comfortably in 512 MB                                                                                                                                                                                                             | client-connection saturation                                                                          |
| `ess-clamav`    | 1 × Standard (2 GB)            | `clamd` memory-maps the full signature database (~1.3 GB resident after `freshclam`). Starter would OOM.                                                                                                                                                                                               | never; uploads are rare                                                                               |
| `ess-postgres`  | Standard (4 GB, 100 GB)        | ~120 employees × 8 years of payslips, audit chain and attendance is well under 20 GB; the plan is chosen for the **PITR window and backup retention**, not for size                                                                                                                                    | disk > 70 % or cache-hit ratio < 0.98                                                                 |

**Concurrency knobs (all explicit, none defaulted):** Fastify `bodyLimit: 1 MiB` (multipart
routes are excepted and capped per `SECURITY.md` §5.3); `server.keepAliveTimeout = 65_000`
and `headersTimeout = 66_000` (both above the platform's 60 s idle timeout, so the platform
closes the connection, not Node — this avoids the classic 502-on-keepalive race);
`requestTimeout = 30_000`; Prisma `connection_limit=8` per API instance (2 instances × 8 = 16
client connections into PgBouncer's pool of 25 server connections, which is 25 of the
Standard plan's 200 `max_connections` — deliberately far under); `@fastify/under-pressure`
with `maxEventLoopDelay: 1000`, `maxHeapUsedBytes: 1.6 GB`, returning `503` with
`Retry-After` when tripped, and **exempting `/healthz`** so a load spike does not look like
a dead container.

**Autoscaling.** Left **off** at this size, on purpose: the workload is a predictable
business-hours curve with a monthly payroll spike, and a fixed two-instance floor is cheaper
and more predictable than reactive scaling. The payroll spike is handled by the scheduled
uplift in the §11.2 runbook. If autoscaling is later enabled, the constraints are: minimum 2,
maximum 4 (4 × 8 = 32 pooled connections, still safe), target CPU 65 %, and the **worker
stays at exactly 1 instance** unless the lease semantics in `ess_ops.background_job` have
been load-tested with concurrent claimants.

### 3.5 Scheduling lives in the worker, not in the platform

Every job in the named-job list of `DATA-MODEL.md` §17.5 — including `email-dispatch`, and
including the `worker-heartbeat` job that R-17 adds to that list — is scheduled _inside_ the
worker process from a single table-driven timer, each claiming an `ess_ops.background_job`
row by lease (`lease_owner`, `lease_expires_at`). Rationale: it is host-portable (moving to
Fly.io changes nothing), it is testable in CI with no platform involved, a missed tick is
visible as a `PENDING` row rather than vanishing, and the lease makes a duplicate run
impossible even if a second worker is accidentally started. Platform cron (`type: cron` on Render) is used for exactly **two** things, and both are
things that must keep working when the application does not:

| Platform cron       | Why it cannot live in the worker                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ess-backup-weekly` | The off-provider dump (§4.5) is the control that survives "the application, the worker, or the Render account is broken". A backup scheduled by the process it backs up is not a backup. It also runs as `ess_backup`, a role the worker must not hold. |
| Restore-drill kick  | §11.5's quarterly drill must be initiated outside the system under test.                                                                                                                                                                                |

Nothing else. Adding a third is a design change, not a configuration change, because every
platform-cron job is invisible to `ess_ops.background_job` and therefore to the "a missed
tick is a `PENDING` row" guarantee.

### 3.6 Deploy mechanics on Render

1. CI builds and pushes `ghcr.io/widedrop/ess-api:<sha>` and resolves it to a digest.
2. CI runs migrations (§4.6) against `DIRECT_DATABASE_URL` as `ess_migrator`.
3. CI calls `POST https://api.render.com/v1/services/<id>/deploys` with
   `{"imageUrl":"ghcr.io/widedrop/ess-api@sha256:<digest>"}` for `ess-api`, then for
   `ess-worker`, and polls until both report `live`.
4. Render starts new instances, waits for `/api/v1/healthz` to pass, shifts traffic, then
   `SIGTERM`s the old ones. `autoDeploy: false` guarantees no deploy ever happens from a
   push alone.
5. The worker is deployed **after** the API, so a schema-dependent job never runs against an
   older API's expectations.

### 3.7 Stated alternative: Fly.io

Use if Render is unavailable, if the organisation later requires in-country hosting (Fly has
`bom`, Mumbai), or if egress costs change the calculus.

```toml
# infra/fly/fly.toml
app            = "widedrop-ess-api"
primary_region = "bom"
kill_signal    = "SIGTERM"
kill_timeout   = "30s"

[build]
  image = "ghcr.io/widedrop/ess-api:REPLACED_BY_CI"

[deploy]
  strategy = "rolling"
  # Migrations run in CI, not here: a release_command failure is harder to
  # observe and cannot be gated behind an environment approval.

[env]
  NODE_ENV     = "production"
  SERVICE_ROLE = "api"
  PORT         = "4000"

[http_service]
  internal_port        = 4000
  force_https          = true
  auto_stop_machines   = false     # never scale to zero: cold starts break refresh
  auto_start_machines  = true
  min_machines_running = 2
  [http_service.concurrency]
    type       = "requests"
    soft_limit = 120
    hard_limit = 200

[[http_service.checks]]
  grace_period = "20s"
  interval     = "15s"
  method       = "GET"
  path         = "/api/v1/healthz"
  timeout      = "5s"

[[vm]]
  size       = "shared-cpu-2x"
  memory     = "2gb"
  processes  = ["app"]

[processes]
  app    = "node apps/api/dist/entrypoint.js"
  worker = "node apps/api/dist/entrypoint.js"   # with SERVICE_ROLE=worker in its secrets
```

Differences to account for: Fly has no managed Postgres of Render's maturity, so the database
moves to **Neon** or **Crunchy Bridge** in `ap-south-1` (both expose a built-in transaction
pooler, which then **replaces the PgBouncer private service** — delete it and point
`DATABASE_URL` at the provider's pooled endpoint, keeping `DIRECT_DATABASE_URL` on the direct
endpoint); private services become Fly apps with `flycast` internal addresses; secrets move to
`fly secrets set`; and `fly.io` rollback is `fly releases` + `fly deploy --image <previous digest>`.

---

## 4. Database

### 4.1 Choice

**Render Managed PostgreSQL 16, plan `standard`, region `singapore`, `ipAllowList: []`.**

| Requirement                                   | How this satisfies it                                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| System of record for persistent business data | Managed Postgres with WAL archiving, not an ephemeral or serverless store                                                                                                                         |
| Version                                       | Postgres **16** — `DATA-MODEL.md` depends on generated columns, `btree_gist` exclusion constraints (`ex_leave_request__no_self_overlap`), `FOR UPDATE SKIP LOCKED`, advisory locks and `pgcrypto` |
| Not internet-reachable                        | `ipAllowList: []` removes the public endpoint entirely; only services in the same Render project resolve `ess-postgres`                                                                           |
| Encrypted at rest                             | provider-managed AES-256 volume + encrypted backups (`SECURITY.md` §7.1 layer 1)                                                                                                                  |
| Same region as the API                        | sub-millisecond private-network RTT; no cross-region egress                                                                                                                                       |

Extensions to enable in the first migration: `pgcrypto` (CSPRNG, digest), `btree_gist`
(the leave-overlap exclusion constraint), `pg_stat_statements` (query-level observability).
`uuid-ossp` is **not** used — UUIDv7 is generated in application code because the row id is
part of the encryption AAD (`SECURITY.md` §7.2).

### 4.2 Connection URLs — there are two, and the distinction is load-bearing

**The role matters as much as the host.** An earlier draft gave every URL to `ess_app`; the
worker needs `BYPASSRLS` (it acts system-wide with no actor context, `DATA-MODEL.md` §1.8.1)
and therefore connects as `ess_job`, while the API must never hold a `BYPASSRLS` credential.

| Variable                    | Role           | Points at            | Used by                                                                              | Pool mode   |
| --------------------------- | -------------- | -------------------- | ------------------------------------------------------------------------------------ | ----------- |
| `DATABASE_URL` (api)        | `ess_app`      | `ess-pgbouncer:6432` | the **API**                                                                          | transaction |
| `DIRECT_DATABASE_URL` (api) | `ess_app`      | `<pg-host>:5432`     | the API's boot-time privilege and schema-guard assertions only                       | session     |
| `DATABASE_URL` (worker)     | `ess_job`      | `<pg-host>:5432`     | the **worker** — identical string to its `DIRECT_DATABASE_URL`                       | session     |
| `MIGRATE_DATABASE_URL`      | `ess_migrator` | `<pg-host>:5432`     | `prisma migrate`, `prisma db execute`, the schema guard — **the migration job only** | session     |
| `BACKUP_DATABASE_URL`       | `ess_backup`   | `<pg-host>:5432`     | `pg_dump` in `ess-backup-weekly` (§4.5) — read-only                                  | session     |
| _(bootstrap / psql)_        | `ess_owner`    | `<pg-host>:5432`     | break-glass only, from a Render one-off job, never from an env var (§11.1 B3)        | session     |

```
# API
DATABASE_URL=postgresql://ess_app:<pw>@ess-pgbouncer:6432/widedrop_ess
              ?pgbouncer=true&connection_limit=8&pool_timeout=10
              &application_name=ess-api&sslmode=disable
DIRECT_DATABASE_URL=postgresql://ess_app:<pw>@<host>:5432/widedrop_ess
              ?sslmode=verify-full&sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
              &connection_limit=2&application_name=ess-api-direct

# WORKER — ess_job, and both variables carry the SAME string
DATABASE_URL=postgresql://ess_job:<pw>@<host>:5432/widedrop_ess
              ?sslmode=verify-full&sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
              &connection_limit=5&application_name=ess-worker
DIRECT_DATABASE_URL=<identical to the line above>

# MIGRATION JOB (exists only for the duration of that job)
MIGRATE_DATABASE_URL=postgresql://ess_migrator:<pw>@<host>:5432/widedrop_ess
              ?sslmode=verify-full&sslrootcert=/etc/ssl/certs/render-postgres-ca.pem

# BACKUP CRON
BACKUP_DATABASE_URL=postgresql://ess_backup:<pw>@<host>:5432/widedrop_ess
              ?sslmode=verify-full&sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
              &application_name=ess-backup
```

Every one of these is typed into the platform in full as a `sync: false` value. **None is
derived from Render's `fromDatabase … property: connectionString`**, which yields the
database owner's credentials and carries no `sslmode` — so using it would both hand the
application an owner credential (forbidden by §4.4) and trip §7.4 refusal 6 at boot.

`sslmode=disable` on the first URL is **only** the API→PgBouncer hop, which never leaves the
private network; PgBouncer itself connects to Postgres with `SERVER_TLS_SSLMODE=verify-full`,
so no plaintext Postgres traffic exists outside that one private hop. If the team prefers no
plaintext anywhere, enable `CLIENT_TLS_SSLMODE=require` on PgBouncer and change the API URL
to `sslmode=require`; the trade is a small CPU cost on the pooler.

In `schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_DATABASE_URL")   // migrations + introspection
}
```

### 4.3 Why pooling matters here, and what breaks without care

A container host restarts and rescales instances freely, and **every Node instance opens its
own Prisma pool**. Without a pooler, `instances × connection_limit` is the connection count,
and Prisma's default `connection_limit` is `num_cpus × 2 + 1` — so a scale-up to 4 instances
on a 4-vCPU plan would silently demand 36 connections, and a deploy briefly doubles that
while old and new instances overlap. Postgres reserves memory per backend, so exhausting
`max_connections` does not degrade gracefully: it returns `FATAL: sorry, too many clients`
and every request fails at once.

PgBouncer in **transaction** mode decouples the two: 400 client connections multiplex onto 25
server connections, and a deploy overlap costs nothing. Consequences that must be respected:

1. **Prepared statements are disabled** by `pgbouncer=true`. This is correct and required —
   without it Prisma will emit `prepared statement "s0" already exists` under load.
2. **`SET LOCAL` still works**, because it is transaction-scoped. This is what makes the RLS
   context in `DATA-MODEL.md` §1.8 safe under transaction pooling. **Plain `SET` must never
   be used** — it would leak one request's identity into another request that happens to
   reuse the server connection. Add an ESLint/CI grep that fails on `$executeRaw` containing
   `SET ` not preceded by `LOCAL`.

   **And the statement must be `set_config`, not `SET LOCAL`.** `DATA-MODEL.md` §1.8.2 writes
   the context as `SET LOCAL ess.actor_user_id = $2`. PostgreSQL's `SET` is a utility
   statement: it **cannot take a bind parameter**, so that line is not implementable as
   written, and the only way to make it run is to interpolate the value into the SQL string —
   which puts an attacker-influenced identity straight into a statement that governs every
   RLS policy in the system. It is the highest-value injection point in the design, and it
   would be introduced by following the schema document literally. The mandated form, which
   is transaction-scoped in exactly the same way and **is** parameterisable:

   ```ts
   await tx.$executeRaw`
     SELECT set_config('ess.organization_id',   ${orgId},      true),
            set_config('ess.actor_user_id',     ${userId},     true),
            set_config('ess.actor_employee_id', ${employeeId}, true),
            set_config('ess.actor_persona',     ${persona},    true),
            set_config('ess.scopes',            ${scopeCsv},   true);
   `;
   ```

   The third argument `true` is `is_local` and is what makes it die with the transaction. A
   Semgrep rule in `.semgrep/widedrop.yml` fails the build on any `SET LOCAL ess.` appearing
   in a raw query, and on any `$executeRawUnsafe` anywhere in `apps/api/src/**`. Amend
   `DATA-MODEL.md` §1.8.2 to show the `set_config` form (**R-20**).

3. **Session-scoped advisory locks do not survive transaction pooling.** `WORKFLOWS.md` §1.7
   has the payroll calculation worker hold `pg_advisory_lock(hashtext('payroll:'||cycle_id))`
   for the whole run — a _session_ lock. Through a transaction pooler the lock would be taken
   on an arbitrary server connection and released to another client mid-run. **Therefore the
   worker connects on `DIRECT_DATABASE_URL`.** The transaction-scoped
   `pg_advisory_xact_lock` used by the audit-chain trigger is fine either way.
4. `LISTEN`/`NOTIFY` and cursors held across transactions are unavailable through the pooler;
   nothing in the design uses them (the job queue is polled with leases, by design).
5. `IGNORE_STARTUP_PARAMETERS` must include `extra_float_digits` and `options`, or the Prisma
   client fails to connect.

**Server-side timeouts**, set on the runtime role so a runaway query cannot hold a pooled
connection hostage:

```sql
ALTER ROLE ess_app  SET statement_timeout = '15s';
ALTER ROLE ess_app  SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE ess_app  SET lock_timeout = '5s';
ALTER ROLE ess_job  SET statement_timeout = '15min';   -- payroll and re-encryption batches
ALTER ROLE ess_job  SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE ess_migrator SET statement_timeout = '30min';
ALTER ROLE ess_migrator SET lock_timeout = '10s';       -- fail fast rather than queue behind DDL
```

### 4.4 Least-privilege roles

**Five roles**, matching `DATA-MODEL.md` §1.8.1 exactly (R-13), created by the first
migration and never merged. **The application never connects as the owner, and the API never
holds a `BYPASSRLS` credential.**

| Role           | `LOGIN`                        | `BYPASSRLS` | Owns objects                         | Privileges                                                                                                                                                                                             | Used by                                               |
| -------------- | ------------------------------ | ----------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `ess_owner`    | **yes, on Render only** (R-13) | no          | **yes** — all schemas, tables, types | full, but every table is `FORCE ROW LEVEL SECURITY` so even the owner is subject to policy                                                                                                             | nobody at runtime; credentials sealed offline (§11.6) |
| `ess_migrator` | yes                            | **yes**     | no — objects are reassigned (below)  | `CREATE` on `ess`, `ess_ops`; `ALTER`/`DROP` via membership of `ess_owner`                                                                                                                             | the CI/Render migration job **only**                  |
| `ess_app`      | yes                            | **no**      | no                                   | `SELECT, INSERT, UPDATE, DELETE` on `ess.*` and `ess_ops.*` **minus** the exclusions below; `USAGE` on schemas and sequences; **no** `BYPASSRLS`, **no** `CREATE`, **no** `TRUNCATE`, **no** superuser | the API                                               |
| `ess_job`      | yes                            | **yes**     | no                                   | as `ess_app`, plus `BYPASSRLS` (jobs act system-wide and have no actor context)                                                                                                                        | the worker                                            |
| `ess_readonly` | yes                            | no          | no                                   | `SELECT` only, and on nothing in data class M1/M5 (`DATA-MODEL.md` §1.6)                                                                                                                               | the analytics replica; **never** the API or worker    |
| `ess_backup`   | yes                            | **yes**     | no                                   | `SELECT` on everything (a dump must be complete); no DML, no DDL, no `CONNECT` from anywhere but the backup cron                                                                                       | `ess-backup-weekly` (§4.5) **only**                   |
| `ess_auth`     | yes                            | no          | no                                   | `EXECUTE` on one `SECURITY DEFINER` function returning `(usename, passwd)` for `ess_app` alone                                                                                                         | PgBouncer's `AUTH_QUERY` (§3.2) **only**              |

```sql
-- Identity. NOINHERIT everywhere: a role must never pick up privileges implicitly.
CREATE ROLE ess_migrator LOGIN PASSWORD :'migrator_pw' BYPASSRLS   NOINHERIT;
CREATE ROLE ess_app      LOGIN PASSWORD :'app_pw'      NOBYPASSRLS NOINHERIT;
CREATE ROLE ess_job      LOGIN PASSWORD :'job_pw'      BYPASSRLS   NOINHERIT;
CREATE ROLE ess_readonly LOGIN PASSWORD :'ro_pw'       NOBYPASSRLS NOINHERIT;
CREATE ROLE ess_backup   LOGIN PASSWORD :'backup_pw'   BYPASSRLS   NOINHERIT;
CREATE ROLE ess_auth     LOGIN PASSWORD :'auth_pw'     NOBYPASSRLS NOINHERIT;

-- Ownership. ess_migrator CREATEs the objects, so without this it would OWN them —
-- contradicting "ess_owner owns all schemas, tables and types" and making the owner
-- row in the table above false. Membership + REASSIGN is what keeps it true.
GRANT ess_owner TO ess_migrator;                 -- NOINHERIT: it must SET ROLE explicitly
ALTER ROLE ess_migrator SET role = ess_owner;    -- every migration session runs as owner

REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE widedrop_ess FROM PUBLIC;
GRANT CONNECT ON DATABASE widedrop_ess
  TO ess_app, ess_job, ess_migrator, ess_readonly, ess_backup, ess_auth;
GRANT USAGE ON SCHEMA ess, ess_ops TO ess_app, ess_job, ess_readonly;

-- Baseline DML
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA ess, ess_ops TO ess_app, ess_job;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA ess, ess_ops TO ess_app, ess_job;
GRANT SELECT                         ON ALL TABLES    IN SCHEMA ess, ess_ops TO ess_backup;

-- The audit trail is append-only for everyone but the owner (DATA-MODEL.md §17.4)
REVOKE UPDATE, DELETE, TRUNCATE ON ess.audit_event FROM ess_app, ess_job;

-- No hard deletes on the tables whose lifecycle is a status column (DATA-MODEL.md §18.2)
REVOKE DELETE ON ess.payslip, ess.payroll_run, ess.payroll_cycle, ess.leave_request,
                 ess.expense_claim, ess.policy_version, ess.policy_acknowledgement,
                 ess.helpdesk_ticket, ess.employee, ess.app_user, ess.file_object
  FROM ess_app, ess_job;

-- PgBouncer AUTH_QUERY: one function, one role, one user. SECURITY DEFINER so ess_auth
-- itself needs no privilege on pg_authid, and it returns ess_app and nothing else — a
-- generic `SELECT usename, passwd FROM pg_shadow` would hand the pooler every hash in
-- the cluster, including ess_owner's.
CREATE FUNCTION ess_ops.pgbouncer_get_auth(p_usename text)
  RETURNS TABLE (usename text, passwd text)
  LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT rolname::text, rolpassword::text
      FROM pg_authid WHERE rolname = p_usename AND rolname = 'ess_app'
  $$;
REVOKE EXECUTE ON FUNCTION ess_ops.pgbouncer_get_auth(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION ess_ops.pgbouncer_get_auth(text) TO ess_auth;

-- Future tables created by a later migration inherit the same grants.
-- DELETE is deliberately NOT in this list. An earlier draft granted it by default,
-- which silently re-granted DELETE on every future lifecycle table and defeated the
-- REVOKE above for anything created after the first migration. A migration that
-- creates a table needing DELETE grants it explicitly, and §4.6 rule 8 checks that
-- a table in the no-delete class never receives one.
ALTER DEFAULT PRIVILEGES FOR ROLE ess_migrator IN SCHEMA ess, ess_ops
  GRANT SELECT, INSERT, UPDATE ON TABLES TO ess_app, ess_job;
ALTER DEFAULT PRIVILEGES FOR ROLE ess_migrator IN SCHEMA ess, ess_ops
  GRANT SELECT              ON TABLES    TO ess_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ess_migrator IN SCHEMA ess, ess_ops
  GRANT USAGE, SELECT       ON SEQUENCES TO ess_app, ess_job;
```

**What SQL grants cannot do, and the claim removed from this section.** An earlier draft
carried `GRANT SELECT ON ess.payroll_employee_v TO ess_app` under the heading "Accounts is
scoped away from non-payroll PII at the SQL layer too". That is not achievable with a grant
and the line was misleading: **every persona — Employee, Manager, HR and Accounts — shares
the single `ess_app` connection**, so a grant cannot distinguish them. Persona scoping is
enforced by (1) the server-side permission check on every route (`SECURITY.md` §4), and
(2) RLS policies that read `ess.actor_persona` and `ess.scopes` from the transaction context
set by `set_config` (§4.3). The view still exists and is still the only shape Accounts-facing
queries select from, but it is a **query-construction** control, not a privilege boundary.
Saying otherwise would invite an implementer to skip the RLS policy that is actually doing
the work.
A boot-time assertion (`apps/api/src/db/assert-privileges.ts`) queries
`information_schema.role_table_grants`, `pg_roles` and `pg_tables` and **refuses to start in
production** on any of the following. It turns a mis-provisioned database into a failed
deploy rather than a silent loss of the audit guarantee, and it runs again in the CI
integration suite.

| #   | Refusal                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `current_user` is `ess_owner` or `ess_migrator` — neither is a runtime role                                                                                                                           |
| 2   | `SERVICE_ROLE=api` **and** the connected role has `rolbypassrls`                                                                                                                                      |
| 3   | `SERVICE_ROLE=worker` **and** the connected role is not `ess_job`                                                                                                                                     |
| 4   | any `TRUNCATE` grant to the connected role                                                                                                                                                            |
| 5   | `UPDATE` or `DELETE` on `ess.audit_event`                                                                                                                                                             |
| 6   | a `DELETE` grant on any table in the no-delete list                                                                                                                                                   |
| 7   | any table in `ess` without both `relrowsecurity` and `relforcerowsecurity` (`DATA-MODEL.md` §1.8.1) — a table with `ENABLE` but not `FORCE` is bypassed by its owner, which R-13 makes reachable here |
| 8   | `current_setting('search_path')` is not the role-pinned `ess, ess_ops, pg_catalog`                                                                                                                    |
| 9   | the connected role holds `CREATE` on `ess` or `ess_ops`                                                                                                                                               |

Refusals 2 and 3 replace a single earlier rule that refused **any** `rolbypassrls` on the
connected role. `ess_job` carries `BYPASSRLS` by design, so that rule would have refused to
start the worker — taking down the outbox, the accruals and the payroll calculation on the
first deploy, with an error message that pointed at the database rather than at itself.

### 4.5 Backups, PITR and the restore drill

| Control                            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated full backup              | daily, provider-managed, encrypted, 07 days retained on `standard` (extend to 30 on the next plan up if policy demands)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PITR                               | continuous WAL archiving, any second within the retention window                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **RPO**                            | **≤ 5 minutes** (WAL shipping interval); ≤ 24 h in the catastrophic case where WAL is lost and only the daily full survives                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **RTO**                            | **≤ 2 hours** to a verified, serving system                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Weekly off-provider copy           | `pg_dump -Fc` run by the `ess-backup-weekly` Render **cron service** (§3.2) on the private network **as the read-only `ess_backup` role**, encrypted with `age` to an offline public key (`BACKUP_AGE_RECIPIENT`), written with a **second cloud account's** credentials to an R2 bucket with object-lock for 35 days. This is the control that survives "the Render account is compromised or closed" — a provider-internal backup does not. The cron never holds a write credential to the production bucket, so a compromised backup job cannot corrupt what it backs up.                                                                                                                                                                                                                                                                                                                                                 |
| Backup integrity                   | the weekly copy is restored into a throwaway database by the same cron job, `pg_restore --list` is diffed against the expected table set, `SELECT count(*)` is compared against the source for six anchor tables, and the result is appended to `docs/runbooks/dr-drill-log.md`. A failure pages.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Encryption of the dump             | `pg_dump -Fc \| age -r $BACKUP_AGE_RECIPIENT > ess-<date>.dump.age`; the matching age **identity** (the private half) is in the sealed offline escrow with the KEK (§11.6), so the cron can write a backup it cannot read. **Be precise about what this protects.** Envelope-encrypted columns (PAN, Aadhaar, UAN, bank account, addresses, personal contact details, ticket bodies, payslip amounts — data classes M1/M5 of `DATA-MODEL.md` §1.6) are ciphertext in the dump and are worthless without the KEK. **Everything else is plaintext**: names, employee codes, work emails, designations, departments, org-level aggregates, `password_hash` (Argon2id + pepper), every blind index, and every `last4`/masked column. `age` is therefore not belt-and-braces — it is the **only** thing protecting that plaintext, which is why the recipient key is offline and the bucket is object-locked in a second account. |
| What a backup does **not** contain | object storage. R2 has its own versioning + lifecycle (§5). A restore is therefore a _pair_ of restores, and the drill covers both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Quarterly restore drill — the written procedure.** Owner: the on-call engineer. Target:
complete in under the 2 h RTO. Recorded in `docs/runbooks/dr-drill-log.md` with the real
elapsed time, which is the number that proves or disproves the RTO.

```
D1.  Announce in #ess-ops. This is a drill; production is not touched at any step.
D2.  Note the target restore point T = now() - 30 minutes.
D3.  Provision a NEW database `ess-postgres-drill` (same plan, same region).
D4.  Provider PITR restore of `ess-postgres` to T into the new instance.
     Render: dashboard → ess-postgres → Recovery → point-in-time → new instance.
     Record the wall-clock time this takes; it dominates RTO.
D5.  Create the four roles in the restored instance (§4.4) with FRESH passwords.
D6.  Integrity gate — all five must pass, else the drill FAILS and is escalated:
       a. SELECT max(seq), count(*) FROM ess.audit_event;
       b. node apps/api/dist/tools/verify-audit-chain.js --full   → chain intact, no gaps
       c. SELECT count(*) FROM ess.payslip WHERE status='PUBLISHED';  → matches production
          within the write volume of the 30-minute gap
       d. node apps/api/dist/tools/verify-payslip-digests.js --sample 50
          → for every sampled payslip, payslip.input_sha256 recomputes from its
            persisted payroll_input_item / attendance rows and payslip.amount_sha256
            recomputes from its decrypted payslip_line rows (directive 6 traceability)
       e. decrypt one canary row per data_encryption_key.purpose with the production KEK
          → proves the KEK escrow and the ciphertexts still agree (SECURITY.md §7.3)
D7.  Restore the object-storage side: verify 20 sampled file_object rows resolve to a live
     R2 object whose sha256 matches file_object.sha256.
D8.  Point a scratch API instance (image = current production digest, DATABASE_URL = the
     restored instance, STORAGE_BUCKET = a copy) at it; run the smoke suite:
     login → MFA → GET /me/payslips → download one payslip → raise a ticket.
D9.  Record elapsed time, the RPO actually achieved (T minus the last committed
     transaction found), and every deviation, in dr-drill-log.md.
D10. Destroy the drill instance, the scratch API and the copied bucket. Rotate the
     drill role passwords out of existence. Confirm nothing was left running.
```

**A real restore** follows the same steps with three changes: D3 restores into a new
instance _and_ the deploy is frozen (`environment: production` protection is set to
"no deployments"); after D6 passes, the API's `DIRECT_DATABASE_URL`/`DATABASE_URL` are
repointed at the restored instance and both services are redeployed; and step D10 is
replaced by retaining the _old_ instance untouched for 14 days as forensic evidence.
Any restore that rewinds past a published payroll run additionally requires the §11.2
reconciliation: re-verify every `payslip.input_sha256` / `amount_sha256` and notify Accounts, because a
rewind can un-publish a payslip an employee has already seen.

### 4.6 Migration strategy

**Prisma Migrate, forward-only.** There are no `down` migrations, and none may be written.
A rollback is a _new_ migration that moves forward to the previous shape. Reason: a `down`
migration is untested by construction, and in this system it would be run exactly once, under
pressure, against real payroll data.

**Expand / contract, in three deploys.** Because two application versions run concurrently
during every rolling deploy, _every_ migration must leave the previous API version working.

| Phase        | Deploy | Migration                                                                                                     | API                                          |
| ------------ | ------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **Expand**   | N      | additive only: add nullable column / new table / new index `CONCURRENTLY` / new enum value / backfill trigger | version N writes both old and new, reads old |
| **Migrate**  | N+1    | backfill in batches via a worker job, never in the migration transaction                                      | version N+1 reads new, still writes both     |
| **Contract** | N+2    | drop the old column / constraint / enum value, after confirming zero readers                                  | version N+2 uses new only                    |

Rules the CI migration linter (`scripts/lint-migration.mjs`) enforces by failing the job:

1. No `DROP COLUMN`, `DROP TABLE`, `ALTER COLUMN … TYPE`, `RENAME`, or `SET NOT NULL` on an
   existing column in the same migration that introduces its replacement — they must be in a
   later, separately deployed migration.
2. `CREATE INDEX` must be `CONCURRENTLY` on any table over 10 000 rows, and a
   `CONCURRENTLY` statement must be alone in its migration file (it cannot run inside a
   transaction).
3. `ALTER TABLE … ADD COLUMN` must have no volatile `DEFAULT` on a large table.
4. Every new table declares `ENABLE ROW LEVEL SECURITY` plus a tenancy policy in the same
   migration (`DATA-MODEL.md` §1.8), or the linter fails.
5. `ALTER TYPE … ADD VALUE` is alone in its file and never in the same transaction as a use.
6. No `GRANT` to `ess_app` or `ess_job` that the §4.4 revoke list forbids, **and** no
   `ALTER DEFAULT PRIVILEGES … GRANT … DELETE`. A default privilege is invisible in review
   and applies to every table a later migration creates, so it is the one way the no-delete
   guarantee can be lost without anyone writing `GRANT DELETE`.
7. Migration SQL contains no literal credential, no `COPY … FROM PROGRAM`, no `CREATE
EXTENSION` outside the allowlist, and no `SECURITY DEFINER` function that this document or
   `DATA-MODEL.md` §1.8.1 does not name.
8. A migration that creates a table named in the no-delete list of §4.4 must contain the
   matching `REVOKE DELETE` in the same file.
9. Every new `timestamp` column is `timestamptz` (R-16); a bare `timestamp` fails the lint.
10. No migration writes an operational row — no `INSERT` into `employee`, `payslip`,
    `leave_request`, `expense_claim`, `helpdesk_ticket`, `notification`, `announcement` or
    any balance table. Reference data is seeded by `db:seed:reference` (§11.1 B6), which is
    audited as `actor_kind='MIGRATION'`; a migration that quietly inserts a row is how a
    fabricated number reaches the UI with a schema change as its cover.

**How migrations run in the pipeline** (the job between "image pushed" and "API deployed"):

```yaml
- name: Apply migrations
  env:
    DATABASE_URL: ${{ secrets.MIGRATE_DATABASE_URL }} # ess_migrator
    DIRECT_DATABASE_URL: ${{ secrets.MIGRATE_DATABASE_URL }}
  run: |
    set -euo pipefail
    npx prisma migrate status                       # must report "Database schema is up to date" or pending only
    npx prisma migrate deploy                       # applies pending, never resets, never prompts
    node apps/api/dist/tools/record-schema-guard.js # writes ess_ops.schema_guard (DATA-MODEL.md §17.5)
    node apps/api/dist/tools/assert-privileges.js   # §4.4 assertions against the real database
```

- It runs from a GitHub Actions job in the protected `production` environment, on a runner
  allowlisted on the database's IP allowlist **for the duration of the job only** (the
  workflow adds the runner's egress IP before and removes it in an `always()` step; if the
  provider does not support that, the migration job runs as a Render **one-off job** on the
  private network and CI only triggers and polls it — preferred, because no database
  credential ever reaches a CI runner).
- `prisma migrate deploy` is the only command used. `migrate dev`, `db push` and
  `migrate reset` are blocked in CI by a grep in the workflow and are refused by the
  `package.json` scripts when `NODE_ENV=production`.
- A **pre-migration backup marker** is taken first: the job records the current LSN and the
  provider's latest backup id into the job summary, so the PITR target for an undo is known
  without guessing.

**What happens when a migration fails.**

| Situation                                                                                                                                              | Behaviour                                                                                                           | Action                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration job fails before applying anything                                                                                                           | deploy pipeline stops; **the running API is untouched** and keeps serving                                           | fix forward, re-run                                                                                                                                                                                                                          |
| Migration partially applied (Postgres DDL is transactional, so this only happens for a multi-statement file with `CONCURRENTLY` or a mid-file failure) | Prisma records the migration as `failed` in `_prisma_migrations`; all later `migrate deploy` runs refuse to proceed | a human inspects, repairs by hand on `DIRECT_DATABASE_URL`, then runs `prisma migrate resolve --applied <name>` (repair completed) or `--rolled-back <name>` (repair reverted); the incident is written up before the next deploy is allowed |
| Migration applied but the new API fails its health check                                                                                               | Render leaves the previous instances serving and marks the deploy failed                                            | roll the API image back (§8.5). **This is safe precisely because of expand/contract**: the expand-phase schema is always compatible with the previous image.                                                                                 |
| Migration applied, API healthy, data corruption discovered                                                                                             | out of scope for a deploy rollback: PITR restore (§4.5) to the recorded pre-migration LSN, then forward-fix         | incident                                                                                                                                                                                                                                     |

Because expand/contract guarantees schema(N+1) works with app(N), **the API image can always
be rolled back one version without touching the database.** That is the entire point of the
discipline, and it is what makes §8.5 a 60-second operation instead of a restore.

---

## 5. Object storage

### 5.1 Choice and layout

**Cloudflare R2**, S3-compatible, location hint `apac`. Chosen over S3 for one operationally
decisive reason: **zero egress fees**, and every payslip, Form 16, policy PDF and expense
bill download is egress. It speaks the S3 API, so `@aws-sdk/client-s3` +
`@aws-sdk/s3-request-presigner` work unchanged and the alternative (AWS S3 in `ap-south-1`)
is a two-line configuration change.

| Bucket                 | Contents                                                          | Versioning       | Lifecycle                 |
| ---------------------- | ----------------------------------------------------------------- | ---------------- | ------------------------- |
| `widedrop-ess-prod`    | all production artefacts                                          | on               | §5.4                      |
| `widedrop-ess-staging` | staging artefacts, synthetic only                                 | off              | delete after 30 days      |
| `widedrop-ess-backup`  | the weekly encrypted `pg_dump` (§4.5), **separate cloud account** | on + object lock | retain 35 days, immutable |

Key layout is exactly `SECURITY.md` §5.3.11 — server-generated, no user input, no guessable
component:

```
ess/<env>/<state>/<context>/<yyyy>/<mm>/<uuidv7>.<canonical-ext>

<env>     : prod | staging | dev          (exactly these three tokens — NOT the
                                           NODE_ENV spellings "production"/"development",
                                           because the lifecycle rules in §5.4 match on
                                           this literal prefix)
<state>   : live | quarantine             (an object is written to .../quarantine/...
                                           and MOVED to .../live/... only when
                                           file_object.scan_status becomes CLEAN; a
                                           signed URL is never minted for a quarantine
                                           key, and §5.4's 30-day rule can only see
                                           objects that never got promoted)
<context> : payslip · form16 · expense-bill · policy-document · letter ·
            employee-document · payroll-input · ticket-attachment · bank-proof
```

`file_object.storage_key` persists the **current** key, and the promotion from `quarantine`
to `live` is a copy-then-delete inside the same transaction that sets `scan_status='CLEAN'`,
with the new key written back to the row. An earlier draft's layout had no `<state>`
segment, which left §5.4's `ess/prod/*/quarantine/` lifecycle rule matching nothing.

`file_object.storage_bucket` and `storage_key` persist the location; `sha256`, `byte_size`,
the sniffed `content_type` and `retention_until` persist alongside (`DATA-MODEL.md` §17.4).
Nothing in the UI ever renders a storage key.

### 5.2 Access model — private, always, with no exceptions

| Control                   | Setting                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public access             | **disabled**. No `r2.dev` public development URL, no custom public domain, no public bucket policy. A bucket that is public cannot be made safe by obscure keys.                                                                                                                                                                                                       |
| Credentials               | one R2 API token per environment, scoped to **one bucket**, with `Object Read & Write` only — never `Admin`, never account-wide. Production and staging tokens are different and neither can see the other's bucket.                                                                                                                                                   |
| Who holds credentials     | the API and the worker only. **Not CI, not the SPA, not a browser.**                                                                                                                                                                                                                                                                                                   |
| Browser → bucket writes   | **do not exist.** Every upload is `multipart/form-data` to the API, which authorizes, validates the magic bytes, re-encodes images, strips EXIF, scans with ClamAV and only then `PutObject`s (`SECURITY.md` §5.3). There is no presigned-PUT path to leave unguarded.                                                                                                 |
| Browser → bucket reads    | **only** a presigned `GET`, minted by the API after the entity-level authorization check in `API.md` §11.1, **120 seconds**, single object, `GET` only, no wildcard, with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store` baked into the signature |
| Pre-signing preconditions | the API mints a URL only when `file_object.scan_status = 'CLEAN'`, `deleted_at IS NULL`, and the re-read `sha256` matches the persisted one; the `audit_event` is written **before** the URL is returned                                                                                                                                                               |
| Encryption at rest        | R2 encrypts every object server-side with AES-256 by default (SSE-managed). On AWS S3 the equivalent is `SSE-KMS` with a customer-managed key and `"s3:x-amz-server-side-encryption": "aws:kms"` enforced by bucket policy. `file_object.is_encrypted_at_rest` records this.                                                                                           |
| Encryption in transit     | HTTPS only; the endpoint is in `OUTBOUND_ALLOWLIST` (`SECURITY.md` §5.5)                                                                                                                                                                                                                                                                                               |
| Second layer              | payslip PDFs and bank proofs are additionally **application-encrypted before upload** with the `BANK`/`STATUTORY` DEK, so a storage compromise alone yields ciphertext. See the two download paths below — for these contexts there is **no presigned URL at all**.                                                                                                    |

**There are exactly two download paths, and an earlier draft conflated them.** A presigned
URL points at R2 and is served by R2; R2 cannot decrypt an application-encrypted object, so
"a 120-second signed URL that serves a decrypt-on-read stream from the API" describes nothing
that can exist. The two real paths:

| Path                         | Contexts                                                                                                         | Mechanism                                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — presigned redirect**   | `expense-bill`, `policy-document`, `letter`, `employee-document`, `form16`, `ticket-attachment`, `payroll-input` | The API authorizes, writes the `audit_event`, then returns `302` to a 120 s presigned `GET` (or the URL itself under `?mode=json`, `API.md` §11.2). `SIGNED_URL_TTL_SECONDS` governs this path.                                                                                                             |
| **B — API-streamed decrypt** | `payslip`, `bank-proof`                                                                                          | The API authorizes, writes the `audit_event`, fetches the ciphertext object server-side, unwraps the DEK, and **streams plaintext in its own response body**. No presigned URL is minted, `SIGNED_URL_TTL_SECONDS` does not apply, and the object never leaves R2 in a form a browser could fetch directly. |

`API.md` §11.2's response shape is identical for both so the client does not branch on
context; under `?mode=json` path B returns `{"mode":"stream","href":"/api/v1/files/<id>/content"}`
and path A returns `{"mode":"redirect","href":"https://…r2…?X-Amz-…","expiresAt":…}`.

**How a download authenticates, since the access token is a Bearer in memory.** A plain
`<a href download>` or a `window.open` is a top-level navigation and carries **no
`Authorization` header**, so neither path works that way — and the refresh cookie is
`__Host-`/`HttpOnly` and is accepted only by `/auth/refresh`, so it cannot stand in for one.
Every download in the SPA is therefore:

```
fetch(url, { credentials: 'include', headers: { Authorization: `Bearer ${accessToken}` } })
  → Response.blob()  → URL.createObjectURL(blob)  → <a download> click  → revokeObjectURL
```

That is why `img-src` allows `blob:` (§2.3) and why the bucket CORS document of §5.3 exists
at all: path A's second hop is a cross-origin `fetch` to R2 and needs `GET`/`HEAD` allowed
from the SPA origin. It also satisfies `Cross-Origin-Embedder-Policy: require-corp`, because
a CORS-mode `fetch` is a valid CORP source — a bare `<img src="https://…r2…">` would not be,
and is not used anywhere.

### 5.3 CORS

Because downloads are a redirect or a same-tab navigation, and uploads go to the API, CORS on
the bucket is needed for exactly one case: the SPA fetching a signed URL into a `blob:` for
in-page preview (which is why the CSP allows `img-src blob:`).

```json
[
  {
    "AllowedOrigins": ["https://ess.widedrop.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range", "If-None-Match", "If-Modified-Since"],
    "ExposeHeaders": ["Content-Length", "Content-Type", "Content-Disposition", "ETag"],
    "MaxAgeSeconds": 600
  }
]
```

Staging uses the same shape with `https://ess-staging.widedrop.com` and
`https://deploy-preview-*--widedrop-ess.netlify.app`. **`PUT`, `POST` and `DELETE` are never
allowed from any origin**, and `AllowedOrigins` never contains `*`. A CI check asserts the
deployed CORS document matches the committed one at `infra/storage/cors.prod.json`.

### 5.4 Lifecycle and retention

Retention is driven by the persisted `file_object.retention_until`, computed from
`document_type.retention_years` or the payroll-evidence class (`DATA-MODEL.md` §18.3).
**Deletion is the application's decision, not the bucket's** — the `file-retention-purge`
worker job deletes the object, sets `file_object.deleted_at` and writes an audit event, so
the fact of deletion is itself auditable. Bucket lifecycle rules exist only as a safety net
for things the application is not the owner of:

| Rule                             | Prefix                 | Action                                                                                                                                              |
| -------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abandoned multipart uploads      | `*`                    | abort after 1 day                                                                                                                                   |
| Quarantined files never promoted | `ess/prod/quarantine/` | delete after 30 days (matches the `<state>` segment of §5.1)                                                                                        |
| Non-current object versions      | `*`                    | expire 90 days after becoming non-current (a window to undo an accidental overwrite, bounded so it is not an indefinite shadow copy of deleted PII) |
| Staging bucket                   | `*`                    | delete after 30 days                                                                                                                                |
| Backup bucket                    | `*`                    | object-lock retain 35 days, then delete                                                                                                             |

**Verify the provider supports each rule before relying on it.** R2's lifecycle
implementation has historically covered multipart-upload abort and object expiry but has
lagged S3 on **non-current version expiration**, and Object Lock is a
bucket-creation-time-only setting. Two consequences, both to be checked at bootstrap (§11.1
B1) and re-checked at each quarterly review (§11.7 Q6):

- if non-current version expiry is unavailable, the `file-retention-purge` job issues an
  explicit `DeleteObjectVersion` for versions older than 90 days as part of its run, so the
  bound is enforced by the application rather than silently absent;
- if Object Lock cannot be enabled on `widedrop-ess-backup` at creation, that bucket moves
  to **AWS S3 `ap-south-1` with Object Lock in compliance mode**. Immutability is the whole
  point of the off-provider copy; a mutable backup bucket in a second account is a copy, not
  a control. The extra egress is a few dollars a year because it is only read during a
  drill.

There is **no** blanket "delete objects older than N years" rule: an 8-year statutory
retention must not be defeated by a bucket policy, and an early deletion must not be
invisible. Two CI/ops assertions guard the pair: a nightly job counts `file_object` rows with
`deleted_at IS NULL` whose key no longer resolves (**orphan ciphertext → P2 alert**), and
counts objects with no `file_object` row (**shadow object → P2 alert**).

---

## 6. Email

### 6.1 Provider

**Amazon SES, region `ap-south-1` (Mumbai)**, used through the HTTPS API (`SendEmail` v2)
with the AWS SDK — never raw SMTP string concatenation (`WORKFLOWS.md` §6.3). Chosen for:
an Indian region (latency and residency), a configuration set with SNS event destinations for
bounce/complaint/delivery, DKIM key management, and a cost of ~$0.10 per 1 000 messages,
which at this volume is rounding error.

**Idempotency.** SES has no `Idempotency-Key` header. The outbox therefore guarantees
delivery-once at the _record_ level and once-at-recipient in practice:
`ux_email_outbox__org_idempotency` makes the enqueue idempotent; the `QUEUED → SENDING` claim
plus the 10-minute sweep bounds duplicates to a crash window; and the worker sets the RFC 5322
`Message-ID` header to `<{email_outbox.id}@widedroptech.com>`, so a duplicate send of the same
row is collapsed by the receiving MTA and is trivially correlatable in the SES event stream.
`provider_message_id` persists the SES `MessageId`. **If strict provider-side idempotency is
later required, Resend (native `Idempotency-Key`) or Postmark are drop-in replacements** —
the provider sits behind `apps/api/src/mail/provider.ts` with a three-method interface
(`send`, `verifyWebhook`, `parseEvent`), and `MAIL_PROVIDER` selects it.

Environment separation: staging uses a **separate SES configuration set and a sandbox-like
suppression list**, and `MAIL_TO_OVERRIDE` (staging-only) forces every recipient to a single
test mailbox so a staging bug cannot email real employees. The boot check refuses
`MAIL_TO_OVERRIDE` in production.

### 6.2 DNS for `widedroptech.com`

All of these are in the **`widedroptech.com`** zone. **Nothing here touches `widedrop.com`.**

| Name                                          | Type         | Value                                                                                                                    | Purpose                                                                                                                                                                                 |
| --------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `widedroptech.com`                            | `TXT`        | `v=spf1 include:amazonses.com -all`                                                                                      | SPF. `-all` (hard fail), not `~all`. If other senders exist (Google Workspace, a CRM) they must be merged into this **single** record — two SPF TXT records is a permanent SPF failure. |
| `<token1>._domainkey` … `<token3>._domainkey` | `CNAME`      | `<token>.dkim.amazonses.com`                                                                                             | Easy DKIM, 2048-bit, three rotating selectors managed by SES                                                                                                                            |
| `_dmarc`                                      | `TXT`        | `v=DMARC1; p=none; rua=mailto:dmarc@widedroptech.com; ruf=mailto:dmarc@widedroptech.com; fo=1; adkim=s; aspf=s; pct=100` | **Week 0–2**: monitor only, collect aggregate reports                                                                                                                                   |
| `_dmarc`                                      | `TXT`        | `v=DMARC1; p=quarantine; pct=25; rua=…; adkim=s; aspf=s`                                                                 | **Week 2–4**, once reports show 100 % alignment                                                                                                                                         |
| `_dmarc`                                      | `TXT`        | `v=DMARC1; p=reject; rua=…; adkim=s; aspf=s`                                                                             | **Week 4+**, the target state                                                                                                                                                           |
| `mail` (MAIL FROM)                            | `MX` + `TXT` | `10 feedback-smtp.ap-south-1.amazonses.com` / `v=spf1 include:amazonses.com -all`                                        | Custom MAIL FROM domain, so SPF aligns for DMARC rather than relying on DKIM alone                                                                                                      |
| `_bimi`                                       | —            | —                                                                                                                        | not configured; noted as optional once `p=reject` has held for 30 days                                                                                                                  |

**Exactly one `_dmarc` TXT record exists at any moment.** The three rows above are the three
successive _values_ of that one record, not three records: a domain publishing two `_dmarc`
TXT records has **no** valid DMARC policy at all, and every receiver falls back to none.
Each step is an edit of the existing record, and `dig +short _dmarc.widedroptech.com TXT`
must return exactly one string after each edit. The same is true of the SPF record on the
apex, which is why the note there insists on merging rather than adding.

**Escalate `p=none → quarantine → reject` on the schedule above, not immediately** — going
straight to `reject` before the aggregate reports confirm alignment is how a real
organisation silently loses its own mail. The gate to each step is: zero DMARC-failing
messages from a legitimate source in the last 7 days of `rua` reports.

**Optional hardening of `widedrop.com` (separate change, separate approval):** if the
marketing domain sends no mail, `v=spf1 -all` and `v=DMARC1; p=reject;` on `widedrop.com`
prevent spoofing of the better-known domain. **This must not be applied blind** — verify with
the marketing owner and 14 days of `p=none` reports first, because it will break any
forgotten sender (a contact form relay, a newsletter tool). It is listed here as a tracked
follow-up in `infra/TODO-widedrop-dmarc.md`, not as part of the ESS rollout.

### 6.3 The outbox worker — retry, backoff, dead-letter

Implements `WORKFLOWS.md` §6.3 exactly. The worker is the **only** component that talks to
SES; no request path ever sends mail synchronously.

```
job:     email-dispatch, every 30 s (WORKER_POLL_INTERVAL_MS floor), batch 50
claim:   UPDATE email_outbox SET status='SENDING', claimed_at=now(), claimed_by=<instance>
         WHERE id IN (SELECT id FROM email_outbox
                      WHERE status='QUEUED' AND next_attempt_at <= now()
                      ORDER BY next_attempt_at
                      FOR UPDATE SKIP LOCKED LIMIT 50)
         RETURNING *;
send:    SES SendEmail v2 · ConfigurationSetName=MAIL_CONFIGURATION_SET
         · Message-ID: <{id}@widedroptech.com>
         · every header value CR/LF-stripped (SECURITY.md §B5)
         · template_data carries identifiers and labels ONLY — never a ticket body,
           an amount, a bank detail or a token
success: status='SENT', sent_at=now(), provider_message_id=<SES MessageId>,
         body_text=NULL, body_html=NULL        -- the rendered body is not retained
failure: retry_count += 1
         retry_count <= 5 → status='QUEUED',
                            next_attempt_at = now() + least(2^retry_count, 60) minutes
                            (2, 4, 8, 16, 32 min; jittered ±20 % so a provider outage
                             does not produce a synchronised thundering herd)
         retry_count  > 5 → status='FAILED', failed_at=now(), last_error=<redacted>
sweep:   status='SENDING' AND claimed_at < now() - interval '10 minutes'
         → back to 'QUEUED' (a worker that died mid-send must not strand a message)
```

**Permanent vs transient failures.** A `4xx` from SES that is structurally permanent
(`MessageRejected`, `MailFromDomainNotVerified`, a suppression-list hit, an invalid address)
goes **straight to `FAILED`** without consuming five retries — retrying a permanently
rejected address just delays the human who needs to fix it. `Throttling`,
`ServiceUnavailable`, `5xx` and network errors take the backoff ladder.

**Dead-letter = `status='FAILED'`.** Effects, all persisted and all visible:
a `SECURITY_ALERT`-class notification to every holder of `ticket:read:any`
(`source_rule_code = 'HELPDESK_EMAIL_FAILED'`); the ticket flagged in the HR queue via
`ix_email_outbox__failed`; a P3 alert (§9.5); and a manual
`POST /tickets/:id/retry-notification` which resets `retry_count=0` with a fresh idempotency
discriminator (`:v2`, `:v3`…) and is audited as `TICKET.EMAIL_RETRIED`.

### 6.4 Bounce, complaint and delivery handling

SES configuration set `ess-prod` publishes `Bounce`, `Complaint`, `Delivery`,
`DeliveryDelay` and `Reject` to an SNS topic, which HTTPS-subscribes to
`POST /api/v1/webhooks/ses`.

> **Reconciliation R-4:** this route does not yet appear in `API.md` §13. Add it as a
> `public: true` route with its own guard block, and add it to the `public` allowlist in the
> boot-time route assertion (`SECURITY.md` §4.8) so the "every route declares a permission"
> check still passes.

Its guard block, in order, before any body is trusted:

1. Content-Length ≤ 16 KiB, else `413`.
2. Verify the **SNS message signature** (`SigningCertURL` must be an
   `https://sns.ap-south-1.amazonaws.com/` host in `OUTBOUND_ALLOWLIST`; certificate fetched,
   cached 24 h, signature checked against the canonical string). Invalid ⇒ `403`, audited as
   `SECURITY.WEBHOOK_SIGNATURE_INVALID`.
3. `TopicArn` must equal `SES_SNS_TOPIC_ARN` exactly. Mismatch ⇒ `403`.
4. `SubscriptionConfirmation` is auto-confirmed **only** for that exact ARN.
5. Rate limit `ip` 120/min; the route writes no `audit_event` on the happy path (an
   unauthenticated endpoint must not be able to grow the audit table — `SECURITY.md` §6.3),
   only a metric and a structured log line.
6. The body is Zod-validated; the referenced `email_outbox` row is found by
   `provider_message_id` or by the `Message-ID` header.

| Event                      | Effect                                                                                                                                                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Delivery`                 | `email_outbox.delivered_at = now()`; the Help-desk screen's "Help desk notified · <time>" is rendered from this, not from `sent_at`, when present                                                                                                                 |
| `Bounce` (permanent)       | `status='FAILED'`, `last_error='bounce:<subtype>'`; the address is added to `ess.email_suppression` with the reason and timestamp; the dead-letter effects in §6.3 fire; if the address is an employee's `work_email`, an HR notification asks them to correct it |
| `Bounce` (transient)       | back to `QUEUED` with the backoff ladder, capped at the same 5 attempts                                                                                                                                                                                           |
| `Complaint`                | `status='FAILED'`; address suppressed permanently; **P2 alert** — a spam complaint against a payroll notification is an incident, not noise                                                                                                                       |
| `Reject` / `DeliveryDelay` | logged and metered; `DeliveryDelay` does not change state (SES retries internally)                                                                                                                                                                                |

The suppression list is consulted **before** every send. A suppressed address short-circuits
to `status='SUPPRESSED'`, which the UI renders as "Email notification disabled" — never as
success.

### 6.5 The inviolable rule

> **An email failure must never lose a persisted ticket, and must never be reported as success.**

Enforced structurally, not by convention:

1. The `helpdesk_ticket` insert, its first `ticket_comment`, the `email_outbox` row, the
   raiser's `notification` and both `audit_event` rows are **one transaction**
   (`WORKFLOWS.md` §6.3). If the ticket commits, the email is durably queued; if it rolls
   back, no email row exists. There is no window in which one exists without the other.
2. **No HTTP request path ever calls SES.** `POST /tickets` returns `201` on commit, and its
   success toast states only the persisted `ticket_no`. The mail provider being down cannot
   fail, slow, or alter a ticket creation.
3. The ticket screen renders `email_outbox.status` verbatim (`QUEUED`/`SENDING` → "Notifying
   the help desk…", `SENT` → "Help desk notified · <sent_at>", `FAILED` → the red banner that
   **still states the ticket is recorded**, `SUPPRESSED` → "Email notification disabled").
   There is no optimistic constant anywhere in that path — which is directive 2 applied to a
   status.
4. `readyz` reports `mailProvider: "degraded"` without failing readiness (`API.md` §13):
   the outbox absorbs a provider outage, so a provider outage must not take the portal down.
5. The integration test `outbox.spec.ts` creates a ticket with the provider stubbed to fail,
   and asserts: the ticket exists and is readable, the outbox row reaches `FAILED` after the
   ladder, the HR notification fires, the UI payload carries the failure state, and **no**
   response at any point claimed delivery.

---

## 7. Environments and configuration

### 7.1 The three environments

|                      | **development**                                                                       | **staging**                                                                          | **production**                                         |
| -------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Runs where           | developer laptop                                                                      | Render, `singapore`, separate project                                                | Render, `singapore`                                    |
| SPA                  | `http://localhost:5173` (Vite proxies `/api` so cookies behave same-origin)           | `ess-staging.widedrop.com` + deploy previews                                         | `ess.widedrop.com`                                     |
| API                  | `http://localhost:4000`                                                               | `api-ess-staging.widedrop.com`                                                       | `api-ess.widedrop.com`                                 |
| Database             | `infra/docker-compose.yml`, port 5433                                                 | own Render Postgres, `starter` plan                                                  | own Render Postgres, `standard`                        |
| Data                 | `db:seed:reference` + `db:seed:demo` (synthetic)                                      | reference + synthetic only — **never a production copy, never a production restore** | real                                                   |
| Storage              | filesystem driver (`STORAGE_DRIVER=filesystem`)                                       | `widedrop-ess-staging` bucket                                                        | `widedrop-ess-prod` bucket                             |
| Mail                 | Mailpit on `localhost:1025`, or the `file` driver writing `.eml`                      | SES with `MAIL_TO_OVERRIDE` to one test mailbox                                      | SES, real recipients                                   |
| ClamAV               | optional; unavailable ⇒ uploads land `QUARANTINED`, which is the documented behaviour | required                                                                             | required                                               |
| MFA                  | required for privileged roles, TOTP against a local authenticator                     | same as production                                                                   | same                                                   |
| Cookies              | `SameSite=Lax`, `Secure=false`, cookie named **`wd_rt`** — see the note below         | `SameSite=None; Secure`, `__Host-wd_rt`                                              | `SameSite=Strict; Secure`, `__Host-wd_rt`              |
| `LOG_LEVEL`          | `debug`                                                                               | `info`                                                                               | `info` — `debug` is **refused** at boot                |
| Deploys              | n/a                                                                                   | auto on merge to `main`, no approval                                                 | manual approval in the `production` GitHub environment |
| Who can reach the DB | the developer                                                                         | two engineers                                                                        | nobody interactively; break-glass only (§11.6)         |

**The refresh cookie loses its `__Host-` prefix in development, and only there.** The
`__Host-` prefix is not decoration: a browser **rejects** a `__Host-`-prefixed cookie that
lacks `Secure`, and `localhost` being a secure _context_ does not make a cookie `Secure`
without the attribute. Setting `__Host-wd_rt` with `Secure=false`, as an earlier draft's
matrix implied, means the cookie is silently discarded and every developer's session dies at
the first refresh — a failure that looks like a bug in the auth code. So: the cookie name is
`COOKIE_SECURE ? '__Host-wd_rt' : 'wd_rt'`, and §7.4 refusal 21 makes the prefixed name
mandatory whenever `COOKIE_SECURE=true`. The alternative — running local development over
HTTPS with `mkcert` — is supported and preferred if the team wants byte-identical cookie
behaviour everywhere; in that case set `COOKIE_SECURE=true` locally and the prefix returns
by itself.

**Staging never holds production data.** Not a masked copy, not a subset. A restore drill
(§4.5) uses a throwaway instance that is destroyed, never staging. This is what keeps the
number of systems holding real PAN/Aadhaar/salary at exactly one.

### 7.2 Environment variable reference

Legend — **S** = secret (never logged, never in git, never in a `VITE_` name);
**R** = required (boot fails without it) in that environment; `—` = not used.

#### Core runtime

| Variable                  | Purpose                                                                              | Example / placeholder                                          | dev | stg | prod | S   |
| ------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --- | --- | ---- | --- |
| `NODE_ENV`                | mode switch; gates every production-only check                                       | `production`                                                   | R   | R   | R    |     |
| `SERVICE_ROLE`            | `api` \| `worker`; selects the entrypoint branch                                     | `api`                                                          | R   | R   | R    |     |
| `PORT`                    | HTTP listen port                                                                     | `4000`                                                         | R   | R   | R    |     |
| `HOST`                    | bind address                                                                         | `0.0.0.0`                                                      | R   | R   | R    |     |
| `LOG_LEVEL`               | pino level; `debug`/`trace` refused when `NODE_ENV=production`                       | `info`                                                         | R   | R   | R    |     |
| `APP_VERSION`             | git SHA, surfaced by `GET /api/v1/version` (internal listener) and on every log line | `a1b2c3d`                                                      |     | R   | R    |     |
| `BUILT_AT`                | image build timestamp, surfaced by `GET /api/v1/version`                             | `2026-09-29T10:00:00Z`                                         |     | R   | R    |     |
| `API_PUBLIC_URL`          | absolute origin of the API; builds absolute links                                    | `https://api-ess.widedrop.com`                                 | R   | R   | R    |     |
| `WEB_PUBLIC_URL`          | absolute origin of the SPA; deep links in outbound mail                              | `https://ess.widedrop.com`                                     | R   | R   | R    |     |
| `ALLOWED_ORIGINS`         | exact CORS allowlist, comma-separated; rejects `*`                                   | `https://ess.widedrop.com`                                     | R   | R   | R    |     |
| `TRUSTED_PROXY_CIDRS`     | exact proxy CIDRs for Fastify `trustProxy`; **never `true`**                         | `10.0.0.0/8`                                                   |     | R   | R    |
| `PRIVATE_PORT`            | second listener for `/readyz` + `/metrics`; not routed (§9.2)                        | `4001`                                                         |     | R   | R    |
| `TZ`                      | container timezone; **must be `UTC`** (R-16)                                         | `UTC`                                                          | R   | R   | R    |
| `ORG_TIMEZONE_FALLBACK`   | used only until the `organization` row exists (§11.1 B8)                             | `Asia/Kolkata`                                                 | R   | R   | R    |
| `ALLOWED_ORIGIN_PATTERNS` | anchored regexes for deploy-preview origins; **refused in production** (§2.4)        | `^https://deploy-preview-\d{1,6}--widedrop-ess\.netlify\.app$` | —   | R   | —    |     |

#### Database

| Variable                  | Purpose                                                             | Example / placeholder                                                                      | dev | stg | prod | S     |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --- | --- | ---- | ----- |
| `DATABASE_URL`            | API → PgBouncer (transaction pooling); worker → direct              | `postgresql://ess_app:…@ess-pgbouncer:6432/widedrop_ess?pgbouncer=true&connection_limit=8` | R   | R   | R    | **S** |
| `DIRECT_DATABASE_URL`     | session-scoped connection: worker advisory locks, migrations, tools | `postgresql://ess_app:…@host:5432/widedrop_ess?sslmode=verify-full`                        | R   | R   | R    | **S** |
| `MIGRATE_DATABASE_URL`    | `ess_migrator` credentials; exists **only** in the migration job    | `postgresql://ess_migrator:…@host:5432/…`                                                  | —   | R   | R    | **S** |
| `BACKUP_DATABASE_URL`     | `ess_backup`, read-only; exists **only** in `ess-backup-weekly`     | `postgresql://ess_backup:…@host:5432/…?sslmode=verify-full`                                | —   | —   | R    | **S** |
| `DB_POOL_MAX`             | Prisma `connection_limit` override if not in the URL                | `8`                                                                                        |     |     |      |       |
| `DB_STATEMENT_TIMEOUT_MS` | client-side guard mirroring the server-side `statement_timeout`     | `15000`                                                                                    |     | R   | R    |       |

#### Authentication and sessions

| Variable                         | Purpose                                                         | Example / placeholder                            | dev | stg | prod | S     |
| -------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ | --- | --- | ---- | ----- |
| `JWT_ISSUER`                     | `iss` claim; must be the API origin                             | `https://api-ess.widedrop.com`                   | R   | R   | R    |       |
| `JWT_AUDIENCE`                   | `aud` claim; must be the SPA origin                             | `https://ess.widedrop.com`                       | R   | R   | R    |       |
| `JWT_ACTIVE_KID`                 | which key signs **new** tokens; `^wd-ess-\d{6}-[0-9a-f]{4}$`    | `wd-ess-202609-a1b2`                             | R   | R   | R    |       |
| `JWT_SIGNING_KEY_<kid>`          | Ed25519 private key, PKCS#8 PEM, base64; **one per live kid**   | `REPLACE_ME__openssl genpkey -algorithm ed25519` | R   | R   | R    | **S** |
| `JWT_PUBLIC_KEY_<kid>`           | matching SPKI PEM; published at the JWKS endpoint               | `REPLACE_ME`                                     | R   | R   | R    |       |
| `ACCESS_TOKEN_TTL_SECONDS`       | 60–900                                                          | `600`                                            | R   | R   | R    |       |
| `REFRESH_TOKEN_TTL_DAYS`         | idle TTL of a refresh token, 1–30                               | `7`                                              | R   | R   | R    |       |
| `REFRESH_FAMILY_MAX_DAYS`        | absolute lifetime of a refresh family, 1–**14**                 | `14`                                             | R   | R   | R    |       |
| `PASSWORD_PEPPER_V1`             | HMAC-SHA512 pepper pre-hashed into Argon2id; base64 ≥ 32 B      | `REPLACE_ME__openssl rand -base64 48`            | R   | R   | R    | **S** |
| `PASSWORD_PEPPER_ACTIVE_VERSION` | which pepper new hashes use during rotation                     | `1`                                              | R   | R   | R    |       |
| `COOKIE_SAMESITE`                | **`strict` in staging and production**, `lax` dev only          | `strict`                                         | R   | R   | R    |       |
| `COOKIE_SECURE`                  | must be `true` outside dev                                      | `true`                                           | R   | R   | R    |       |
| `COOKIE_DOMAIN`                  | **must be empty everywhere**; `__Host-` forbids `Domain` (§1.4) | _(empty)_                                        |     |     |      |       |
| `MFA_ISSUER_LABEL`               | the label shown in the authenticator app                        | `Widedrop ESS`                                   | R   | R   | R    |       |
| `HIBP_ENABLED`                   | breach-check new passwords via k-anonymity                      | `true`                                           | R   | R   | R    |       |
| `HIBP_TIMEOUT_MS`                | fail-open budget; degradation is metered and alerted            | `2000`                                           |     | R   | R    |       |

#### Encryption and integrity keys

| Variable                     | Purpose                                                                                                                                                                                      | Example / placeholder                 | dev | stg | prod | S     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- | --- | --- | ---- | ----- |
| `MASTER_KEK_V1` (+ `_V2`…)   | wraps every DEK; base64, **exactly 32 bytes**                                                                                                                                                | `REPLACE_ME__openssl rand -base64 32` | R   | R   | R    | **S** |
| `MASTER_KEK_ACTIVE_VERSION`  | which KEK wraps new DEKs; both stay resident during rotation                                                                                                                                 | `1`                                   | R   | R   | R    |       |
| `BLIND_INDEX_KEY_V1`         | HMAC pepper for the `*_fpr` blind indexes (`DATA-MODEL.md` §1.6 — the suffix is `_fpr`, the value is the full 32 bytes, and each column carries `<field>_fpr_pepper_version`); base64 ≥ 32 B | `REPLACE_ME__openssl rand -base64 48` | R   | R   | R    | **S** |
| `AUDIT_CHAIN_KEY_V1`         | HMAC key sealing the audit hash chain; base64 ≥ 32 B                                                                                                                                         | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `AUDIT_CHAIN_ACTIVE_VERSION` | new rows only; history is never re-keyed                                                                                                                                                     | `1`                                   | R   | R   | R    |       |
| `CSRF_KEY`                   | HMAC binding the double-submit token to the session                                                                                                                                          | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `LOG_HASH_KEY`               | HMAC for `ip_hash` / `user_agent_hash` / rate-limit bucket keys                                                                                                                              | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `RECOVERY_CODE_KEY`          | HMAC over MFA recovery codes                                                                                                                                                                 | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `CURSOR_HMAC_KEY`            | signs pagination cursors, bound to `sub`                                                                                                                                                     | `REPLACE_ME`                          | R   | R   | R    | **S** |

#### Object storage

| Variable                    | Purpose                                                                  | Example / placeholder                      | dev | stg | prod | S     |
| --------------------------- | ------------------------------------------------------------------------ | ------------------------------------------ | --- | --- | ---- | ----- |
| `STORAGE_DRIVER`            | `filesystem` \| `s3`; `filesystem` **refused** in production             | `s3`                                       | R   | R   | R    |       |
| `STORAGE_ENDPOINT`          | S3-compatible endpoint; must be `https://`                               | `https://<acct>.r2.cloudflarestorage.com`  | —   | R   | R    |       |
| `STORAGE_REGION`            | `auto` for R2, `ap-south-1` for S3                                       | `auto`                                     | —   | R   | R    |       |
| `STORAGE_BUCKET`            | one bucket per environment                                               | `widedrop-ess-prod`                        | —   | R   | R    |       |
| `STORAGE_ACCESS_KEY_ID`     | bucket-scoped token id                                                   | `REPLACE_ME`                               | —   | R   | R    | **S** |
| `STORAGE_SECRET_ACCESS_KEY` | bucket-scoped token secret                                               | `REPLACE_ME`                               | —   | R   | R    | **S** |
| `STORAGE_FORCE_PATH_STYLE`  | `true` for R2                                                            | `true`                                     | —   | R   | R    |       |
| `STORAGE_LOCAL_PATH`        | dev only, filesystem driver root                                         | `./.storage`                               | R   | —   | —    |       |
| `SIGNED_URL_TTL_SECONDS`    | 30–3600; **120** per `API.md` §11.2. Governs download path A only (§5.2) | `120`                                      | R   | R   | R    |       |
| `BACKUP_AGE_RECIPIENT`      | `age` **public** key the weekly dump is encrypted to (§4.5)              | `age1…`                                    | —   | —   | R    |       |
| `BACKUP_BUCKET`             | second-account bucket for the off-provider dump                          | `widedrop-ess-backup`                      | —   | —   | R    |       |
| `BACKUP_ENDPOINT`           | second-account S3 endpoint                                               | `https://<acct2>.r2.cloudflarestorage.com` | —   | —   | R    |       |
| `BACKUP_ACCESS_KEY_ID`      | second-account token id; cannot read the prod bucket                     | `REPLACE_ME`                               | —   | —   | R    | **S** |
| `BACKUP_SECRET_ACCESS_KEY`  | second-account token secret                                              | `REPLACE_ME`                               | —   | —   | R    | **S** |

#### Email

| Variable                  | Purpose                                                                                                   | Example / placeholder                      | dev | stg | prod | S     |
| ------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --- | --- | ---- | ----- |
| `MAIL_PROVIDER`           | `ses` \| `resend` \| `postmark` \| `smtp` \| `file` \| `noop`; only the first three allowed in production | `ses`                                      | R   | R   | R    |       |
| `MAIL_REGION`             | provider region                                                                                           | `ap-south-1`                               | —   | R   | R    |       |
| `MAIL_ACCESS_KEY_ID`      | SES IAM key id, `ses:SendEmail` only                                                                      | `REPLACE_ME`                               | —   | R   | R    | **S** |
| `MAIL_SECRET_ACCESS_KEY`  | SES IAM secret                                                                                            | `REPLACE_ME`                               | —   | R   | R    | **S** |
| `MAIL_FROM`               | envelope + header sender; must end `@widedroptech.com` (R-2)                                              | `no-reply@widedroptech.com`                | R   | R   | R    |       |
| `MAIL_CONFIGURATION_SET`  | SES configuration set carrying the SNS event destination                                                  | `ess-prod`                                 | —   | R   | R    |       |
| `SES_SNS_TOPIC_ARN`       | the only ARN the webhook accepts                                                                          | `arn:aws:sns:ap-south-1:…:ess-prod-events` | —   | R   | R    |       |
| `HELPDESK_EMAIL_FALLBACK` | used only if `organization.helpdesk_email` is unset                                                       | `helpdesk@widedroptech.com`                | R   | R   | R    |       |
| `MAIL_TO_OVERRIDE`        | staging-only recipient clamp; **refused in production**                                                   | `ess-staging@widedroptech.com`             | —   | R   | —    |       |
| `MAIL_FILE_PATH`          | dev `.eml` output directory                                                                               | `./.mail`                                  | R   | —   | —    |       |
| `SMTP_HOST` / `SMTP_PORT` | dev Mailpit only                                                                                          | `localhost` / `1025`                       |     | —   | —    |       |

#### Workers, limits, scanning, outbound

| Variable                      | Purpose                                                                                                                                                                                                                   | Example / placeholder                                                                                                | dev | stg | prod | S     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --- | --- | ---- | ----- |
| `WORKER_POLL_INTERVAL_MS`     | job loop tick, 1 000–300 000                                                                                                                                                                                              | `15000`                                                                                                              | R   | R   | R    |       |
| `WORKER_CONCURRENCY`          | parallel jobs per worker instance                                                                                                                                                                                         | `4`                                                                                                                  | R   | R   | R    |       |
| `RATE_LIMIT_STORE`            | `redis` (**default**, per `SECURITY.md` §9.3) \| `postgres`                                                                                                                                                               | `redis`                                                                                                              | R   | R   | R    |       |
| `REDIS_URL`                   | **required in staging and production**; `rediss://` (TLS) enforced in production; private network + `requirepass`. Postgres `ess_ops.rate_limit_counter` is the durable **fallback**, used only when Redis is unreachable | `rediss://…`                                                                                                         | —   | R   | R    | **S** |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `clamd` INSTREAM target; required in staging and production                                                                                                                                                               | `ess-clamav` / `3310`                                                                                                |     | R   | R    |       |
| `OUTBOUND_ALLOWLIST`          | the only hostnames the process may egress to (`SECURITY.md` §5.5)                                                                                                                                                         | `api.pwnedpasswords.com,email.ap-south-1.amazonaws.com,<acct>.r2.cloudflarestorage.com,sns.ap-south-1.amazonaws.com` | R   | R   | R    |       |

#### Observability

| Variable                    | Purpose                                                                         | Example / placeholder           | dev | stg | prod | S     |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------- | --- | --- | ---- | ----- |
| `SENTRY_DSN`                | error tracking; omit to disable                                                 | `https://…@…ingest.sentry.io/…` | —   | R   | R    | **S** |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0`–`1.0`                                                                     | `0.05`                          | —   | R   | R    |       |
| `METRICS_ENABLED`           | expose `/metrics`                                                               | `true`                          |     | R   | R    |       |
| `METRICS_BEARER_TOKEN`      | bearer required by `/metrics`; the route is also bound to the private interface | `REPLACE_ME`                    | —   | R   | R    | **S** |
| `LOG_SINK_TOKEN`            | token for the log shipper, when the platform does not forward stdout            | `REPLACE_ME`                    | —   | R   | R    | **S** |

#### Web build-time (all public, all non-secret, all baked into the bundle)

| Variable            | Purpose                                                             | Example                        |
| ------------------- | ------------------------------------------------------------------- | ------------------------------ |
| `VITE_API_BASE_URL` | the API origin; also the CSP `connect-src` value (§2.3)             | `https://api-ess.widedrop.com` |
| `VITE_APP_ENV`      | `production` \| `staging` \| `preview` \| `development`             | `production`                   |
| `VITE_BUILD_SHA`    | shown in the About panel; correlates a client report to a build     | `a1b2c3d`                      |
| `VITE_SENTRY_DSN`   | browser DSN — a public value by design, and rate-limited at Sentry  | `https://…`                    |
| `CSP_REPORT_ONLY`   | `true` for the single report-only release (§2.3); `false` otherwise | `false`                        |

A CI check fails the build if any `VITE_*` name matches `/KEY|SECRET|TOKEN|PASSWORD|PEPPER/i`.
A bundled secret is a published secret.

### 7.3 Where secrets live, per environment

| Environment        | Store                                                                                                                                                                             | Injection                        | Who can read                                |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------- |
| development        | `apps/api/.env`, git-ignored, generated by `npm run secrets:dev` (random values, never shared)                                                                                    | dotenv at boot                   | the developer                               |
| staging            | Render environment group `ess-staging`                                                                                                                                            | platform → process env           | 2 engineers                                 |
| production         | Render environment group `ess-shared` (values typed once, `sync: false` in the blueprint so they are **never** in git)                                                            | platform → process env           | 2 named owners, MFA-enforced, access logged |
| GitHub Actions     | repository/environment secrets for `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, `RENDER_API_KEY`, `RENDER_*_SERVICE_ID`; **OIDC** for GHCR and (where supported) the container host   | per-job, masked                  | workflow only                               |
| Break-glass copies | `MASTER_KEK_V*`, the `age` backup identity and the `ess_owner` password are **additionally** held offline under split knowledge by two officers (`SECURITY.md` §7.3, break-glass) | sealed envelope / hardware token | two officers, both required                 |

Inventory metadata — owner, purpose, last rotated, next due, **never a value** — lives in
`docs/secret-inventory.md` and is reviewed quarterly.

### 7.4 Boot-time validation — the process refuses to start

`apps/api/src/config/env.ts` parses a Zod schema **before** the Fastify instance exists. Any
failure prints the offending **variable names and the rule** — never a value — and calls
`process.exit(1)`, so a misconfigured container never serves a request (`SECURITY.md` §10.2).
In addition to the per-variable types in §7.2, these cross-cutting refusals apply when
`NODE_ENV=production`:

| #   | Refusal                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Any secret shorter than its minimum decoded length, or a KEK that is not exactly 32 bytes                                                                                                                                                                                                                                                               |
| 2   | Any secret whose value appears in the committed `.env.example`                                                                                                                                                                                                                                                                                          |
| 3   | Any secret matching a known placeholder (`changeme`, `dev-secret`, `REPLACE_ME`, all-zero, 32 identical bytes)                                                                                                                                                                                                                                          |
| 4   | Any secret with Shannon entropy below 3.5 bits/byte over its decoded form                                                                                                                                                                                                                                                                               |
| 5   | **The same value reused across two different variables**                                                                                                                                                                                                                                                                                                |
| 6   | `DATABASE_URL`/`DIRECT_DATABASE_URL` without `sslmode=verify-full` (the private PgBouncer hop is the single documented exception, recognised by the `ess-pgbouncer` host)                                                                                                                                                                               |
| 7   | `ALLOWED_ORIGINS` containing `*`, `http://`, or an entry that is not an exact absolute origin                                                                                                                                                                                                                                                           |
| 8   | `COOKIE_SECURE=false`, `COOKIE_SAMESITE=none`, or `COOKIE_DOMAIN` set to anything non-empty                                                                                                                                                                                                                                                             |
| 9   | `LOG_LEVEL` of `debug` or `trace`                                                                                                                                                                                                                                                                                                                       |
| 10  | `STORAGE_DRIVER=filesystem` (a container filesystem is ephemeral — payslips would vanish on redeploy)                                                                                                                                                                                                                                                   |
| 11  | `MAIL_PROVIDER` of `file`/`noop`/`smtp`, or `MAIL_TO_OVERRIDE` set                                                                                                                                                                                                                                                                                      |
| 12  | `MAIL_FROM` not ending `@widedroptech.com`                                                                                                                                                                                                                                                                                                              |
| 13  | `CLAMAV_HOST` unset                                                                                                                                                                                                                                                                                                                                     |
| 14  | `TRUSTED_PROXY_CIDRS` unset, or set to `true`/`0.0.0.0/0`                                                                                                                                                                                                                                                                                               |
| 15  | `JWT_ACTIVE_KID` with no matching `JWT_SIGNING_KEY_<kid>`, or a key that fails to parse as Ed25519 PKCS#8                                                                                                                                                                                                                                               |
| 16  | `MASTER_KEK_ACTIVE_VERSION` with no matching `MASTER_KEK_V<n>`                                                                                                                                                                                                                                                                                          |
| 17  | A `SERVICE_ROLE` other than `api` or `worker`                                                                                                                                                                                                                                                                                                           |
| 18  | `SERVICE_ROLE=api` with a `DATABASE_URL` whose role is not `ess_app`, or `SERVICE_ROLE=worker` with one whose role is not `ess_job` (§4.2); either being `ess_owner`, `ess_migrator` or `ess_backup` is fatal in every environment, including development                                                                                               |
| 19  | `PRIVATE_PORT` unset, equal to `PORT`, or below 1024                                                                                                                                                                                                                                                                                                    |
| 20  | `TZ` not exactly `UTC`, or unset (R-16) — an unset `TZ` is the dangerous case, because it defaults to UTC and therefore _looks_ correct until the host changes                                                                                                                                                                                          |
| 21  | `COOKIE_SECURE=true` while the refresh cookie name lacks the `__Host-` prefix, or `COOKIE_SECURE=false` while it carries one (§7.1)                                                                                                                                                                                                                     |
| 22  | `ALLOWED_ORIGIN_PATTERNS` set at all; and in any environment, a pattern that is not anchored with `^` and `$`                                                                                                                                                                                                                                           |
| 23  | `HELPDESK_EMAIL_FALLBACK` unset, not a syntactically valid address, or not ending `@widedroptech.com` — directive 8 names a specific recipient and a typo there loses tickets silently                                                                                                                                                                  |
| 24  | `SES_SNS_TOPIC_ARN` unset, or not matching `^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]+$`                                                                                                                                                                                                                                                             |
| 25  | `OUTBOUND_ALLOWLIST` missing any host the configuration implies it needs: the `STORAGE_ENDPOINT` host, `email.<MAIL_REGION>.amazonaws.com`, `sns.<MAIL_REGION>.amazonaws.com` when the webhook is enabled, and `api.pwnedpasswords.com` when `HIBP_ENABLED=true`. This is derived, not typed, so the list cannot drift from the configuration it guards |
| 26  | `SENTRY_TRACES_SAMPLE_RATE` outside `0.0`–`1.0`, or above `0.2` in production                                                                                                                                                                                                                                                                           |
| 27  | `CSP_REPORT_ONLY=true` on a deploy whose message does not carry the `csp-report-only` marker — the flag must be a deliberate, recorded release, never a leftover                                                                                                                                                                                        |
| 28  | any `BACKUP_*` variable present on a service other than the backup cron, or `MIGRATE_DATABASE_URL` present on the API or the worker — a credential in the wrong process is a privilege escalation waiting for a bug                                                                                                                                     |

Two further assertions run after the database connection opens, and also exit non-zero:
the **privilege assertion** of §4.4, and the **schema-guard check** — `ess_ops.schema_guard`'s
latest `schema_sha256` must match the value compiled into the image, so an API can never
serve against a schema it was not built for.

### 7.5 `.env.example`

Committed, containing **every** variable in §7.2 with a comment, an obviously non-functional
placeholder, and the exact command to mint a real value:

```dotenv
# 32 random bytes, base64. Generate: openssl rand -base64 32
MASTER_KEK_V1=REPLACE_ME__openssl_rand_base64_32
```

A CI job parses `env.ts` and `.env.example` and **fails if either contains a variable the
other lacks**, so a new secret cannot be introduced without being documented.

### 7.6 The rule about committed secrets

> **No secret is ever committed. Not temporarily, not in a branch, not in a test fixture,
> not in a comment, not in a screenshot, not "just the staging one".**

Enforced by: `.gitignore` covering `.env`, `.env.*` (except `.env.example`), `*.pem`, `*.key`,
`*.p12`, `*.jks`, `secrets/`; `gitleaks` as a pre-commit hook **and** as a CI job over the
full history on every PR; GitHub secret scanning with **push protection** enabled; build logs
scanned for secret patterns with the job failed and the log purged on a match; and
`prisma/seed.ts` containing no credential of any kind (§11.1). **A secret that reaches a
commit is compromised even after a force-push** — it is rotated per §11.6, not deleted and
forgotten.

---

## 8. CI/CD

Two workflows. `.github/workflows/ci.yml` already exists and is **extended**;
`.github/workflows/deploy.yml` is **new**. Both set `permissions: contents: read` at the top
level and widen per job. Every third-party action is pinned to a full commit SHA (shown here
as `@<sha> # vX.Y.Z` for readability). `pull_request_target` is never used.

### 8.1 On pull request — `.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

env:
  NODE_VERSION: '22'

jobs:
  quality: # typecheck · lint · format · env-parity · migration lint
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version: '22', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm rebuild @node-rs/argon2 sharp
      - run: npm run build -w @widedrop/shared
      - run: npm run db:generate -w @widedrop/api
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run format:check
      - run: node scripts/check-env-parity.mjs # env.ts ⇄ .env.example (§7.5)
      - run: node scripts/lint-migration.mjs # expand/contract rules (§4.6)
      - run: node scripts/check-vite-env-names.mjs # no secret-shaped VITE_* (§7.2)

  test: # unit + integration against a real Postgres 16
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: ess
          POSTGRES_PASSWORD: ess_ci
          POSTGRES_DB: widedrop_ess_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U ess -d widedrop_ess_test"
          --health-interval 5s --health-timeout 5s --health-retries 20
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://ess:ess_ci@127.0.0.1:5432/widedrop_ess_test?schema=public
      DIRECT_DATABASE_URL: postgresql://ess:ess_ci@127.0.0.1:5432/widedrop_ess_test?schema=public
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/setup-node@<sha>
        with: { node-version: '22', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm rebuild @node-rs/argon2 sharp
      - run: npm run build -w @widedrop/shared
      - run: npm run db:generate -w @widedrop/api
      - run: npm run db:migrate -w @widedrop/api # prisma migrate deploy
      - run: npm run db:seed:reference -w @widedrop/api
      - run: npm test # vitest: api (Fastify inject) + web
      - run: npm run build # api tsc + web vite build
      - run: node apps/web/scripts/gen-csp-headers.mjs
      - run: node apps/web/scripts/assert-no-inline-styles.mjs
      # The three directive gates of §2.8 — each fails the job.
      - run: node apps/web/scripts/assert-no-fixture-data.mjs # directive 2
      - run: node apps/web/scripts/assert-design-tokens.mjs # directive 1
      - run: npx vitest run apps/web/scripts/empty-state.spec.ts # directive 9
      - run: node scripts/assert-netlify-config.mjs
      # This exact directory is what deploy.yml publishes; it is never rebuilt.
      - uses: actions/upload-artifact@<sha>
        with: { name: web-dist, path: apps/web/dist, retention-days: 30 }

  security:
    runs-on: ubuntu-latest
    permissions: { contents: read, security-events: write }
    steps:
      - uses: actions/checkout@<sha>
        with: { fetch-depth: 0 }
      - uses: actions/setup-node@<sha>
        with: { node-version: '22', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm audit --audit-level=high # dependency audit
      - uses: gitleaks/gitleaks-action@<sha> # secret scan, full history
        env: { GITHUB_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
      - uses: semgrep/semgrep-action@<sha> # SAST
        with:
          config: >-
            p/typescript
            p/nodejs
            p/owasp-top-ten
            p/secrets
            .semgrep/widedrop.yml        # project rules: no raw SET, no === on *Hash,
                                          # no template literal in a log message,
                                          # no route without a permission declaration
      - run: docker build -f apps/api/Dockerfile -t ess-api:scan .
      - uses: aquasecurity/trivy-action@<sha> # image CVE scan
        with: { image-ref: 'ess-api:scan', severity: 'HIGH,CRITICAL', exit-code: '1' }

  codeql: # existing .github/workflows/codeql.yml
    uses: ./.github/workflows/codeql.yml
```

Five integration tests are treated as **release gates**, not ordinary tests, and are named
explicitly in the required-checks list. Each maps to a product directive that has no other
automated defender:

| Gate                             | Directive | Asserts                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `payroll-visibility.spec.ts`     | 6         | Walks the full six-step workflow and asserts `404` on every employee-facing payslip route at each earlier step, **and** asserts `SELECT count(*) FROM ess.payslip` is `0` until P6 — visibility and existence are separate claims and both are made (`SECURITY.md` Appendix A.3). It additionally attempts each out-of-order transition directly against the service layer, bypassing the HTTP routes, and asserts the state machine refuses each one. |
| `outbox.spec.ts`                 | 8         | The help-desk email-failure test of §6.5: ticket persists, outbox reaches `FAILED`, HR is notified, and no response ever claimed delivery.                                                                                                                                                                                                                                                                                                             |
| `rbac-matrix.spec.ts`            | 3         | Every route in `API.md` §13 × every persona (Employee, Manager, HR, Accounts, unauthenticated) — asserts the expected `200`/`403`/`404`, and that a route added without a declared permission fails the suite rather than defaulting to open.                                                                                                                                                                                                          |
| `audit-completeness.spec.ts`     | 5         | Every state transition and every sensitive read named in `SECURITY.md` §8 writes an `audit_event`, the chain verifies after the run, and the suite fails if a new mutating route appears with no audit assertion.                                                                                                                                                                                                                                      |
| `policy-acknowledgement.spec.ts` | 7         | A new `policy_version` resets acknowledgement for every assigned employee; an acknowledgement stores employee + version + status + timestamp; acknowledging version _n_ never satisfies version _n+1_; the count on the Policies screen equals `SELECT count(*)` over unacknowledged assignments.                                                                                                                                                      |

Plus the four build gates of §2.8, which run in the `test` job.

### 8.2 On merge to `main` — `.github/workflows/deploy.yml`

```yaml
name: Deploy
# `workflow_run` and NOT `push`. An earlier draft triggered on `push: branches: [main]`,
# which starts the deploy in parallel with `ci.yml` rather than after it: required status
# checks gate the PULL REQUEST, not the push event, so an admin merge, a direct push, or a
# merge queue bypass would have deployed code whose tests had not finished — including the
# five release gates above. `workflow_run` with the conclusion check makes a green CI run
# the only way into production.
on:
  workflow_run:
    workflows: ['CI']
    branches: [main]
    types: [completed]
  workflow_dispatch:

permissions:
  contents: read
  packages: write # GHCR push
  id-token: write # OIDC

concurrency:
  group: deploy-production # one deploy at a time, never cancelled mid-flight
  cancel-in-progress: false

jobs:
  # ---------------------------------------------------------------- 0 ----
  gate:
    runs-on: ubuntu-latest
    if: >-
      github.event_name == 'workflow_dispatch' ||
      github.event.workflow_run.conclusion == 'success'
    steps:
      - run: echo "CI ${{ github.event.workflow_run.id }} passed on ${{ github.sha }}"

  # ---------------------------------------------------------------- 1 ----
  build-image:
    needs: gate
    runs-on: ubuntu-latest
    outputs:
      digest: ${{ steps.push.outputs.digest }}
    steps:
      - uses: actions/checkout@<sha>
      - uses: docker/setup-buildx-action@<sha>
      - uses: docker/login-action@<sha>
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: push
        uses: docker/build-push-action@<sha>
        with:
          context: .
          file: apps/api/Dockerfile
          push: true
          provenance: true # SLSA attestation
          sbom: true # SBOM attached to the image
          build-args: |
            GIT_SHA=${{ github.sha }}
            BUILT_AT=${{ github.event.head_commit.timestamp }}
          tags: ghcr.io/widedrop/ess-api:${{ github.sha }}
          cache-from: type=gha
          cache-to: type=gha,mode=max

  # ---------------------------------------------------------------- 2 ----
  deploy-staging:
    needs: build-image
    environment: staging # no approval required
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - name: Migrate staging
        run: node scripts/run-migration-job.mjs --env staging
        env: { RENDER_API_KEY: '${{ secrets.RENDER_API_KEY }}' }
      - name: Deploy staging API + worker
        run: node scripts/render-deploy.mjs --env staging --digest ${{ needs.build-image.outputs.digest }}
        env: { RENDER_API_KEY: '${{ secrets.RENDER_API_KEY }}' }
      - name: Smoke test staging
        run: node scripts/smoke.mjs https://api-ess-staging.widedrop.com

  # ---------------------------------------------------------------- 3 ----
  migrate-production:
    needs: [build-image, deploy-staging]
    environment: production # ⛔ REQUIRED REVIEWER — the pipeline pauses here
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      - name: Record pre-migration recovery point
        run: node scripts/record-recovery-point.mjs >> "$GITHUB_STEP_SUMMARY"
        env: { RENDER_API_KEY: '${{ secrets.RENDER_API_KEY }}' }
      # Runs `prisma migrate status && prisma migrate deploy && record-schema-guard
      # && assert-privileges` as a Render ONE-OFF JOB on the private network, as
      # role ess_migrator, and polls to completion. No database credential ever
      # reaches the CI runner (§4.6).
      - name: Apply migrations
        run: node scripts/run-migration-job.mjs --env production --wait
        env: { RENDER_API_KEY: '${{ secrets.RENDER_API_KEY }}' }

  # ---------------------------------------------------------------- 4 ----
  deploy-api:
    needs: [build-image, migrate-production]
    environment: production
    runs-on: ubuntu-latest
    env:
      RENDER_API_KEY: ${{ secrets.RENDER_API_KEY }}
    steps:
      - uses: actions/checkout@<sha>
      # API first, then worker, each polled to `live`; a health-check failure
      # leaves the previous instances serving and fails the job.
      # `env:` is declared at JOB level, not on the second step. Attached to the
      # second `- run:` alone — as an earlier draft had it — the first step runs
      # with no RENDER_API_KEY and the API is never deployed, while the worker is:
      # a split-version production, which expand/contract does not protect against.
      - run: node scripts/render-deploy.mjs --service ess-api    --digest ${{ needs.build-image.outputs.digest }} --wait
      - run: node scripts/render-deploy.mjs --service ess-worker --digest ${{ needs.build-image.outputs.digest }} --wait
      - name: Post-deploy verification
        run: |
          node scripts/smoke.mjs https://api-ess.widedrop.com
          curl -fsS -H "Authorization: Bearer $SMOKE_TOKEN" \
            https://api-ess.widedrop.com/api/v1/version | tee /dev/stderr \
            | grep -q '"gitSha":"${{ github.sha }}"'
        env: { SMOKE_TOKEN: '${{ secrets.SMOKE_TOKEN }}' }

  # ---------------------------------------------------------------- 5 ----
  deploy-web:
    needs: deploy-api # SPA last: it may call endpoints the new API adds
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<sha>
      # Publish the EXACT directory the `test` job verified. Rebuilding here would
      # ship an artifact that no gate in §2.8 has ever seen — a different bundle
      # from the one the empty-state, fabrication and design-token gates passed.
      - uses: actions/download-artifact@<sha>
        with:
          name: web-dist
          path: apps/web/dist
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
      - name: Assert the artifact is the right build
        run: |
          grep -q 'data-build-sha="${{ github.sha }}"' apps/web/dist/index.html
          test -f apps/web/dist/_headers
          node scripts/assert-netlify-config.mjs
      - name: Assert Netlify is not self-building
        run: node scripts/assert-netlify-not-building.mjs # §2.1 production-branch lock
        env:
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      - name: Deploy to Netlify (no Netlify build minutes consumed)
        run: |
          cp infra/netlify/netlify.toml ./netlify.toml   # the CLI reads cwd (§2.5)
          npx netlify-cli@17 deploy --prod --no-build \
            --dir=apps/web/dist --site="$NETLIFY_SITE_ID" --auth="$NETLIFY_AUTH_TOKEN" \
            --message="ess-web ${GITHUB_SHA::7}" --json > deploy.json
          node scripts/record-netlify-deploy.mjs deploy.json >> "$GITHUB_STEP_SUMMARY"
        env:
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      - name: Verify headers reached the edge
        run: node scripts/assert-headers.mjs https://ess.widedrop.com
      - name: Record the deploy in the audit trail
        run: node scripts/record-deploy-audit.mjs --sha ${{ github.sha }} --approver "${{ github.actor }}"
        env: { DEPLOY_AUDIT_TOKEN: '${{ secrets.DEPLOY_AUDIT_TOKEN }}' }
```

**Deploy order is API → worker → SPA, and it is not arbitrary.** The schema is always ahead
of the API (expand/contract), the API is always ahead of the SPA, and the SPA is the only
component a user's browser caches — so at no instant does a client call an endpoint that does
not exist.

#### 8.2.1 The pipeline scripts — contracts, so none of this is left to invent

Every script named above lives in `scripts/` (or `apps/web/scripts/`), is a plain Node ESM
module, reads configuration from flags and environment only, writes machine-readable JSON to
stdout and human text to stderr, and **exits non-zero on any failure with no partial effect**.
None of them ever prints a secret, and each one masks any value it received from a `secrets.*`
context before logging.

| Script                            | Inputs                                                                                      | Does                                                                                                                                                                                                                                                              | Exit non-zero when                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `render-deploy.mjs`               | `--service <name>` \| `--env <staging\|production>`, `--digest`, `--wait`, `RENDER_API_KEY` | Resolves the service name to its id from `RENDER_SERVICE_IDS` (a JSON map in a repo variable, **not** a secret), `POST`s a deploy with `imageUrl: <repo>@<digest>`, polls every 10 s up to 15 min                                                                 | the deploy reports `build_failed`/`canceled`/`deactivated`, the health check never passes, or the poll times out |
| `run-migration-job.mjs`           | `--env`, `--wait`, `RENDER_API_KEY`                                                         | Creates a Render **one-off job** on the API service running `prisma migrate status && prisma migrate deploy && record-schema-guard && assert-privileges`; streams its log; **no database credential touches the runner**                                          | the job exits non-zero, or `prisma migrate status` reports a `failed` migration                                  |
| `record-recovery-point.mjs`       | `RENDER_API_KEY`                                                                            | Writes the current LSN and the latest provider backup id as a Markdown block for `$GITHUB_STEP_SUMMARY`; this is the PITR target §8.6 and §11.5 refer to                                                                                                          | the provider API is unreachable — a deploy must not proceed without a recorded undo point                        |
| `smoke.mjs <base-url>`            | base URL, `SMOKE_TOKEN`                                                                     | `GET /api/v1/healthz` (expects `{"status":"ok"}`), `GET /api/v1/version` with the probe credential, and one authenticated read that returns an **empty** collection; asserts CORS rejects a foreign `Origin`                                                      | any check fails, or `/api/v1/version` reports a `gitSha` other than the one deployed                             |
| `assert-headers.mjs <url>`        | url                                                                                         | Fetches `/` and one `/assets/*` file; asserts every header of §2.2 is present with the exact value, that exactly **one** `Content-Security-Policy` header is returned, that its `connect-src` names the production API, and that `Reporting-Endpoints` is present | any header missing, duplicated, or different                                                                     |
| `record-netlify-deploy.mjs`       | `deploy.json`                                                                               | Appends the deploy id, permalink and commit to the job summary — this is the list §8.4's rollback picks from                                                                                                                                                      | the JSON has no `deploy_id`                                                                                      |
| `assert-netlify-not-building.mjs` | `NETLIFY_SITE_ID`, `NETLIFY_AUTH_TOKEN`                                                     | `getSite`; asserts `build_settings.stop_builds === true` **or** `build_settings.repo_branch !== 'main'` (§2.1)                                                                                                                                                    | the site would build `main` itself                                                                               |
| `assert-netlify-config.mjs`       | `infra/netlify/netlify.toml`, `apps/web/dist/_headers`                                      | The §2.8 Netlify-config gate                                                                                                                                                                                                                                      | publish path wrong, redirect order wrong, or a header name in both files                                         |
| `record-deploy-audit.mjs`         | `--sha`, `--approver`, `DEPLOY_AUDIT_TOKEN`                                                 | `POST /api/v1/admin/deploys` so the deploy lands in `ess.audit_event` as `ADMIN.DEPLOYED` with the approving GitHub identity (§8.3)                                                                                                                               | the API rejects it — a deploy that cannot be audited is reported as a failed deploy                              |

**`SMOKE_TOKEN` and `DEPLOY_AUDIT_TOKEN` are not personal credentials**, and leaving them
undefined would have been the largest hole in this pipeline: a static bearer that can
authenticate to production, of unstated scope, held by CI. Each is the credential of a
dedicated `app_user` of kind `SERVICE` with:

- **no `employee` row**, so it can never be a subject of payroll, leave or policy data;
- exactly one permission each — `auth:login` + `health:read` for the smoke probe,
  `admin:deploy:record` for the audit poster — and **no** read permission over any employee
  record, payslip, ticket or document;
- MFA not applicable (it is not interactive) but **IP-bound** to the CI egress ranges and
  rate-limited to 60 requests/hour, so a leaked token is useless from anywhere else;
- a 90-day expiry enforced by the `session-sweep` job, listed in `docs/secret-inventory.md`,
  and rotated by §11.6 C3 like any other application secret;
- every use written to `ess.audit_event` with `actor_kind='SERVICE'`, so "CI read production"
  is a query, not an assumption.

The same treatment applies to the **synthetic-login probe account** of §9.4: it is a real
`app_user` with an `employee` row in a dedicated `Monitoring` department, holds only the
Employee persona, owns no payroll data (it never appears in a `payroll_cycle`), and its
dashboard is legitimately empty — which is also a continuous, production-side test of
directive 9.

### 8.3 Environment protection and required checks

| Control                         | Setting                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch protection on `main`     | linear history; no force-push; no deletion; **required reviewers 1** (2 for anything under `apps/api/src/auth/**`, `apps/api/src/crypto/**`, `prisma/migrations/**`, `infra/**`, `.github/workflows/**` via `CODEOWNERS`)                                                                                                                                                                                           |
| Required status checks          | `quality`, `test`, `security`, `codeql`, and the five release gates `payroll-visibility`, `outbox`, `rbac-matrix`, `audit-completeness`, `policy-acknowledgement`, plus the four build gates `fixture-data`, `empty-state`, `design-tokens`, `netlify-config` (§2.8) — all must pass, and the branch must be up to date                                                                                             |
| GitHub environment `staging`    | no reviewer; secrets scoped to staging                                                                                                                                                                                                                                                                                                                                                                              |
| GitHub environment `production` | **required reviewer** (a named ops owner, who may not be the PR author), a 10-minute wait timer, deployment branch restricted to `main` only, secrets scoped to production                                                                                                                                                                                                                                          |
| Secrets in CI                   | no long-lived cloud credentials: OIDC to GHCR; `RENDER_API_KEY` scoped to deploy-only; Netlify token scoped to the ESS site. CI never receives a database URL, a KEK, a JWT key or a mail credential.                                                                                                                                                                                                               |
| Actions hygiene                 | all actions pinned to a full SHA; `permissions:` least-privilege per job; `npm ci --ignore-scripts`; Dependabot on `npm`, `docker` and `github-actions`                                                                                                                                                                                                                                                             |
| Image retention                 | GHCR keeps **every digest deployed to production for 180 days and never fewer than the last 20**, because §8.5's rollback is a redeploy of a previous digest and a pruned image is an unavailable rollback. The cleanup workflow deletes only untagged digests older than 30 days that were never deployed, and reads the deployed set from `ess.audit_event` (`ADMIN.DEPLOYED`) rather than from a tag convention. |
| Merge queue / admin merges      | branch protection applies to administrators (`enforce_admins: true`); there is no bypass list. This matters because `deploy.yml` now triggers on a successful `CI` run — an unprotected direct push would simply never deploy, which is the correct failure, but an admin bypass with `CI` green would.                                                                                                             |
| Audit                           | every production deploy writes an `audit_event` of kind `ADMIN.DEPLOYED` (actor = the approving GitHub user, from the workflow's OIDC claims) via the post-deploy step, so a deploy is in the same trail as a payroll publication                                                                                                                                                                                   |

### 8.4 Rollback — the SPA

Netlify deploys are immutable and atomic, so rollback is a publish of a prior deploy.

```bash
# 1. list recent deploys and pick the last known-good id
npx netlify-cli@17 api listSiteDeploys --data '{"site_id":"'"$NETLIFY_SITE_ID"'"}' \
  | jq -r '.[] | select(.state=="ready") | "\(.id)  \(.created_at)  \(.title)"' | head -10

# 2. restore it — atomic, ~10 seconds, no rebuild
npx netlify-cli@17 api restoreSiteDeploy \
  --data '{"site_id":"'"$NETLIFY_SITE_ID"'","deploy_id":"<good-deploy-id>"}'

# 3. verify
curl -sI https://ess.widedrop.com | grep -i cache-control        # index.html: no-store
curl -s  https://ess.widedrop.com/ | grep -o 'data-build-sha="[^"]*"'
```

`index.html` is `no-store`, so the rollback reaches every client on their next navigation
rather than after a cache TTL. Hashed assets are immutable, so a client mid-session keeps
working against the assets it already holds. Also available in the Netlify UI:
Deploys → the good deploy → **Publish deploy**.

### 8.5 Rollback — the API

```bash
# Previous digests are in the workflow run summary and in GHCR.
node scripts/render-deploy.mjs --service ess-api    --digest sha256:<previous> --wait
node scripts/render-deploy.mjs --service ess-worker --digest sha256:<previous> --wait
curl -s https://api-ess.widedrop.com/api/v1/version   # confirm gitSha is the previous one
```

Equivalent in the Render UI: service → Events → the previous deploy → **Rollback**. Because
images are addressed by digest and `autoDeploy: false`, a rollback is deterministic and
cannot be re-overwritten by a stray push.

**Time to rollback: under 3 minutes for both services.** It is the first response to any
production incident that began at a deploy — investigate afterwards, from logs, not from a
broken production.

### 8.6 Rollback — a migration

There is no `down` migration (§4.6), and there does not need to be:

| Scenario                                                                           | Response                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migration applied, new API bad                                                     | **Roll the API image back only.** The expand-phase schema is compatible with the previous image by construction. Do not touch the database.                                                                                                                                                                                                    |
| Migration itself is wrong but harmless (a bad index, a wrong default)              | Fix forward: a new migration in the next deploy.                                                                                                                                                                                                                                                                                               |
| Migration is wrong and destructive (contract phase dropped something still needed) | This is why the contract phase is a separate deploy two releases later, and why the linter forbids destructive DDL alongside its replacement. If it still happens: PITR restore (§4.5) to the pre-migration recovery point recorded in the job summary, then forward-fix. Declare an incident; a restore rewinds every write since that point. |
| Migration left `failed` in `_prisma_migrations`                                    | Repair by hand on `DIRECT_DATABASE_URL`, then `prisma migrate resolve --applied <name>` or `--rolled-back <name>`. **Never** `migrate reset`. Write the incident up before the next deploy is approved.                                                                                                                                        |

### 8.7 Dependency and supply-chain posture in the pipeline

`npm audit --audit-level=high` fails the PR; Dependabot raises weekly PRs across npm, Docker
and Actions; Trivy fails the build on a `HIGH`/`CRITICAL` image CVE; the image ships a
**provenance attestation and an SBOM**; `npm ci --ignore-scripts` is the default, with
`@node-rs/argon2` and `sharp` rebuilt in an explicit, reviewable step; and the lockfile is
committed and never regenerated in CI.

---

## 9. Observability

### 9.1 Structured logs

`pino` JSON to stdout, one line per event, shipped by the platform to the log backend. Every
line carries: `time` (ISO-8601 UTC), `level`, `service` (`ess-api` \| `ess-worker`), `env`,
`version` (git SHA), `requestId`, `route` (**templated** — `/payslips/:id`, never the id),
`method`, `statusCode`, `durationMs`, `userId` (uuid only), `sessionId`, `roles`, `ipHash`,
`outcome`.

`requestId` is taken from an inbound `X-Request-Id` when it is a valid UUID, otherwise
generated; it is echoed in the response header, stored on `audit_event.request_id`, and
**propagated into worker jobs via the job payload** — so one identifier ties an HTTP request,
its audit rows, its logs and its background work together. This is what makes "why did this
employee's payslip not appear?" a single query rather than an investigation.

**PII redaction is two independent mechanisms**, because either alone fails
(`SECURITY.md` §11.2):

1. **Denylist** (`pino.redact`) at every depth: `authorization`, `cookie`, `x-wd-csrf`,
   `set-cookie`, `*.password`, `*.token`, `*.refreshToken`, `*.accessToken`, `*.secret`,
   `*.totp`, `*.otp`, `*.code`, `*.recoveryCode`, `*.pan`, `*.aadhaar`, `*.accountNumber`,
   `*.ifsc`, `*.dateOfBirth`, `*.personalEmail`, `*.personalPhone`, `*.currentAddress`,
   `*.permanentAddress`, `*.ciphertext`, `*.body`.
2. **Allowlist — the real control.** Request and response **bodies are never logged at all**;
   the HTTP logger emits only the fixed field list above. An ESLint rule forbids template
   literals and string concatenation in a logger's message argument, which is what stops
   ``log.info(`saving ${email}`)`` — the single most common PII leak into logs.

Never logged under any level: passwords or derivatives; access/refresh/reset/invite/CSRF
tokens; TOTP secrets, codes or recovery codes; any DEK, KEK, pepper or HMAC key; decrypted
PAN/Aadhaar/UAN/bank/address/DOB/personal contact values; **payslip amounts**; ticket, leave
or rejection free text; raw client IPs or user-agent strings (hashes only); full SQL
parameter values (Prisma query logging is `warn`+ in production, never `query`).

Retention: **30 days hot, 180 days cold, then deleted.** Logs are an operational artefact;
`ess.audit_event` is the record of truth and has its own, longer retention
(`DATA-MODEL.md` §18.3).

### 9.2 Health, readiness and version endpoints

| Endpoint              | Exposure                                               | Semantics                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/healthz` | public, `ip` 60/min, `Cache-Control: no-store`         | **Liveness only, touching no dependency** — `200 {"status":"ok"}`. Wired to the container `HEALTHCHECK` and to Render's `healthCheckPath`. A Postgres blip must not restart-loop the API.                                                                                                                                                                                                   |
| `GET /api/v1/readyz`  | **`PRIVATE_PORT` listener only** (see below)           | `200 {"status":"ready","checks":{"db":"ok","objectStorage":"ok","kms":"ok","rateLimitStore":"ok","mailProvider":"degraded"}}` or `503`. `db`, `kms` and `rateLimitStore` failing ⇒ not ready. **`mailProvider: "degraded"` does not fail readiness** — the outbox absorbs it (§6.5). Flips to `503` immediately on `SIGTERM` so the platform drains the instance before it stops accepting. |
| `GET /api/v1/version` | requires `auth:login`                                  | `{"apiVersion","gitSha","builtAt","schemaSha256","payrollEngineVersion"}`. No dependency versions, no hostnames, no env names — a version endpoint is reconnaissance surface.                                                                                                                                                                                                               |
| `GET /api/v1/metrics` | **`PRIVATE_PORT` listener** and `METRICS_BEARER_TOKEN` | Prometheus exposition (§9.3)                                                                                                                                                                                                                                                                                                                                                                |

**What "private interface" actually means here, because a Render web service has exactly one
public port.** There is no separate network interface to bind to; saying "internal only"
without a mechanism is how an endpoint that leaks authentication-failure counts and
dependency health ends up on the internet. The mechanism:

- the API process starts **two** Fastify instances: the public one on `PORT` (4000) carrying
  every business route, and a second on `PRIVATE_PORT` (4001) carrying **only**
  `/api/v1/readyz` and `/api/v1/metrics`;
- Render routes `PORT` and nothing else, so 4001 is reachable only from inside the Render
  private network, at `http://ess-api:4001` — which is where the metrics agent and the
  readiness prober point;
- the public instance **does not register those two routes at all**. It is not a 403 on the
  public port; the routes do not exist there, and the boot-time route assertion asserts that
  (`SECURITY.md` §4.8, `config: { internal: true }`);
- `/api/v1/metrics` additionally requires `Authorization: Bearer $METRICS_BEARER_TOKEN`,
  compared in constant time, so a compromised neighbour on the private network still cannot
  read it;
- `HOST` binds `0.0.0.0` for both, because the private network requires it; the isolation
  comes from the platform's routing, not from the bind address, and that distinction is
  written down here so nobody "hardens" it to `127.0.0.1` and breaks the scraper.

If the platform ever routes a second port, the fallback is the same two-instance split plus
a source-IP check against the private CIDR — never a change to the route's permission alone.

**Path consistency.** All four endpoints live under `/api/v1` (R-14). `SECURITY.md` writes
them unprefixed (`/healthz`, `/readyz`, `/metrics`) as shorthand; `API.md` §13 is canonical
and prefixes them. `/.well-known/jwks.json` is the single unprefixed route in the system.

### 9.3 Metrics worth collecting

Prometheus counters and histograms (`SECURITY.md` §11.3), scraped by the platform's metrics
agent or Grafana Cloud's agent:

| Group            | Metrics                                                                                                                                                                                                                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP**         | `http_requests_total{route,status}`, `http_request_duration_seconds{route}` (p50/p95/p99), `http_response_size_bytes`                                                                                                                                                                                            |
| **Auth**         | `auth_login_total{outcome}`, `auth_lockout_total`, `mfa_failure_total`, `refresh_reuse_total`, `authz_denied_total{permission,role}`                                                                                                                                                                             |
| **Abuse**        | `rate_limit_tripped_total{route}`, `csrf_rejected_total{reason}`, `upload_rejected_total{reason}`                                                                                                                                                                                                                |
| **Privacy**      | `pii_unmask_total{kind,actor_role}`, `export_total{kind}`                                                                                                                                                                                                                                                        |
| **Payroll**      | `payroll_state_transitions_total{from,to}`, **`payroll_cycle_duration_seconds{phase}`** (a histogram per phase: input upload → attendance submitted → manager approved → validated → calculated → published), `payroll_validation_failures_total{check}`, `payslips_generated_total`, `payslips_published_total` |
| **Queues**       | `outbox_pending`, `outbox_failed_total`, `outbox_send_duration_seconds`, `background_job_duration_seconds{job_name}`, `background_job_failures_total{job_name}`, `background_job_lease_expired_total`                                                                                                            |
| **Integrity**    | `audit_chain_verification_failures_total`, `audit_write_latency_seconds`, `decrypt_failures_total`, `file_integrity_mismatch_total`, `orphan_ciphertext_total`, `shadow_object_total`                                                                                                                            |
| **Dependencies** | `db_pool_in_use`, `db_query_duration_seconds`, `pgbouncer_cl_waiting`, `hibp_degraded_total`, `clamav_unavailable_total`, `ses_send_failures_total{reason}`                                                                                                                                                      |

`payroll_cycle_duration_seconds` earns its place: it is the single number that tells HR
whether the mandated six-step workflow is being completed on time, and its per-phase split
shows _which_ actor is the bottleneck — all derived from persisted `payroll_cycle` timestamps,
never from an estimate.

### 9.4 Uptime checks

| Check            | Target                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Interval | From                             | Fails after   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------- | ------------- |
| API liveness     | `GET https://api-ess.widedrop.com/api/v1/healthz` expecting `200` and `"ok"`                                                                                                                                                                                                                                                                                                                                                                                 | 60 s     | 3 regions incl. Mumbai/Singapore | 2 consecutive |
| SPA availability | `GET https://ess.widedrop.com/` expecting `200` and the `Strict-Transport-Security` header                                                                                                                                                                                                                                                                                                                                                                   | 60 s     | 3 regions                        | 2 consecutive |
| Synthetic login  | scripted `login → MFA → GET /me/dashboard` with a dedicated, least-privileged probe account                                                                                                                                                                                                                                                                                                                                                                  | 15 min   | 1 region                         | 2 consecutive |
| TLS expiry       | both hosts                                                                                                                                                                                                                                                                                                                                                                                                                                                   | daily    | —                                | < 21 days     |
| Worker heartbeat | the worker completes an `ess_ops.background_job` row with `job_name='worker-heartbeat'` every minute, setting `finished_at = now()`; a dead-man check alerts if `max(finished_at)` for that job name is older than 5 minutes. **R-17: `worker-heartbeat` is not in the named-job list of `DATA-MODEL.md` §17.5 and must be added there**, or the job-name check constraint rejects every heartbeat row and the alert fires permanently from the first deploy | 60 s     | —                                | 5 min         |
| DNS drift        | `ess`, `api-ess`, and the apex/`www`/`MX` of `widedrop.com` compared against `infra/dns/*.before.txt`                                                                                                                                                                                                                                                                                                                                                        | daily    | —                                | any diff      |

The worker heartbeat matters more than it looks: a worker that dies silently stops the
outbox, the SLA escalations, the leave accruals and the payroll calculation, and **nothing in
the UI would show an error** — the symptoms would be "my ticket email never arrived" a day
later. The dead-man check converts that into a page.

### 9.5 Alert thresholds

Defined in `infra/monitoring/alerts.yaml`, reviewed quarterly, every P1 with a runbook in
`docs/runbooks/`.

| Alert                                       | Condition                                                                                                                    | Sev    | Route                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ | ------------------------------------------------ |
| API down                                    | uptime check failing 2×                                                                                                      | **P1** | page                                             |
| Error rate                                  | `5xx` > 2 % of requests over 5 min, or any `500` on `/auth/*`                                                                | **P1** | page                                             |
| Latency                                     | p95 > 2 s for 10 min                                                                                                         | **P2** | alert channel                                    |
| Refresh-token reuse                         | any `AUTH.REFRESH_REUSE_DETECTED`                                                                                            | **P1** | page + email the affected user                   |
| Audit chain broken                          | any verification failure                                                                                                     | **P1** | page                                             |
| Decrypt failure / AAD mismatch              | `decrypt_failures_total` > 0                                                                                                 | **P1** | page                                             |
| Mass PII unmask                             | `pii_unmask_total` > 30 per actor per hour                                                                                   | **P1** | page + auto-suspend that session pending review  |
| Malware in upload                           | any `SECURITY.UPLOAD_MALWARE_DETECTED`                                                                                       | **P1** | page                                             |
| Database                                    | connections > 80 % of `max_connections`, disk > 80 %, replication/PITR lag > 15 min, or `pgbouncer_cl_waiting` > 0 for 5 min | **P1** | page                                             |
| Worker dead                                 | heartbeat older than 5 min                                                                                                   | **P1** | page                                             |
| Credential-stuffing wave                    | > 100 `AUTH.LOGIN_FAILED` org-wide in 5 min, or ≥ 25 distinct accounts from one `ip_hash` in 10 min                          | **P2** | alert channel                                    |
| Failed logins, single account               | > 10 in 10 min for one account                                                                                               | **P2** | alert + notify the user                          |
| Payroll published outside the change window | `PAYROLL.RUN_PUBLISHED` outside the configured window, or by a first-time publisher                                          | **P2** | alert + HR notification                          |
| Payroll cycle stalled                       | a cycle in one phase > 72 h, or `payroll_cycle_duration_seconds` beyond the 90th percentile of the last 6 cycles             | **P2** | alert to HR + Accounts                           |
| Bulk approvals                              | > 100 approve/reject by one actor in an hour                                                                                 | **P2** | alert (rubber-stamping or a compromised manager) |
| Role granted                                | any `ADMIN.ROLE_GRANTED` for `HR`/`ACCOUNTS`                                                                                 | **P2** | alert channel, **always**, even when legitimate  |
| Export volume                               | any export > 1 000 rows, or > 3 exports per actor per day                                                                    | **P2** | alert                                            |
| Spam complaint                              | any SES `Complaint`                                                                                                          | **P2** | alert                                            |
| Outbox backlog                              | `outbox_pending` > 50 for 15 min, or any `TICKET.EMAIL_FAILED`                                                               | **P3** | ticket                                           |
| Job failures                                | `background_job_failures_total{job_name}` > 3 in an hour                                                                     | **P3** | ticket                                           |
| Breach-check degraded                       | `hibp_degraded_total` rising for 15 min                                                                                      | **P3** | ticket                                           |
| ClamAV unavailable                          | `clamav_unavailable_total` > 0 for 30 min (uploads are piling up `QUARANTINED`)                                              | **P3** | ticket                                           |
| CSP violations                              | a new `blocked-uri` appearing after a release                                                                                | **P3** | ticket                                           |
| Cert expiry / DNS drift                     | < 21 days / any diff                                                                                                         | **P3** | ticket                                           |

**Alert hygiene:** every alert names the runbook that resolves it; an alert that fires more
than twice without action is either fixed or deleted; P1 pages a human, P2 posts to the
on-call channel, P3 opens a ticket. There is no "informational" severity — an alert nobody
acts on trains people to ignore the ones that matter.

### 9.6 Error tracking

Sentry (or GlitchTip, self-hosted, if a processor must be avoided), with PII scrubbing
configured **before** the first event is sent:

| Setting            | Value                                                                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sendDefaultPii`   | **`false`**                                                                                                                                                                                                         |
| `beforeSend`       | drops the event entirely if its message or any frame's local variables match the denylist of §9.1; strips `request.data`, `request.cookies`, `request.headers.authorization`, and every query string                |
| User context       | `{ id: <uuid>, roles: [...] }` only — **never** an email, a name, or an employee code                                                                                                                               |
| Breadcrumbs        | `console` and `fetch` breadcrumbs carry the **templated** route and the status only; the URL's path parameters are masked (`/payslips/[id]`)                                                                        |
| `tracesSampleRate` | `0.05` server, `0.02` browser                                                                                                                                                                                       |
| Release            | the git SHA, so an error maps to a deploy; source maps uploaded **and then deleted from the published bundle** (`sourcemap: 'hidden'` in the Vite production config — they are needed by Sentry, not by the public) |
| Data residency     | Sentry's `de`/`us` region choice recorded in `docs/PROCESSORS.md`; only scrubbed, identifier-level data leaves the primary region                                                                                   |
| Retention          | 90 days                                                                                                                                                                                                             |

The browser DSN is public by design (it is in the bundle) and is rate-limited and
origin-restricted at Sentry. The server DSN is a secret (§7.2).

---

## 10. Cost

Indicative USD/month for a small organisation (~120 employees, ~40 daily active users, one
payroll cycle a month, < 5 GB of documents in year one). **List prices as understood in 2026;
re-verify before committing — the ratios matter more than the absolutes.**

### 10.1 Recommended production configuration

| Line                        | Service                         | Spec                                                 | $/mo      |
| --------------------------- | ------------------------------- | ---------------------------------------------------- | --------- |
| ESS SPA                     | Netlify (free tier, own team)   | static hosting, built in CI so 0 build minutes       | **0**     |
| API                         | Render Web Service × 2          | Standard, 1 vCPU / 2 GB, `singapore`                 | 50        |
| Worker                      | Render Background Worker × 1    | Starter, 0.5 vCPU / 512 MB                           | 7         |
| PgBouncer                   | Render Private Service × 1      | Starter                                              | 7         |
| ClamAV                      | Render Private Service × 1      | Standard, 2 GB (signature DB)                        | 25        |
| Database                    | Render PostgreSQL               | Standard, 4 GB RAM / 100 GB SSD, daily backup + PITR | 95        |
| Staging (API + worker + DB) | Render                          | Starter × 2 + Postgres Basic                         | 33        |
| Object storage              | Cloudflare R2                   | 20 GB stored, ~200k Class-A/B ops, **zero egress**   | 2         |
| Off-provider backup bucket  | R2 in a second account          | 20 GB, object-lock                                   | 1         |
| Backup cron                 | Render Cron Job × 1             | Starter, weekly `pg_dump` + `age` + upload (§4.5)    | 1         |
| Email                       | Amazon SES `ap-south-1`         | ~8 000 messages                                      | 1         |
| Error tracking              | Sentry Team                     | 50k events, 90-day retention                         | 26        |
| Logs                        | Better Stack / Grafana Cloud    | ~10 GB ingest, 30 d hot                              | 25        |
| Uptime + status page        | Better Stack Uptime             | 6 monitors, 60 s, 3 regions                          | 8         |
| DNS                         | existing registrar / Cloudflare | 2 records added                                      | 0         |
| Container registry          | GHCR                            | under the free private allowance                     | 0         |
| CI                          | GitHub Actions                  | ~600 min/mo on a private repo (2 000 free)           | 0         |
|                             |                                 | **Total**                                            | **≈ 281** |

Roughly **$2.30 per employee per month**, all-in, for a system that holds payroll.

### 10.2 What drives the number

| Driver             | Comment                                                                                                                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Database plan (95) | the single largest line, and it is bought for **PITR and backup retention**, not for size or speed. Do not economise here — it is the difference between a 2-hour recovery and a permanent loss of payroll history. |
| ClamAV (25)        | an awkward cost for a rarely-used service, but `clamd` needs 2 GB resident. §10.3 gives the cheaper arrangement and its trade-off.                                                                                  |
| Egress (≈ 0)       | R2's zero-egress pricing is why storage is $2 rather than $20–40: payslip and Form 16 downloads are pure egress, and they spike every month-end and every July.                                                     |
| Netlify (0)        | free tier is genuinely sufficient because the SPA is static and built in CI. The account-wide build-minute risk to the marketing site is eliminated by §2.5, not merely tolerated.                                  |
| Staging (33)       | the cheapest insurance in the table. Do not delete it to save $33; it is where migrations and key rotations are rehearsed.                                                                                          |

### 10.3 Cheapest viable configuration, and what it sacrifices

| Line                    | Change                                                                    | $/mo     |
| ----------------------- | ------------------------------------------------------------------------- | -------- |
| API                     | 1 × Starter instead of 2 × Standard                                       | 7        |
| Worker                  | Starter (unchanged)                                                       | 7        |
| PgBouncer               | **removed** — Prisma `connection_limit=5` on a single instance            | 0        |
| ClamAV                  | **co-located in the worker container** on a Standard plan (worker 7 → 25) | +18      |
| Database                | Render PostgreSQL **Basic**, 1 GB / 16 GB SSD, daily backup, **no PITR**  | 19       |
| Staging                 | **removed**                                                               | 0        |
| Logs                    | platform stdout retention only (7 days)                                   | 0        |
| Errors                  | GlitchTip self-hosted on the worker box, or Sentry free (5k events)       | 0        |
| Uptime                  | Healthchecks.io / UptimeRobot free                                        | 0        |
| Storage, email, SPA, CI | unchanged                                                                 | 3        |
|                         | **Total**                                                                 | **≈ 54** |

**What that sacrifices, stated plainly so the decision is informed:**

1. **No PITR.** RPO goes from 5 minutes to **24 hours**. A bad `UPDATE` at 16:00 costs the
   whole day. For a payroll system this is the sacrifice to think hardest about; the weekly
   off-provider `pg_dump` (§4.5) becomes _essential_ rather than a belt-and-braces measure,
   and should be moved to daily.
2. **No zero-downtime deploys.** One API instance means every deploy and every platform
   restart is a 20–40 second outage. Acceptable for an internal portal deployed outside
   business hours; not acceptable during a payroll publication window.
3. **No redundancy.** One instance dying is an outage until the platform restarts it.
4. **No staging**, so migrations, key rotations and payroll changes are rehearsed in
   production. This is the change most likely to cause the incident the other savings then
   have to survive. If only one line is restored from this list, restore staging.
5. **No connection pooler**, so the instance count can never grow without revisiting §4.3,
   and a connection leak becomes an outage rather than a queue.
6. **7-day log retention**, so any investigation older than a week has only
   `ess.audit_event` to work from. The audit trail is deliberately designed to be sufficient
   for the _security_ questions; it is not sufficient for performance forensics.
7. **ClamAV in the worker** couples upload scanning to job processing: a payroll run at 100 %
   CPU slows virus scanning, and an OOM in either kills both.

**Recommended middle path (~$150):** keep PITR (Standard database), keep staging, run
1 × Standard API, drop the paid log backend, keep ClamAV separate. That preserves every
_recovery_ and _rehearsal_ property and gives up only redundancy and log depth.

### 10.4 Scaling markers

| Marker                        | Change                                                             | Added $/mo |
| ----------------------------- | ------------------------------------------------------------------ | ---------- |
| > 500 employees               | API 2 → 3 Standard; database → 8 GB                                | ~70        |
| > 200 rps sustained           | rate-limit store → managed Redis (`RATE_LIMIT_STORE=redis`)        | ~15        |
| Payroll run > 10 min          | worker Starter → Standard, `WORKER_CONCURRENCY` 4 → 8              | 18         |
| In-country residency required | Fly.io `bom` + Neon/Crunchy `ap-south-1` (§3.7)                    | ~+20       |
| Audit retention > 8 years     | partition `ess.audit_event` by year, archive cold partitions to R2 | ~5         |

---

## 11. Runbooks

Each lives in `docs/runbooks/<name>.md` as the executable copy; this section is the
authority for their content. Every runbook ends by writing what actually happened to
`docs/runbooks/oplog.md` with the date, operator and elapsed time.

### 11.1 First-time production bootstrap

**Goal:** a serving production system with exactly one HR/Accounts administrator who set
their own password, and **no default credential anywhere in the system at any instant**.

**Pre-conditions:** §2.7 DNS verified; the `production` GitHub environment created with its
reviewer; every secret in §7.2 minted fresh (`openssl rand -base64 48`, `openssl rand -base64 32`
for the KEK, `openssl genpkey -algorithm ed25519` for the JWT key) and typed into the Render
environment group — never generated on a laptop that syncs to cloud storage, never pasted
into a chat.

```
B1.  Apply the blueprint: create ess-postgres, ess-pgbouncer, ess-clamav, ess-api,
     ess-worker. Confirm ipAllowList is [] and neither private service has a public URL.
B2.  Seal the break-glass envelope: MASTER_KEK_V1, the age backup identity and the
     ess_owner password, split between two officers (§7.3). Record in secret-inventory.md.
     Do this BEFORE any data exists — a KEK lost after go-live is unrecoverable ciphertext.
B3.  Create the database roles (§4.4) as ess_owner, with fresh passwords, and apply the
     statement/lock timeouts. HOW: the database has no public endpoint (ipAllowList: []),
     so there is no psql from a laptop. Run it as a Render ONE-OFF JOB on the private
     network:
       render jobs create --service ess-api --command \
         "psql \"$ESS_OWNER_URL\" -v ON_ERROR_STOP=1 \
            -v migrator_pw=... -v app_pw=... -v job_pw=... -v ro_pw=... \
            -v backup_pw=... -v auth_pw=... -f apps/api/prisma/sql/roles.sql"
     ESS_OWNER_URL is supplied to that one job as a one-off environment override and is
     REMOVED from the service immediately afterwards; it is never in the environment group
     and never in git. Verify with `render env list` that it is gone, then close the
     ess_owner session and do not reopen it outside §11.6.
B4.  Run the migration job: prisma migrate deploy → record-schema-guard → assert-privileges.
     assert-privileges MUST pass; if it does not, stop — the grants are wrong.
B5.  Deploy ess-api and ess-worker on the first image digest. /healthz green on PORT;
     /readyz on PRIVATE_PORT (curl it from another private service — it is not routed,
     §9.2) reporting all "ok" except mailProvider, which may be "degraded" until B7.
     Then PIN TRUSTED_PROXY_CIDRS to the observed value: call the staging-only route
     GET /api/v1/debug/forwarded through the real edge, read back the full
     X-Forwarded-For chain and the socket address, and record the platform's proxy
     addresses as exact CIDRs in the environment group. Record them in
     infra/dns/proxy-cidrs.txt with the date. Every rate limit, lockout counter and
     ip_hash on this system is keyed on the address this setting produces; leaving the
     placeholder means a client can prepend its own X-Forwarded-For and choose its own
     rate-limit bucket.
B6.  Seed reference data: npm run db:seed:reference.  (Run as a one-off job, role
     ess_migrator. `db:seed:demo` is a DIFFERENT script and REFUSES to run when
     NODE_ENV=production or when the target database answers to the production host —
     it is the only thing in the repository that can manufacture an operational row, so
     it is refused twice, at the script and at the package.json level.)
     This writes ONLY configuration — leave types and schemes, holiday calendar, document
     types, ticket categories, expense categories, notification kinds, permission and role
     rows, tax slabs for the FY. It creates NO employee, NO payslip, NO ticket, NO
     announcement, NO balance. Every insert is audited with actor_kind='MIGRATION'.
     Verify: SELECT count(*) FROM ess.employee;  →  0
             SELECT count(*) FROM ess.payslip;   →  0
     The portal at this point is a correct, fully-rendered EMPTY system: every screen shows
     its designed empty state (directive 9). Open it and confirm that before adding anyone.
B7.  Verify SES: DKIM CNAMEs resolving, SPF/DMARC published, the domain "Verified" in the
     SES console, MAIL_FROM domain verified. Send one test to helpdesk@widedroptech.com and
     confirm the SNS Delivery event reaches /api/v1/webhooks/ses.
B8.  Create the organisation row and its settings via the bootstrap tool, audited as
     ADMIN.ORG_CREATED: legal name, PAN/TAN, registered address, financial year start =
     April, timezone = Asia/Kolkata (R-16 — every date in the product resolves through
     this value), locale = en-IN, currency = INR, pay-day rule, business hours, and
     helpdesk_email = helpdesk@widedroptech.com (directive 8; HELPDESK_EMAIL_FALLBACK is
     only used until this row exists).
     NOTE — reconcile with DATA-MODEL.md §18.1, which lists `organization` among the rows
     written by db:seed:reference. Exactly one of the two must own it. This document's
     position: the seeder writes NOTHING organisation-specific, because seeding is
     idempotent-by-natural-key and an organisation's PAN/TAN is not reference data. B8
     owns it, and §18.1's `organization` row should be struck (**R-21**). Whichever is
     chosen, it must be one of them: two writers means a re-seed silently reverts an HR
     edit to the legal address.
B9.  CREATE THE FIRST ADMINISTRATOR — no password is involved at any point:

       render jobs create --service ess-api --command \
         "node apps/api/dist/scripts/bootstrap-admin.js \
            --email first.admin@widedroptech.com \
            --employee-code WD0001 \
            --full-name '<name>' \
            --roles HR,ACCOUNTS"

     What the script does:
       · REFUSES and exits 1 if any app_user already holds HR or ACCOUNTS — it is a
         one-time bootstrap, not a back door, and it cannot be used to mint a second admin;
       · creates the employee and the app_user in status INVITED with NO password hash
         column populated at all (not an empty string, not a default — NULL);
       · mints a 32-byte random activation token, stores ONLY its SHA-256, expires_at =
         now() + 60 minutes, single use;
       · enqueues an email_outbox row of kind USER_INVITE to that address, which the worker
         delivers through SES;
       · prints the token to stdout ONLY when --print-link is passed, as an explicit
         break-glass path for when mail is not yet working;
       · writes USER.INVITED and ADMIN.BOOTSTRAP_ADMIN_CREATED audit events.

B10. The administrator opens the emailed link at https://ess.widedrop.com/activate?token=…,
     sets their own password (checked against HIBP, Argon2id + pepper), and is FORCED
     through TOTP enrolment before the account can reach ACTIVE — HR and ACCOUNTS have no
     MFA grace period (SECURITY.md §2.7). Recovery codes are shown once and stored by them.
B11. Verify the bootstrap left nothing behind, and that the EMPTY system is correct:
       SELECT id,status,password_hash IS NULL AS no_pw FROM ess.app_user;   → 1 row, ACTIVE
       SELECT count(*) FROM ess.user_invitation WHERE consumed_at IS NULL;  → 0
       grep -ri "password" prisma/seed*.ts                                  → no credential
     If --print-link was used, purge that job's log from the platform now.
     Then walk every screen as that administrator, with zero operational rows, and
     confirm directive 9 holds end to end on the real deployment: every list shows its
     designed empty block, every metric tile shows an em dash with an explanatory
     sub-label, no chart renders an axis with invented ticks, and no screen throws. This
     is the same check §11.7 Q8 repeats quarterly and the §2.8 empty-state gate proves
     per-component — this is the only time it is proved against the real stack before
     anyone has data to hide a defect behind.
B12. Second administrator: the first admin invites them through the UI (HR employee:create).
     Granting HR or ACCOUNTS requires a second HR approver (SECURITY.md §4.9), so the org
     is never one person away from being locked out — and never one compromised account
     away from an unreviewed privilege grant.
B13. Turn on the alerts in §9.5, run the synthetic-login probe, and file the first entry in
     dr-drill-log.md with a restore drill scheduled for the end of month one.
```

**The property to preserve:** at no point does a known or default password exist. The
credential is created by the human who will own it, over TLS, from a single-use token with a
60-minute life, with MFA enforced before the account becomes usable.

### 11.2 Running a monthly payroll cycle end to end

**Roles:** Accounts (payroll inputs), HR (attendance submission), Managers (attendance
approval), Accounts (publication). Separation of duties is enforced server-side; this
runbook is the _operational_ sequence around it. The ordering is the mandated workflow and
the system will refuse to proceed out of order — nothing here can be skipped by agreement.

```
P0.  T-3 days — PRE-FLIGHT (ops)
     · confirm the previous cycle is CLOSED:
         SELECT id,period_label,status FROM ess.payroll_cycle ORDER BY period_start DESC LIMIT 3;
     · confirm outbox_pending = 0 and no FAILED rows
     · confirm the last audit-chain verification passed
     · confirm a backup completed in the last 24 h
     · if the last cycle's payroll_cycle_duration_seconds exceeded 10 min, scale
       ess-worker to Standard for the window (§3.4) and note it here
     · freeze deploys touching prisma/migrations/** or apps/api/src/payroll/** until P7

P1.  CYCLE OPEN (job payroll-cycle-open, or Accounts via POST /payroll/cycles)
     Creates payroll_cycle in DRAFT and its paired attendance_period in OPEN, 1:1, and
     resolves scheduled_pay_date from the org pay-day rule against the holiday calendar.
     Guard: no other open cycle, prior cycle closed.

P2.  ACCOUNTS UPLOAD PAYROLL DATA  →  cycle INPUTS_UPLOADED
     Accounts uploads the input file(s) (CSV/XLSX, ≤ 25 MiB). Every accepted row is
     persisted as payroll_input_item rows (row_number, source_file_id) under one
     payroll_input_batch; formulas are never evaluated; the file's sha256 and the batch are
     recorded (ux_pib__cycle_file_sha makes a re-upload of the same bytes idempotent).
     Verify: the Payroll screen's counts come from
       SELECT count(*) FROM ess.payroll_input_item WHERE batch_id = :b;
     — never from a parse of the file and never from the uploader's own row count.
     Rejected rows are listed with their row numbers — fix and re-upload the corrected file.

P3.  HR SUBMITS ATTENDANCE  →  attendance_period SUBMITTED
     HR closes the attendance period. The system computes present/absent/LOP days from
     attendance_record and the approved leave_request_day rows. Submission is blocked
     while any employee in the period has no attendance record.
     Verify: SELECT count(*) FROM ess.attendance_record WHERE period_id=… AND status='DRAFT'; → 0

P4.  MANAGERS REVIEW AND APPROVE  →  each attendance_approval APPROVED
     Every manager with direct reports in the period gets an approval task. Job
     attendance-approval-reminder nags hourly; §1.6 of WORKFLOWS.md tracks who still owes.
     Ops view:
       SELECT manager_employee_id, count(*) FILTER (WHERE status='PENDING') AS owing
         FROM ess.attendance_approval WHERE period_id = :p GROUP BY 1 HAVING count(*) > 0;
     Chase the named managers. A manager on leave is handled by REASSIGNED, not by an
     override — HR reassigning is audited and visible.
     The period reaches APPROVED only when the last approval lands (guarded by
     pg_advisory_xact_lock so two simultaneous approvals cannot both fire the completion).

P5.  VALIDATION  →  cycle VALIDATED  (system, on demand from Accounts)
     Runs the §1.5 checklist: every active employee has a salary structure; attendance
     approved for all; no unresolved LOP conflict; statutory rates present for the FY; bank
     details present and CLEAN for every payee; expense cut-off applied; no duplicate input
     row. Failures are listed per employee with the failing check — nothing is auto-fixed.
     THIS IS THE GATE. Until it passes, no payslip row exists anywhere in the database.

P6.  GENERATION  →  cycle CALCULATING → CALCULATED
     One worker task takes pg_advisory_lock(hashtext('payroll:'||cycle_id)) on a DIRECT
     connection (§4.3) and holds it for the whole run. Each payslip records
     payroll_engine_version, input_sha256 (SHA-256 over jsonb_canonical of its persisted
     inputs) and amount_sha256 (over the canonical serialisation of the decrypted amounts)
     — DATA-MODEL.md §10, SECURITY.md §7.4. Both are the traceability anchor directive 6
     requires, and both are recomputable from persisted rows alone.
     Watch: payroll_cycle_duration_seconds{phase="calculating"}, background_job_failures_total.
     Payslips exist now but are NOT visible: no payslip_publication row exists, and the
     employee-facing routes return 404 (API.md §11.1, enforced in SQL by the publication
     gate in the RLS policy — not by a UI condition).

P7.  REVIEW  (Accounts, and HR for headcount)
     Compare the run's totals against the previous cycle; investigate any employee whose net
     moved more than a configured threshold. Re-verify a sample:
       node apps/api/dist/tools/verify-payslip-digests.js --cycle <id> --sample 25
       # recomputes input_sha256 and amount_sha256 for the sample and diffs against
       # the persisted values; any mismatch blocks P8.
     A correction at this stage is a re-run (WORKFLOWS.md §1.10), not an edit: the run is
     superseded and both remain in the audit trail.

P8.  PUBLISH  →  cycle PUBLISHED, payslips visible
     Accounts publishes. In ONE transaction: every payslip.status, every
     payslip_publication row, the FY rollups, the TDS quarter recompute, the reimbursement
     batch → PAID with its expense claims → REIMBURSED, the tax-regime election lock, and
     one notification + one email_outbox row per employee.
     ONLY NOW does a payslip appear in the employee's Payslips screen. That is directive 6,
     and it is enforced in the database, not in the client.
     Alerts: publication outside the configured change window, or by a first-time publisher,
     fires a P2 by design (§9.5) — acknowledge it, do not silence it.

P9.  POST-CYCLE (ops, same day)
     · outbox_pending drains to 0; investigate any FAILED row
     · spot-check one employee end-to-end: payslip visible, PDF downloads, amounts match
       the persisted payslip_line rows
     · confirm the payroll-integrity-verify nightly job passes on the new cycle
     · scale ess-worker back to Starter if it was raised at P0
     · unfreeze deploys
     · record the cycle's wall-clock duration per phase in oplog.md — this is the series
       that makes "payroll is slipping" an observation rather than an opinion
```

**If something goes wrong:** a failure in P2–P5 blocks progress and nothing is generated —
fix the underlying data and re-run the step. A failure during P6 leaves the cycle in
`CALCULATING` with the advisory lock released on worker death; the run is resumable and
idempotent per `ux_payslip__one_live_per_cycle_employee`. A problem discovered **after** P8
is never fixed by editing a payslip — it is an off-cycle correction run (`WORKFLOWS.md`
§1.10), because a published payslip is immutable and an employee has already seen it.

### 11.3 Rotating the encryption key

Two distinct operations. **Read R-15/R-18 first**: `SECURITY.md` §7.2 names the key table
`data_key` with purposes `PII`/`STATUTORY`/`BANK`/`MFA`/`TICKET`, while `DATA-MODEL.md` §17.3
names it `data_encryption_key` with purposes `FIELD_DEFAULT`/`PAYROLL`/`MFA`. **R-18 resolved this in
favour of `data_encryption_key` and the three-purpose list** (§0.7); the commands
below use the `SECURITY.md` spelling; substitute whichever the schema settles on, and read
the purpose list from the schema rather than from this page — a rotation that iterates the
wrong purpose list leaves a column encrypted under a retired key, and D6's completion check
is the only thing that would catch it.

**Rehearse both in staging first** — the staging database has the
same schema and synthetic data, so a rehearsal proves the scripts, the timings and the
verification queries.

#### 11.3.1 KEK rotation (cheap, ~minutes, no downtime) — annually, or immediately on suspicion

Only the wrapped DEKs change; **no column data is touched**.

```
K1.  Mint the new KEK:  openssl rand -base64 32   → MASTER_KEK_V2
     Add it to the Render environment group ALONGSIDE MASTER_KEK_V1. Do not remove V1.
     Add V2 to the sealed break-glass envelope before proceeding (§7.3).
K2.  Set MASTER_KEK_ACTIVE_VERSION=2 and redeploy. Both KEKs are now resident: the app
     unwraps with whichever kek_version each data_encryption_key row names, and wraps new DEKs with V2.
K3.  Re-wrap, as a one-off job:
       node apps/api/dist/tools/rewrap-deks.js --from 1 --to 2
     For each data_encryption_key row, in a transaction: unwrap with V1, re-wrap with V2, set
     kek_version=2. There are single-digit rows (one per purpose), so this is seconds.
     Emits SECURITY.KEY_ROTATION_STARTED / _COMPLETED with counts.
K4.  Verify:
       SELECT purpose, kek_version, status FROM ess.data_encryption_key ORDER BY purpose;
         → every live row kek_version = 2
       node apps/api/dist/tools/decrypt-canary.js --all-purposes   → all OK
K5.  Smoke: read one masked profile, one unmasked statutory id (step-up), one bank last4,
     one encrypted ticket body. decrypt_failures_total must stay at 0 for 24 h.
K6.  After 30 days with no decrypt failure, remove MASTER_KEK_V1 from the environment group
     and from the sealed envelope; record the destruction in secret-inventory.md.
     DO NOT remove it earlier — it is the only way back if K3 missed a row.
Rollback: set MASTER_KEK_ACTIVE_VERSION=1 and run rewrap-deks.js --from 2 --to 1.
          Safe at any point because both KEKs are resident throughout.
```

#### 11.3.2 DEK rotation / re-encryption (expensive, hours, online) — annually, or on suspicion

Per `purpose` (`PII`, `STATUTORY`, `BANK`, `MFA`, `TICKET`). Run **outside** a payroll window.

```
D1.  Schedule: not during a payroll cycle (§11.2 P1–P8), not during month-end.
     Announce a 5 % database CPU uplift for the duration.
D2.  If BLIND_INDEX_KEY is rotating too, add BLIND_INDEX_KEY_V2 now — the *_fpr values are
     recomputed in the SAME backfill pass, so rotating them separately would mean two scans.
D3.  Insert the new data_encryption_key row as PENDING, wrapped under the current KEK; flip it ACTIVE
     and the previous one RETIRING:
       node apps/api/dist/tools/rotate-dek.js --purpose BANK --begin
     From this moment new writes use the new DEK and reads still decrypt with whichever
     dek_id the envelope names. This dual-read is inherent to the envelope format and needs
     no feature flag — which is why a stall here is harmless.
D4.  Backfill:
       node apps/api/dist/tools/reencrypt-worker.js --purpose BANK --batch 500
     Walks each affected table in id order, 500 rows per transaction,
     SELECT … FOR UPDATE SKIP LOCKED, decrypt-old → encrypt-new (recomputing *_fpr when
     the index key rotated). Progress is checkpointed in reencryption_job(purpose,
     table_name, last_id, rows_done, …) so it is resumable after any interruption.
     Throttle to ≤ 5 % database CPU; pause with --stop, resume with the same command.
D5.  Monitor: db_query_duration_seconds, replication/PITR lag, decrypt_failures_total (must
     stay 0), and the reencryption_job checkpoint advancing.
D6.  Completion check — count envelopes still naming the retiring dek_id:
       SELECT count(*) FROM ess.employee_bank_account
        WHERE substring(account_number_enc from 2 for 1) = :old_dek_id;   → 0
     Repeat for every table in the purpose. Only then set the old row RETIRED.
D7.  Verify: decrypt-canary across all purposes; a masked read (which uses the plaintext
     last4 column and performs NO decryption) still renders; a step-up unmask returns the
     right value and writes its audit event.
D8.  After 30 days, delete the retired row's wrapped material. Record in
     secret-inventory.md. Emit SECURITY.KEY_ROTATION_COMPLETED with the row counts.
If it stalls: the system is fully functional with the rotation half-done — that is the
     design. Resume when convenient. Do NOT delete the retiring DEK while D6 is non-zero.
```

### 11.4 Rotating JWT signing keys

Every 90 days, scheduled; immediately on suspected exposure. **Zero downtime, zero forced
logouts**, because verification accepts every live `kid` while signing uses one.

```
J1.  Mint:
       openssl genpkey -algorithm ed25519 -out new.pem
       openssl pkey -in new.pem -pubout -out new.pub
     kid = wd-ess-YYYYMM-<4 hex>, matching ^wd-ess-\d{6}-[0-9a-f]{4}$.
J2.  Add JWT_SIGNING_KEY_<newkid> and JWT_PUBLIC_KEY_<newkid> to the environment group.
     LEAVE the current key in place. Redeploy.
     State: NEXT — published in JWKS, accepted for verification, not yet signing.
J3.  Confirm the JWKS endpoint serves both kids and that a token signed by the old kid still
     verifies. Wait one full deploy cycle so every instance holds both keys.
J4.  Set JWT_ACTIVE_KID=<newkid>. Redeploy.
     State: new = CURRENT (signs), old = RETIRED (verifies only).
     Every access token issued from now carries the new kid. Existing access tokens remain
     valid for at most ACCESS_TOKEN_TTL_SECONDS (600 s), and refresh tokens are unaffected
     because they are opaque database rows, not JWTs — so nobody is logged out.
J5.  Verify:
       curl -s https://api-ess.widedrop.com/api/v1/.well-known/jwks.json | jq '.keys[].kid'
       log in, decode the access token header, confirm the new kid
       auth_login_total{outcome="success"} unchanged; no spike in 401s
J6.  After 24 h (> 2 × the access-token TTL, with margin), remove the old
     JWT_SIGNING_KEY_<oldkid> and JWT_PUBLIC_KEY_<oldkid> and redeploy. Record in
     secret-inventory.md.
Emergency (key believed exposed): perform J1–J4 back-to-back, then IMMEDIATELY drop the old
     key (skip J6's wait) and bump token_version for every user, which invalidates every
     access token at once and forces a refresh — at the cost of a brief burst of refresh
     traffic. Then follow §11.6.
```

### 11.5 Restoring from backup

The drill in §4.5 is the rehearsal; this is the incident version. **Declare an incident
first** — a restore is never a quiet operation, because it rewinds committed work.

```
R1.  DECLARE. Name an incident lead. Open a timeline document. Note the time.
R2.  FREEZE. Set the `production` GitHub environment to block deployments. Stop the worker
     (scale ess-worker to 0) so no job writes to a database that is about to be replaced and
     no email is sent about state that is about to be rewound.
R3.  DECIDE THE TARGET TIME T. This is the hardest and most consequential decision: every
     write after T is lost. Use ess.audit_event to find the last known-good moment —
       SELECT seq, occurred_at, kind, actor_user_id FROM ess.audit_event
        WHERE occurred_at BETWEEN :from AND :to ORDER BY seq;
     — and prefer the latest T that excludes the damage. Write T in the timeline before
     starting; do not change it silently afterwards.
R4.  RESTORE TO A NEW INSTANCE, never in place. Provider PITR → ess-postgres-restore.
     (If PITR is unavailable: the latest daily, then the weekly off-provider dump as a
     cross-check — restore it separately and diff the anchor-table counts.)
R5.  Create the four roles (§4.4) with FRESH passwords. Apply the role timeouts.
R6.  INTEGRITY GATE — all must pass before any traffic is pointed at it:
       a. verify-audit-chain --full            → intact, no gaps, no fork
       b. verify-payslip-digests --sample 100  → every input_sha256 AND amount_sha256
                                                  recomputes from persisted rows
       c. decrypt-canary --all-purposes        → the KEK still opens the ciphertext
       d. anchor counts vs. the last known-good figures: employee, app_user, payslip
          (PUBLISHED), leave_request, expense_claim, helpdesk_ticket, audit_event
       e. assert-privileges                    → grants are correct on the restored instance
R7.  RECONCILE OBJECT STORAGE. R2 was not rewound. For 50 sampled file_object rows confirm
     the object exists and its sha256 matches. Then find the two divergences:
       · file_object rows that no longer exist after the rewind but whose objects do
         → orphan objects; list them, do not delete during the incident
       · objects referenced by restored rows that were deleted after T by the retention job
         → these are genuinely lost; list them for the notification in R11
R8.  REPOINT: update DATABASE_URL / DIRECT_DATABASE_URL to the restored instance; redeploy
     ess-api; smoke test (login → MFA → /me/dashboard → one payslip download).
R9.  RESTART THE WORKER only after R8 passes. Watch the outbox: it will now contain rows
     from before T that may have ALREADY been delivered. Before scaling up, mark any row
     whose sent_at was after T and whose delivery you have confirmed externally as SENT, so
     employees are not emailed twice about the same event.
R10. RETAIN the damaged instance untouched for 14 days as forensic evidence. Do not delete
     it to save money.
R11. COMMUNICATE what was lost: the window (T → incident time), which modules were affected,
     and specifically whether any PUBLISHED payslip was un-published by the rewind — if so,
     Accounts must re-publish and the affected employees must be told, because they may have
     seen a document that is now absent.
R12. Post-incident review within 5 working days: why the damage happened, why it was not
     caught sooner, what detection would have caught it, and whether the achieved RPO/RTO
     matched the §4.5 targets. Update the targets or the architecture — not the runbook
     alone.
```

### 11.6 Responding to a suspected credential compromise

Triggered by: a refresh-reuse P1, a mass-unmask P1, a gitleaks hit, a secret in a log or a
screenshot, a departing employee with production access, a provider breach notice, or simply
a credible suspicion. **Act first, confirm later** — rotation is cheap, a live compromise is
not.

```
C1.  CLASSIFY (2 minutes). Which credential class?
       (a) one USER account         → C2
       (b) an APPLICATION secret    → C3   (JWT key, KEK, pepper, CSRF/HMAC key)
       (c) an INFRASTRUCTURE secret → C4   (database, storage, mail, Render, Netlify, GHCR)
     When unsure, treat it as the widest plausible class.

C2.  USER ACCOUNT
     · suspend the account (status SUSPENDED) — this revokes every session immediately
     · bump token_version → every access token for that user dies within 600 s
     · revoke the whole refresh family; reset MFA; invalidate recovery codes
     · pull their audit trail:
         SELECT occurred_at, kind, route, subject_employee_id, ip_hash
           FROM ess.audit_event WHERE actor_user_id = :u AND occurred_at > :since
           ORDER BY seq;
       Pay particular attention to READ_SENSITIVE, EXPORT, PII unmask, role grants and
       approval decisions — that is the blast radius, and audit_event tells you exactly
       which employees' rows were read.
     · re-invite through the §11.1 B9/B10 flow: new password set by them, MFA re-enrolled
     · if the account held HR or ACCOUNTS, also do C3 for CSRF_KEY and review every role
       grant they made

C3.  APPLICATION SECRET
     · JWT signing key  → §11.4 emergency path, then bump token_version org-wide
     · MASTER_KEK       → §11.3.1 immediately (minutes). Note: KEK exposure WITHOUT
                          database access does not expose data — the KEK only unwraps DEKs
                          that live in Postgres. Rotate anyway, and check for database
                          access in the same breath.
     · PASSWORD_PEPPER  → add _V2, set the active version; hashes re-hash lazily at next
                          login. Exposure of the pepper alone does not reveal a password,
                          but it removes a layer against an offline attack on a stolen dump.
     · CSRF_KEY, CURSOR_HMAC_KEY, LOG_HASH_KEY, RECOVERY_CODE_KEY
                        → deploy new values. Cost: live cursors and CSRF tokens re-arm on
                          the next request; recovery codes must be regenerated by users
                          (notify them); ip_hash correlation breaks across the boundary —
                          accepted and documented.
     · AUDIT_CHAIN_KEY  → new version from a given seq; history is NEVER re-keyed, and the
                          verifier must be told the boundary seq. Re-verify the full chain
                          afterwards.

C4.  INFRASTRUCTURE SECRET
     · Database: rotate ess_app / ess_job passwords (ALTER ROLE … PASSWORD), update the
       environment group, redeploy. Then rotate ess_migrator and, if the exposure could
       reach it, ess_owner from the sealed envelope. Review pg_stat_activity and the
       provider's connection logs for any client that is not ours.
     · Object storage: delete the exposed R2 token, mint a new bucket-scoped one, redeploy.
       Review R2 access logs for reads from an unexpected source. Remember the second layer:
       payslip and bank-proof objects are application-encrypted, so a storage-only
       compromise yields ciphertext.
     · Mail: rotate the SES IAM key; check the SES sending statistics for volume that is
       not ours (a stolen mail credential is used for phishing within hours).
     · Render / Netlify / GHCR: revoke the token, rotate every API key, force re-login for
       every team member, enable/verify MFA on every account, and review the deploy history
       for a deploy nobody recognises.

C5.  ALWAYS, regardless of class:
     · verify the audit chain end to end — an attacker with database write access would have
       had to break it, and a gap or fork is the strongest signal available:
         node apps/api/dist/tools/verify-audit-chain.js --full
     · mass session revocation if there is any doubt about scope (bump token_version for all
       users; every session must re-authenticate)
     · review ADMIN.ROLE_GRANTED events since the earliest plausible compromise — a granted
       role is how a short compromise becomes a persistent one
     · review app_user rows created or activated in the window
     · check for new or modified user_invitation rows, and expire every unconsumed one
     · rotate the exposed secret in secret-inventory.md with the date and reason
     · a secret that ever reached a git commit is compromised even after a force-push:
       rotate it, do not merely remove it

C6.  ASSESS AND NOTIFY. Reconstruct from ess.audit_event exactly which subject_employee_id
     rows were accessed, by which actor, at what time — the subject_employee_id index exists
     for precisely this query. If personal data was accessed by an unauthorised party, the
     DPDP Act notification duties in SECURITY.md §14.7 apply: the Data Protection Board and
     every affected Data Principal, without delay. Legal and the DPO decide the wording;
     engineering supplies the evidence, not the judgement.

C7.  POST-INCIDENT. Within 5 working days: how the credential escaped, which control should
     have stopped it, what detection would have caught it sooner, and one concrete change.
     Update this runbook if any step proved wrong under pressure.
```

### 11.7 Quarterly operational review

Small, scheduled, and the cheapest insurance in this document. Owner: the ops owner.

```
Q1.  DNS drift: diff the live zone against infra/dns/widedrop.com.before.txt. Investigate
     EVERY difference. Specifically hunt for a CNAME pointing at a service we no longer
     own — because every *.widedrop.com host is same-site with the API (§1.4), a dangling
     record is a route into the same-site set.
Q2.  Secret inventory: every entry has an owner and a next-due date; rotate anything overdue.
Q3.  Access review: who can reach the Render account, the Netlify ESS team, GHCR, the AWS/SES
     account, the R2 account, the break-glass envelope. Remove anyone who left. Confirm MFA
     on every one of those accounts.
Q4.  Restore drill (§4.5). Record the elapsed time; compare against the 2 h RTO.
Q5.  Alert review: which alerts fired, which were actioned, which were noise. Delete or fix
     any alert that fired more than twice without action.
Q6.  Dependency and image review: outstanding Dependabot PRs, Trivy findings, Node 22 LTS
     patch level, Postgres 16 minor version, the pinned action SHAs, and the
     render-postgres-ca.pem expiry (R-6 — fail the review if under 90 days).
     Re-verify TRUSTED_PROXY_CIDRS against the live edge (§11.1 B5) and re-verify that
     the object-storage lifecycle rules of §5.4 are actually in force at the provider
     (R-24) — both are settings that drift silently and whose failure is invisible until
     it matters.
Q7.  Cost review against §10, and a check that staging has not silently grown production-like
     data (it must contain no real employee).
Q8.  Confirm the empty-state guarantee still holds: point a scratch API at a freshly migrated,
     reference-seeded database with zero operational rows and walk every screen. Any screen
     that errors, renders a blank box, or shows an invented number is a bug against
     directive 9 — and this is the only routine check that catches a regression in it.
```

---

## 12. Open risks and reconciliations

| #    | Item                                                                                                                                                                            | Impact                                                                                                                                                                          | Proposed resolution                                                                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | API hostname: this document, `SECURITY.md` and `API.md` use `api-ess.widedrop.com`; the task brief proposed `api.ess.widedrop.com`                                              | none technically; a documentation inconsistency if left unstated                                                                                                                | §0.2. Confirm with the domain owner, then the string is fixed in four places.                                                                                                                                              |
| R-2  | `SECURITY.md` §10.2 requires `MAIL_FROM` to end `@widedrop.com`, but the mandated help-desk address and the `WORKFLOWS.md` sender are `@widedroptech.com`                       | the boot check would reject a correct configuration                                                                                                                             | Amend `SECURITY.md` §10.2 to `@widedroptech.com`. Keeps all mail DNS out of the `widedrop.com` zone.                                                                                                                       |
| R-3  | `apps/api/src/config/env.ts` uses single-version key names                                                                                                                      | rotation procedures in `SECURITY.md` §3.2/§7.3 cannot be executed                                                                                                               | §0.4 rename table, before any production secret is minted.                                                                                                                                                                 |
| R-4  | `POST /api/v1/webhooks/ses` (bounce/complaint) is not in `API.md` §13                                                                                                           | delivery state would be `SENT` forever and bounces invisible                                                                                                                    | Add the route with the §6.4 guard block, plus its `public: true` allowlist entry.                                                                                                                                          |
| R-5  | `SECURITY.md` §6.4 names `apps/web/public/_headers` as a header source                                                                                                          | duplicate/conflicting `Content-Security-Policy` headers at the edge                                                                                                             | §2.3: `netlify.toml` owns all headers except CSP; CSP is generated into `dist/_headers`; a build assertion fails if `public/_headers` exists.                                                                              |
| R-6  | `infra/certs/render-postgres-ca.pem` is referenced by the Dockerfile but does not exist in the repo                                                                             | the image build fails, or `sslmode=verify-full` cannot be used                                                                                                                  | Download the provider CA at bootstrap, commit it (a public certificate, not a secret), and add a CI check that it is not expiring within 90 days.                                                                          |
| R-7  | Render has no India region; Postgres and the API sit in Singapore                                                                                                               | a future contract or policy may require in-country storage                                                                                                                      | Documented in `docs/PROCESSORS.md`; §3.7 gives the Fly.io `bom` + `ap-south-1` Postgres path. The migration is a restore plus a DNS change, not a rewrite.                                                                 |
| R-8  | SES has no provider-side idempotency key, which `WORKFLOWS.md` §6.3 assumes                                                                                                     | a crash between send and status write could duplicate one message                                                                                                               | §6.1: `Message-ID` derived from `email_outbox.id` plus the `SENDING` claim and 10-minute sweep bound it. Switch `MAIL_PROVIDER` to Resend if strict idempotency becomes a requirement.                                     |
| R-9  | Single worker instance                                                                                                                                                          | the outbox, SLA escalations, accruals and payroll calculation all stop if it dies                                                                                               | Mitigated by the heartbeat dead-man alert (§9.4) rather than by redundancy, because the lease design makes a restart safe and a second instance adds cost without removing the failure mode. Revisit above ~500 employees. |
| R-10 | ClamAV unavailable ⇒ uploads land `QUARANTINED`                                                                                                                                 | expense claims and tickets accept files that nobody can then read                                                                                                               | Correct and deliberate (`SECURITY.md` §5.3.10), but the UI must say so honestly; the P3 alert (§9.5) exists so it is noticed within 30 minutes rather than at month-end.                                                   |
| R-11 | `ess_owner` credentials exist in a sealed envelope                                                                                                                              | a two-person offline process is a real operational dependency                                                                                                                   | Test it during the quarterly review (Q3) — an escrow nobody has ever opened is not an escrow.                                                                                                                              |
| R-12 | Netlify free tier has no SLA                                                                                                                                                    | an outage takes the SPA down while the API stays up                                                                                                                             | Accepted: the SPA is static and the API's data is unaffected. If an SLA is required, the ESS site moves to a paid Netlify plan (~$19) or to Cloudflare Pages, changing only §2 and the CSP `connect-src` consumer.         |
| R-13 | `DEPLOYMENT.md` §4.4 described four database roles with a `LOGIN` `ess_owner`; `DATA-MODEL.md` §1.8.1 declares five with `ess_owner` `NOLOGIN`                                  | privilege model diverges from the schema; the worker's `BYPASSRLS` role would have failed the boot assertion                                                                    | §0.5 + the rewritten §4.4: five roles (plus `ess_backup`, `ess_auth`), owner `LOGIN` only because Render requires it, role-aware privilege assertion, `FORCE ROW LEVEL SECURITY` asserted at boot.                         |
| R-14 | CSP report URL: `SECURITY.md`/`FRONTEND.md` say `/csp-report`, `API.md` §1.1 says everything lives under `/api/v1`; `report-to` and `Reporting-Endpoints` were missing entirely | reports silently delivered nowhere; a clean report-only rollout that reported nothing                                                                                           | §0.6 + §2.3. Adopt `/api/v1/csp-report`, emit `report-to csp` **and** `Reporting-Endpoints` from the generated `_headers`, add `CSP_REPORT_ONLY`. Amend `SECURITY.md` §6.3 and `FRONTEND.md`.                              |
| R-15 | Runbooks referenced `payroll_input_row`, `payslip.input_digest` and "21 named jobs", none of which exist in `DATA-MODEL.md`                                                     | a runbook that cannot be executed, and digest verification against a column that is not there                                                                                   | §0.7 name table; §4.5, §11.2, §11.5 corrected to `payroll_input_batch`/`payroll_input_item`, `input_sha256`/`amount_sha256`, and to reading the job list rather than a count.                                              |
| R-16 | No timezone anywhere in the deployment, while `DATA-MODEL.md` §1.2 resolves every `date` in `Asia/Kolkata`                                                                      | every attendance day, pay date, cut-off and SLA clock 5 h 30 m out of step — wrong numbers that are not invented numbers, so directive 2's usual defences miss them             | §0.8: `TZ=UTC` everywhere, database `timezone=UTC`, all civil dates via `AT TIME ZONE org.timezone`, lint against unzoned `Date` accessors, IANA zone stored with every schedule.                                          |
| R-17 | `worker-heartbeat` (§9.4) is not in `DATA-MODEL.md` §17.5's named-job list                                                                                                      | the dead-man alert fires permanently, or the job-name constraint rejects every heartbeat                                                                                        | Add `worker-heartbeat` to §17.5. Until then the alert is knowingly broken, which is worse than absent.                                                                                                                     |
| R-18 | `SECURITY.md` §7.2 `data_key` (purposes `PII`/`STATUTORY`/`BANK`/`MFA`/`TICKET`) vs `DATA-MODEL.md` §17.3 `data_encryption_key` (`FIELD_DEFAULT`/`PAYROLL`/`MFA`)               | a key rotation that iterates the wrong purpose list leaves a column under a retired key                                                                                         | **RESOLVED (§0.7): `data_encryption_key`, purposes `FIELD_DEFAULT`/`PAYROLL`/`MFA`, status `PENDING`/`ACTIVE`/`RETIRED`/`COMPROMISED`.** §11.3 still reads the live purpose list from the schema, not from prose.          |
| R-19 | `POST /api/v1/csp-report` is not in `API.md` §13                                                                                                                                | boot-time route assertion fails, or the endpoint ships undeclared and unguarded                                                                                                 | Add it as `public: true` with the §2.3 guard block and a public-allowlist entry, exactly as R-4 does for the SES webhook.                                                                                                  |
| R-20 | `DATA-MODEL.md` §1.8.2 writes the RLS context as `SET LOCAL ess.actor_user_id = $2`, which PostgreSQL cannot bind                                                               | the only implementable reading is string interpolation of the actor identity into the statement that governs every RLS policy — the highest-value injection point in the design | §4.3: mandate `SELECT set_config('ess.…', $n, true)`; Semgrep fails the build on `SET LOCAL ess.` in a raw query and on any `$executeRawUnsafe`. Amend `DATA-MODEL.md` §1.8.2.                                             |
| R-21 | `DATA-MODEL.md` §18.1 seeds the `organization` row; §11.1 B8 creates it                                                                                                         | two writers; a re-seed silently reverts an HR edit to the legal address or the helpdesk email                                                                                   | One owner. This document's position: B8 owns it and §18.1's `organization` entry is struck. Decide before the first production seed.                                                                                       |
| R-22 | Netlify's production branch defaults to `main` and would build and publish it                                                                                                   | a second, unreviewed production deploy path that bypasses CI, the required reviewer and §2.5's zero-build-minute property                                                       | §2.1: production branch set to `netlify-prod-locked` or builds stopped, asserted on every deploy by `assert-netlify-not-building.mjs`.                                                                                     |
| R-23 | Deploy previews are `deploy-preview-<n>--…netlify.app`, an unbounded origin set, while §7.4 refuses `*`                                                                         | either a wildcard CORS allowlist or previews that cannot call the API at all                                                                                                    | §2.4: `ALLOWED_ORIGIN_PATTERNS`, anchored regex, **refused outright when `NODE_ENV=production`**, with near-miss unit tests.                                                                                               |
| R-24 | R2's lifecycle support for non-current version expiry, and Object Lock's create-time-only constraint                                                                            | a retention bound that silently does not exist, or a mutable off-provider backup                                                                                                | §5.4: verify at bootstrap; fall back to application-issued `DeleteObjectVersion`, and move the backup bucket to S3 `ap-south-1` with compliance-mode Object Lock if R2 cannot lock it.                                     |
| R-25 | `SMOKE_TOKEN` / `DEPLOY_AUDIT_TOKEN` were named but never defined                                                                                                               | a long-lived, unscoped production bearer held by CI                                                                                                                             | §8.2.1: `SERVICE`-kind users, one permission each, no `employee` row, IP-bound to CI egress, 60 req/h, 90-day expiry, every use audited.                                                                                   |
| R-26 | "Private interface" for `/readyz` and `/metrics` has no meaning on a single-port platform                                                                                       | authentication-failure counts and dependency health exposed on the internet                                                                                                     | §9.2: a second Fastify instance on `PRIVATE_PORT=4001` that the platform does not route; the routes are **not registered** on the public instance; `/metrics` additionally bearer-gated.                                   |
