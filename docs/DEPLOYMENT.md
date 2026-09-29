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
