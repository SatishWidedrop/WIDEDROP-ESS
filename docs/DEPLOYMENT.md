# Widedrop ESS — Deployment & Operations Architecture

**Status:** implementation-ready specification.
**Audience:** the implementer and whoever is on call afterwards.
**Companions:** `docs/SECURITY.md` (controls), `docs/DATA-MODEL.md` (schema),
`docs/API.md` (wire contract), `docs/WORKFLOWS.md` (state machines).
This document is the authority for _where things run, how they are configured, how they
ship and how they are recovered_. Where it repeats a control from `SECURITY.md` it does so
only to state the deployment-time obligation; the security rationale lives there.

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

| In the scaffold today                               | Canonical name                                                                                                                                                    | Why                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `CORS_ORIGINS`                                      | `ALLOWED_ORIGINS`                                                                                                                                                 | matches `SECURITY.md` §6.5                                                                 |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KEY_ID` | `JWT_SIGNING_KEY_<kid>` / `JWT_PUBLIC_KEY_<kid>` / `JWT_ACTIVE_KID`                                                                                               | overlapping-key rotation (`SECURITY.md` §3.2) needs N keys resident at once                |
| `PASSWORD_PEPPER`                                   | `PASSWORD_PEPPER_V1` (+ `_V2`…)                                                                                                                                   | lazy re-hash rotation                                                                      |
| `ENCRYPTION_KEK` / `ENCRYPTION_KEY_VERSION`         | `MASTER_KEK_V1` (+ …) / `MASTER_KEK_ACTIVE_VERSION`                                                                                                               | KEK re-wrap keeps the old KEK for 30 days                                                  |
| `AUDIT_HMAC_KEY`                                    | `AUDIT_CHAIN_KEY_V1`                                                                                                                                              | chain history is never re-keyed                                                            |
| `REDIS_URL` **required** in production              | `RATE_LIMIT_STORE=postgres\|redis`, `REDIS_URL` optional                                                                                                          | `SECURITY.md` §9.3 makes Postgres the primary limiter store; Redis is the >200 rps upgrade |
| `S3_*`                                              | `STORAGE_*`                                                                                                                                                       | matches `SECURITY.md` §10.2                                                                |
| `SMTP_*`                                            | `MAIL_*` (HTTPS provider API)                                                                                                                                     | `WORKFLOWS.md` §6.3 forbids raw SMTP string concatenation                                  |
| — (absent)                                          | `DIRECT_DATABASE_URL`                                                                                                                                             | session-scoped advisory locks and migrations must bypass the transaction pooler (§4.3)     |
| — (absent)                                          | `SERVICE_ROLE`, `TRUSTED_PROXY_CIDRS`, `BLIND_INDEX_KEY_V1`, `CSRF_KEY`, `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`, `CURSOR_HMAC_KEY`, `CLAMAV_*`, `OUTBOUND_ALLOWLIST` | required by `SECURITY.md` §5.3, §5.5, §7.2, §7.4, §9.2                                     |

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

| #   | Component         | Product / plan                                                           | Purpose                                                                | Holds persistent data?    | Reachable from the internet?            |
| --- | ----------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------- | --------------------------------------- |
| 1   | Marketing site    | Netlify, existing free team                                              | `widedrop.com`                                                         | no                        | yes (unchanged)                         |
| 2   | ESS SPA           | Netlify, **new dedicated site on a new team**                            | static React build at `ess.widedrop.com`                               | no                        | yes                                     |
| 3   | ESS API           | Render Web Service (Docker), `singapore`, 2 instances                    | Fastify, all authorization, all business logic                         | no (stateless)            | yes, `api-ess.widedrop.com` only        |
| 4   | ESS worker        | Render Background Worker (same image, `SERVICE_ROLE=worker`), 1 instance | `email-dispatch` + the 21 named jobs in `DATA-MODEL.md` §17.5          | no (state is in Postgres) | **no**                                  |
| 5   | Connection pooler | Render Private Service, PgBouncer, transaction mode                      | multiplexes API connections onto Postgres                              | no                        | **no**                                  |
| 6   | Malware scanner   | Render Private Service, `clamav/clamav:stable`, 2 GB                     | `clamd` INSTREAM scan of every upload (`SECURITY.md` §5.3.10)          | signature DB only         | **no**                                  |
| 7   | Database          | Render Managed PostgreSQL 16, `singapore`                                | **the system of record**                                               | **yes**                   | **no** — private network + IP allowlist |
| 8   | Object storage    | Cloudflare R2, `apac` location hint                                      | payslip PDFs, expense bills, policy PDFs, letters, payroll input files | **yes**                   | no public access; 120 s signed GET only |
| 9   | Email             | Amazon SES, `ap-south-1`                                                 | help-desk dispatch, invites, resets, notifications                     | no                        | outbound; inbound SNS webhook only      |
| 10  | CI/CD             | GitHub Actions + GHCR                                                    | build, test, scan, migrate, deploy                                     | build artifacts           | n/a                                     |
| 11  | Logs              | Better Stack (or Grafana Cloud Loki)                                     | structured JSON log sink, 30 d hot / 180 d cold                        | logs (PII-redacted)       | no                                      |
| 12  | Errors            | Sentry, PII scrubbing on                                                 | exception tracking                                                     | scrubbed events           | no                                      |
| 13  | Uptime            | Better Stack Uptime (or Healthchecks.io)                                 | external probe of `/api/v1/healthz` and the SPA                        | no                        | n/a                                     |

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

| Setting                              | Value                                                                                                                       |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Site name                            | `widedrop-ess` (serves `widedrop-ess.netlify.app`)                                                                          |
| Repository                           | connected **read-only for previews only**; production deploys arrive from CI (§2.5)                                         |
| Base directory                       | `apps/web`                                                                                                                  |
| Build command                        | `npm run build` (only used by deploy previews; production builds happen in CI)                                              |
| Publish directory                    | `apps/web/dist`                                                                                                             |
| Functions directory                  | **unset** — the ESS site runs no functions                                                                                  |
| Node version                         | `22` (from `.nvmrc`, and pinned again in `netlify.toml`)                                                                    |
| Custom domain                        | `ess.widedrop.com` (primary). No apex, no `www`.                                                                            |
| HTTPS                                | Let's Encrypt, auto-renew; "Force HTTPS" **on**                                                                             |
| Asset optimisation / post-processing | **off** — it rewrites markup and would break SRI and the no-inline-style guarantee (`SECURITY.md` §6.3)                     |
| Branch deploys                       | `staging` only                                                                                                              |
| Deploy previews                      | on, for PRs; they point at the **staging** API (§2.4)                                                                       |
| Environment variables                | `VITE_API_BASE_URL`, `VITE_APP_ENV`, `VITE_BUILD_SHA`, `VITE_SENTRY_DSN` — all public build-time config, **never a secret** |

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
  base    = "apps/web"
  command = "npm run build"
  publish = "apps/web/dist"

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
# SPA history fallback. Last rule, 200 (rewrite, not redirect) so deep links
# such as /payslips/<id> render the app instead of Netlify's 404 page.
# force = false, so a real file on disk always wins over the fallback.
# ---------------------------------------------------------------------------
[[redirects]]
  from   = "/*"
  to     = "/index.html"
  status = 200
  force  = false

# The SPA must never proxy the API. A Netlify rewrite to api-ess.widedrop.com
# would make the API same-ORIGIN, defeating the CORS allowlist and putting an
# uncontrolled CDN in front of authenticated responses. Explicitly refused:
[[redirects]]
  from   = "/api/*"
  to     = "/index.html"
  status = 404

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
/*
  Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'none'; style-src-elem 'self'; img-src 'self' blob:; font-src 'self'; connect-src 'self' ${VITE_API_BASE_URL}; manifest-src 'self'; worker-src 'self'; form-action 'none'; frame-ancestors 'none'; frame-src 'none'; base-uri 'none'; object-src 'none'; media-src 'none'; upgrade-insecure-requests; require-trusted-types-for 'script'; trusted-types default; report-uri ${VITE_API_BASE_URL}/api/v1/csp-report
```

