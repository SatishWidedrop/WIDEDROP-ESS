# Going live

The ordered list of what has to happen, what it costs, and the three decisions
still open. Written against the Netlify + Supabase architecture.

Companion documents: `docs/PLAN.md` for what was built, `docs/RUNBOOK.md` for
operating it once it is up.

---

## 1. What fits, measured

The Netlify + Supabase shape works. Two numbers decide where the edges are, and
both were measured against this codebase rather than assumed.

|                                                 |                              |
| ----------------------------------------------- | ---------------------------- |
| Building one payslip PDF                        | **0.27 ms**                  |
| Reading a payslip with its lines and employment | **8 ms**                     |
| Writing one object to storage                   | **~120 ms** over the network |

So a payslip costs about **130 ms**, and essentially all of it is the storage
round trip. Rendering now runs eight at a time, which makes a cycle roughly
`(employees ÷ 8) × 130 ms`:

| Employees | Rendering, 8 at a time | Netlify's 10 s synchronous limit |
| --------- | ---------------------- | -------------------------------- |
| 20        | ~0.3 s                 | fits                             |
| 100       | ~1.6 s                 | fits                             |
| 500       | ~8 s                   | fits, no margin                  |
| 2,000     | ~33 s                  | needs slicing                    |

And `renderPendingPayslips` takes a `limit`, returning `more: true` when it cut
the batch short — so a function with a deadline renders what it can and asks
the queue to call it again. There is no size at which this stops working; past
about five hundred people it just takes more than one invocation.

**Payroll calculation** is the other long operation. It carries a 300-second
transaction timeout in code, which is a ceiling rather than a measurement — it
is database writes with no network round trips, so a few hundred employees
should land in a second or two. **Measure it before the first real run** with a
copy of your actual headcount; if it exceeds ten seconds it has to become a
queued job, and unlike rendering it cannot simply be sliced, because a
half-calculated payroll run is worse than none.

---

## 2. The three decisions still open

### 2.1 Rate limiting — resolved, Postgres-backed

~~Blocked.~~ Built. With an in-process counter, ten Lambda instances mean ten
separate budgets and an account lockout holds only on whichever instance the
next attempt reaches — which is not a lockout, and brute-force protection on
sign-in was a stated requirement.

Neither Netlify nor Supabase provides Redis, so the limiter now falls back to a
store every instance can already see: `ess_ops.rate_limit_counter`, maintained
by a single `INSERT ... ON CONFLICT DO UPDATE` that also handles window expiry,
so two requests arriving together cannot read the same count and write back the
same increment. A test builds two app instances sharing nothing but the
database and spends one sign-in budget across both.

It costs one upsert per limited request — a real cost, and the reason it is the
fallback rather than the default. Set `REDIS_URL` when that starts to matter
and nothing else changes. `RATE_LIMIT_ALLOW_IN_PROCESS=true` exists for the one
case where the in-process counter is not a mistake, a single instance that will
never be scaled out, and has to be said out loud because otherwise the failure
is silent.

Netlify's edge rate limiting is still worth adding in front: it stops a flood
before it costs an invocation. It cannot replace this, because it sees an IP
and not the email address being attempted.

### 2.2 Supabase free tier is not where payroll records should live

Two properties make this unsuitable as the only copy of employee and payroll
data:

- **Zero backup retention.** No daily backups, no point-in-time recovery. Pro
  gets daily backups held seven days.
- **Projects pause after about seven days of low activity.** An internal portal
  over a holiday is exactly that. A paused payroll system on the morning
  somebody needs a payslip for a loan application is a bad day.

Your own architecture note reaches the same conclusion — that the first paid
upgrade should be the database layer. Agreed, and I would make it the _only_
paid thing from day one. **Supabase Pro, about $25/month.** Everything else can
stay free.

### 2.3 Supabase Auth and row-level security — I would not

This is the largest piece of the proposal and the one I would push back on,
though it is your call.

