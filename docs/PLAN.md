# Plan and milestones

What was asked for, how it was broken into milestones, what each one delivered,
and what is honestly still missing. Written after the fact as well as before,
so the "delivered" column says what is true rather than what was intended.

Companion documents: `docs/README.md` for what every document in here is for,
`docs/RUNBOOK.md` for operating it, `docs/RBAC.md` for who can do what.

---

## 1. The brief, and what each clause turned into

The directive was a single instruction with eight constraints attached. Each one
is load-bearing on a specific part of the build, so they are traced rather than
summarised.

| The constraint                                                                                                                                                                                            | Where it lives in the build                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Use the attached HTML as the primary UI/UX directive — preserve its visual language, navigation, responsive behaviour and functional intent                                                               | `design/prototype/` (extracted verbatim), `design/DESIGN-SYSTEM.md`, `packages/shared/src/design/tokens.ts`. The container-query layout is reproduced with `ResizeObserver` rather than viewport media queries, because the prototype's cards reflow to their own width, not the window's.                                                                                 |
| Every value, count, amount, status, balance, metric, notification and number must come from persisted data or a deterministic calculation over it — nothing invented, hardcoded, placeholder or synthetic | No component holds a literal figure. Rollups (`payslip_fy_rollup`, `tds_quarter`, `expense_rollup`, `leave_balance`) are recomputed from their source rows, and a figure that does not exist yet renders as an em dash rather than a zero.                                                                                                                                 |
| Strict RBAC for Employee, Manager, HR, Accounts                                                                                                                                                           | `packages/shared/src/rbac/roles.ts` — 58 permissions × 4 roles × 5 scopes, deny by default. Enforced server-side in every route; `docs/RBAC.md` is generated from it.                                                                                                                                                                                                      |
| Cybersecurity as a first-class architectural requirement                                                                                                                                                  | Ed25519 access tokens, rotating refresh tokens with family reuse detection, Argon2id with a server-side pepper, TOTP MFA required for the three elevated roles, AES-256-GCM envelope encryption with per-record keys, a hash-chained audit log, per-route rate limits, a CSP with no `unsafe-inline`, and an environment validator that refuses to start on a weak secret. |
| Complete auditability for sensitive HR, payroll, approval, policy and administrative actions                                                                                                              | `audit_event`, HMAC-chained per organisation under an advisory lock, with `BEFORE UPDATE/DELETE/TRUNCATE` triggers making it append-only in the database itself.                                                                                                                                                                                                           |
| Payslips must not exist or become visible until the workflow completes                                                                                                                                    | `payroll_cycle` as a guarded state machine; the requirement is tested end to end over HTTP in `apps/api/src/routes/v1/pipeline.e2e.test.ts`, including the case that matters — a payslip row that **exists** but is not published must be unreachable by list, by id and by download.                                                                                      |
| Version-controlled policies with explicit acknowledgement, storing employee, version, status and timestamp                                                                                                | `policy`, `policy_version`, `policy_assignment`, `policy_acknowledgement`. Acknowledging a superseded version is refused; re-acknowledging keeps the original timestamp.                                                                                                                                                                                                   |
| Help-desk tickets persisted **and** emailed to helpdesk@widedroptech.com                                                                                                                                  | `helpdesk_ticket` plus a transactional outbox. The row and the queued message commit together, so a ticket can never exist without its mail being owed. Proven against a real database: HD-1001 persisted, one message queued with the reference in the subject and the requester as `Reply-To`, delivered by the worker.                                                  |
| Every screen polished and correct with no data; never fabricate values to fill the interface                                                                                                              | `EmptyState` on every list, table, chart and tile, each saying what will appear there and what has to happen first.                                                                                                                                                                                                                                                        |
| Deploy so it coexists with the Netlify-hosted widedrop.com, keeping backend and database secure                                                                                                           | A separate Netlify site on `ess.widedrop.com`; the API, worker, rate-limit store and database on Render, none of them reachable from the internet except the API. `infra/`, `docs/RUNBOOK.md`.                                                                                                                                                                             |

---

## 2. Milestones