Build-time assertions in the same script, each failing the build:

1. `VITE_API_BASE_URL` is an absolute `https://` origin with no path and no `*`.
2. In the `production` context it equals exactly `https://api-ess.widedrop.com`.
3. No `VITE_*` variable name matches `/KEY|SECRET|TOKEN|PASSWORD|PEPPER/i`.
4. `grep -c 'style="' dist/**/*.html` is `0`, and no emitted JS contains `.setAttribute('style'` —
   the no-inline-style guarantee that lets `style-src 'self'` stand (`SECURITY.md` §6.3).
5. `apps/web/public/_headers` and `apps/web/public/_redirects` **do not exist** (they would be
   copied into `dist` and merged with the generated file). _Amend `SECURITY.md` §6.4, which
   mentions `apps/web/public/_headers`: that file is not used._

### 2.4 Deploy previews

- Previews build on Netlify from the PR branch and are served at
  `deploy-preview-<n>--widedrop-ess.netlify.app`.
- They point at `api-ess-staging.widedrop.com`, which has its **own** origin allowlist, its
  own database and no production data. `*.netlify.app` is **never** added to the production
  API's `ALLOWED_ORIGINS` (`SECURITY.md` §6.5).
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

`netlify.toml` is still read from the repository base on a CLI deploy, so redirects and
headers apply. The upload is an atomic, immutable deploy with its own permalink — which is
what makes the one-click rollback in §8.6 instant.

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

**The one shared resource is the DNS zone.** Two records are added to it, both leaf `CNAME`s
on previously unused labels. Adding a subdomain record cannot affect apex resolution.

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
      - key: LOG_LEVEL
        value: info
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
      - key: OUTBOUND_ALLOWLIST
        value: api.pwnedpasswords.com,email.ap-south-1.amazonaws.com,<r2-account-id>.r2.cloudflarestorage.com
      - key: HIBP_ENABLED
        value: 'true'
      - key: CLAMAV_HOST
        value: ess-clamav # Render private-service DNS name
      - key: CLAMAV_PORT
        value: '3310'
      - key: TRUSTED_PROXY_CIDRS
        value: 10.0.0.0/8 # Render's edge; confirm in the dashboard
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
      - key: DATABASE_URL # through PgBouncer, transaction pooling
        value: postgresql://ess_app:__FROM_SECRET__@ess-pgbouncer:6432/widedrop_ess?pgbouncer=true&connection_limit=8&sslmode=disable&application_name=ess-api
      - key: DIRECT_DATABASE_URL # straight to Postgres, session scope
        fromDatabase:
          name: ess-postgres
          property: connectionString
      - key: APP_VERSION
        fromService:
          type: web
          name: ess-api
          property: commitSha

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
      # The worker bypasses PgBouncer: pg_advisory_lock() is SESSION-scoped and
      # does not survive transaction pooling (§4.3).
      - key: DATABASE_URL
        fromDatabase:
          name: ess-postgres
          property: connectionString
      - key: DIRECT_DATABASE_URL
        fromDatabase:
          name: ess-postgres
          property: connectionString

  # ------------------------------------------------------------ PGBOUNCER ---
  - type: pserv # private service: no public URL, ever
    name: ess-pgbouncer
    runtime: image
    image:
      url: docker.io/edoburu/pgbouncer:1.23.1
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
      - key: DEFAULT_POOL_SIZE
        value: '25'
      - key: RESERVE_POOL_SIZE
        value: '5'
      - key: SERVER_TLS_SSLMODE
        value: verify-full
      - key: SERVER_TLS_CA_FILE
        value: /etc/ssl/certs/render-postgres-ca.pem
      - key: AUTH_TYPE
        value: scram-sha-256
      - key: IGNORE_STARTUP_PARAMETERS
        value: extra_float_digits,options,search_path

  # --------------------------------------------------------------- CLAMAV ---
  - type: pserv
    name: ess-clamav
    runtime: image
    image:
      url: docker.io/clamav/clamav:stable
    plan: standard # 2 GB — the signature database needs it
    region: singapore
    numInstances: 1
    envVars:
      - key: CLAMAV_NO_MILTERD
        value: 'true'
      - key: FRESHCLAM_CHECKS
        value: '4'
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

All 21 named jobs (`DATA-MODEL.md` §17.5) plus `email-dispatch` are scheduled _inside_ the
worker process from a single table-driven timer, each claiming an `ess_ops.background_job`
row by lease (`lease_owner`, `lease_expires_at`). Rationale: it is host-portable (moving to
Fly.io changes nothing), it is testable in CI with no platform involved, a missed tick is
visible as a `PENDING` row rather than vanishing, and the lease makes a duplicate run
impossible even if a second worker is accidentally started. Platform cron (`type: cron` on
Render) is used for exactly one thing — the quarterly restore drill in §11.5 — because that
one must run _outside_ the application.

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

| Variable              | Points at            | Used by                                                                                                              | Pool mode   |
| --------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------- |
| `DATABASE_URL`        | `ess-pgbouncer:6432` | the **API**                                                                                                          | transaction |
| `DIRECT_DATABASE_URL` | `ess-postgres:5432`  | the **worker**, `prisma migrate`, `prisma db execute`, the reference seeder, the bootstrap script, psql in a runbook | session     |