**Replacing the built authentication** means deleting, and then rebuilding
against a different set of primitives: Ed25519 access tokens with a rotatable
key id; opaque refresh tokens with family reuse detection; Argon2id hashing
with a **server-side pepper**, so a stolen database is not enough to mount an
offline attack; TOTP enrolment that gates elevated permissions, so an HR
account with no second factor has no HR powers; breach-corpus checking on every
new password; a `token_epoch` column that revokes every session for a user in
one write; and a lockout policy with exponential backoff. Supabase Auth
provides bcrypt hashing, JWTs, refresh rotation with reuse detection, and TOTP.
The pepper, the breach check, and "MFA must be enrolled before HR permissions
do anything" have no equivalent — they would have to be rebuilt on top, which
is most of what is already there.

**Browsers reading Supabase directly under RLS** runs into something more
concrete. Bank accounts, PAN, Aadhaar and personal contact details are
AES-256-GCM encrypted at the application layer, with per-record keys derived
from a key-encrypting key. A browser reading those rows gets ciphertext,
because `ENCRYPTION_KEK` must never reach it. So "GET my profile" straight from
Supabase returns unreadable blobs for exactly the fields that matter. The same
is true of the audit chain, whose HMAC key the database never sees.

There is also a duplication cost. `packages/shared/src/rbac/roles.ts` holds 58
permissions across four roles and five scopes; `docs/RBAC.md` is generated from
it and CI fails if the two drift. Expressing the same decisions a second time
as RLS policies creates exactly the drift that check exists to prevent, in a
place where a mistake is a data leak.

**What I would do instead:** keep the built auth and keep every read going
through the API. The saving from bypassing it is a handful of function
invocations against a 125,000/month allowance. That is not a problem you have.

---

## 3. The sequence

Nothing below depends on the decisions above except where noted.

### Step 1 — Supabase project _(done in code; you do the console work)_

1. Create the project. Pick the region closest to your people — `ap-south-1`
   (Mumbai) or `ap-southeast-1` (Singapore).
2. **Upgrade to Pro before any real data goes in** (§2.2).
3. Project Settings → Database → copy both connection strings:
   - pooled, port 6543 → `DATABASE_URL`, and append `&pgbouncer=true`
   - direct, port 5432 → `DIRECT_DATABASE_URL`

   Both need `sslmode=require`. The validator refuses to start otherwise, and
   refuses a pooled URL missing `pgbouncer=true` — without it the API starts
   fine and then fails intermittently under load, which is a far worse way to
   find out.

4. Storage → create a **private** bucket, `ess-documents`. Not public: every
   read goes through a short-lived signed URL the API issues after it has
   checked authorization.
