# Runbook

What to do when something is wrong, and what to do before anything is. Written
for whoever is on call, who may not have written any of this.

Companion documents: `docs/ARCHITECTURE.md` for how the pieces fit,
`docs/DEPLOYMENT.md` for where they run, `docs/SECURITY.md` for why the
controls are the way they are.

---

## 1. The shape of the system

| Piece    | Where                                      | What it is                                        |
| -------- | ------------------------------------------ | ------------------------------------------------- |
| SPA      | Netlify, `ess.widedrop.com`                | Static files. No server, no state.                |
| API      | Render web service, `api-ess.widedrop.com` | Fastify. Two instances behind a health check.     |
| Worker   | Render worker service                      | Drains the email outbox, sweeps overdue policies. |
| Database | Render Postgres 16                         | The system of record.                             |
| Files    | S3-compatible object storage               | Payslips, letters, receipts. Private, always.     |

The SPA and the API are separate origins on the same site. That is deliberate:
it lets the refresh cookie be `SameSite=Lax` and still reach the API, while a
third-party page cannot forge a request that carries it.

**Business time is Asia/Kolkata. Every container's clock is UTC.** The
application converts at the edges where a person reads a date. If you find
yourself changing `TZ` to fix a date, stop: you are about to shift every
stored timestamp.

---

## 2. First response

### 2.1 Is it up?

```sh
curl -s https://api-ess.widedrop.com/health          # the process is alive
curl -s https://api-ess.widedrop.com/health/ready    # …and the database answers
curl -sI https://ess.widedrop.com/ | head -20        # the SPA and its headers
```

`/health` answering while `/health/ready` does not means the API is running and
the database is not reachable. That is a database incident, not an API one.

### 2.2 What is it saying?

Logs are structured JSON. Every line carries `requestId`; every error a user
sees carries the same id in its `Reference`. Ask the person reporting the
problem for that reference and search for it — it is faster than guessing.

```sh
# Render dashboard → ess-api → Logs, or:
render logs --service ess-api --tail
```

Nothing in a log line is ever a password, a token, a bank account, a PAN or an
Aadhaar number. The logger redacts them by key, so if you see one, that is
itself the incident.

---

## 3. Incidents

### 3.1 Nobody can sign in

Work down this list; each step rules out the one above it.

1. **`/health/ready` failing** → the database. See §3.2.
2. **`INVALID_CREDENTIALS` for everyone, including a password you know is
   right** → `PASSWORD_PEPPER` has changed or is missing. Every hash was
   computed with it; without it none verify. Restore the value; do not reset
   anybody's password, which would be irreversible and wrong.
3. **`AUTHENTICATION_REQUIRED` immediately after a successful sign-in** →
   `JWT_PRIVATE_KEY`/`JWT_PUBLIC_KEY` do not match, or the key id changed. The
   token is signed by one instance and rejected by another. Check that both
   instances have the same values.
4. **Sign-in succeeds, every subsequent request 401s, only in a browser** →
   the cookie is not coming back. Check `COOKIE_DOMAIN` is `.widedrop.com`,
   `COOKIE_SECURE` is `true`, and `CORS_ORIGINS` contains exactly
   `https://ess.widedrop.com`.
5. **One person only** → their account is locked. Ten failed attempts locks
   for fifteen minutes and doubles. `SELECT locked_until FROM ess.app_user
WHERE email = …`. Unlock by letting it expire or by a password reset; do not
   clear `failed_login_count` by hand without recording why.

### 3.2 The database is unreachable

1. Check the Render dashboard for the instance's own status first — a
   maintenance window looks exactly like an outage from the API's side.
2. Connection exhaustion looks like intermittent `P1001`/`P2024` under load.
   The API uses the **pooled** connection string; a migration or a console
   session on the **direct** one holds a real connection. Close them.
3. If the database is up and the API cannot reach it, check `ipAllowList` on
   the database and that the API's outbound address has not changed.

**Do not restore from a backup to fix a connection problem.** A restore loses
every transaction since the snapshot, including payroll that has been published
and payslips people have downloaded.

### 3.3 Payroll will not publish

The pipeline refuses rather than half-completing, and the refusal names the
reason. In order of how often it is each one:

