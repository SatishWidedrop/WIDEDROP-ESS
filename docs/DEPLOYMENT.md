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

---

## 4. Database

### 4.1 Choice

**Render Managed PostgreSQL 16, plan `standard`, region `singapore`, `ipAllowList: []`.**

| Requirement | How this satisfies it |
|---|---|
| System of record for persistent business data | Managed Postgres with WAL archiving, not an ephemeral or serverless store |
| Version | Postgres **16** — `DATA-MODEL.md` depends on generated columns, `btree_gist` exclusion constraints (`ex_leave_request__no_self_overlap`), `FOR UPDATE SKIP LOCKED`, advisory locks and `pgcrypto` |
| Not internet-reachable | `ipAllowList: []` removes the public endpoint entirely; only services in the same Render project resolve `ess-postgres` |
| Encrypted at rest | provider-managed AES-256 volume + encrypted backups (`SECURITY.md` §7.1 layer 1) |
| Same region as the API | sub-millisecond private-network RTT; no cross-region egress |

Extensions to enable in the first migration: `pgcrypto` (CSPRNG, digest), `btree_gist`
(the leave-overlap exclusion constraint), `pg_stat_statements` (query-level observability).
`uuid-ossp` is **not** used — UUIDv7 is generated in application code because the row id is
part of the encryption AAD (`SECURITY.md` §7.2).

### 4.2 Connection URLs — there are two, and the distinction is load-bearing

| Variable | Points at | Used by | Pool mode |
|---|---|---|---|
| `DATABASE_URL` | `ess-pgbouncer:6432` | the **API** | transaction |
| `DIRECT_DATABASE_URL` | `ess-postgres:5432` | the **worker**, `prisma migrate`, `prisma db execute`, the reference seeder, the bootstrap script, psql in a runbook | session |

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
   for the whole run — a *session* lock. Through a transaction pooler the lock would be taken
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

| Role | `LOGIN` | Owns objects | Privileges | Used by |
|---|---|---|---|---|
| `ess_owner` | yes (break-glass only) | **yes** — all schemas, tables, types | full | nobody at runtime; credentials sealed offline (§11.6) |
| `ess_migrator` | yes | no | `CREATE` on `ess`, `ess_ops`; `ALTER`/`DROP` via ownership delegation; `BYPASSRLS` | the CI migration job **only** |
| `ess_app` | yes | no | `SELECT, INSERT, UPDATE, DELETE` on `ess.*` and `ess_ops.*` **minus** the exclusions below; `USAGE` on schemas and sequences; **no** `BYPASSRLS`, **no** `CREATE`, **no** `TRUNCATE`, **no** superuser | the API |
| `ess_job` | yes | no | as `ess_app`, plus `BYPASSRLS` (jobs act system-wide across tenants and have no actor context) | the worker |

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

| Control | Value |
|---|---|
| Automated full backup | daily, provider-managed, encrypted, 07 days retained on `standard` (extend to 30 on the next plan up if policy demands) |
| PITR | continuous WAL archiving, any second within the retention window |
| **RPO** | **≤ 5 minutes** (WAL shipping interval); ≤ 24 h in the catastrophic case where WAL is lost and only the daily full survives |
| **RTO** | **≤ 2 hours** to a verified, serving system |
| Weekly off-provider copy | `pg_dump -Fc` run by a Render **cron job** in the same private network, encrypted with `age` to an offline public key, written to an R2 bucket in a **different cloud account** with object-lock/immutability for 35 days. This is the control that survives "the Render account is compromised or closed" — a provider-internal backup does not. |
| Backup integrity | the weekly copy is restored into a throwaway database by the same cron job, `pg_restore --list` is diffed against the expected table set, `SELECT count(*)` is compared against the source for six anchor tables, and the result is appended to `docs/runbooks/dr-drill-log.md`. A failure pages. |
| Encryption of the dump | `pg_dump -Fc | age -r <recipient> > ess-<date>.dump.age`; the age identity is in the sealed offline escrow with the KEK (§11.6). **The dump contains ciphertext columns, not plaintext PII** — the envelope encryption means a stolen dump without the KEK yields no PAN, Aadhaar, bank account or address. |
| What a backup does **not** contain | object storage. R2 has its own versioning + lifecycle (§5). A restore is therefore a *pair* of restores, and the drill covers both. |

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
instance *and* the deploy is frozen (`environment: production` protection is set to
"no deployments"); after D6 passes, the API's `DIRECT_DATABASE_URL`/`DATABASE_URL` are
repointed at the restored instance and both services are redeployed; and step D10 is
replaced by retaining the *old* instance untouched for 14 days as forensic evidence.
Any restore that rewinds past a published payroll run additionally requires the §11.2
reconciliation: re-verify every `payslip.input_digest` and notify Accounts, because a
rewind can un-publish a payslip an employee has already seen.