```
DATABASE_URL=postgresql://ess_app:<pw>@ess-pgbouncer:6432/widedrop_ess
              ?pgbouncer=true&connection_limit=8&pool_timeout=10
              &application_name=ess-api&sslmode=disable
DIRECT_DATABASE_URL=postgresql://ess_app:<pw>@<host>:5432/widedrop_ess
              ?sslmode=verify-full&sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
              &connection_limit=5&application_name=ess-worker
MIGRATE_DATABASE_URL=postgresql://ess_migrator:<pw>@<host>:5432/widedrop_ess
              ?sslmode=verify-full&sslrootcert=/etc/ssl/certs/render-postgres-ca.pem
```

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
   context in `DATA-MODEL.md` §1.8 (`SET LOCAL ess.actor_user_id = …`) safe under transaction
   pooling. **Plain `SET` must never be used** — it would leak one request's identity into
   another request that happens to reuse the server connection. Add an ESLint/CI grep that
   fails on `$executeRaw` containing `SET ` not preceded by `LOCAL`.
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

Four roles, created by the first migration and never merged. **The application never connects
as the owner.**

| Role           | `LOGIN`                | Owns objects                         | Privileges                                                                                                                                                                                             | Used by                                               |
| -------------- | ---------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `ess_owner`    | yes (break-glass only) | **yes** — all schemas, tables, types | full                                                                                                                                                                                                   | nobody at runtime; credentials sealed offline (§11.6) |
| `ess_migrator` | yes                    | no                                   | `CREATE` on `ess`, `ess_ops`; `ALTER`/`DROP` via ownership delegation; `BYPASSRLS`                                                                                                                     | the CI migration job **only**                         |
| `ess_app`      | yes                    | no                                   | `SELECT, INSERT, UPDATE, DELETE` on `ess.*` and `ess_ops.*` **minus** the exclusions below; `USAGE` on schemas and sequences; **no** `BYPASSRLS`, **no** `CREATE`, **no** `TRUNCATE`, **no** superuser | the API                                               |
| `ess_job`      | yes                    | no                                   | as `ess_app`, plus `BYPASSRLS` (jobs act system-wide across tenants and have no actor context)                                                                                                         | the worker                                            |

```sql
-- Identity
CREATE ROLE ess_migrator LOGIN PASSWORD :'migrator_pw' BYPASSRLS;
CREATE ROLE ess_app      LOGIN PASSWORD :'app_pw'      NOBYPASSRLS;
CREATE ROLE ess_job      LOGIN PASSWORD :'job_pw'      BYPASSRLS;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON DATABASE widedrop_ess FROM PUBLIC;
GRANT CONNECT ON DATABASE widedrop_ess TO ess_app, ess_job, ess_migrator;
GRANT USAGE ON SCHEMA ess, ess_ops TO ess_app, ess_job;

-- Baseline DML
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA ess, ess_ops TO ess_app, ess_job;
GRANT USAGE, SELECT                  ON ALL SEQUENCES IN SCHEMA ess, ess_ops TO ess_app, ess_job;

-- The audit trail is append-only for everyone but the migrator (DATA-MODEL.md §17.4)
REVOKE UPDATE, DELETE, TRUNCATE ON ess.audit_event FROM ess_app, ess_job;

-- No hard deletes on the tables whose lifecycle is a status column (DATA-MODEL.md §18.2)
REVOKE DELETE ON ess.payslip, ess.payroll_run, ess.payroll_cycle, ess.leave_request,
                 ess.expense_claim, ess.policy_version, ess.policy_acknowledgement,
                 ess.helpdesk_ticket, ess.employee, ess.app_user, ess.file_object
  FROM ess_app, ess_job;

-- Accounts is scoped away from non-payroll PII at the SQL layer too (SECURITY.md §4.5)
GRANT SELECT ON ess.payroll_employee_v TO ess_app;

-- Future tables created by a later migration inherit the same grants
ALTER DEFAULT PRIVILEGES FOR ROLE ess_migrator IN SCHEMA ess, ess_ops
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ess_app, ess_job;
ALTER DEFAULT PRIVILEGES FOR ROLE ess_migrator IN SCHEMA ess, ess_ops
  GRANT USAGE, SELECT ON SEQUENCES TO ess_app, ess_job;
```

A boot-time assertion (`apps/api/src/db/assert-privileges.ts`) queries
`information_schema.role_table_grants` and `pg_roles` and **refuses to start in production**
if the connected role has `rolbypassrls`, any `TRUNCATE` grant, `UPDATE`/`DELETE` on
`ess.audit_event`, or a `DELETE` grant on any table in the no-delete list. This turns a
mis-provisioned database into a failed deploy rather than a silent loss of the audit
guarantee. It is also asserted in the CI integration suite.

### 4.5 Backups, PITR and the restore drill

| Control                            | Value                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Automated full backup              | daily, provider-managed, encrypted, 07 days retained on `standard` (extend to 30 on the next plan up if policy demands)                                                                                                                                                                                                                           |
| PITR                               | continuous WAL archiving, any second within the retention window                                                                                                                                                                                                                                                                                  |
| **RPO**                            | **≤ 5 minutes** (WAL shipping interval); ≤ 24 h in the catastrophic case where WAL is lost and only the daily full survives                                                                                                                                                                                                                       |
| **RTO**                            | **≤ 2 hours** to a verified, serving system                                                                                                                                                                                                                                                                                                       |
| Weekly off-provider copy           | `pg_dump -Fc` run by a Render **cron job** in the same private network, encrypted with `age` to an offline public key, written to an R2 bucket in a **different cloud account** with object-lock/immutability for 35 days. This is the control that survives "the Render account is compromised or closed" — a provider-internal backup does not. |
| Backup integrity                   | the weekly copy is restored into a throwaway database by the same cron job, `pg_restore --list` is diffed against the expected table set, `SELECT count(*)` is compared against the source for six anchor tables, and the result is appended to `docs/runbooks/dr-drill-log.md`. A failure pages.                                                 |
| Encryption of the dump             | `pg_dump -Fc                                                                                                                                                                                                                                                                                                                                      | age -r <recipient> > ess-<date>.dump.age`; the age identity is in the sealed offline escrow with the KEK (§11.6). **The dump contains ciphertext columns, not plaintext PII** — the envelope encryption means a stolen dump without the KEK yields no PAN, Aadhaar, bank account or address. |
| What a backup does **not** contain | object storage. R2 has its own versioning + lifecycle (§5). A restore is therefore a _pair_ of restores, and the drill covers both.                                                                                                                                                                                                               |

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
          → every payslip.input_digest recomputes from its persisted inputs (D3 traceability)
       e. decrypt one canary row per data_key.purpose with the production KEK
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
reconciliation: re-verify every `payslip.input_digest` and notify Accounts, because a
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
6. No `GRANT` to `ess_app` that the §4.4 revoke list forbids.
7. Migration SQL contains no literal credential, no `COPY … FROM PROGRAM`, no `CREATE
EXTENSION` outside the allowlist.

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
| Migration applied but the new API fails its health check                                                                                               | Render leaves the previous instances serving and marks the deploy failed                                            | roll the API image back (§8.6). **This is safe precisely because of expand/contract**: the expand-phase schema is always compatible with the previous image.                                                                                 |
| Migration applied, API healthy, data corruption discovered                                                                                             | out of scope for a deploy rollback: PITR restore (§4.5) to the recorded pre-migration LSN, then forward-fix         | incident                                                                                                                                                                                                                                     |