Twelve milestones, in dependency order. Each one was merged working: the gate
(typecheck, lint, format, tests, build, audit) passed before the next started.

### M1 — Foundation

Monorepo (`apps/api`, `apps/web`, `packages/shared`, `infra/`, `docs/`,
`design/`), toolchain, CI. The prototype extracted from its bundle into markup,
logic and a design-system document, so the UI directive is a file that can be
diffed rather than an attachment.

Design tokens, self-hosted fonts, the crypto primitives, the error envelope and
the logger. Money settled as `bigint` paise, serialised as strings — decided
here because every later table depends on it.

### M2 — Contracts

`packages/shared`: the RBAC matrix, the state machines, the validation schemas.
One module both sides import, so the client renders from the same definition the
server enforces. It is authoritative for _shape_; authority over _access_ stays
with the server.

### M3 — Database

100 models, 7 migrations. Prisma for the shape, hand-written SQL for what Prisma
cannot express: generated columns, `CHECK` constraints, `EXCLUDE USING gist` for
overlapping leave, `BEFORE UPDATE` triggers that make the audit log append-only,
and a `touch_updated_at` trigger that owns `updated_at` so no application path
can lie about it.

The integrity rules are in the database because a rule enforced only in
application code is a rule that holds until the next caller.

### M4 — Authentication and authorization

Ed25519 access tokens (ten minutes) and opaque rotating refresh tokens (thirty
days) with family reuse detection. Argon2id with a server-side pepper. TOTP MFA,
required before Manager, HR or Accounts permissions do anything.

Authorization resolves scope per permission, per request, against the resource
actually being touched — never from the request body. The reporting chain is a
materialised closure table (`employee_reporting_closure`), so `REPORTING_CHAIN`
is an index lookup rather than a recursive query per request.

### M5 — Payroll engine and pipeline

The deterministic calculation engine, then the pipeline that drives it. Every
payslip line carries its own derivation in `calculation_note`, and each run
carries an `input_digest`: the same inputs reproduce the same output, which is
what makes a disputed figure answerable.

The cycle is a state machine with guards on the transitions, not on the columns,
so there is no way to reach `PUBLISHED` except through the required sequence.

### M6 — Self-service surfaces

Leave, expenses, policies, help desk, documents, directory, announcements,
profile, tax, benefits — the services, their routes and their tests. Leave
reservations move through a ledger rather than a counter, so a balance is the
sum of its movements and `available_days` is a generated column that cannot
disagree with its parts.

### M7 — Manager, HR and Accounts surfaces

Approvals, attendance, people administration, payroll cycles, payroll inputs,
reimbursements, and the audit reader with its chain verifier. This is where the
payslip-visibility requirement was proven end to end.

### M8 — The SPA

24 screens on one set of primitives. CSS Modules with custom properties and no
inline styles anywhere, which is what lets the CSP hold without
`unsafe-inline` — and the build asserts it, rather than trusting it.

Routes are a table filtered by the person's permissions; a path their roles do
not cover renders "not available to you" rather than 404, because the difference
matters to somebody who has been sent a link.

### M9 — The worker

The email outbox drained with `FOR UPDATE SKIP LOCKED` and an explicit lease, so
a message a dead worker was holding is reclaimed without being sent twice. Six
attempts over about eleven hours, then kept for a person rather than discarded.

### M10 — Deployment

Netlify for the SPA, Render for everything with state, one image for both
processes, a generated CSP, a deploy workflow that ships the artifact CI
exercised, and `docs/RUNBOOK.md`.

Building this is where four defects surfaced that no source-level test could
see. They are worth listing, because each one is a category:

1. **`node dist/server.js` did not start.** The generated Prisma client sits
   beside the sources and tsc does not copy it, so the compiled output could not
   resolve its own imports. Every test runs from TypeScript. CI now starts the
   built server and worker and signals them.
2. **The Render blueprint named variables the validator does not read**
   (`STORAGE_BUCKET` for `S3_BUCKET`), omitted `REDIS_URL`, and took
   `DATABASE_URL` from a source that carries no `sslmode`. The blueprint is now
   parsed in a test and fed to the real validator.