### 4.6 Migration strategy

**Prisma Migrate, forward-only.** There are no `down` migrations, and none may be written.
A rollback is a *new* migration that moves forward to the previous shape. Reason: a `down`
migration is untested by construction, and in this system it would be run exactly once, under
pressure, against real payroll data.

**Expand / contract, in three deploys.** Because two application versions run concurrently
during every rolling deploy, *every* migration must leave the previous API version working.

| Phase | Deploy | Migration | API |
|---|---|---|---|
| **Expand** | N | additive only: add nullable column / new table / new index `CONCURRENTLY` / new enum value / backfill trigger | version N writes both old and new, reads old |
| **Migrate** | N+1 | backfill in batches via a worker job, never in the migration transaction | version N+1 reads new, still writes both |
| **Contract** | N+2 | drop the old column / constraint / enum value, after confirming zero readers | version N+2 uses new only |

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
    DATABASE_URL:        ${{ secrets.MIGRATE_DATABASE_URL }}   # ess_migrator
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

| Situation | Behaviour | Action |
|---|---|---|
| Migration job fails before applying anything | deploy pipeline stops; **the running API is untouched** and keeps serving | fix forward, re-run |
| Migration partially applied (Postgres DDL is transactional, so this only happens for a multi-statement file with `CONCURRENTLY` or a mid-file failure) | Prisma records the migration as `failed` in `_prisma_migrations`; all later `migrate deploy` runs refuse to proceed | a human inspects, repairs by hand on `DIRECT_DATABASE_URL`, then runs `prisma migrate resolve --applied <name>` (repair completed) or `--rolled-back <name>` (repair reverted); the incident is written up before the next deploy is allowed |
| Migration applied but the new API fails its health check | Render leaves the previous instances serving and marks the deploy failed | roll the API image back (§8.6). **This is safe precisely because of expand/contract**: the expand-phase schema is always compatible with the previous image. |
| Migration applied, API healthy, data corruption discovered | out of scope for a deploy rollback: PITR restore (§4.5) to the recorded pre-migration LSN, then forward-fix | incident |

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

| Bucket | Contents | Versioning | Lifecycle |
|---|---|---|---|
| `widedrop-ess-prod` | all production artefacts | on | §5.4 |
| `widedrop-ess-staging` | staging artefacts, synthetic only | off | delete after 30 days |
| `widedrop-ess-backup` | the weekly encrypted `pg_dump` (§4.5), **separate cloud account** | on + object lock | retain 35 days, immutable |

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

| Control | Setting |
|---|---|
| Public access | **disabled**. No `r2.dev` public development URL, no custom public domain, no public bucket policy. A bucket that is public cannot be made safe by obscure keys. |
| Credentials | one R2 API token per environment, scoped to **one bucket**, with `Object Read & Write` only — never `Admin`, never account-wide. Production and staging tokens are different and neither can see the other's bucket. |
| Who holds credentials | the API and the worker only. **Not CI, not the SPA, not a browser.** |
| Browser → bucket writes | **do not exist.** Every upload is `multipart/form-data` to the API, which authorizes, validates the magic bytes, re-encodes images, strips EXIF, scans with ClamAV and only then `PutObject`s (`SECURITY.md` §5.3). There is no presigned-PUT path to leave unguarded. |
| Browser → bucket reads | **only** a presigned `GET`, minted by the API after the entity-level authorization check in `API.md` §11.1, **120 seconds**, single object, `GET` only, no wildcard, with `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, no-store` baked into the signature |
| Pre-signing preconditions | the API mints a URL only when `file_object.scan_status = 'CLEAN'`, `deleted_at IS NULL`, and the re-read `sha256` matches the persisted one; the `audit_event` is written **before** the URL is returned |
| Encryption at rest | R2 encrypts every object server-side with AES-256 by default (SSE-managed). On AWS S3 the equivalent is `SSE-KMS` with a customer-managed key and `"s3:x-amz-server-side-encryption": "aws:kms"` enforced by bucket policy. `file_object.is_encrypted_at_rest` records this. |
| Encryption in transit | HTTPS only; the endpoint is in `OUTBOUND_ALLOWLIST` (`SECURITY.md` §5.5) |
| Second layer | payslip PDFs and bank proofs are additionally **application-encrypted before upload** with the `BANK`/`STATUTORY` DEK, so a storage compromise alone yields ciphertext. The 120-second signed URL therefore serves a decrypt-on-read stream from the API for those two contexts rather than a direct redirect — the implementer must keep `API.md` §11.2's `?mode=json` shape identical either way. |

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