Because expand/contract guarantees schema(N+1) works with app(N), **the API image can always
be rolled back one version without touching the database.** That is the entire point of the
discipline, and it is what makes §8.6 a 60-second operation instead of a restore.

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
ess/<env>/<context>/<yyyy>/<mm>/<uuidv7>.<canonical-ext>

contexts: payslip · form16 · expense-bill · policy-document · letter ·
          employee-document · payroll-input · ticket-attachment · bank-proof
```

`file_object.storage_bucket` and `storage_key` persist the location; `sha256`, `byte_size`,
the sniffed `content_type` and `retention_until` persist alongside (`DATA-MODEL.md` §17.4).
Nothing in the UI ever renders a storage key.

### 5.2 Access model — private, always, with no exceptions

| Control                   | Setting                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public access             | **disabled**. No `r2.dev` public development URL, no custom public domain, no public bucket policy. A bucket that is public cannot be made safe by obscure keys.                                                                                                                                                                                                                                    |
| Credentials               | one R2 API token per environment, scoped to **one bucket**, with `Object Read & Write` only — never `Admin`, never account-wide. Production and staging tokens are different and neither can see the other's bucket.                                                                                                                                                                                |
| Who holds credentials     | the API and the worker only. **Not CI, not the SPA, not a browser.**                                                                                                                                                                                                                                                                                                                                |
| Browser → bucket writes   | **do not exist.** Every upload is `multipart/form-data` to the API, which authorizes, validates the magic bytes, re-encodes images, strips EXIF, scans with ClamAV and only then `PutObject`s (`SECURITY.md` §5.3). There is no presigned-PUT path to leave unguarded.                                                                                                                              |
| Browser → bucket reads    | **only** a presigned `GET`, minted by the API after the entity-level authorization check in `API.md` §11.1, **120 seconds**, single object, `GET` only, no wildcard, with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store` baked into the signature                              |
| Pre-signing preconditions | the API mints a URL only when `file_object.scan_status = 'CLEAN'`, `deleted_at IS NULL`, and the re-read `sha256` matches the persisted one; the `audit_event` is written **before** the URL is returned                                                                                                                                                                                            |
| Encryption at rest        | R2 encrypts every object server-side with AES-256 by default (SSE-managed). On AWS S3 the equivalent is `SSE-KMS` with a customer-managed key and `"s3:x-amz-server-side-encryption": "aws:kms"` enforced by bucket policy. `file_object.is_encrypted_at_rest` records this.                                                                                                                        |
| Encryption in transit     | HTTPS only; the endpoint is in `OUTBOUND_ALLOWLIST` (`SECURITY.md` §5.5)                                                                                                                                                                                                                                                                                                                            |
| Second layer              | payslip PDFs and bank proofs are additionally **application-encrypted before upload** with the `BANK`/`STATUTORY` DEK, so a storage compromise alone yields ciphertext. The 120-second signed URL therefore serves a decrypt-on-read stream from the API for those two contexts rather than a direct redirect — the implementer must keep `API.md` §11.2's `?mode=json` shape identical either way. |

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

| Rule                             | Prefix                   | Action                                                                                                                                              |
| -------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Abandoned multipart uploads      | `*`                      | abort after 1 day                                                                                                                                   |
| Quarantined files never promoted | `ess/prod/*/quarantine/` | delete after 30 days                                                                                                                                |
| Non-current object versions      | `*`                      | expire 90 days after becoming non-current (a window to undo an accidental overwrite, bounded so it is not an indefinite shadow copy of deleted PII) |
| Staging bucket                   | `*`                      | delete after 30 days                                                                                                                                |
| Backup bucket                    | `*`                      | object-lock retain 35 days, then delete                                                                                                             |

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
| Cookies              | `SameSite=Lax`, `Secure=false` (localhost is a secure context exception)              | `SameSite=None; Secure` (deploy previews are cross-site)                             | `SameSite=Strict; Secure`, `__Host-` prefix            |
| `LOG_LEVEL`          | `debug`                                                                               | `info`                                                                               | `info` — `debug` is **refused** at boot                |
| Deploys              | n/a                                                                                   | auto on merge to `main`, no approval                                                 | manual approval in the `production` GitHub environment |
| Who can reach the DB | the developer                                                                         | two engineers                                                                        | nobody interactively; break-glass only (§11.6)         |

**Staging never holds production data.** Not a masked copy, not a subset. A restore drill
(§4.5) uses a throwaway instance that is destroyed, never staging. This is what keeps the
number of systems holding real PAN/Aadhaar/salary at exactly one.

### 7.2 Environment variable reference

Legend — **S** = secret (never logged, never in git, never in a `VITE_` name);
**R** = required (boot fails without it) in that environment; `—` = not used.

#### Core runtime

| Variable              | Purpose                                                        | Example / placeholder          | dev | stg | prod | S   |
| --------------------- | -------------------------------------------------------------- | ------------------------------ | --- | --- | ---- | --- |
| `NODE_ENV`            | mode switch; gates every production-only check                 | `production`                   | R   | R   | R    |     |
| `SERVICE_ROLE`        | `api` \| `worker`; selects the entrypoint branch               | `api`                          | R   | R   | R    |     |
| `PORT`                | HTTP listen port                                               | `4000`                         | R   | R   | R    |     |
| `HOST`                | bind address                                                   | `0.0.0.0`                      | R   | R   | R    |     |
| `LOG_LEVEL`           | pino level; `debug`/`trace` refused when `NODE_ENV=production` | `info`                         | R   | R   | R    |     |
| `APP_VERSION`         | git SHA, surfaced by `GET /version` and on every log line      | `a1b2c3d`                      |     | R   | R    |     |
| `BUILT_AT`            | image build timestamp, surfaced by `GET /version`              | `2026-09-29T10:00:00Z`         |     | R   | R    |     |
| `API_PUBLIC_URL`      | absolute origin of the API; builds absolute links              | `https://api-ess.widedrop.com` | R   | R   | R    |     |
| `WEB_PUBLIC_URL`      | absolute origin of the SPA; deep links in outbound mail        | `https://ess.widedrop.com`     | R   | R   | R    |     |
| `ALLOWED_ORIGINS`     | exact CORS allowlist, comma-separated; rejects `*`             | `https://ess.widedrop.com`     | R   | R   | R    |     |
| `TRUSTED_PROXY_CIDRS` | exact proxy CIDRs for Fastify `trustProxy`; **never `true`**   | `10.0.0.0/8`                   |     | R   | R    |     |

#### Database