| Message                                         | What it means                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------- |
| `N payslips have no document yet`               | Rendering has not finished, or partly failed. See below.                      |
| `attendance for this period is not approved`    | A manager has not decided. The cycle screen lists who.                        |
| `N employees were excluded`                     | Validation found blocking problems. The findings name each person and remedy. |
| `a cycle that is published cannot be published` | Somebody already did it. Reload before acting.                                |

**Payslips with no document.** Calculating a cycle renders them, and the
worker re-renders anything it missed on its next pass — so this usually clears
itself within a poll interval. If it does not, the render failed rather than
lagged: look for `payslip render sweep failed` or
`some payslip documents could not be rendered` in the logs. It is almost always
object storage, so check `STORAGE_*` and the bucket's reachability rather than
anything in payroll. `POST /api/v1/payroll/cycles/:id/render` retries on
demand, and is idempotent — a payslip that already has a document is untouched.

```sql
SELECT c.label, count(*) AS missing
  FROM ess.payslip p JOIN ess.payroll_cycle c ON c.id = p.payroll_cycle_id
 WHERE p.pdf_file_object_id IS NULL AND p.status IN ('GENERATED','PUBLISHED')
 GROUP BY c.label;
```

Never set `pdf_file_object_id` by hand to get past the guard. It exists so an
employee is not told their payslip is ready and then offered nothing.

A cycle stuck in `VALIDATING` or `CALCULATING` means a run died mid-flight.
Both transitions are transactional, so nothing is half-written: move the cycle
back with the reverse event and run it again. **Never** `UPDATE
ess.payroll_cycle SET status = …` by hand — the guards that make the pipeline
safe are on the transition, not on the column.

### 3.4 Email is not arriving

The ticket is never lost: it is in `ess.helpdesk_ticket` regardless of whether
the mail went. The outbox is the thing to look at.

```sql
SELECT status, count(*), max(attempts)
  FROM ess_ops.email_outbox
 GROUP BY status;
```

- **`QUEUED` and growing** → nothing is draining the outbox. Which thing
  depends on the deployment:

  - **A container**: check the `ess-worker` service is up.
  - **Serverless**: the scheduler is not getting through. Read
    `ess_ops.job_run` first — it is the only place that knows whether the job
    _ran_, as opposed to whether something called it:

    ```sql
    SELECT job_name, status, started_at, finished_at, payload, last_error
      FROM ess_ops.job_run
     ORDER BY started_at DESC LIMIT 20;
    ```

    No rows at all means the call is not arriving. Then check the response
    codes in Supabase: `SELECT status_code, created FROM net._http_response
ORDER BY created DESC LIMIT 20;`. A **401** means the token in
    `ess_ops.job_runner_config` and `JOB_RUNNER_TOKEN` on the API disagree. A
    **404** means `JOB_RUNNER_TOKEN` is unset on the API, so the endpoint was
    never registered. A **429** means something else is spending the budget.

  Either way the messages are safe; they deliver when it comes back.

- **`QUEUED` with `attempts` climbing and `last_error` set** → the mail
  provider is refusing. Read `last_error`; it is the provider's own words.
- **`FAILED`** → six attempts over about eleven hours, all refused. These need
  a person. They are kept, not deleted, precisely so somebody can decide.
- **`SUPPRESSED`** → the address was rejected outright. Usually a typo in a
  category's routing address.

To retry a failed message after fixing the cause:

```sql
UPDATE ess_ops.email_outbox
   SET status = 'QUEUED', attempts = 0, next_attempt_at = now(), last_error = NULL
 WHERE status = 'FAILED' AND id = '…';
```

### 3.5 Somebody says a number is wrong

This system's central claim is that every displayed figure comes from a
persisted row or a deterministic calculation over persisted rows. So the answer
is always findable.

1. **A payslip figure** → every line carries its derivation in
   `calculation_note`, and the run that produced it carries an `input_digest`.
   The same inputs reproduce the same output — and so does the document: the
   PDF is a function of the stored rows and nothing else, so re-rendering a
   disputed payslip and comparing the bytes tells you whether the figures
   changed or only somebody's memory of them did. The derivations are printed
   on the payslip itself, so the answer is usually in the employee's own copy.