| Rule | Prefix | Action |
|---|---|---|
| Abandoned multipart uploads | `*` | abort after 1 day |
| Quarantined files never promoted | `ess/prod/*/quarantine/` | delete after 30 days |
| Non-current object versions | `*` | expire 90 days after becoming non-current (a window to undo an accidental overwrite, bounded so it is not an indefinite shadow copy of deleted PII) |
| Staging bucket | `*` | delete after 30 days |
| Backup bucket | `*` | object-lock retain 35 days, then delete |

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
delivery-once at the *record* level and once-at-recipient in practice:
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

| Name | Type | Value | Purpose |
|---|---|---|---|
| `widedroptech.com` | `TXT` | `v=spf1 include:amazonses.com -all` | SPF. `-all` (hard fail), not `~all`. If other senders exist (Google Workspace, a CRM) they must be merged into this **single** record — two SPF TXT records is a permanent SPF failure. |
| `<token1>._domainkey` … `<token3>._domainkey` | `CNAME` | `<token>.dkim.amazonses.com` | Easy DKIM, 2048-bit, three rotating selectors managed by SES |
| `_dmarc` | `TXT` | `v=DMARC1; p=none; rua=mailto:dmarc@widedroptech.com; ruf=mailto:dmarc@widedroptech.com; fo=1; adkim=s; aspf=s; pct=100` | **Week 0–2**: monitor only, collect aggregate reports |
| `_dmarc` | `TXT` | `v=DMARC1; p=quarantine; pct=25; rua=…; adkim=s; aspf=s` | **Week 2–4**, once reports show 100 % alignment |
| `_dmarc` | `TXT` | `v=DMARC1; p=reject; rua=…; adkim=s; aspf=s` | **Week 4+**, the target state |
| `mail` (MAIL FROM) | `MX` + `TXT` | `10 feedback-smtp.ap-south-1.amazonses.com` / `v=spf1 include:amazonses.com -all` | Custom MAIL FROM domain, so SPF aligns for DMARC rather than relying on DKIM alone |
| `_bimi` | — | — | not configured; noted as optional once `p=reject` has held for 30 days |

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

| Event | Effect |
|---|---|
| `Delivery` | `email_outbox.delivered_at = now()`; the Help-desk screen's "Help desk notified · <time>" is rendered from this, not from `sent_at`, when present |
| `Bounce` (permanent) | `status='FAILED'`, `last_error='bounce:<subtype>'`; the address is added to `ess.email_suppression` with the reason and timestamp; the dead-letter effects in §6.3 fire; if the address is an employee's `work_email`, an HR notification asks them to correct it |
| `Bounce` (transient) | back to `QUEUED` with the backoff ladder, capped at the same 5 attempts |
| `Complaint` | `status='FAILED'`; address suppressed permanently; **P2 alert** — a spam complaint against a payroll notification is an incident, not noise |
| `Reject` / `DeliveryDelay` | logged and metered; `DeliveryDelay` does not change state (SES retries internally) |

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