| Variable                  | Purpose                                                             | Example / placeholder                                                                      | dev | stg | prod | S     |
| ------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --- | --- | ---- | ----- |
| `DATABASE_URL`            | API → PgBouncer (transaction pooling); worker → direct              | `postgresql://ess_app:…@ess-pgbouncer:6432/widedrop_ess?pgbouncer=true&connection_limit=8` | R   | R   | R    | **S** |
| `DIRECT_DATABASE_URL`     | session-scoped connection: worker advisory locks, migrations, tools | `postgresql://ess_app:…@host:5432/widedrop_ess?sslmode=verify-full`                        | R   | R   | R    | **S** |
| `MIGRATE_DATABASE_URL`    | `ess_migrator` credentials; exists **only** in the CI migration job | `postgresql://ess_migrator:…@host:5432/…`                                                  | —   | R   | R    | **S** |
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
| `REFRESH_FAMILY_MAX_DAYS`        | absolute lifetime of a refresh family, 1–60                     | `30`                                             | R   | R   | R    |       |
| `PASSWORD_PEPPER_V1`             | HMAC-SHA512 pepper pre-hashed into Argon2id; base64 ≥ 32 B      | `REPLACE_ME__openssl rand -base64 48`            | R   | R   | R    | **S** |
| `PASSWORD_PEPPER_ACTIVE_VERSION` | which pepper new hashes use during rotation                     | `1`                                              | R   | R   | R    |       |
| `COOKIE_SAMESITE`                | `strict` prod, `none` staging, `lax` dev                        | `strict`                                         | R   | R   | R    |       |
| `COOKIE_SECURE`                  | must be `true` outside dev                                      | `true`                                           | R   | R   | R    |       |
| `COOKIE_DOMAIN`                  | **must be empty everywhere**; `__Host-` forbids `Domain` (§1.4) | _(empty)_                                        |     |     |      |       |
| `MFA_ISSUER_LABEL`               | the label shown in the authenticator app                        | `Widedrop ESS`                                   | R   | R   | R    |       |
| `HIBP_ENABLED`                   | breach-check new passwords via k-anonymity                      | `true`                                           | R   | R   | R    |       |
| `HIBP_TIMEOUT_MS`                | fail-open budget; degradation is metered and alerted            | `2000`                                           |     | R   | R    |       |

#### Encryption and integrity keys

| Variable                     | Purpose                                                         | Example / placeholder                 | dev | stg | prod | S     |
| ---------------------------- | --------------------------------------------------------------- | ------------------------------------- | --- | --- | ---- | ----- |
| `MASTER_KEK_V1` (+ `_V2`…)   | wraps every DEK; base64, **exactly 32 bytes**                   | `REPLACE_ME__openssl rand -base64 32` | R   | R   | R    | **S** |
| `MASTER_KEK_ACTIVE_VERSION`  | which KEK wraps new DEKs; both stay resident during rotation    | `1`                                   | R   | R   | R    |       |
| `BLIND_INDEX_KEY_V1`         | HMAC key for `*_bidx` exact-match lookup; base64 ≥ 32 B         | `REPLACE_ME__openssl rand -base64 48` | R   | R   | R    | **S** |
| `AUDIT_CHAIN_KEY_V1`         | HMAC key sealing the audit hash chain; base64 ≥ 32 B            | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `AUDIT_CHAIN_ACTIVE_VERSION` | new rows only; history is never re-keyed                        | `1`                                   | R   | R   | R    |       |
| `CSRF_KEY`                   | HMAC binding the double-submit token to the session             | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `LOG_HASH_KEY`               | HMAC for `ip_hash` / `user_agent_hash` / rate-limit bucket keys | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `RECOVERY_CODE_KEY`          | HMAC over MFA recovery codes                                    | `REPLACE_ME`                          | R   | R   | R    | **S** |
| `CURSOR_HMAC_KEY`            | signs pagination cursors, bound to `sub`                        | `REPLACE_ME`                          | R   | R   | R    | **S** |

#### Object storage

| Variable                    | Purpose                                                      | Example / placeholder                     | dev | stg | prod | S     |
| --------------------------- | ------------------------------------------------------------ | ----------------------------------------- | --- | --- | ---- | ----- |
| `STORAGE_DRIVER`            | `filesystem` \| `s3`; `filesystem` **refused** in production | `s3`                                      | R   | R   | R    |       |
| `STORAGE_ENDPOINT`          | S3-compatible endpoint; must be `https://`                   | `https://<acct>.r2.cloudflarestorage.com` | —   | R   | R    |       |
| `STORAGE_REGION`            | `auto` for R2, `ap-south-1` for S3                           | `auto`                                    | —   | R   | R    |       |
| `STORAGE_BUCKET`            | one bucket per environment                                   | `widedrop-ess-prod`                       | —   | R   | R    |       |
| `STORAGE_ACCESS_KEY_ID`     | bucket-scoped token id                                       | `REPLACE_ME`                              | —   | R   | R    | **S** |
| `STORAGE_SECRET_ACCESS_KEY` | bucket-scoped token secret                                   | `REPLACE_ME`                              | —   | R   | R    | **S** |
| `STORAGE_FORCE_PATH_STYLE`  | `true` for R2                                                | `true`                                    | —   | R   | R    |       |
| `STORAGE_LOCAL_PATH`        | dev only, filesystem driver root                             | `./.storage`                              | R   | —   | —    |       |
| `SIGNED_URL_TTL_SECONDS`    | 30–3600; **120** per `API.md` §11.2                          | `120`                                     | R   | R   | R    |       |

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

| Variable                      | Purpose                                                           | Example / placeholder                                                                                                | dev | stg | prod | S     |
| ----------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --- | --- | ---- | ----- |
| `WORKER_POLL_INTERVAL_MS`     | job loop tick, 1 000–300 000                                      | `15000`                                                                                                              | R   | R   | R    |       |
| `WORKER_CONCURRENCY`          | parallel jobs per worker instance                                 | `4`                                                                                                                  | R   | R   | R    |       |
| `RATE_LIMIT_STORE`            | `postgres` (default, per `SECURITY.md` §9.3) \| `redis`           | `postgres`                                                                                                           | R   | R   | R    |       |
| `REDIS_URL`                   | only when `RATE_LIMIT_STORE=redis`; TLS required in production    | `rediss://…`                                                                                                         |     |     |      | **S** |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `clamd` INSTREAM target; required in staging and production       | `ess-clamav` / `3310`                                                                                                |     | R   | R    |       |
| `OUTBOUND_ALLOWLIST`          | the only hostnames the process may egress to (`SECURITY.md` §5.5) | `api.pwnedpasswords.com,email.ap-south-1.amazonaws.com,<acct>.r2.cloudflarestorage.com,sns.ap-south-1.amazonaws.com` | R   | R   | R    |       |

#### Observability

