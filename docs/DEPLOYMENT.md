# Widedrop ESS — Deployment & Operations Architecture

**Status:** implementation-ready specification.
**Audience:** the implementer and whoever is on call afterwards.
**Companions:** `docs/SECURITY.md` (controls), `docs/DATA-MODEL.md` (schema),
`docs/API.md` (wire contract), `docs/WORKFLOWS.md` (state machines).
This document is the authority for *where things run, how they are configured, how they
ship and how they are recovered*. Where it repeats a control from `SECURITY.md` it does so
only to state the deployment-time obligation; the security rationale lives there.

---

## 0. Conventions, and three reconciliations you must apply

### 0.1 Naming conventions

| Thing | Value |
|---|---|
| SPA host (production) | `ess.widedrop.com` |
| API host (production) | `api-ess.widedrop.com` |
| SPA host (staging) | `ess-staging.widedrop.com` |
| API host (staging) | `api-ess-staging.widedrop.com` |
| API base path | `/api/v1` |
| Mail sending domain | `widedroptech.com` |
| Existing marketing site | `widedrop.com` + `www.widedrop.com` — **untouched** |
| Container image | `ghcr.io/widedrop/ess-api:<git-sha>` (immutable; `:latest` is never deployed) |
| Primary region | `singapore` (Render) for API + Postgres; `apac` hint for R2; `ap-south-1` (Mumbai) for SES |

### 0.2 Reconciliation R-1 — the API hostname is flat, not nested

The brief for this document proposed `api.ess.widedrop.com`. `docs/SECURITY.md` §6.1/§6.3/§6.5
and `docs/API.md` §1.1 were written against **`api-ess.widedrop.com`**, and those strings are
baked into the CSP `connect-src`, the CORS allowlist, the JWT issuer/audience and the TLS
section. This document adopts **`api-ess.widedrop.com`** so the four documents agree.

The choice is security-neutral: both names sit under the registrable domain `widedrop.com`,
so both are *same-site* with `ess.widedrop.com` (§1.4), and both are host-locked identically
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

| In the scaffold today | Canonical name | Why |
|---|---|---|
| `CORS_ORIGINS` | `ALLOWED_ORIGINS` | matches `SECURITY.md` §6.5 |
| `JWT_PRIVATE_KEY` / `JWT_PUBLIC_KEY` / `JWT_KEY_ID` | `JWT_SIGNING_KEY_<kid>` / `JWT_PUBLIC_KEY_<kid>` / `JWT_ACTIVE_KID` | overlapping-key rotation (`SECURITY.md` §3.2) needs N keys resident at once |
| `PASSWORD_PEPPER` | `PASSWORD_PEPPER_V1` (+ `_V2`…) | lazy re-hash rotation |
| `ENCRYPTION_KEK` / `ENCRYPTION_KEY_VERSION` | `MASTER_KEK_V1` (+ …) / `MASTER_KEK_ACTIVE_VERSION` | KEK re-wrap keeps the old KEK for 30 days |
| `AUDIT_HMAC_KEY` | `AUDIT_CHAIN_KEY_V1` | chain history is never re-keyed |
| `REDIS_URL` **required** in production | `RATE_LIMIT_STORE=postgres\|redis`, `REDIS_URL` optional | `SECURITY.md` §9.3 makes Postgres the primary limiter store; Redis is the >200 rps upgrade |
| `S3_*` | `STORAGE_*` | matches `SECURITY.md` §10.2 |
| `SMTP_*` | `MAIL_*` (HTTPS provider API) | `WORKFLOWS.md` §6.3 forbids raw SMTP string concatenation |
| — (absent) | `DIRECT_DATABASE_URL` | session-scoped advisory locks and migrations must bypass the transaction pooler (§4.3) |
| — (absent) | `SERVICE_ROLE`, `TRUSTED_PROXY_CIDRS`, `BLIND_INDEX_KEY_V1`, `CSRF_KEY`, `LOG_HASH_KEY`, `RECOVERY_CODE_KEY`, `CURSOR_HMAC_KEY`, `CLAMAV_*`, `OUTBOUND_ALLOWLIST` | required by `SECURITY.md` §5.3, §5.5, §7.2, §7.4, §9.2 |

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