| | **development** | **staging** | **production** |
|---|---|---|---|
| Runs where | developer laptop | Render, `singapore`, separate project | Render, `singapore` |
| SPA | `http://localhost:5173` (Vite proxies `/api` so cookies behave same-origin) | `ess-staging.widedrop.com` + deploy previews | `ess.widedrop.com` |
| API | `http://localhost:4000` | `api-ess-staging.widedrop.com` | `api-ess.widedrop.com` |
| Database | `infra/docker-compose.yml`, port 5433 | own Render Postgres, `starter` plan | own Render Postgres, `standard` |
| Data | `db:seed:reference` + `db:seed:demo` (synthetic) | reference + synthetic only — **never a production copy, never a production restore** | real |
| Storage | filesystem driver (`STORAGE_DRIVER=filesystem`) | `widedrop-ess-staging` bucket | `widedrop-ess-prod` bucket |
| Mail | Mailpit on `localhost:1025`, or the `file` driver writing `.eml` | SES with `MAIL_TO_OVERRIDE` to one test mailbox | SES, real recipients |
| ClamAV | optional; unavailable ⇒ uploads land `QUARANTINED`, which is the documented behaviour | required | required |
| MFA | required for privileged roles, TOTP against a local authenticator | same as production | same |
| Cookies | `SameSite=Lax`, `Secure=false` (localhost is a secure context exception) | `SameSite=None; Secure` (deploy previews are cross-site) | `SameSite=Strict; Secure`, `__Host-` prefix |
| `LOG_LEVEL` | `debug` | `info` | `info` — `debug` is **refused** at boot |
| Deploys | n/a | auto on merge to `main`, no approval | manual approval in the `production` GitHub environment |
| Who can reach the DB | the developer | two engineers | nobody interactively; break-glass only (§11.6) |

**Staging never holds production data.** Not a masked copy, not a subset. A restore drill
(§4.5) uses a throwaway instance that is destroyed, never staging. This is what keeps the
number of systems holding real PAN/Aadhaar/salary at exactly one.

### 7.2 Environment variable reference

Legend — **S** = secret (never logged, never in git, never in a `VITE_` name);
**R** = required (boot fails without it) in that environment; `—` = not used.

#### Core runtime

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `NODE_ENV` | mode switch; gates every production-only check | `production` | R | R | R | |
| `SERVICE_ROLE` | `api` \| `worker`; selects the entrypoint branch | `api` | R | R | R | |
| `PORT` | HTTP listen port | `4000` | R | R | R | |
| `HOST` | bind address | `0.0.0.0` | R | R | R | |
| `LOG_LEVEL` | pino level; `debug`/`trace` refused when `NODE_ENV=production` | `info` | R | R | R | |
| `APP_VERSION` | git SHA, surfaced by `GET /version` and on every log line | `a1b2c3d` | | R | R | |
| `BUILT_AT` | image build timestamp, surfaced by `GET /version` | `2026-09-29T10:00:00Z` | | R | R | |
| `API_PUBLIC_URL` | absolute origin of the API; builds absolute links | `https://api-ess.widedrop.com` | R | R | R | |
| `WEB_PUBLIC_URL` | absolute origin of the SPA; deep links in outbound mail | `https://ess.widedrop.com` | R | R | R | |
| `ALLOWED_ORIGINS` | exact CORS allowlist, comma-separated; rejects `*` | `https://ess.widedrop.com` | R | R | R | |
| `TRUSTED_PROXY_CIDRS` | exact proxy CIDRs for Fastify `trustProxy`; **never `true`** | `10.0.0.0/8` | | R | R | |

#### Database

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `DATABASE_URL` | API → PgBouncer (transaction pooling); worker → direct | `postgresql://ess_app:…@ess-pgbouncer:6432/widedrop_ess?pgbouncer=true&connection_limit=8` | R | R | R | **S** |
| `DIRECT_DATABASE_URL` | session-scoped connection: worker advisory locks, migrations, tools | `postgresql://ess_app:…@host:5432/widedrop_ess?sslmode=verify-full` | R | R | R | **S** |
| `MIGRATE_DATABASE_URL` | `ess_migrator` credentials; exists **only** in the CI migration job | `postgresql://ess_migrator:…@host:5432/…` | — | R | R | **S** |
| `DB_POOL_MAX` | Prisma `connection_limit` override if not in the URL | `8` | | | | |
| `DB_STATEMENT_TIMEOUT_MS` | client-side guard mirroring the server-side `statement_timeout` | `15000` | | R | R | |