| Variable                    | Purpose                                                                         | Example / placeholder           | dev | stg | prod | S     |
| --------------------------- | ------------------------------------------------------------------------------- | ------------------------------- | --- | --- | ---- | ----- |
| `SENTRY_DSN`                | error tracking; omit to disable                                                 | `https://…@…ingest.sentry.io/…` | —   | R   | R    | **S** |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0`–`1.0`                                                                     | `0.05`                          | —   | R   | R    |       |
| `METRICS_ENABLED`           | expose `/metrics`                                                               | `true`                          |     | R   | R    |       |
| `METRICS_BEARER_TOKEN`      | bearer required by `/metrics`; the route is also bound to the private interface | `REPLACE_ME`                    | —   | R   | R    | **S** |
| `LOG_SINK_TOKEN`            | token for the log shipper, when the platform does not forward stdout            | `REPLACE_ME`                    | —   | R   | R    | **S** |

#### Web build-time (all public, all non-secret, all baked into the bundle)

| Variable            | Purpose                                                            | Example                        |
| ------------------- | ------------------------------------------------------------------ | ------------------------------ |
| `VITE_API_BASE_URL` | the API origin; also the CSP `connect-src` value (§2.3)            | `https://api-ess.widedrop.com` |
| `VITE_APP_ENV`      | `production` \| `staging` \| `preview` \| `development`            | `production`                   |
| `VITE_BUILD_SHA`    | shown in the About panel; correlates a client report to a build    | `a1b2c3d`                      |
| `VITE_SENTRY_DSN`   | browser DSN — a public value by design, and rate-limited at Sentry | `https://…`                    |

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

| #   | Refusal                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Any secret shorter than its minimum decoded length, or a KEK that is not exactly 32 bytes                                                                                 |
| 2   | Any secret whose value appears in the committed `.env.example`                                                                                                            |
| 3   | Any secret matching a known placeholder (`changeme`, `dev-secret`, `REPLACE_ME`, all-zero, 32 identical bytes)                                                            |
| 4   | Any secret with Shannon entropy below 3.5 bits/byte over its decoded form                                                                                                 |
| 5   | **The same value reused across two different variables**                                                                                                                  |
| 6   | `DATABASE_URL`/`DIRECT_DATABASE_URL` without `sslmode=verify-full` (the private PgBouncer hop is the single documented exception, recognised by the `ess-pgbouncer` host) |
| 7   | `ALLOWED_ORIGINS` containing `*`, `http://`, or an entry that is not an exact absolute origin                                                                             |
| 8   | `COOKIE_SECURE=false`, `COOKIE_SAMESITE=none`, or `COOKIE_DOMAIN` set to anything non-empty                                                                               |
| 9   | `LOG_LEVEL` of `debug` or `trace`                                                                                                                                         |
| 10  | `STORAGE_DRIVER=filesystem` (a container filesystem is ephemeral — payslips would vanish on redeploy)                                                                     |
| 11  | `MAIL_PROVIDER` of `file`/`noop`/`smtp`, or `MAIL_TO_OVERRIDE` set                                                                                                        |
| 12  | `MAIL_FROM` not ending `@widedroptech.com`                                                                                                                                |
| 13  | `CLAMAV_HOST` unset                                                                                                                                                       |
| 14  | `TRUSTED_PROXY_CIDRS` unset, or set to `true`/`0.0.0.0/0`                                                                                                                 |
| 15  | `JWT_ACTIVE_KID` with no matching `JWT_SIGNING_KEY_<kid>`, or a key that fails to parse as Ed25519 PKCS#8                                                                 |
| 16  | `MASTER_KEK_ACTIVE_VERSION` with no matching `MASTER_KEK_V<n>`                                                                                                            |
| 17  | A `SERVICE_ROLE` other than `api` or `worker`                                                                                                                             |

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
      - run: node apps/web/scripts/assert-no-inline-styles.mjs
      - uses: actions/upload-artifact@<sha>
        with: { name: web-dist, path: apps/web/dist, retention-days: 7 }

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

Two integration tests are treated as **release gates**, not ordinary tests, and are named
explicitly in the required-checks list:

- `payroll-visibility.spec.ts` — walks the full six-step workflow and asserts `404` on every
  employee-facing payslip route at each earlier step (`SECURITY.md` Appendix A.3).
- `outbox.spec.ts` — the help-desk email-failure test of §6.5.

### 8.2 On merge to `main` — `.github/workflows/deploy.yml`

```yaml
name: Deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  packages: write # GHCR push
  id-token: write # OIDC

concurrency:
  group: deploy-production # one deploy at a time, never cancelled mid-flight
  cancel-in-progress: false

jobs:
  # ---------------------------------------------------------------- 1 ----
  build-image:
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
    steps:
      - uses: actions/checkout@<sha>
      # API first, then worker, each polled to `live`; a health-check failure
      # leaves the previous instances serving and fails the job.
      - run: node scripts/render-deploy.mjs --service ess-api    --digest ${{ needs.build-image.outputs.digest }} --wait
      - run: node scripts/render-deploy.mjs --service ess-worker --digest ${{ needs.build-image.outputs.digest }} --wait
        env: { RENDER_API_KEY: '${{ secrets.RENDER_API_KEY }}' }
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
      - uses: actions/setup-node@<sha>
        with: { node-version: '22', cache: npm }
      - run: npm ci --ignore-scripts
      - run: npm run build -w @widedrop/shared
      - run: npm run build -w @widedrop/web
        env:
          VITE_API_BASE_URL: https://api-ess.widedrop.com
          VITE_APP_ENV: production
          VITE_BUILD_SHA: ${{ github.sha }}
          VITE_SENTRY_DSN: ${{ vars.VITE_SENTRY_DSN }}
      - run: node apps/web/scripts/gen-csp-headers.mjs # writes dist/_headers (§2.3)
      - run: node apps/web/scripts/assert-no-inline-styles.mjs
      - name: Deploy to Netlify (no Netlify build minutes consumed)
        run: |
          npx netlify-cli@17 deploy --prod --no-build \
            --dir=apps/web/dist --site="$NETLIFY_SITE_ID" --auth="$NETLIFY_AUTH_TOKEN" \
            --message="ess-web ${GITHUB_SHA::7}" --json > deploy.json
          node scripts/record-netlify-deploy.mjs deploy.json >> "$GITHUB_STEP_SUMMARY"
        env:
          NETLIFY_SITE_ID: ${{ secrets.NETLIFY_SITE_ID }}
          NETLIFY_AUTH_TOKEN: ${{ secrets.NETLIFY_AUTH_TOKEN }}
      - name: Verify headers reached the edge
        run: node scripts/assert-headers.mjs https://ess.widedrop.com
```

**Deploy order is API → worker → SPA, and it is not arbitrary.** The schema is always ahead
of the API (expand/contract), the API is always ahead of the SPA, and the SPA is the only
component a user's browser caches — so at no instant does a client call an endpoint that does
not exist.

### 8.3 Environment protection and required checks