5. Project Settings → Storage → S3 access keys → generate a pair. Set
   `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
   `S3_SECRET_ACCESS_KEY`. These keys bypass row-level security, so they are
   server-side only and must never reach a `VITE_` variable — the SPA build
   asserts that.
6. `npm run db:migrate -w @widedrop/api` against the direct connection.
7. `npm run db:seed:reference -w @widedrop/api` — roles, permissions, pay
   components. It creates no people.

### Step 2 — Email

Resend, as chosen. Add the three DNS records it gives you for
`widedroptech.com`, then set `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=587`,
`SMTP_USER=resend`, `SMTP_PASSWORD=<api key>`, `MAIL_FROM=no-reply@widedroptech.com`.

Verify before going further: a help-desk ticket is persisted and its mail
queued in one transaction, so a ticket can never exist without its mail being
owed — but only the worker actually sends it, and an unsent outbox is silent.

### Step 3 — Rate limiting

Nothing to do; see §2.1. Optionally put Netlify's edge rate limiting in front,
which stops a flood before it costs an invocation.

### Step 4 — The API on Netlify Functions

The work, in order of risk:

1. **Wrap Fastify.** `@fastify/aws-lambda` turns the existing app into a
   handler with no route changes. One function at `/api/*` rather than one per
   route, so the plugin chain — CSRF, security headers, authentication,
   authorization — runs exactly as it does now.
2. **Connection handling.** One Prisma client per container, reused across
   invocations; never one per request. Against the pooled URL, with
   `pgbouncer=true`.
3. **Bundle size.** The Prisma query engine is a ~17 MB native binary. It fits
   Lambda's limit but needs to be included deliberately — check this early, it
   is the most likely unpleasant surprise.
4. **Drop what has no meaning.** `@fastify/under-pressure` (there is no event
   loop to shed load from) and the graceful-drain shutdown (nothing to drain).
5. **Cold starts.** Prisma plus the engine is roughly a second on a cold
   start. Acceptable for an internal portal; worth knowing before somebody
   reports the first load as slow.

### Step 5 — Background work

The `background_jobs` table from your architecture note is the right design,
and the existing outbox already works this way — claimed with
`FOR UPDATE SKIP LOCKED` under a lease, six attempts with backoff, then kept
for a person rather than discarded. Generalise that rather than writing a
second mechanism.

Two things need to run on a schedule:

- **Draining the outbox** — every minute or two.
- **Rendering pending payslips** — the publish guard refuses a cycle whose
  payslips have no document, so this is what unblocks a publish.

Supabase Cron (`pg_cron` + `pg_net`) posts to a Netlify function, which drains a
bounded slice and returns. Under ten seconds per invocation, so **no paid
Netlify plan is needed** — Background Functions are Core Pro and above, and
slicing avoids them entirely.

### Step 6 — The SPA

Already done and asserted by the build. Set `VITE_API_BASE_URL` per context in
`infra/netlify/netlify.toml`, and note that if the API becomes same-origin on
Netlify it is `/api` rather than a separate host — which also means the CSP's
`connect-src` becomes `'self'` and the CORS allowlist stops mattering.

### Step 7 — Domain and DNS

1. `ess.widedrop.com` → the new Netlify site. Netlify issues the certificate.
2. Keep it a separate site from `widedrop.com`, so a deploy of one cannot take
   down the other.
3. If the API stays on its own host, `api-ess.widedrop.com` → wherever it runs.
   Same site, different origin, which is what lets the refresh cookie be
   `SameSite=Lax` and still work.

### Step 8 — The first administrator

```sh
npm run bootstrap:admin -w @widedrop/api
```

Prints a password once and never stores it readably. That account must enrol
two-factor authentication before its HR or Accounts permissions do anything.

Then, in the portal rather than in SQL: organisation details, departments,
locations, designations, holiday calendar, leave types and their accrual, pay
components, the tax regime, expense categories, help-desk categories, and the
first employees.

### Step 9 — Before real payroll

A rehearsal, on real headcount, in this order:

1. Load every employee and their salary structure.
2. Run one full cycle end to end: Accounts uploads inputs → HR submits
   attendance → managers approve → validate → calculate → render → publish.
3. **Time the calculation step** (§1).
4. Download a payslip as an employee and check the figures against your
   existing payroll.
5. Verify the audit chain.
6. Practise a restore from a Supabase backup into a scratch project. A restore
   nobody has done is a restore that does not work.

---

## 4. Cost

|                  |                                                    |
| ---------------- | -------------------------------------------------- |
| Netlify          | Free — 125k function invocations, 100 GB bandwidth |
| Supabase Pro     | ~$25/month — the only thing I would insist on      |
| Resend           | Free at this volume                                |
| Rate-limit store | Free — the database you already have               |
| **Total**        | **~$25/month**                                     |

---

## 5. What is not built

From `docs/PLAN.md` §4, the ones that matter before real use:

- **Upload surfaces beyond expense bills.** The service is generic; each
  remaining one is a route that calls `acceptUpload`. The notable gap is
  `PROFILE_PROOF` — the cancelled cheque for a bank-detail change, which the
  prototype names explicitly.
- **Virus scanning.** Every uploaded row is written `SKIPPED` rather than
  `PENDING`, because `PENDING` would claim a scanner is coming.

Rate limiting was on this list and is not any more; see §2.1. Nothing that
remains blocks production outright.