#### Authentication and sessions

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `JWT_ISSUER` | `iss` claim; must be the API origin | `https://api-ess.widedrop.com` | R | R | R | |
| `JWT_AUDIENCE` | `aud` claim; must be the SPA origin | `https://ess.widedrop.com` | R | R | R | |
| `JWT_ACTIVE_KID` | which key signs **new** tokens; `^wd-ess-\d{6}-[0-9a-f]{4}$` | `wd-ess-202609-a1b2` | R | R | R | |
| `JWT_SIGNING_KEY_<kid>` | Ed25519 private key, PKCS#8 PEM, base64; **one per live kid** | `REPLACE_ME__openssl genpkey -algorithm ed25519` | R | R | R | **S** |
| `JWT_PUBLIC_KEY_<kid>` | matching SPKI PEM; published at the JWKS endpoint | `REPLACE_ME` | R | R | R | |
| `ACCESS_TOKEN_TTL_SECONDS` | 60–900 | `600` | R | R | R | |
| `REFRESH_TOKEN_TTL_DAYS` | idle TTL of a refresh token, 1–30 | `7` | R | R | R | |
| `REFRESH_FAMILY_MAX_DAYS` | absolute lifetime of a refresh family, 1–60 | `30` | R | R | R | |
| `PASSWORD_PEPPER_V1` | HMAC-SHA512 pepper pre-hashed into Argon2id; base64 ≥ 32 B | `REPLACE_ME__openssl rand -base64 48` | R | R | R | **S** |
| `PASSWORD_PEPPER_ACTIVE_VERSION` | which pepper new hashes use during rotation | `1` | R | R | R | |
| `COOKIE_SAMESITE` | `strict` prod, `none` staging, `lax` dev | `strict` | R | R | R | |
| `COOKIE_SECURE` | must be `true` outside dev | `true` | R | R | R | |
| `COOKIE_DOMAIN` | **must be empty everywhere**; `__Host-` forbids `Domain` (§1.4) | *(empty)* | | | | |
| `MFA_ISSUER_LABEL` | the label shown in the authenticator app | `Widedrop ESS` | R | R | R | |
| `HIBP_ENABLED` | breach-check new passwords via k-anonymity | `true` | R | R | R | |
| `HIBP_TIMEOUT_MS` | fail-open budget; degradation is metered and alerted | `2000` | | R | R | |

#### Encryption and integrity keys

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `MASTER_KEK_V1` (+ `_V2`…) | wraps every DEK; base64, **exactly 32 bytes** | `REPLACE_ME__openssl rand -base64 32` | R | R | R | **S** |
| `MASTER_KEK_ACTIVE_VERSION` | which KEK wraps new DEKs; both stay resident during rotation | `1` | R | R | R | |
| `BLIND_INDEX_KEY_V1` | HMAC key for `*_bidx` exact-match lookup; base64 ≥ 32 B | `REPLACE_ME__openssl rand -base64 48` | R | R | R | **S** |
| `AUDIT_CHAIN_KEY_V1` | HMAC key sealing the audit hash chain; base64 ≥ 32 B | `REPLACE_ME` | R | R | R | **S** |
| `AUDIT_CHAIN_ACTIVE_VERSION` | new rows only; history is never re-keyed | `1` | R | R | R | |
| `CSRF_KEY` | HMAC binding the double-submit token to the session | `REPLACE_ME` | R | R | R | **S** |
| `LOG_HASH_KEY` | HMAC for `ip_hash` / `user_agent_hash` / rate-limit bucket keys | `REPLACE_ME` | R | R | R | **S** |
| `RECOVERY_CODE_KEY` | HMAC over MFA recovery codes | `REPLACE_ME` | R | R | R | **S** |
| `CURSOR_HMAC_KEY` | signs pagination cursors, bound to `sub` | `REPLACE_ME` | R | R | R | **S** |