| Control                         | Setting                                                                                                                                                                                                                           |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch protection on `main`     | linear history; no force-push; no deletion; **required reviewers 1** (2 for anything under `apps/api/src/auth/**`, `apps/api/src/crypto/**`, `prisma/migrations/**`, `infra/**`, `.github/workflows/**` via `CODEOWNERS`)         |
| Required status checks          | `quality`, `test`, `security`, `codeql`, `payroll-visibility`, `outbox` — all must pass, and the branch must be up to date                                                                                                        |
| GitHub environment `staging`    | no reviewer; secrets scoped to staging                                                                                                                                                                                            |
| GitHub environment `production` | **required reviewer** (a named ops owner, who may not be the PR author), a 10-minute wait timer, deployment branch restricted to `main` only, secrets scoped to production                                                        |
| Secrets in CI                   | no long-lived cloud credentials: OIDC to GHCR; `RENDER_API_KEY` scoped to deploy-only; Netlify token scoped to the ESS site. CI never receives a database URL, a KEK, a JWT key or a mail credential.                             |
| Actions hygiene                 | all actions pinned to a full SHA; `permissions:` least-privilege per job; `npm ci --ignore-scripts`; Dependabot on `npm`, `docker` and `github-actions`                                                                           |
| Audit                           | every production deploy writes an `audit_event` of kind `ADMIN.DEPLOYED` (actor = the approving GitHub user, from the workflow's OIDC claims) via the post-deploy step, so a deploy is in the same trail as a payroll publication |

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

| Endpoint              | Exposure                                          | Semantics                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/healthz` | public, `ip` 60/min, `Cache-Control: no-store`    | **Liveness only, touching no dependency** — `200 {"status":"ok"}`. Wired to the container `HEALTHCHECK` and to Render's `healthCheckPath`. A Postgres blip must not restart-loop the API.                                                                                                                                                                                                   |
| `GET /api/v1/readyz`  | **private interface only, not internet-routable** | `200 {"status":"ready","checks":{"db":"ok","objectStorage":"ok","kms":"ok","rateLimitStore":"ok","mailProvider":"degraded"}}` or `503`. `db`, `kms` and `rateLimitStore` failing ⇒ not ready. **`mailProvider: "degraded"` does not fail readiness** — the outbox absorbs it (§6.5). Flips to `503` immediately on `SIGTERM` so the platform drains the instance before it stops accepting. |
| `GET /api/v1/version` | requires `auth:login`                             | `{"apiVersion","gitSha","builtAt","schemaSha256","payrollEngineVersion"}`. No dependency versions, no hostnames, no env names — a version endpoint is reconnaissance surface.                                                                                                                                                                                                               |
| `GET /api/v1/metrics` | private interface **and** `METRICS_BEARER_TOKEN`  | Prometheus exposition (§9.3)                                                                                                                                                                                                                                                                                                                                                                |

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

| Check            | Target                                                                                                                                         | Interval | From                             | Fails after   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------- | ------------- |
| API liveness     | `GET https://api-ess.widedrop.com/api/v1/healthz` expecting `200` and `"ok"`                                                                   | 60 s     | 3 regions incl. Mumbai/Singapore | 2 consecutive |
| SPA availability | `GET https://ess.widedrop.com/` expecting `200` and the `Strict-Transport-Security` header                                                     | 60 s     | 3 regions                        | 2 consecutive |
| Synthetic login  | scripted `login → MFA → GET /me/dashboard` with a dedicated, least-privileged probe account                                                    | 15 min   | 1 region                         | 2 consecutive |
| TLS expiry       | both hosts                                                                                                                                     | daily    | —                                | < 21 days     |
| Worker heartbeat | the worker writes `ess_ops.background_job('worker-heartbeat')` every minute; a dead-man check alerts if the newest row is older than 5 minutes | 60 s     | —                                | 5 min         |
| DNS drift        | `ess`, `api-ess`, and the apex/`www`/`MX` of `widedrop.com` compared against `infra/dns/*.before.txt`                                          | daily    | —                                | any diff      |

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
| Email                       | Amazon SES `ap-south-1`         | ~8 000 messages                                      | 1         |
| Error tracking              | Sentry Team                     | 50k events, 90-day retention                         | 26        |
| Logs                        | Better Stack / Grafana Cloud    | ~10 GB ingest, 30 d hot                              | 25        |
| Uptime + status page        | Better Stack Uptime             | 6 monitors, 60 s, 3 regions                          | 8         |
| DNS                         | existing registrar / Cloudflare | 2 records added                                      | 0         |
| Container registry          | GHCR                            | under the free private allowance                     | 0         |
| CI                          | GitHub Actions                  | ~600 min/mo on a private repo (2 000 free)           | 0         |
|                             |                                 | **Total**                                            | **≈ 280** |

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
B3.  Create the database roles (§4.4) as ess_owner, with fresh passwords. Apply the
     statement/lock timeouts. Then close the ess_owner session and do not reopen it.
B4.  Run the migration job: prisma migrate deploy → record-schema-guard → assert-privileges.
     assert-privileges MUST pass; if it does not, stop — the grants are wrong.
B5.  Deploy ess-api and ess-worker on the first image digest. /healthz green,
     /readyz all "ok" except mailProvider (which may be "degraded" until B7).
B6.  Seed reference data: npm run db:seed:reference.
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
B8.  Create the organisation row and its settings (legal name, PAN/TAN, address, financial
     year start = April, pay-day rule, business hours, helpdesk_email =
     helpdesk@widedroptech.com) via the bootstrap tool, audited as ADMIN.ORG_CREATED.
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
B11. Verify the bootstrap left nothing behind:
       SELECT id,status,password_hash IS NULL AS no_pw FROM ess.app_user;   → 1 row, ACTIVE
       SELECT count(*) FROM ess.user_invitation WHERE consumed_at IS NULL;  → 0
       grep -ri "password" prisma/seed*.ts                                  → no credential
     If --print-link was used, purge that job's log from the platform now.
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
     persisted to payroll_input_row with row_number and source_file_id; formulas are never
     evaluated; the file's sha256 and the batch are recorded (ux_pib__cycle_file_sha makes
     a re-upload of the same bytes idempotent).
     Verify: the Payroll screen's counts come from payroll_input_row, not from the file.
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
     One worker task takes pg_advisory_lock('payroll:'||cycle_id) on a DIRECT connection
     (§4.3) and holds it for the whole run. Each payslip records payroll_engine_version and
     input_digest = SHA-256 over the canonical JSON of its inputs (SECURITY.md §7.4).
     Watch: payroll_cycle_duration_seconds{phase="calculating"}, background_job_failures_total.
     Payslips exist now but are NOT visible: no payslip_publication row exists, and the
     employee-facing routes return 404 (API.md §11.1, enforced in SQL by the publication
     gate in the RLS policy — not by a UI condition).

P7.  REVIEW  (Accounts, and HR for headcount)
     Compare the run's totals against the previous cycle; investigate any employee whose net
     moved more than a configured threshold. Re-verify a sample:
       node apps/api/dist/tools/verify-payslip-digests.js --cycle <id> --sample 25
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