| # | Component | Product / plan | Purpose | Holds persistent data? | Reachable from the internet? |
|---|---|---|---|---|---|
| 1 | Marketing site | Netlify, existing free team | `widedrop.com` | no | yes (unchanged) |
| 2 | ESS SPA | Netlify, **new dedicated site on a new team** | static React build at `ess.widedrop.com` | no | yes |
| 3 | ESS API | Render Web Service (Docker), `singapore`, 2 instances | Fastify, all authorization, all business logic | no (stateless) | yes, `api-ess.widedrop.com` only |
| 4 | ESS worker | Render Background Worker (same image, `SERVICE_ROLE=worker`), 1 instance | `email-dispatch` + the 21 named jobs in `DATA-MODEL.md` §17.5 | no (state is in Postgres) | **no** |
| 5 | Connection pooler | Render Private Service, PgBouncer, transaction mode | multiplexes API connections onto Postgres | no | **no** |
| 6 | Malware scanner | Render Private Service, `clamav/clamav:stable`, 2 GB | `clamd` INSTREAM scan of every upload (`SECURITY.md` §5.3.10) | signature DB only | **no** |
| 7 | Database | Render Managed PostgreSQL 16, `singapore` | **the system of record** | **yes** | **no** — private network + IP allowlist |
| 8 | Object storage | Cloudflare R2, `apac` location hint | payslip PDFs, expense bills, policy PDFs, letters, payroll input files | **yes** | no public access; 120 s signed GET only |
| 9 | Email | Amazon SES, `ap-south-1` | help-desk dispatch, invites, resets, notifications | no | outbound; inbound SNS webhook only |
| 10 | CI/CD | GitHub Actions + GHCR | build, test, scan, migrate, deploy | build artifacts | n/a |
| 11 | Logs | Better Stack (or Grafana Cloud Loki) | structured JSON log sink, 30 d hot / 180 d cold | logs (PII-redacted) | no |
| 12 | Errors | Sentry, PII scrubbing on | exception tracking | scrubbed events | no |
| 13 | Uptime | Better Stack Uptime (or Healthchecks.io) | external probe of `/api/v1/healthz` and the SPA | no | n/a |

**What deliberately does not exist:** no Netlify Functions, no Netlify Edge Functions, no
serverless function as a system of record, no CDN in front of the API, no public database
endpoint, no browser-to-bucket write path, no SSR, no cookie shared with `widedrop.com`.

### 1.3 Why a second Netlify site, on a second Netlify team

| Option | Verdict |
|---|---|
| Path on the existing site (`widedrop.com/ess`) via a rewrite | **Rejected.** One deploy pipeline for two products; a marketing deploy can break the portal; the CSP and HSTS the portal needs would be forced onto the marketing site; `Path=/` cookies would be shared with marketing pages; and there is no way to give HR/engineering access to one without the other. |
| Second site, same Netlify team | Workable but rejected as default. Free-tier **build minutes (300/mo) and bandwidth (100 GB/mo) are account-wide**, so ESS traffic would silently consume the marketing site's allowance, and one leaked Netlify token would reach both sites. |
| **Second site, separate Netlify team** (chosen) | Independent quota, independent access control, independent deploy token, independent rollback. Free tier is sufficient for a static SPA. The marketing site's team is never given an ESS credential and never sees an ESS deploy. |

**Build minutes are additionally reduced to zero** on *both* teams: the SPA is built inside
GitHub Actions and uploaded with `netlify deploy --prod --dir=apps/web/dist --no-build`.
Netlify only serves the artifact. This means the ESS can ship any number of times a day
without ever touching a free-tier build-minute budget, on either team (§2.5).

### 1.4 Same-site cookie implications — the reason the subdomain choice matters