#### Object storage

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `STORAGE_DRIVER` | `filesystem` \| `s3`; `filesystem` **refused** in production | `s3` | R | R | R | |
| `STORAGE_ENDPOINT` | S3-compatible endpoint; must be `https://` | `https://<acct>.r2.cloudflarestorage.com` | — | R | R | |
| `STORAGE_REGION` | `auto` for R2, `ap-south-1` for S3 | `auto` | — | R | R | |
| `STORAGE_BUCKET` | one bucket per environment | `widedrop-ess-prod` | — | R | R | |
| `STORAGE_ACCESS_KEY_ID` | bucket-scoped token id | `REPLACE_ME` | — | R | R | **S** |
| `STORAGE_SECRET_ACCESS_KEY` | bucket-scoped token secret | `REPLACE_ME` | — | R | R | **S** |
| `STORAGE_FORCE_PATH_STYLE` | `true` for R2 | `true` | — | R | R | |
| `STORAGE_LOCAL_PATH` | dev only, filesystem driver root | `./.storage` | R | — | — | |
| `SIGNED_URL_TTL_SECONDS` | 30–3600; **120** per `API.md` §11.2 | `120` | R | R | R | |

#### Email

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `MAIL_PROVIDER` | `ses` \| `resend` \| `postmark` \| `smtp` \| `file` \| `noop`; only the first three allowed in production | `ses` | R | R | R | |
| `MAIL_REGION` | provider region | `ap-south-1` | — | R | R | |
| `MAIL_ACCESS_KEY_ID` | SES IAM key id, `ses:SendEmail` only | `REPLACE_ME` | — | R | R | **S** |
| `MAIL_SECRET_ACCESS_KEY` | SES IAM secret | `REPLACE_ME` | — | R | R | **S** |
| `MAIL_FROM` | envelope + header sender; must end `@widedroptech.com` (R-2) | `no-reply@widedroptech.com` | R | R | R | |
| `MAIL_CONFIGURATION_SET` | SES configuration set carrying the SNS event destination | `ess-prod` | — | R | R | |
| `SES_SNS_TOPIC_ARN` | the only ARN the webhook accepts | `arn:aws:sns:ap-south-1:…:ess-prod-events` | — | R | R | |
| `HELPDESK_EMAIL_FALLBACK` | used only if `organization.helpdesk_email` is unset | `helpdesk@widedroptech.com` | R | R | R | |
| `MAIL_TO_OVERRIDE` | staging-only recipient clamp; **refused in production** | `ess-staging@widedroptech.com` | — | R | — | |
| `MAIL_FILE_PATH` | dev `.eml` output directory | `./.mail` | R | — | — | |
| `SMTP_HOST` / `SMTP_PORT` | dev Mailpit only | `localhost` / `1025` | | — | — | |

#### Workers, limits, scanning, outbound

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `WORKER_POLL_INTERVAL_MS` | job loop tick, 1 000–300 000 | `15000` | R | R | R | |
| `WORKER_CONCURRENCY` | parallel jobs per worker instance | `4` | R | R | R | |
| `RATE_LIMIT_STORE` | `postgres` (default, per `SECURITY.md` §9.3) \| `redis` | `postgres` | R | R | R | |
| `REDIS_URL` | only when `RATE_LIMIT_STORE=redis`; TLS required in production | `rediss://…` | | | | **S** |
| `CLAMAV_HOST` / `CLAMAV_PORT` | `clamd` INSTREAM target; required in staging and production | `ess-clamav` / `3310` | | R | R | |
| `OUTBOUND_ALLOWLIST` | the only hostnames the process may egress to (`SECURITY.md` §5.5) | `api.pwnedpasswords.com,email.ap-south-1.amazonaws.com,<acct>.r2.cloudflarestorage.com,sns.ap-south-1.amazonaws.com` | R | R | R | |

#### Observability

| Variable | Purpose | Example / placeholder | dev | stg | prod | S |
|---|---|---|---|---|---|---|
| `SENTRY_DSN` | error tracking; omit to disable | `https://…@…ingest.sentry.io/…` | — | R | R | **S** |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0`–`1.0` | `0.05` | — | R | R | |
| `METRICS_ENABLED` | expose `/metrics` | `true` | | R | R | |
| `METRICS_BEARER_TOKEN` | bearer required by `/metrics`; the route is also bound to the private interface | `REPLACE_ME` | — | R | R | **S** |
| `LOG_SINK_TOKEN` | token for the log shipper, when the platform does not forward stdout | `REPLACE_ME` | — | R | R | **S** |

#### Web build-time (all public, all non-secret, all baked into the bundle)

| Variable | Purpose | Example |
|---|---|---|
| `VITE_API_BASE_URL` | the API origin; also the CSP `connect-src` value (§2.3) | `https://api-ess.widedrop.com` |
| `VITE_APP_ENV` | `production` \| `staging` \| `preview` \| `development` | `production` |
| `VITE_BUILD_SHA` | shown in the About panel; correlates a client report to a build | `a1b2c3d` |
| `VITE_SENTRY_DSN` | browser DSN — a public value by design, and rate-limited at Sentry | `https://…` |