Two distinct operations. **Rehearse both in staging first** — the staging database has the
same schema and synthetic data, so a rehearsal proves the scripts, the timings and the
verification queries.

#### 11.3.1 KEK rotation (cheap, ~minutes, no downtime) — annually, or immediately on suspicion

Only the wrapped DEKs change; **no column data is touched**.

```
K1.  Mint the new KEK:  openssl rand -base64 32   → MASTER_KEK_V2
     Add it to the Render environment group ALONGSIDE MASTER_KEK_V1. Do not remove V1.
     Add V2 to the sealed break-glass envelope before proceeding (§7.3).
K2.  Set MASTER_KEK_ACTIVE_VERSION=2 and redeploy. Both KEKs are now resident: the app
     unwraps with whichever kek_version each data_key row names, and wraps new DEKs with V2.
K3.  Re-wrap, as a one-off job:
       node apps/api/dist/tools/rewrap-deks.js --from 1 --to 2
     For each data_key row, in a transaction: unwrap with V1, re-wrap with V2, set
     kek_version=2. There are single-digit rows (one per purpose), so this is seconds.
     Emits SECURITY.KEY_ROTATION_STARTED / _COMPLETED with counts.
K4.  Verify:
       SELECT purpose, kek_version, status FROM ess.data_key ORDER BY purpose;
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
D2.  If BLIND_INDEX_KEY is rotating too, add BLIND_INDEX_KEY_V2 now — the *_bidx values are
     recomputed in the SAME backfill pass, so rotating them separately would mean two scans.
D3.  Insert the new data_key row as PENDING, wrapped under the current KEK; flip it ACTIVE
     and the previous one RETIRING:
       node apps/api/dist/tools/rotate-dek.js --purpose BANK --begin
     From this moment new writes use the new DEK and reads still decrypt with whichever
     dek_id the envelope names. This dual-read is inherent to the envelope format and needs
     no feature flag — which is why a stall here is harmless.
D4.  Backfill:
       node apps/api/dist/tools/reencrypt-worker.js --purpose BANK --batch 500
     Walks each affected table in id order, 500 rows per transaction,
     SELECT … FOR UPDATE SKIP LOCKED, decrypt-old → encrypt-new (recomputing *_bidx when
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
       b. verify-payslip-digests --sample 100  → every input_digest recomputes
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
     patch level, Postgres 16 minor version, the pinned action SHAs.
Q7.  Cost review against §10, and a check that staging has not silently grown production-like
     data (it must contain no real employee).
Q8.  Confirm the empty-state guarantee still holds: point a scratch API at a freshly migrated,
     reference-seeded database with zero operational rows and walk every screen. Any screen
     that errors, renders a blank box, or shows an invented number is a bug against
     directive 9 — and this is the only routine check that catches a regression in it.
```

---

## 12. Open risks and reconciliations

| #    | Item                                                                                                                                                      | Impact                                                                            | Proposed resolution                                                                                                                                                                                                        |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1  | API hostname: this document, `SECURITY.md` and `API.md` use `api-ess.widedrop.com`; the task brief proposed `api.ess.widedrop.com`                        | none technically; a documentation inconsistency if left unstated                  | §0.2. Confirm with the domain owner, then the string is fixed in four places.                                                                                                                                              |
| R-2  | `SECURITY.md` §10.2 requires `MAIL_FROM` to end `@widedrop.com`, but the mandated help-desk address and the `WORKFLOWS.md` sender are `@widedroptech.com` | the boot check would reject a correct configuration                               | Amend `SECURITY.md` §10.2 to `@widedroptech.com`. Keeps all mail DNS out of the `widedrop.com` zone.                                                                                                                       |
| R-3  | `apps/api/src/config/env.ts` uses single-version key names                                                                                                | rotation procedures in `SECURITY.md` §3.2/§7.3 cannot be executed                 | §0.4 rename table, before any production secret is minted.                                                                                                                                                                 |
| R-4  | `POST /api/v1/webhooks/ses` (bounce/complaint) is not in `API.md` §13                                                                                     | delivery state would be `SENT` forever and bounces invisible                      | Add the route with the §6.4 guard block, plus its `public: true` allowlist entry.                                                                                                                                          |
| R-5  | `SECURITY.md` §6.4 names `apps/web/public/_headers` as a header source                                                                                    | duplicate/conflicting `Content-Security-Policy` headers at the edge               | §2.3: `netlify.toml` owns all headers except CSP; CSP is generated into `dist/_headers`; a build assertion fails if `public/_headers` exists.                                                                              |
| R-6  | `infra/certs/render-postgres-ca.pem` is referenced by the Dockerfile but does not exist in the repo                                                       | the image build fails, or `sslmode=verify-full` cannot be used                    | Download the provider CA at bootstrap, commit it (a public certificate, not a secret), and add a CI check that it is not expiring within 90 days.                                                                          |
| R-7  | Render has no India region; Postgres and the API sit in Singapore                                                                                         | a future contract or policy may require in-country storage                        | Documented in `docs/PROCESSORS.md`; §3.7 gives the Fly.io `bom` + `ap-south-1` Postgres path. The migration is a restore plus a DNS change, not a rewrite.                                                                 |
| R-8  | SES has no provider-side idempotency key, which `WORKFLOWS.md` §6.3 assumes                                                                               | a crash between send and status write could duplicate one message                 | §6.1: `Message-ID` derived from `email_outbox.id` plus the `SENDING` claim and 10-minute sweep bound it. Switch `MAIL_PROVIDER` to Resend if strict idempotency becomes a requirement.                                     |
| R-9  | Single worker instance                                                                                                                                    | the outbox, SLA escalations, accruals and payroll calculation all stop if it dies | Mitigated by the heartbeat dead-man alert (§9.4) rather than by redundancy, because the lease design makes a restart safe and a second instance adds cost without removing the failure mode. Revisit above ~500 employees. |
| R-10 | ClamAV unavailable ⇒ uploads land `QUARANTINED`                                                                                                           | expense claims and tickets accept files that nobody can then read                 | Correct and deliberate (`SECURITY.md` §5.3.10), but the UI must say so honestly; the P3 alert (§9.5) exists so it is noticed within 30 minutes rather than at month-end.                                                   |
| R-11 | `ess_owner` credentials exist in a sealed envelope                                                                                                        | a two-person offline process is a real operational dependency                     | Test it during the quarterly review (Q3) — an escrow nobody has ever opened is not an escrow.                                                                                                                              |
| R-12 | Netlify free tier has no SLA                                                                                                                              | an outage takes the SPA down while the API stays up                               | Accepted: the SPA is static and the API's data is unaffected. If an SLA is required, the ESS site moves to a paid Netlify plan (~$19) or to Cloudflare Pages, changing only §2 and the CSP `connect-src` consumer.         |