3. **The S3 driver threw**, and production refuses to start on the filesystem
   driver.
4. **The SPA read `VITE_API_URL`** while everything else set
   `VITE_API_BASE_URL`, so the bundle called its own origin and Netlify answered
   the entire API with the index page. The build now asserts the bundle contains
   the origin its own `connect-src` permits.

### M11 — Payslip documents

The pipeline refuses to publish a cycle whose payslips have no document — a
payslip an employee can see in a list and cannot open reads as a broken portal
— and nothing rendered one. The end-to-end test fabricated `FileObject` rows to
get past it, which meant the one step between "payroll is calculated" and "an
employee can download their payslip" was the one step never exercised. In
production no cycle could have been published at all.

The renderer is written against the PDF format rather than a document library,
for the reason the rest of the system is the way it is: a payslip has to be
reproducible. Every payslip carries a `sourceDigest` claiming the same inputs
produce the same output, and a library that stamps a creation date — or that
lays text out a hair differently in its next minor version — quietly makes that
untrue. Here the bytes are a function of the data and nothing else, which the
tests assert directly.

It runs after calculation and again in the worker's sweep, so the ordinary path
needs nobody to remember a second step and a run whose storage failed halfway
heals itself. The end-to-end test now uses the real renderer.

### M12 — Uploads

The one place bytes somebody else chose reach the system. The accept list was
described in a constant and enforced nowhere; `file-type` was a dependency
nothing imported. Now the content type recorded is the one sniffed from the
bytes, and a file whose bytes disagree with its declared type or its own
extension is refused — an HTML file called `invoice.pdf` being the case the
check exists for.

---

## 3. Where it stands

|                   |                                 |
| ----------------- | ------------------------------- |
| Database models   | 100, across 7 migrations        |
| API route modules | 21                              |
| Domain services   | 26                              |
| Screens           | 24                              |
| Test files        | 32                              |
| Tests             | 518 (399 API + 119 shared)      |
| Permissions       | 58, across 4 roles and 5 scopes |

The gate that has to pass before anything merges: `npm run typecheck`,
`npm run lint`, `npm run format:check`, `npm test`, `npm run build`,
`npm run audit:ci`, the image build, and the built server and worker starting.

---

## 4. What is not built

Stated plainly, because a plan that only lists what was delivered is not a plan
anybody can act on.

**Not built, and the system is honest about it**

- **Virus scanning of uploads.** `FileObject.scanStatus` exists and every
  uploaded row is written `SKIPPED` rather than `PENDING`, because `PENDING`
  would claim a scanner is coming. Wiring one up means a worker job and a status
  transition; nothing else changes.
- **Upload surfaces beyond expense bills.** The service is generic and the
  schema anticipates six more (`PROFILE_PROOF` for a bank-change cheque,
  `POLICY_PDF`, `TICKET_ATTACHMENT`, `EMPLOYEE_DOCUMENT`, `BENEFIT_DOCUMENT`,
  `PAYROLL_INPUT_UPLOAD`). Each is a route that calls `acceptUpload` and links
  the resulting `FileObject`.
- **`DEPARTMENT` scope.** Defined and resolved, held by no role. Granting it is
  a line in `roles.ts`.

**Deliberately not built**

- **A password-only path for the elevated roles.** MFA enrolment is required
  before Manager, HR or Accounts permissions take effect, with no bypass.
- **An administrator override.** There is no role that can read a payslip it
  does not own, and none that can write to the audit log.

**Environment limits, not defects**

- The Docker image could not be built to completion in the development sandbox:
  its egress proxy re-terminates TLS, and the build container does not trust its
  CA, so `npm ci` and Prisma's engine download both fail inside the build. A CI
  job builds the image on every pull request, so a real Dockerfile defect fails
  there rather than at a deploy.
- One dependency advisory has no stable fix — `deepmerge-ts`, reached through
  the Prisma CLI, is resolved in a Prisma release that is still a release
  candidate. It is accepted with a written reason and a review date in
  `scripts/audit-check.mjs`, and the audit gate fails when that date passes.