A CI check fails the build if any `VITE_*` name matches `/KEY|SECRET|TOKEN|PASSWORD|PEPPER/i`.
A bundled secret is a published secret.

### 7.3 Where secrets live, per environment

| Environment | Store | Injection | Who can read |
|---|---|---|---|
| development | `apps/api/.env`, git-ignored, generated by `npm run secrets:dev` (random values, never shared) | dotenv at boot | the developer |
| staging | Render environment group `ess-staging` | platform → process env | 2 engineers |
| production | Render environment group `ess-shared` (values typed once, `sync: false` in the blueprint so they are **never** in git) | platform → process env | 2 named owners, MFA-enforced, access logged |
| GitHub Actions | repository/environment secrets for `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, `RENDER_API_KEY`, `RENDER_*_SERVICE_ID`; **OIDC** for GHCR and (where supported) the container host | per-job, masked | workflow only |
| Break-glass copies | `MASTER_KEK_V*`, the `age` backup identity and the `ess_owner` password are **additionally** held offline under split knowledge by two officers (`SECURITY.md` §7.3, break-glass) | sealed envelope / hardware token | two officers, both required |

Inventory metadata — owner, purpose, last rotated, next due, **never a value** — lives in
`docs/secret-inventory.md` and is reviewed quarterly.

### 7.4 Boot-time validation — the process refuses to start

`apps/api/src/config/env.ts` parses a Zod schema **before** the Fastify instance exists. Any
failure prints the offending **variable names and the rule** — never a value — and calls
`process.exit(1)`, so a misconfigured container never serves a request (`SECURITY.md` §10.2).
In addition to the per-variable types in §7.2, these cross-cutting refusals apply when
`NODE_ENV=production`:

| # | Refusal |
|---|---|
| 1 | Any secret shorter than its minimum decoded length, or a KEK that is not exactly 32 bytes |
| 2 | Any secret whose value appears in the committed `.env.example` |
| 3 | Any secret matching a known placeholder (`changeme`, `dev-secret`, `REPLACE_ME`, all-zero, 32 identical bytes) |
| 4 | Any secret with Shannon entropy below 3.5 bits/byte over its decoded form |
| 5 | **The same value reused across two different variables** |
| 6 | `DATABASE_URL`/`DIRECT_DATABASE_URL` without `sslmode=verify-full` (the private PgBouncer hop is the single documented exception, recognised by the `ess-pgbouncer` host) |
| 7 | `ALLOWED_ORIGINS` containing `*`, `http://`, or an entry that is not an exact absolute origin |
| 8 | `COOKIE_SECURE=false`, `COOKIE_SAMESITE=none`, or `COOKIE_DOMAIN` set to anything non-empty |
| 9 | `LOG_LEVEL` of `debug` or `trace` |
| 10 | `STORAGE_DRIVER=filesystem` (a container filesystem is ephemeral — payslips would vanish on redeploy) |
| 11 | `MAIL_PROVIDER` of `file`/`noop`/`smtp`, or `MAIL_TO_OVERRIDE` set |
| 12 | `MAIL_FROM` not ending `@widedroptech.com` |
| 13 | `CLAMAV_HOST` unset |
| 14 | `TRUSTED_PROXY_CIDRS` unset, or set to `true`/`0.0.0.0/0` |
| 15 | `JWT_ACTIVE_KID` with no matching `JWT_SIGNING_KEY_<kid>`, or a key that fails to parse as Ed25519 PKCS#8 |
| 16 | `MASTER_KEK_ACTIVE_VERSION` with no matching `MASTER_KEK_V<n>` |
| 17 | A `SERVICE_ROLE` other than `api` or `worker` |

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