The refresh session lives in `__Host-wd_rt`, an `HttpOnly` cookie set by the API
(`SECURITY.md` §3.4). Whether the browser attaches it to the SPA's XHR is decided by the
**site** comparison, which uses the registrable domain (eTLD+1), *not* the full host.

| Layout | SPA origin | API origin | eTLD+1 | Browser verdict | Cookie behaviour |
|---|---|---|---|---|---|
| **Chosen** | `https://ess.widedrop.com` | `https://api-ess.widedrop.com` | both `widedrop.com` | **same-site**, cross-origin | `SameSite=Strict` attaches on the SPA's own `fetch`. `SameSite=Lax` would also work; `Strict` is chosen because nothing in the flow depends on a cross-site top-level navigation carrying the cookie, and `Strict` additionally blocks a phishing page navigating the victim to `/auth/refresh`. |
| Nested alternative | `https://ess.widedrop.com` | `https://api.ess.widedrop.com` | both `widedrop.com` | identical | identical — the extra label changes nothing for `SameSite`. |
| **Cross-site alternative** (rejected) | `https://ess.widedrop.com` | `https://widedrop-ess-api.onrender.com` or `api.widedrop-ess.com` | `widedrop.com` vs `onrender.com` | **cross-site** | Requires `SameSite=None; Secure` on the refresh cookie. That is strictly worse: the cookie is then attached to *every* cross-site request the browser can be tricked into making, so CSRF defence rests entirely on the server-side token; Safari ITP and Firefox TCP treat it as third-party storage and may **partition or evict it**, silently logging users out; and `__Host-` plus `SameSite=None` is a combination several corporate proxies and webviews mishandle. |

Three consequences the implementer must honour:

1. **`credentials: 'include'` is still required** on the SPA's `fetch` to the API, because
   same-site is not same-*origin*. CORS is therefore still in play, with an exact-string
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

| Setting | Value |
|---|---|
| Site name | `widedrop-ess` (serves `widedrop-ess.netlify.app`) |
| Repository | connected **read-only for previews only**; production deploys arrive from CI (§2.5) |
| Base directory | `apps/web` |
| Build command | `npm run build` (only used by deploy previews; production builds happen in CI) |
| Publish directory | `apps/web/dist` |
| Functions directory | **unset** — the ESS site runs no functions |
| Node version | `22` (from `.nvmrc`, and pinned again in `netlify.toml`) |
| Custom domain | `ess.widedrop.com` (primary). No apex, no `www`. |
| HTTPS | Let's Encrypt, auto-renew; "Force HTTPS" **on** |
| Asset optimisation / post-processing | **off** — it rewrites markup and would break SRI and the no-inline-style guarantee (`SECURITY.md` §6.3) |
| Branch deploys | `staging` only |
| Deploy previews | on, for PRs; they point at the **staging** API (§2.4) |
| Environment variables | `VITE_API_BASE_URL`, `VITE_APP_ENV`, `VITE_BUILD_SHA`, `VITE_SENTRY_DSN` — all public build-time config, **never a secret** |

### 2.2 `infra/netlify/netlify.toml` — committed, canonical

This file is the single source of truth for build config, the SPA fallback and every
**context-invariant** header. The `Content-Security-Policy` is *not* here: its `connect-src`
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
   copied into `dist` and merged with the generated file). *Amend `SECURITY.md` §6.4, which
   mentions `apps/web/public/_headers`: that file is not used.*

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

| Item | Change |
|---|---|
| The `widedrop.com` Netlify site, its build settings, its `netlify.toml`, its env vars | **none** |
| The apex `A` / `ALIAS` / `ANAME` record and the `www` `CNAME` | **none** |
| `MX`, existing `SPF`, existing `DKIM`, existing `DMARC` on `widedrop.com` | **none** (all ESS mail DNS is in `widedroptech.com` — see R-2) |
| `NS` and `SOA` of `widedrop.com` | **none** |
| The marketing team's Netlify members, tokens, or build-minute budget | **none**; ESS lives in a different team and builds in CI |
| Marketing site TLS certificate | **none**; `ess` gets its own certificate on its own site |
| Marketing site headers/CSP | **none**; Netlify headers are per-site, never inherited across sites |