2. **A leave balance** → `ess.leave_balance_ledger` has one row per movement,
   each naming its source. The balance is the sum; `available_days` is a
   generated column, so it cannot disagree with its parts.
3. **A year-to-date total** → `ess.payslip_fy_rollup`, recomputed from
   published payslips at each publication. If it disagrees with the payslips,
   re-run the publication's rollup rather than editing the total.
4. **Anything at all** → the audit trail. Filter by entity type and id.

### 3.6 The audit chain does not verify

Take this seriously. The chain is HMAC-linked with a key the database never
sees, so a broken chain means one of three things:

1. **A row was altered or deleted** outside the application. The verifier names
   the sequence number where the chain breaks; everything after it is suspect.
2. **`AUDIT_HMAC_KEY` changed.** Rows written under the old key will not verify
   under the new one. Check the deploy history before assuming the worst.
3. **A gap in the sequence.** The sequence is per-organisation and contiguous,
   assigned under an advisory lock, so a gap means rows were removed.

Do not "fix" it. Preserve the state, capture the verifier's output, and
escalate. The value of the trail is that it is not something anybody can
quietly repair.

---

## 4. Routine operations

### 4.1 Deploying

Merging to `main` runs CI; CI passing triggers the deploy workflow. It builds
the image, uploads the SPA, releases both Render services and then smoke-tests
the result. Nothing needs to be done by hand.

The image is tagged by commit, never `latest`, so a deploy names exactly what
it is shipping.

### 4.2 Rolling back

- **The SPA**: Netlify → Deploys → the previous one → _Publish deploy_. It is
  immediate and reversible.
- **The API**: Render → ess-api → Events → the previous deploy → _Rollback_.
  Roll the worker back to the same commit.
- **A migration**: do not roll a migration back. Migrations here are additive
  and backward-compatible by policy, so the previous release runs against the
  new schema. If one is not, that is the defect to fix, forward.

### 4.3 Restoring the database

Render keeps point-in-time recovery. A restore creates a **new** instance; it
does not overwrite the old one, which is what makes the drill safe to practise.

1. Restore to a new instance at the chosen timestamp.
2. Point a staging API at it and check: the audit chain verifies, the payslip
   count matches what people remember, and the latest cycle is in the state it
   should be.
3. Only then repoint production, and record the window of lost transactions.

Practise this quarterly. A restore nobody has done is a restore that does not
work.

### 4.4 Rotating a secret

| Secret              | Effect of rotating                                                                  |
| ------------------- | ----------------------------------------------------------------------------------- |
| `JWT_PRIVATE_KEY`   | Every session ends. Everybody signs in again. This is the break-glass control.      |
| `PASSWORD_PEPPER`   | **Every password stops working.** Effectively irreversible. Do not rotate casually. |
| `ENCRYPTION_KEK`    | Needs a re-wrap pass; the old key must stay available until it finishes.            |
| `AUDIT_HMAC_KEY`    | Rows written before the change no longer verify. Record the changeover point.       |
| SMTP credentials    | In-flight messages fail and retry. No data is lost.                                 |
| Storage credentials | Signed URLs already issued keep working until they expire.                          |

### 4.5 Onboarding the first administrator

A fresh database has no accounts, which is correct: nothing here ships with a
default password.

```sh
npm run db:migrate -w @widedrop/api
npm run db:seed:reference -w @widedrop/api   # roles, permissions, pay components
npm run bootstrap:admin -w @widedrop/api     # prints a password once
```

The generated password is shown once and never stored in readable form. The
account must enrol two-factor authentication before it can use its HR or
Accounts permissions.

---

## 5. Things that look like incidents and are not

- **"No payslips yet" for a new employee.** Correct. A payslip does not exist
  until payroll has run and been published. The screen says so.
- **An em dash where a number should be.** Also correct. It means the figure
  does not exist yet, which is a different claim from zero, and the system
  refuses to make the wrong one.
- **A manager cannot see a report's payslip.** By design. No role holds
  `payslip:read` beyond `SELF`; Accounts reads the register, which is a
  different permission and is audited as an export.
- **A 404 where a 403 seems more honest.** Also by design. A 403 would confirm
  that the record exists, which is information the caller has not earned.
- **The audit trail recording your own searches of it.** Yes. An auditor
  looking at one person's payslip reads leaves a record of having looked.
