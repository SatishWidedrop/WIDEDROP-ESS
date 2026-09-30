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

**Payroll calculation** is the other long operation, and it is now measured
rather than guessed. `npm run bench:payroll -w @widedrop/api` builds a real
organisation at a given headcount, runs the pipeline through the same service
functions the routes call, and times each stage:

| Employees | Validate | Calculate  | Statements issued by calculate |
| --------- | -------- | ---------- | ------------------------------ |
| 50        | 0.72 s   | 1.20 s     | 670                            |
| 200       | 2.53 s   | 4.35 s     | 2,620                          |
| 500       | 5.96 s   | **10.9 s** | 6,520                          |

It scales linearly — about **22 ms and 13 database round trips per employee**,
flat from 50 to 500, so there is no hidden quadratic waiting further up. The
earlier guess of "a second or two for a few hundred" was roughly an order of
magnitude optimistic.

The round-trip count is the number that matters, because those timings are
against Postgres on a loopback socket and production's statements cross a
network to Supabase. Thirteen round trips per employee means latency dominates:

| Per-statement latency | Employees in a 10 s function |
| --------------------- | ---------------------------- |
| loopback (measured)   | ~450                         |
| 1 ms                  | ~280                         |
| 2 ms                  | ~200                         |

So the practical ceiling for a synchronous calculate on Netlify is **about two
hundred people**, not the four hundred the raw timing suggests. Widedrop is far
below that, and this is a number to revisit at around 150 rather than a problem
today.

One correction to what this document used to say: calculation **can** be sliced
after all. The claim that it cannot rested on "a half-calculated run is worse
than none", which is true of a run that is _visible_ while half-finished — but
the state machine already has a state for exactly this. Payslips may exist in
`CALCULATING`, and `EMPLOYEE_VISIBLE_STATES` is `PUBLISHED` and `CLOSED` only,
so a cycle part-way through calculation is invisible to employees by
construction. A resumable job could write payslips in batches and transition to
`CALCULATED` only once every eligible employee has one. That is a real change to
`generatePayroll`, not a flag, and it is not worth making until the headcount
asks for it — but it is available, and it is the answer at that point rather
than a paid tier.

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

Built. The same Fastify application `server.ts` listens with, handed to the
platform as a handler instead — not a second implementation, so a route cannot
behave one way here and another way in a container. It is one function serving
`/api/*` rather than one per route, which is what keeps the plugin chain
identical: request context, security headers, rate limiting, CSRF,
authentication, authorization, registered once in one order.

**The API is same-origin with the SPA.** Both are on one Netlify site, so there
is no cross-origin request to allow, no CORS allowlist to get wrong, and the
refresh cookie can be `SameSite=Strict` rather than `Lax`. The CSP's
`connect-src` is `'self'` with no host to name.

Measured on the bundled function against a real database:

|                                         |                                                |
| --------------------------------------- | ---------------------------------------------- |
| Cold start, including the first request | **269 ms**                                     |
| Warm request                            | **3 ms**                                       |
| Function size                           | **19.3 MB zipped**, against a 50 MB hard limit |

That last number was **53 MB** — over the limit — before three things came out,
and it is worth knowing why, because each was invisible until measured:

1. **Two Prisma engines.** `native` is the build machine's; only
   `rhel-openssl-3.0.x` (Amazon Linux) is ever loaded in a Lambda. 17 MB.
2. **TypeScript.** Netlify's bundler hardcodes `@prisma/client` as external and
   copies the whole package, TypeScript included. 15 MB, unreachable.
3. **A WebAssembly query engine for every database Prisma supports** —
   CockroachDB, MySQL, SQL Server, SQLite. 25 MB, none of it used: the
   generated client is self-contained and uses the native engine.

Two further traps, both found by actually running the bundle:

- **The AWS SDK is omitted by the bundler**, which assumes the Lambda runtime
  provides it. That is true of `client-s3` and not documented for
  `s3-request-presigner`, and payslip downloads are not the place to find out —
  so it is shipped explicitly, which costs 0.6 MB.
  `npm run check:function` fails the build if an SDK upgrade adds a scope the
  paths do not cover; that is how `@aws/lambda-invoke-store` was caught.
- **`@node-rs/argon2`** is a native addon and cannot be inlined either. Its
  platform package is `linux-x64-gnu`, which is what Amazon Linux runs, so the
  one the build machine installs is the one the function needs.

Verified end to end against the dev database, through the bundled artifact: a
401 without a token, a successful sign-in, three payslips with the right
figures, a signed download URL, the security headers, and the rate limiter
refusing the eleventh and twelfth sign-in attempts.

### Step 5 — Background work

Built. Three jobs, defined once in `services/jobs/registry.ts` and driven from
two directions: a container runs `worker.ts`, which loops on a timer, and a
serverless deployment has a scheduler call `POST /api/v1/jobs/:name`. Both call
the same functions — a second implementation of "drain the outbox" would be a
second set of assumptions about leases and retries, and the first time they
disagreed a message would go out twice.

| Job                 | What it does                                                                | How often    |
| ------------------- | --------------------------------------------------------------------------- | ------------ |
| `email-outbox`      | Sends what is queued, and requeues anything a stopped sender was holding    | every minute |
| `payslip-documents` | Renders payslip documents that are missing one, so a cycle can be published | every minute |
| `maintenance`       | Marks overdue policy acknowledgements, drops closed rate-limit windows      | hourly       |

**Every job is bounded and resumable.** Each gets a budget — seven seconds
under a ten-second function — does what it can, and says whether more is
waiting. Nothing assumes it will be allowed to finish: the outbox claims under
a lease, rendering claims a payslip conditionally, the sweeps converge. A test
runs two drainers at once over ten messages and asserts exactly ten were sent,
because a cron invocation _will_ land while the previous one is still going.

**Setting it up on Supabase:**

1. Generate a token: `openssl rand -base64 48`. Set it as `JOB_RUNNER_TOKEN` on
   the Netlify site.
2. Edit the two values at the top of `infra/supabase/cron.sql` — your API
   origin and that same token — and run the file in the Supabase SQL editor.
   It creates `pg_cron` and `pg_net`, stores the token in a table only the
   scheduler can read, and schedules the three jobs.
3. Check it: `SELECT job_name, status, started_at, payload FROM ess_ops.job_run
ORDER BY started_at DESC LIMIT 20;` — that is the one to read, because
   `pg_cron` only knows it called and `pg_net` only knows the status code.

**Without a token the endpoint is not registered at all.** That is deliberate:
an endpoint that drains the outbox and writes files should not be reachable on
a deployment that does not use it, and "does not exist" is a stronger
guarantee than "exists and checks". The Render blueprint sets no token for
exactly that reason — it has a worker.

The caller is a database, not a person: no cookie, no MFA, no employee record
for the RBAC matrix to reason about. So it is one token compared in constant
time, and the route is exempt from the Origin check because `pg_net` sends no
Origin — the token is what replaces it, and a browser cannot supply one because
nothing stores it there.

One thing worth knowing, because it would have been invisible: the obvious rate
limit for this endpoint was `payroll:mutate`, at 30 an hour. A scheduler
calling three jobs every minute is 180. It would have refused two runs in every
three, and shown up as mail that arrives eventually rather than as anything
failing. It has its own budget of 360.

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