**The one shared resource is the DNS zone.** Two records are added to it, both leaf `CNAME`s
on previously unused labels. Adding a subdomain record cannot affect apex resolution.

### 2.7 DNS records to add

**Case A — `widedrop.com` DNS is at a registrar or Cloudflare (external DNS).**

| Name | Type | Value | TTL | Note |
|---|---|---|---|---|
| `ess` | `CNAME` | `widedrop-ess.netlify.app.` | 300 | Netlify then issues the cert automatically |
| `api-ess` | `CNAME` | `ess-api.onrender.com.` | 300 | Render's generated hostname for the service |
| `_acme-challenge.api-ess` | — | — | — | not needed; Render uses HTTP-01 |
| `ess-staging` | `CNAME` | `widedrop-ess-staging.netlify.app.` | 300 | staging only |
| `api-ess-staging` | `CNAME` | `ess-api-staging.onrender.com.` | 300 | staging only |

If the provider is Cloudflare, these records must be **DNS-only (grey cloud)**. Proxying
`api-ess` through Cloudflare would put a CDN in front of authenticated responses, which
`SECURITY.md` §6.6 forbids, and would replace the client IP that the rate limiter keys on.

**Case B — `widedrop.com` is delegated to Netlify DNS on the marketing team.**
The zone is edited in the marketing team's DNS panel, but *only by adding records*:

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

previewsEnabled: false          # no Render preview environments; staging is explicit

databases:
  - name: ess-postgres
    databaseName: widedrop_ess
    user: ess_owner             # the OWNER role; the app never uses it (§4.4)
    plan: standard              # 4 GB RAM / 4 vCPU / 100 GB SSD, daily backup + PITR
    region: singapore
    postgresMajorVersion: "16"
    ipAllowList: []             # [] == private network only, NO public endpoint

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
        value: ""                       # MUST stay empty — __Host- forbids Domain (§1.4)
      - key: COOKIE_SAMESITE
        value: strict
      - key: COOKIE_SECURE
        value: "true"
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
        value: "true"
      - key: SIGNED_URL_TTL_SECONDS
        value: "120"
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
        value: "true"
      - key: CLAMAV_HOST
        value: ess-clamav                      # Render private-service DNS name
      - key: CLAMAV_PORT
        value: "3310"
      - key: TRUSTED_PROXY_CIDRS
        value: 10.0.0.0/8                      # Render's edge; confirm in the dashboard
      - key: ACCESS_TOKEN_TTL_SECONDS
        value: "600"
      - key: REFRESH_TOKEN_TTL_DAYS
        value: "7"
      - key: REFRESH_FAMILY_MAX_DAYS
        value: "30"
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
    runtime: image                  # deploy an immutable digest built in CI
    image:
      url: ghcr.io/widedrop/ess-api:REPLACED_BY_CI
      creds:
        fromRegistryCreds:
          name: ghcr-widedrop
    plan: standard                  # 1 vCPU / 2 GB
    region: singapore
    numInstances: 2                 # two, so a rolling deploy is genuinely zero-downtime
    healthCheckPath: /api/v1/healthz
    autoDeploy: false               # CI deploys explicitly; no deploy-on-push
    domains:
      - api-ess.widedrop.com
    envVars:
      - fromGroup: ess-shared
      - key: SERVICE_ROLE
        value: api
      - key: PORT
        value: "4000"
      - key: DATABASE_URL           # through PgBouncer, transaction pooling
        value: postgresql://ess_app:__FROM_SECRET__@ess-pgbouncer:6432/widedrop_ess?pgbouncer=true&connection_limit=8&sslmode=disable&application_name=ess-api
      - key: DIRECT_DATABASE_URL    # straight to Postgres, session scope
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
      url: ghcr.io/widedrop/ess-api:REPLACED_BY_CI   # THE SAME image as the API
      creds:
        fromRegistryCreds:
          name: ghcr-widedrop
    plan: starter                   # 0.5 vCPU / 512 MB
    region: singapore
    numInstances: 1                 # exactly one; leases make >1 safe but it is not needed
    autoDeploy: false
    envVars:
      - fromGroup: ess-shared
      - key: SERVICE_ROLE
        value: worker
      - key: WORKER_POLL_INTERVAL_MS
        value: "15000"
      - key: WORKER_CONCURRENCY
        value: "4"
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
  - type: pserv                     # private service: no public URL, ever
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
        value: "400"
      - key: DEFAULT_POOL_SIZE
        value: "25"
      - key: RESERVE_POOL_SIZE
        value: "5"
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
    plan: standard                  # 2 GB — the signature database needs it
    region: singapore
    numInstances: 1
    envVars:
      - key: CLAMAV_NO_MILTERD
        value: "true"
      - key: FRESHCLAM_CHECKS
        value: "4"
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
# dev dependencies, no .env, non-root, read-only root filesystem.
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

| Step | API | Worker |
|---|---|---|
| 1. `SIGTERM` received | set `readyz` to `503` immediately, so the platform drains it from the load balancer | stop claiming new jobs and new outbox rows |
| 2. drain | stop accepting new connections; let in-flight requests finish, **cap 25 s** | finish the in-flight job/batch, **cap 25 s**; a job that will not finish releases its lease so another worker reclaims it |
| 3. close | `await prisma.$disconnect()`, flush pino, flush Sentry (2 s), close the storage client | same |
| 4. exit | `process.exit(0)` | `process.exit(0)` |
| Hard stop | a 30 s watchdog calls `process.exit(1)` so a stuck handle cannot block the deploy | same |
| Never | no `process.on('uncaughtException')` that swallows and continues — log, flush, exit non-zero | same |

Render sends `SIGTERM` then `SIGKILL` after 30 s; the caps above sit inside that window.

### 3.4 Resource sizing and concurrency

| Service | Plan | Why that size | Scale trigger |
|---|---|---|---|
| `ess-api` | 2 × Standard (1 vCPU, 2 GB) | Node is single-threaded per instance; Argon2id at m=64 MiB, t=3 costs ~90 ms and ~64 MB *per concurrent login*, which is the real memory driver. 2 GB leaves headroom for 8 concurrent hashes plus the Prisma client. Two instances make rolling deploys zero-downtime and survive one instance dying. | p95 latency > 800 ms for 10 min, or CPU > 70 % for 15 min → 3 instances |
| `ess-worker` | 1 × Starter (0.5 vCPU, 512 MB) | The workload is IO-bound (outbox sends, SQL scans). The one CPU-heavy job, payroll calculation, is bounded by `WORKER_CONCURRENCY=4` and runs monthly. | `outbox_pending` > 50 for 15 min, or a payroll run exceeding 10 min → Standard for the payroll window |
| `ess-pgbouncer` | 1 × Starter | pgbouncer is a single-process event loop; 400 client connections fit comfortably in 512 MB | client-connection saturation |
| `ess-clamav` | 1 × Standard (2 GB) | `clamd` memory-maps the full signature database (~1.3 GB resident after `freshclam`). Starter would OOM. | never; uploads are rare |
| `ess-postgres` | Standard (4 GB, 100 GB) | ~120 employees × 8 years of payslips, audit chain and attendance is well under 20 GB; the plan is chosen for the **PITR window and backup retention**, not for size | disk > 70 % or cache-hit ratio < 0.98 |

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

All 21 named jobs (`DATA-MODEL.md` §17.5) plus `email-dispatch` are scheduled *inside* the
worker process from a single table-driven timer, each claiming an `ess_ops.background_job`
row by lease (`lease_owner`, `lease_expires_at`). Rationale: it is host-portable (moving to
Fly.io changes nothing), it is testable in CI with no platform involved, a missed tick is
visible as a `PENDING` row rather than vanishing, and the lease makes a duplicate run
impossible even if a second worker is accidentally started. Platform cron (`type: cron` on
Render) is used for exactly one thing — the quarterly restore drill in §11.5 — because that
one must run *outside* the application.

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
